/**
 * @zzc/dsh-node-sched — dsh host plugin (M1).
 *
 * Adapter over the remote `sched` node-level GPU/CPU scheduler. This plugin
 * never reimplements scheduling: it shells out to the remote CLI over ssh
 * (JSON interfaces are the contract), and exposes the surface as agent tools.
 * Dashboard RPC/WS arrives in M2/M3.
 *
 * Loading contract mirrors official plugins (verified against
 * @deepseek-ai/dsh-tool-jobs 0.1.0-rc.7): exports { name, inject, Config,
 * apply }, Config is a schemastery schema, apply(ctx, config) returns an
 * optional disposer. ctx.logger is cordis-built-in (never injected).
 * Services are cordis Service subclasses — arbitrary ctx property assignment
 * throws ("cannot set property ... without provide"), so this plugin keeps
 * its proxy closure-local and registers tools directly.
 *
 * Design doc: VeighNa_Trade/docs/04-scheduler/dsh_sched_plugin_research.md
 * Sched semantics: VeighNa_Trade/docs/04-scheduler/scheduler_design.md
 */

import cp from "node:child_process";
import { canonicalDaemonHealth } from "./daemon-health.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { WebSocketServer } from "ws";
import {
	HostStore,
	KEYBOARD_INTERACTIVE_PROMPT_CAP,
	SshEngine,
	formatSshError,
	normalizeKeyboardInteractivePrompts,
	openExecStream,
	probeHostKey,
	resolveHostRoute,
	trustedHostKeyRecords,
} from "./ssh-engine.js";
import { defaultKnownHostsFiles, lookupKnownHostKeys } from "./known-hosts.js";
import {
	HostTrustBroker,
	hostTrustPrincipalKey,
	hostTrustRouteSnapshot,
	knownHostTrustRecords,
} from "./host-trust.js";
import { LocalTransport } from "./transport.js";
import {
	NoOpenSshMasterError,
	SystemOpenSshTransport,
	validateSshEntry,
} from "./system-openssh.js";
import { isLoopbackAddress, loopbackRequestAllowed, originHostAllowed, sameOriginPostAllowed } from "./request-guard.js";
import { parseUploadedPath } from "./upload-path.js";
import { persistEntryOverride as writeEntryOverride } from "./entry-override.js";
import { parseScreenEnd, parseScreenResult } from "./screen-result.js";
import { appendLimitedOutput, finalizeLimitedOutput, limitedOutputText } from "./output-limit.js";
import { redactCommand, sanitizeLogText } from "./redact.js";
import { isTransientSshError } from "./retry-policy.js";
import { DeviceAuthError, TrustedBrowserAuth } from "./device-auth.js";

const name = "node-sched";

/**
 * Config is deployment truth only — no account/node/path may leak into code
 * (same discipline as sched's own I/J-class config separation). The ssh entry
 * remains explicitly configured; the plugin never switches entries on its
 * own. The HPDC deployment currently uses only ssh HPDC.
 */
const Config = z.object({
	/** ssh entry alias; probed at activation with a short ConnectTimeout. */
	sshEntry: z.string().default("HPDC"),
	/** Remote sched binary; full path required (non-interactive ssh has no rc PATH). */
	schedBin: z.string().default("$HOME/bin/sched"),
	/** Subcommand used for the activation probe. */
	probeCommand: z.string().default("status"),
	/** ConnectTimeout passed to ssh for every invocation (seconds). */
	connectTimeoutSec: z.number().min(5).max(120).default(20),
	/** Fallback polling interval (seconds) when the events tail is unavailable. */
	pollFallbackSec: z.number().min(10).max(600).default(30),
	/** Transport for read-only sched commands. */
	transport: z.union([z.const("auto"), z.const("local")]).default("auto"),
	/** Mutations fail closed unless a writer is explicitly selected. */
	mutationMode: z.union([
		z.const("disabled"),
		z.const("local"),
		z.const("engine"),
		z.const("ssh"),
		z.const("screen"),
	]).default("disabled"),
	/** Engine alias or ssh entry for the mutation writer. */
	mutationTarget: z.string().default(""),
	/** Required screen session when mutationMode is screen. */
	mutationSession: z.string().default(""),
	/** Expected sched config.node and writer hostname. */
	mutationExpectedNode: z.string().default(""),
});

const inject = ["tools", "systemPrompt", "webServer"];

/** One in-flight mutation for the configured writer; preflight stays adjacent to write. */
class WriteGate {
	constructor() {
		/** @type {Promise<unknown> | null} */
		this.inflight = null;
		this.activeKey = "";
	}

	run(key, fn) {
		if (this.inflight !== null) {
			return Promise.reject(
				new Error(
					`node-sched: operation already in flight: ${this.activeKey} (refusing concurrent write)`,
				),
			);
		}
		const p = Promise.resolve()
			.then(fn)
			.finally(() => {
				if (this.inflight === p) {
					this.inflight = null;
					this.activeKey = "";
				}
			});
		this.activeKey = key;
		this.inflight = p;
		return p;
	}
}

function terminateProcessTree(child, signal = "SIGTERM", groupPid) {
	if (process.platform !== "win32" && Number.isInteger(groupPid)) {
		try {
			process.kill(-groupPid, signal);
			return;
		} catch {
			// The tracked process group is already gone; never target an untracked PID.
		}
	}
	try { child?.kill(signal); } catch { /* already exited */ }
}

function stopProcessTreeWithGrace(child, groupPid, graceMs = 1_000) {
	let trackedGroupPid = groupPid;
	let escalationTimer;
	let leaderExited = false;
	const clearIdentity = () => {
		leaderExited = true;
		clearTimeout(escalationTimer);
		escalationTimer = undefined;
		trackedGroupPid = undefined;
	};
	child?.once?.("exit", clearIdentity);
	child?.once?.("close", clearIdentity);
	terminateProcessTree(child, "SIGTERM", trackedGroupPid);
	if (!leaderExited) {
		escalationTimer = setTimeout(() => {
			escalationTimer = undefined;
			const targetGroupPid = trackedGroupPid;
			trackedGroupPid = undefined;
			terminateProcessTree(child, "SIGKILL", targetGroupPid);
		}, graceMs);
		escalationTimer.unref?.();
	}
}

function sshOpenDeadlineAt(engine) {
	const configured = typeof engine.interactivePrompter === "function"
		? engine.opts?.interactiveAuthTimeoutMs
		: engine.opts?.connectTimeoutMs;
	const timeoutMs = Number.isFinite(configured) && configured > 0 ? configured : 15_000;
	return Date.now() + timeoutMs;
}

function beginPendingOpen(pending, limit) {
	if (pending.size >= limit) return undefined;
	const controller = new AbortController();
	pending.add(controller);
	let settled = false;
	return {
		controller,
		settle() {
			if (settled) return;
			settled = true;
			pending.delete(controller);
		},
	};
}

function abortPendingOpens(pending, reason) {
	for (const controller of pending) controller.abort(reason);
}

function makeRunner(childProcess, cfg) {
	return function runRemote(args, {
		timeoutMs = 120_000,
		maxOutputBytes = 2 * 1024 * 1024,
		sshEntry = cfg.sshEntry,
		stdinData,
		signal,
	} = {}) {
		return new Promise((resolve) => {
			const stdout = { text: "", bytes: 0, droppedBytes: 0, truncated: false };
			const stderr = { text: "", bytes: 0, droppedBytes: 0, truncated: false };
			const detached = process.platform !== "win32";
			const termGraceMs = Number.isFinite(cfg.termGraceMs) && cfg.termGraceMs >= 0
				? cfg.termGraceMs
				: 1_000;
			let child;
			let groupPid;
			let settled = false;
			let timedOut = false;
			let terminalError;
			let graceTimer;
			let leaderExited = false;
			let leaderCode = -1;
			const finish = (code, error = terminalError) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				clearTimeout(graceTimer);
				groupPid = undefined;
				signal?.removeEventListener?.("abort", abort);
				if (error) {
					appendLimitedOutput(
						stderr,
						Buffer.from(`${stderr.bytes ? "\n" : ""}${error.message}`, "utf8"),
						maxOutputBytes,
					);
				}
				if (timedOut) {
					appendLimitedOutput(stderr, Buffer.from("\nprocess timed out", "utf8"), maxOutputBytes);
				}
				finalizeLimitedOutput(stdout);
				finalizeLimitedOutput(stderr);
				resolve({
					ok: !error && !timedOut && code === 0,
					code: code ?? -1,
					stdout: limitedOutputText(stdout),
					stderr: limitedOutputText(stderr).trim(),
				});
			};
			const terminate = (error) => {
				if (settled || graceTimer !== undefined) return;
				terminalError = error;
				if (leaderExited) {
					finish(leaderCode);
					return;
				}
				terminateProcessTree(child, "SIGTERM", groupPid);
				graceTimer = setTimeout(() => {
					graceTimer = undefined;
					if (!leaderExited) {
						terminateProcessTree(child, "SIGKILL", groupPid);
					}
					finish(leaderCode);
				}, termGraceMs);
			};
			const abort = () => terminate(new Error("operation aborted"));
			const timer = setTimeout(() => {
				timedOut = true;
				terminate();
			}, timeoutMs);
			try {
				child = childProcess.spawn(
					"ssh",
					["-o", `ConnectTimeout=${cfg.connectTimeoutSec}`, "-o", "BatchMode=yes", sshEntry, args],
					{
						timeout: timeoutMs,
						signal,
						detached,
						killSignal: "SIGTERM",
					},
				);
				if (detached && Number.isInteger(child.pid)) groupPid = child.pid;
			} catch (error) {
				finish(-1, error);
				return;
			}
			child.stdout.on("data", (data) => appendLimitedOutput(stdout, data, maxOutputBytes));
			child.stderr.on("data", (data) => appendLimitedOutput(stderr, data, maxOutputBytes));
			child.on("exit", (code) => {
				leaderExited = true;
				leaderCode = code ?? -1;
				// Keep the operation deadline (and any active grace period) until
				// close or bounded settlement; the stdio descriptors may outlive
				// the leader. Never reuse the exited leader's process-group ID.
				groupPid = undefined;
			});
			child.on("error", (error) => {
				if (error?.name === "AbortError" && terminalError) return;
				terminalError ??= error;
			});
			child.on("close", (code) => finish(code));
			signal?.addEventListener?.("abort", abort, { once: true });
			if (signal?.aborted) abort();
			child.stdin?.end(stdinData);
		});
	};
}

function boundedLimit(value, fallback, max) {
	if (value === undefined || value === null) return fallback;
	const numeric = Number(value);
	if (!Number.isFinite(numeric) || numeric < 1) throw new Error("limit must be a positive integer");
	return Math.min(Math.trunc(numeric), max);
}

function commandCursor(value, label) {
	if (value === undefined || value === null) return "";
	if (typeof value !== "string" || !value || value.length > 1024 || /[\0-\x1f\x7f]/.test(value)) {
		throw new Error(`${label} is invalid`);
	}
	return shellQuote(value);
}

function buildStatusCommand({ schedBin, limit, cursor, jobCursor } = {}) {
	if (!schedBin) throw new Error("schedBin is required");
	const batchCursor = commandCursor(cursor, "status cursor");
	const jobsCursor = commandCursor(jobCursor, "status job cursor");
	return `${schedBin} status --json --limit ${boundedLimit(limit, 200, 1000)}`
		+ (batchCursor ? ` --cursor ${batchCursor}` : "")
		+ (jobsCursor ? ` --job-cursor ${jobsCursor}` : "");
}

function buildHistoryCommand({ schedBin, batch, limit, cursor } = {}) {
	if (!schedBin) throw new Error("schedBin is required");
	const batchArg = batch ? ` ${shellQuote(batch)}` : "";
	const historyCursor = commandCursor(cursor, "history cursor");
	return `${schedBin} history${batchArg} --json --limit ${boundedLimit(limit, 50, 200)}`
		+ (historyCursor ? ` --cursor ${historyCursor}` : "");
}

function taskReference(reference) {
	if (typeof reference === "string") return reference;
	if (!reference || typeof reference !== "object" || !reference.batch_id || !reference.task) {
		throw new Error("task reference requires batch_id and task");
	}
	return `${reference.batch_id}:${reference.task}`;
}

function buildTaskCommand(operation, reference, { schedBin, lines = 100 } = {}) {
	if (!schedBin) throw new Error("schedBin is required");
	const ref = shellQuote(taskReference(reference));
	if (operation === "log") return `${schedBin} log ${ref} -n ${boundedLimit(lines, 100, 5000)}`;
	if (operation === "task") return `${schedBin} task ${ref} --json`;
	if (operation === "diag") return `${schedBin} diag ${ref}`;
	if (operation === "retry") return `${schedBin} retry ${ref}`;
	if (operation === "resubmit") return `${schedBin} resubmit ${ref}`;
	throw new Error(`unsupported task operation: ${operation}`);
}

function buildOperationCommand(operation, id, schedBin) {
	if (!schedBin) throw new Error("schedBin is required");
	const commands = {
		cancel: () => `${schedBin} cancel ${shellQuote(id)} --yes`,
		retry: () => `${schedBin} retry ${shellQuote(id)}`,
		resubmit: () => `${schedBin} resubmit ${shellQuote(id)}`,
		"gpu-free": () => `${schedBin} gpu-free ${id} --yes`,
		"gpu-ignore": () => `${schedBin} gpu-ignore ${id}`,
		"gpu-ok": () => `${schedBin} gpu-ok ${id}`,
		"daemon-start": () => `${schedBin} daemon start`,
		"daemon-stop": () => `${schedBin} daemon stop`,
	};
	if (!commands[operation]) throw new Error(`unsupported operation: ${operation}`);
	return commands[operation]();
}
function canonicalGpuAssignments(assignments) {
	if (!Array.isArray(assignments)) throw new Error("GPU assignments precondition is required");
	const result = assignments.map((assignment, index) => {
		if (
			!assignment
			|| typeof assignment !== "object"
			|| Array.isArray(assignment)
			|| Object.keys(assignment).some((key) => key !== "job_id" && key !== "vram_gib")
			|| typeof assignment.job_id !== "string"
			|| !assignment.job_id
			|| (
				assignment.vram_gib !== null
				&& (
					typeof assignment.vram_gib !== "number"
					|| !Number.isFinite(assignment.vram_gib)
					|| assignment.vram_gib < 0
				)
			)
		) {
			throw new Error(`GPU assignment ${index} is invalid`);
		}
		return { job_id: assignment.job_id, vram_gib: assignment.vram_gib };
	});
	for (let index = 1; index < result.length; index += 1) {
		if (result[index - 1].job_id >= result[index].job_id) {
			throw new Error("GPU assignments must be uniquely sorted by job_id");
		}
	}
	return result;
}

function buildIdempotentMutationCommand(
	command,
	schedBin,
	requestId,
	precondition = { kind: "none" },
) {
	if (typeof schedBin !== "string" || !schedBin) throw new Error("schedBin is required");
	if (typeof requestId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(requestId)) {
		throw new Error("mutation request id is invalid");
	}
	const prefix = `${schedBin} `;
	if (typeof command !== "string" || !command.startsWith(prefix) || command.length === prefix.length) {
		throw new Error("mutation command must use the configured sched binary");
	}
	const kind = String(precondition?.kind ?? "none");
	const expectation = [];
	if (kind !== "none") {
		const id = precondition?.id;
		const status = precondition?.expectedStatus;
		if (
			!["batch", "task", "gpu"].includes(kind)
			|| typeof id !== "string"
			|| !id
			|| typeof status !== "string"
			|| !status
			|| !Number.isInteger(precondition.expectedRevision)
			|| precondition.expectedRevision < 0
		) {
			throw new Error("mutation precondition is invalid");
		}
		expectation.push(
			"--expect-kind", shellQuote(kind),
			"--expect-id", shellQuote(id),
			"--expect-status", shellQuote(status),
			"--expect-revision", String(precondition.expectedRevision),
		);
		if (kind === "task") {
			if (!Number.isInteger(precondition.expectedVersion) || precondition.expectedVersion < 1) {
				throw new Error("task mutation precondition version is invalid");
			}
			expectation.push("--expect-version", String(precondition.expectedVersion));
		}
		if (kind === "gpu") {
			if (precondition.expectedQuarantined !== undefined) {
				if (![0, 1].includes(precondition.expectedQuarantined)) {
					throw new Error("GPU mutation quarantine precondition is invalid");
				}
				expectation.push("--expect-quarantined", String(precondition.expectedQuarantined));
			}
			expectation.push(
				"--expect-assignments-json",
				shellQuote(JSON.stringify(canonicalGpuAssignments(precondition.expectedAssignments))),
			);
		}
	} else if (precondition && precondition.kind !== undefined && precondition.kind !== "none") {
		throw new Error("mutation precondition is invalid");
	} else {
		expectation.push("--expect-revision", "0");
	}
	const expectationText = ` ${expectation.join(" ")}`;
	return `${schedBin} request ${shellQuote(requestId)}${expectationText} -- ${command.slice(prefix.length)}`;
}
function durableUploadName(requestId, content) {
	if (typeof requestId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(requestId)) {
		throw new Error("durable upload request id is invalid");
	}
	const digest = createHash("sha256").update(String(content), "utf8").digest("hex").slice(0, 32);
	return `nodesched-upload-${requestId}-${digest}.json`;
}

function operationHttpResult(result) {
	return { ok: Boolean(result?.ok), code: result?.code ?? -1, text: String(result?.text ?? "") };
}

function hostMatches(left, right) {
	const normalize = (value) => String(value ?? "")
		.trim()
		.toLowerCase()
		.replace(/\.+$/, "");
	const a = normalize(left);
	const b = normalize(right);
	return Boolean(a && b && a === b);
}

function resolveMutationWriter({
	configuredWriter,
	schedConfigNode,
	writerHostname,
	expectedNode = configuredWriter?.expectedNode,
} = {}) {
	if (!configuredWriter || configuredWriter.mode === "disabled") {
		throw new Error("explicit mutation writer is missing or disabled");
	}
	if (!schedConfigNode || !writerHostname) {
		throw new Error("mutation writer hostname and sched config node must be verified");
	}
	if (expectedNode && !hostMatches(expectedNode, schedConfigNode)) {
		throw new Error("configured mutation writer expected node does not match sched config node");
	}
	if (!hostMatches(writerHostname, schedConfigNode)) {
		throw new Error("mutation writer hostname does not match sched config node");
	}
	return configuredWriter;
}

function parseWriterVerification(configuredWriter, result) {
	if (!result?.ok) {
		const detail = result?.stderr || result?.stdout || `exit ${result?.code ?? -1}`;
		throw new Error(`mutation writer verification failed: ${String(detail).trim()}`);
	}
	const output = String(result.stdout ?? "");
	const newline = output.indexOf("\n");
	if (newline < 1) throw new Error("mutation writer verification returned no hostname/config");
	const writerHostname = output.slice(0, newline).trim();
	let schedConfig;
	try {
		schedConfig = JSON.parse(output.slice(newline + 1));
	} catch {
		throw new Error("mutation writer verification returned invalid sched config JSON");
	}
	return resolveMutationWriter({
		configuredWriter,
		expectedNode: configuredWriter.expectedNode,
		schedConfigNode: schedConfig?.node,
		writerHostname,
	});
}

async function verifyAndExecuteMutation({
	configuredWriter,
	command,
	timeoutMs,
	executeRead,
	executeMutation,
	preflight,
	prepare,
	schedBin = configuredWriter?.schedBin,
} = {}) {
	if (typeof executeRead !== "function" || typeof executeMutation !== "function") {
		throw new Error("mutation executors are required");
	}
	if (preflight !== undefined && typeof preflight !== "function") {
		throw new Error("mutation preflight must be a function");
	}
	if (prepare !== undefined && typeof prepare !== "function") {
		throw new Error("mutation preparation must be a function");
	}
	if (!schedBin) throw new Error("schedBin is required for mutation writer verification");
	const verification = await executeRead(
		configuredWriter,
		`hostname && ${schedBin} config get`,
		timeoutMs,
	);
	const writer = parseWriterVerification(configuredWriter, verification);
	if (preflight) await preflight(writer, timeoutMs);
	const prepared = prepare ? await prepare(writer, timeoutMs) : { command };
	if (!prepared || typeof prepared.command !== "string" || !prepared.command) {
		throw new Error("mutation preparation returned no command");
	}
	const result = await executeMutation(writer, prepared.command, timeoutMs);
	const definitive = result?.ok === true
		|| (Number.isInteger(result?.code) && result.code > 0 && result.code < 128 && result.code !== 75);
	if (definitive) {
		try { await prepared.cleanup?.(); } catch { /* age GC removes retained cleanup failures */ }
	}
	return result;
}
class ByteLineFramer {
	constructor({ maxLineBytes = 3_000, onLine } = {}) {
		if (!Number.isInteger(maxLineBytes) || maxLineBytes < 1 || typeof onLine !== "function") {
			throw new Error("line framer requires a positive byte limit and callback");
		}
		this.maxLineBytes = maxLineBytes;
		this.onLine = onLine;
		this.parts = [];
		this.bufferedBytes = 0;
		this.droppedBytes = 0;
	}

	#append(bytes) {
		const available = this.maxLineBytes - this.bufferedBytes;
		const retained = Math.min(available, bytes.length);
		if (retained > 0) {
			const copy = Buffer.allocUnsafe(retained);
			bytes.copy(copy, 0, 0, retained);
			this.parts.push(copy);
			this.bufferedBytes += retained;
		}
		this.droppedBytes += bytes.length - retained;
	}

	#emit() {
		let bytes = this.bufferedBytes > 0
			? Buffer.concat(this.parts, this.bufferedBytes)
			: Buffer.alloc(0);
		if (bytes.at(-1) === 0x0d) bytes = bytes.subarray(0, bytes.length - 1);
		let text;
		let invalidTail = 0;
		for (; invalidTail <= Math.min(3, bytes.length); invalidTail += 1) {
			try {
				text = new TextDecoder("utf-8", { fatal: true }).decode(
					invalidTail === 0 ? bytes : bytes.subarray(0, bytes.length - invalidTail),
				);
				break;
			} catch {
				// A byte cap may bisect one trailing code point; account for it as dropped.
			}
		}
		if (text === undefined) text = bytes.toString("utf8");
		const dropped = this.droppedBytes + invalidTail;
		const line = `${text.trimEnd()}${dropped > 0 ? `…[truncated ${dropped} bytes]` : ""}`;
		this.parts = [];
		this.bufferedBytes = 0;
		this.droppedBytes = 0;
		if (line) this.onLine(line);
	}

	push(chunk) {
		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		let offset = 0;
		while (offset < bytes.length) {
			const newline = bytes.indexOf(0x0a, offset);
			if (newline < 0) {
				this.#append(bytes.subarray(offset));
				return;
			}
			this.#append(bytes.subarray(offset, newline));
			this.#emit();
			offset = newline + 1;
		}
	}

	flush() {
		if (this.bufferedBytes > 0 || this.droppedBytes > 0) this.#emit();
	}
}


class FreshStatusCache {
	constructor({ ttlMs = 30_000, now = Date.now } = {}) {
		if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error("status cache ttlMs must be positive");
		if (typeof now !== "function") throw new Error("status cache now must be a function");
		this.ttlMs = ttlMs;
		this.now = now;
		this.entries = new Map();
	}

	recordSuccess(key, body) {
		this.entries.set(String(key), {
			body,
			successAt: this.now(),
			lastError: null,
		});
		return body;
	}

	recordFailure(key, error) {
		const cacheKey = String(key);
		const entry = this.entries.get(cacheKey) ?? {
			body: null,
			successAt: null,
			lastError: null,
		};
		entry.lastError = error;
		this.entries.set(cacheKey, entry);
	}

	delete(key) {
		this.entries.delete(String(key));
	}

	clear() {
		this.entries.clear();
	}

	read(key, { requireFresh = false } = {}) {
		const entry = this.entries.get(String(key));
		if (!entry) {
			return { body: null, fresh: false, stale: false, ageMs: null, lastError: null };
		}
		const ageMs = entry.successAt == null ? null : Math.max(0, this.now() - entry.successAt);
		const fresh = entry.body != null && entry.lastError == null && ageMs < this.ttlMs;
		const stale = entry.body != null && !fresh;
		return {
			body: requireFresh && !fresh ? null : entry.body,
			fresh,
			stale,
			ageMs,
			lastError: entry.lastError,
		};
	}
}

function loadOrCreateAccessToken(
	file = path.join(os.homedir(), ".dsh", "node-sched-access-token"),
) {
	const directory = path.dirname(file);
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	const directoryStat = fs.lstatSync(directory);
	if (
		!directoryStat.isDirectory()
		|| directoryStat.isSymbolicLink()
		|| (typeof process.getuid === "function" && directoryStat.uid !== process.getuid())
	) {
		throw new Error("node-sched token directory must be an owned real directory");
	}
	fs.chmodSync(directory, 0o700);

	const readExisting = () => {
		const fd = fs.openSync(
			file,
			fs.constants.O_RDONLY
				| (fs.constants.O_CLOEXEC ?? 0)
				| (fs.constants.O_NOFOLLOW ?? 0),
		);
		try {
			const info = fs.fstatSync(fd);
			if (
				!info.isFile()
				|| info.size > 512
				|| (typeof process.getuid === "function" && info.uid !== process.getuid())
				|| (info.mode & 0o077) !== 0
			) {
				throw new Error("node-sched token file must be owned, regular, and mode 0600");
			}
			const token = fs.readFileSync(fd, "utf8").trim();
			if (!/^[A-Za-z0-9_-]{40,128}$/.test(token)) {
				throw new Error("node-sched token file is invalid");
			}
			return token;
		} finally {
			fs.closeSync(fd);
		}
	};

	try {
		return readExisting();
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
	}
	const token = randomBytes(32).toString("base64url");
	const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
	let linked = false;
	try {
		const fd = fs.openSync(
			temporary,
			fs.constants.O_WRONLY
				| fs.constants.O_CREAT
				| fs.constants.O_EXCL
				| (fs.constants.O_CLOEXEC ?? 0)
				| (fs.constants.O_NOFOLLOW ?? 0),
			0o600,
		);
		try {
			fs.writeFileSync(fd, `${token}\n`, "utf8");
			fs.fchmodSync(fd, 0o600);
			fs.fsyncSync(fd);
		} finally {
			fs.closeSync(fd);
		}
		try {
			fs.linkSync(temporary, file);
			linked = true;
		} catch (error) {
			if (error?.code !== "EEXIST") throw error;
		}
	} finally {
		try { fs.unlinkSync(temporary); } catch { /* absent */ }
	}
	return linked ? token : readExisting();
}
function parseBoundedJson(text, { maxDepth = 32, maxNodes = 10_000 } = {}) {
	const value = JSON.parse(String(text));
	const stack = [[value, 0]];
	let nodes = 0;
	while (stack.length > 0) {
		const [current, depth] = stack.pop();
		nodes += 1;
		if (nodes > maxNodes) throw new Error("JSON node limit exceeded");
		if (depth > maxDepth) throw new Error("JSON depth limit exceeded");
		if (current === null || typeof current !== "object") continue;
		const children = Array.isArray(current) ? current : Object.values(current);
		for (const child of children) stack.push([child, depth + 1]);
	}
	return value;
}

function appendPrivateClientLog(home, line) {
	const directory = path.join(home, ".sched");
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	const directoryStat = fs.lstatSync(directory);
	if (
		!directoryStat.isDirectory()
		|| directoryStat.isSymbolicLink()
		|| (typeof process.getuid === "function" && directoryStat.uid !== process.getuid())
	) {
		throw new Error("client log directory must be an owned real directory");
	}
	fs.chmodSync(directory, 0o700);
	const file = path.join(directory, "client-exceptions.log");
	const fd = fs.openSync(
		file,
		fs.constants.O_WRONLY
			| fs.constants.O_APPEND
			| fs.constants.O_CREAT
			| (fs.constants.O_CLOEXEC ?? 0)
			| (fs.constants.O_NOFOLLOW ?? 0),
		0o600,
	);
	try {
		const info = fs.fstatSync(fd);
		if (
			!info.isFile()
			|| info.nlink !== 1
			|| (typeof process.getuid === "function" && info.uid !== process.getuid())
		) {
			throw new Error("client log must be an owned regular file without hard links");
		}
		fs.fchmodSync(fd, 0o600);
		fs.writeFileSync(fd, String(line), "utf8");
	} finally {
		fs.closeSync(fd);
	}
}

const PRIVATE_UPLOAD_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function fsyncDirectory(directory) {
	const fd = fs.openSync(
		directory,
		fs.constants.O_RDONLY
			| (fs.constants.O_DIRECTORY ?? 0)
			| (fs.constants.O_CLOEXEC ?? 0)
			| (fs.constants.O_NOFOLLOW ?? 0),
	);
	try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function gcPrivateUploads(
	directory,
	{ now = Date.now(), maxAgeMs = PRIVATE_UPLOAD_MAX_AGE_MS, exclude } = {},
) {
	let removed = 0;
	for (const name of fs.readdirSync(directory)) {
		if (
			!/^nodesched-upload-[A-Za-z0-9_.:-]{1,180}\.json$/.test(name)
			|| name === exclude
		) continue;
		const candidate = path.join(directory, name);
		let info;
		try { info = fs.lstatSync(candidate); } catch { continue; }
		if (
			!info.isFile()
			|| info.isSymbolicLink()
			|| now - info.mtimeMs < maxAgeMs
		) continue;
		try {
			fs.unlinkSync(candidate);
			removed += 1;
		} catch { /* raced with a definitive cleanup */ }
	}
	if (removed > 0) fsyncDirectory(directory);
	return removed;
}

function writePrivateUpload(directory, name, content) {
	if (
		typeof name !== "string"
		|| !/^nodesched-upload-[A-Za-z0-9_.:-]{1,180}\.json$/.test(name)
		|| path.basename(name) !== name
	) {
		throw new Error("private upload name is invalid");
	}
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	const directoryStat = fs.lstatSync(directory);
	if (
		!directoryStat.isDirectory()
		|| directoryStat.isSymbolicLink()
		|| (typeof process.getuid === "function" && directoryStat.uid !== process.getuid())
	) {
		throw new Error("private upload directory must be an owned real directory");
	}
	fs.chmodSync(directory, 0o700);
	const target = path.join(directory, name);
	const temporary = path.join(
		directory,
		`.${name}.${process.pid}.${randomUUID()}.tmp`,
	);
	let fd;
	try {
		fd = fs.openSync(
			temporary,
			fs.constants.O_WRONLY
				| fs.constants.O_CREAT
				| fs.constants.O_EXCL
				| (fs.constants.O_CLOEXEC ?? 0)
				| (fs.constants.O_NOFOLLOW ?? 0),
			0o600,
		);
		fs.writeFileSync(fd, String(content), "utf8");
		fs.fchmodSync(fd, 0o600);
		fs.fsyncSync(fd);
		fs.closeSync(fd);
		fd = undefined;
		fs.renameSync(temporary, target);
		fsyncDirectory(directory);
		gcPrivateUploads(directory, { exclude: name });
		return target;
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
		try { fs.unlinkSync(temporary); } catch { /* moved or absent */ }
	}
}

function requestCredentialOrigin(req) {
	const supplied = String(req?.headers?.origin ?? "").trim();
	if (supplied) return supplied;
	const host = String(req?.headers?.host ?? "").trim();
	if (!host) return "";
	try {
		return new URL(`${req?.socket?.encrypted ? "https" : "http"}://${host}`).origin;
	} catch {
		return "";
	}
}

function bearerToken(req) {
	const header = req?.headers?.authorization;
	if (typeof header !== "string" || !header.startsWith("Bearer ")) return null;
	return header.slice(7);
}

function bearerPrincipal(req, expectedToken) {
	const token = bearerToken(req);
	if (token === null) return null;
	if (expectedToken && typeof expectedToken.authenticateBearer === "function") {
		try {
			return expectedToken.authenticateBearer(token, requestCredentialOrigin(req));
		} catch {
			return null;
		}
	}
	if (typeof expectedToken !== "string" || !expectedToken) return null;
	const supplied = Buffer.from(token, "utf8");
	const expected = Buffer.from(expectedToken, "utf8");
	return supplied.length === expected.length && timingSafeEqual(supplied, expected)
		? { kind: "master", clientId: null, expiresAt: null }
		: null;
}

function bearerRequestAllowed(req, expectedToken) {
	return bearerPrincipal(req, expectedToken) !== null;
}

function websocketRequestPrincipal(req, expectedToken) {
	const remote = req?.socket?.remoteAddress ?? "";
	if (!isLoopbackAddress(remote) || !originHostAllowed(req)) return null;
	const header = req?.headers?.["sec-websocket-protocol"];
	if (typeof header !== "string") return null;
	const protocols = header.split(",").map((value) => value.trim()).filter(Boolean);
	if (!protocols.includes("sched-auth")) return null;
	const suppliedToken = protocols.find((value) => value !== "sched-auth");
	if (!suppliedToken || protocols.length !== 2) return null;
	if (expectedToken && typeof expectedToken.authenticateBearer === "function") {
		try {
			return expectedToken.authenticateBearer(suppliedToken, requestCredentialOrigin(req));
		} catch {
			return null;
		}
	}
	const supplied = Buffer.from(suppliedToken, "utf8");
	const expected = Buffer.from(String(expectedToken ?? ""), "utf8");
	return expected.length > 0
		&& supplied.length === expected.length
		&& timingSafeEqual(supplied, expected)
		? { kind: "master", clientId: null, expiresAt: null }
		: null;
}

function websocketRequestAllowed(req, expectedToken) {
	return websocketRequestPrincipal(req, expectedToken) !== null;
}

function selectAuthenticatedWebSocketProtocol(protocols) {
	return protocols.has("sched-auth") ? "sched-auth" : false;
}


function rejectUnauthorized(res) {
	res.writeHead(401, {
		"content-type": "application/json; charset=utf-8",
		"www-authenticate": "Bearer",
	});
	res.end(JSON.stringify({ ok: false, error: "unauthorized: local bearer token required" }));
}


function guardSameOriginPostRequest(req, res) {
	if (req?.method !== "POST") {
		res.writeHead(405, { "content-type": "application/json; charset=utf-8" });
		res.end(JSON.stringify({ ok: false, error: "method not allowed: POST" }));
		return false;
	}
	if (!sameOriginPostAllowed(req)) {
		res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
		res.end(JSON.stringify({ ok: false, error: "forbidden: exact same-origin loopback request required" }));
		return false;
	}
	return true;
}

function guardMutationRequest(req, res, accessToken) {
	if (!guardSameOriginPostRequest(req, res)) return false;
	if (!bearerRequestAllowed(req, accessToken)) {
		rejectUnauthorized(res);
		return false;
	}
	return true;
}

function remoteShellPath(value) {
	const remotePath = String(value ?? "");
	if (!remotePath || remotePath.includes("\0") || remotePath.includes("\n")) {
		throw new Error("remote inbox path is invalid");
	}
	if (remotePath.startsWith("$HOME/")) return `"$HOME"/${shellQuote(remotePath.slice(6))}`;
	if (remotePath.startsWith("~/")) return `"$HOME"/${shellQuote(remotePath.slice(2))}`;
	return shellQuote(remotePath);
}

function buildRemoteInboxWriteCommand(remotePath) {
	const fileArg = remoteShellPath(remotePath);
	const script = [
		"import os,stat,sys,tempfile,time",
		"target=os.path.abspath(sys.argv[1])",
		"directory=os.path.dirname(target)",
		"os.makedirs(directory,mode=0o700,exist_ok=True)",
		"os.chmod(directory,0o700)",
		"fd,tmp=tempfile.mkstemp(prefix='.'+os.path.basename(target)+'.',suffix='.tmp',dir=directory)",
		"try:",
		" f=os.fdopen(fd,'wb')",
		" try:",
		"  while True:",
		"   chunk=sys.stdin.buffer.read(65536)",
		"   if not chunk: break",
		"   f.write(chunk)",
		"  os.fchmod(f.fileno(),0o600); f.flush(); os.fsync(f.fileno())",
		" finally: f.close()",
		" os.replace(tmp,target)",
		" dirfd=os.open(directory,os.O_RDONLY|getattr(os,'O_DIRECTORY',0))",
		" try: os.fsync(dirfd)",
		" finally: os.close(dirfd)",
		" cutoff=time.time()-7*24*60*60",
		" for entry in os.scandir(directory):",
		"  if entry.path==target or not entry.name.startswith('nodesched-upload-') or not entry.name.endswith('.json'): continue",
		"  try: info=entry.stat(follow_symlinks=False)",
		"  except OSError: continue",
		"  if stat.S_ISREG(info.st_mode) and info.st_mtime<cutoff:",
		"   try: os.unlink(entry.path)",
		"   except OSError: pass",
		" sys.stdout.write(target+'\\n')",
		"finally:",
		" try: os.unlink(tmp)",
		" except FileNotFoundError: pass",
	].join("\n");
	return `umask 077; python3 -c ${shellQuote(script)} ${fileArg}`;
}

function guardReadRequest(req, res, accessToken) {
	if (req?.method !== "GET" || !loopbackRequestAllowed(req)) {
		res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
		res.end(JSON.stringify({ ok: false, error: "forbidden: loopback Origin/Host required" }));
		return false;
	}
	if (!bearerRequestAllowed(req, accessToken)) {
		rejectUnauthorized(res);
		return false;
	}
	return true;
}

function executeGenericSsh(engine, alias, command, { timeoutMs } = {}) {
	return engine.execOnce(alias, command, timeoutMs);
}

const AUTH_PENDING_CAP = 32;
const AUTH_PROMPT_COUNT_CAP = KEYBOARD_INTERACTIVE_PROMPT_CAP;
const AUTH_EVENT_TEXT_BYTES_CAP = 32 * 1024;

function authEventTextBytes(event) {
	let bytes = 0;
	for (const value of [
		event.alias,
		event.method,
		event.name,
		event.instructions,
		event.lang,
	]) {
		bytes += Buffer.byteLength(String(value ?? ""), "utf8");
	}
	for (const prompt of event.prompts) {
		bytes += Buffer.byteLength(String(prompt.prompt ?? ""), "utf8");
	}
	return bytes;
}

class AuthChallengeBroker {
	constructor({
		timeoutMs = 180_000,
		clock = globalThis,
		hasVisibleAudience = () => false,
		broadcast = () => {},
	} = {}) {
		this.timeoutMs = timeoutMs;
		this.clock = clock;
		this.hasVisibleAudience = hasVisibleAudience;
		this.broadcast = broadcast;
		this.pending = new Map();
		this.sequence = 0;
	}

	request(request = {}) {
		if (!this.hasVisibleAudience()) {
			return Promise.reject(new Error("SSH authentication requires a visible dashboard audience"));
		}
		const now = typeof this.clock.now === "function" ? this.clock.now() : Date.now();
		const requestedDeadline = Number(request.deadlineAt);
		const deadlineAt = Number.isFinite(requestedDeadline)
			? Math.min(now + this.timeoutMs, requestedDeadline)
			: now + this.timeoutMs;
		if (request.signal?.aborted) {
			return Promise.resolve({
				state: request.signal.reason?.code === "SSH_INTERACTIVE_AUTH_DEADLINE"
					? "expired"
					: "cancelled",
			});
		}
		if (deadlineAt <= now) return Promise.resolve({ state: "expired" });
		if (this.pending.size >= AUTH_PENDING_CAP) {
			return Promise.reject(new Error(`SSH authentication pending challenge cap (${AUTH_PENDING_CAP}) reached`));
		}
		if (Array.isArray(request.prompts) && request.prompts.length > AUTH_PROMPT_COUNT_CAP) {
			return Promise.reject(new Error(`SSH authentication prompt count cap (${AUTH_PROMPT_COUNT_CAP}) exceeded`));
		}
		const prompts = normalizeKeyboardInteractivePrompts(request.prompts);
		const event = {
			type: "auth",
			alias: String(request.alias ?? ""),
			method: String(request.method ?? "keyboard-interactive").slice(0, 80),
			name: sanitizeLogText(request.name, 200),
			instructions: sanitizeLogText(request.instr, 500),
			lang: sanitizeLogText(request.lang, 80),
			prompts,
		};
		if (authEventTextBytes(event) > AUTH_EVENT_TEXT_BYTES_CAP) {
			return Promise.reject(new Error(`SSH authentication event text cap (${AUTH_EVENT_TEXT_BYTES_CAP} bytes) exceeded`));
		}
		const id = `a${now.toString(36)}${(++this.sequence).toString(36)}`;
		event.id = id;
		return new Promise((resolve, reject) => {
			const timer = this.clock.setTimeout(
				() => this.finish(id, "expired"),
				Math.max(0, deadlineAt - now),
			);
			const onAbort = () => {
				const state = request.signal?.reason?.code === "SSH_INTERACTIVE_AUTH_DEADLINE"
					? "expired"
					: "cancelled";
				this.finish(id, state);
			};
			this.pending.set(id, {
				resolve,
				timer,
				promptCount: prompts.length,
				event,
				signal: request.signal,
				onAbort,
			});
			request.signal?.addEventListener("abort", onAbort, { once: true });
			try {
				this.broadcast(event);
			} catch (error) {
				this.clock.clearTimeout(timer);
				request.signal?.removeEventListener("abort", onAbort);
				this.pending.delete(id);
				reject(error);
			}
		});
	}

	finish(id, state, answers) {
		const pending = this.pending.get(id);
		if (!pending) return false;
		this.pending.delete(id);
		this.clock.clearTimeout(pending.timer);
		pending.signal?.removeEventListener("abort", pending.onAbort);
		const terminalState = state === "answered" ? "resolved" : state;
		const outcome = state === "answered"
			? { state: "answered", answers }
			: { state };
		try {
			this.broadcast({ type: "auth", id, state: terminalState });
		} catch {
			// The SSH waiter must settle even if every dashboard disappeared.
		} finally {
			pending.resolve(outcome);
		}
		return true;
	}

	answer(id, answers) {
		const pending = this.pending.get(id);
		if (!pending) throw new Error("authentication challenge does not exist or has expired");
		if (!Array.isArray(answers) || answers.length !== pending.promptCount) {
			throw new Error("authentication answer count mismatch");
		}
		return this.finish(id, "answered", answers.map((value) => String(value ?? "").slice(0, 4096)));
	}

	cancel(id) {
		if (!this.finish(id, "cancelled")) {
			throw new Error("authentication challenge does not exist or has expired");
		}
	}

	cancelAll() {
		for (const id of [...this.pending.keys()]) this.finish(id, "cancelled");
	}

	/** Cancel every pending challenge that targets one of the given aliases.
	 * Transport switches invalidate the connections these challenges were
	 * authenticating; without this, a stale modal lingers until its 180s
	 * deadline for a host the dashboard is no longer using. */
	cancelAllForAliases(aliases) {
		const wanted = new Set((Array.isArray(aliases) ? aliases : [])
			.filter((alias) => typeof alias === "string" && alias)
			.map((alias) => String(alias)));
		if (wanted.size === 0) return [];
		const cancelled = [];
		for (const [id, pending] of [...this.pending]) {
			if (!wanted.has(pending.event.alias)) continue;
			if (this.finish(id, "cancelled")) cancelled.push(id);
		}
		return cancelled;
	}

	pendingIds() {
		return [...this.pending.keys()];
	}

	replay(send) {
		for (const pending of this.pending.values()) send(pending.event);
	}

	audienceDisconnected() {
		// Pending challenges live until their absolute deadline and can be replayed.
	}
}

function shellQuote(s) {
	return `'${String(s).replaceAll("'", `'\\''`)}'`;
}

function clamp(n, lo, hi) {
	const value = Number(n);
	if (!Number.isFinite(value)) return lo;
	return Math.min(Math.max(Math.trunc(value), lo), hi);
}

function clip(text, max = 20_000) {
	const output = { text: "", bytes: 0, droppedBytes: 0, truncated: false };
	appendLimitedOutput(output, Buffer.from(String(text ?? ""), "utf8"), max);
	finalizeLimitedOutput(output);
	return limitedOutputText(output);
}
function safeError(error, maxChars = 300) {
	const message = String(error?.message ?? error);
	const withoutPaths = message.replace(
		/(^|[\s:(\"'])((?:\/(?:Users|home|private|tmp|var|opt|Volumes|usr|root|etc|workspace)\/|[A-Za-z]:[\\/])[^\s"'`)\]}]*)/g,
		(_, lead) => `${lead}[path]`,
	);
	return sanitizeLogText(withoutPaths, maxChars);
}

/** Uniform tool result envelope: human-readable text + optional parsed JSON. */
function envelope(res, { json = true } = {}) {
	// ok/code always preserved — HTTP routes branch on them.
	if (!res.ok) {
		return { ok: false, code: res.code, text: clip(`[error exit=${res.code}] ${(res.stderr || res.stdout || "(no output)").trim()}`), raw: undefined };
	}
	const body = (res.stdout ?? "").trim();
	if (!json) return { ok: true, code: res.code, text: clip(body || "(no output)"), raw: undefined };
	const parsed = (() => { try { return JSON.parse(body); } catch { return undefined; } })();
	return {
		ok: true, code: res.code,
		text: clip(parsed ? JSON.stringify(parsed, null, 1) : (body || "(no output)")),
		raw: parsed,
	};
}

const STATUS_TOP_LEVEL_KEYS = new Set([
	"schema_version",
	"limit",
	"truncated",
	"next_cursor",
	"next_job_cursor",
	"daemon_health",
	"batches",
	"jobs",
	"gpus",
	"cpu",
	"host_memory",
]);
const STATUS_BATCH_KEYS = new Set([
	"id",
	"name",
	"batch_id",
	"batch_name",
	"mode",
	"status",
	"depends_on",
	"progress",
	"project",
	"revision",
]);
const STATUS_JOB_KEYS = new Set([
	"id",
	"batch_id",
	"batch_name",
	"task",
	"status",
	"wait_reason",
	"gpu",
	"version",
	"resources",
	"retries",
	"failure",
	"started_at",
	"finished_at",
	"progress",
]);
const STATUS_GPU_KEYS = new Set(["idx", "status", "job", "quarantined", "revision", "assignments"]);
const STATUS_BATCH_STATES = new Set(["queued", "active", "blocked", "done", "cancelled", "discarded"]);
const STATUS_JOB_STATES = new Set([
	"pending",
	"running",
	"done",
	"skip",
	"failed",
	"blocked",
	"cancelled",
	"timed_out",
	"interrupted",
]);
const STATUS_GPU_STATES = new Set(["free", "assigned", "releasing", "unmanaged"]);

function statusRecord(value, label) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError(`${label} is not a canonical object`);
	}
	return value;
}

function statusText(value, label, { nullable = false, max = 256 } = {}) {
	if (nullable && value === null) return null;
	if (typeof value !== "string" || value.length < 1 || value.length > max || /[\0-\x1f\x7f]/.test(value)) {
		throw new TypeError(`${label} is not canonical text`);
	}
	return value;
}

function statusKnownKeys(value, allowed, label) {
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) throw new TypeError(`${label} contains unsupported field ${key}`);
	}
}

function canonicalStatusDocument(document) {
	statusRecord(document, "status");
	statusKnownKeys(document, STATUS_TOP_LEVEL_KEYS, "status");
	if (document.schema_version !== 1) throw new TypeError("status schema_version must be 1");
	if (!Number.isInteger(document.limit) || document.limit < 1 || document.limit > 1000) {
		throw new TypeError("status limit is invalid");
	}
	const truncated = statusRecord(document.truncated, "status.truncated");
	statusKnownKeys(truncated, new Set(["batches", "jobs"]), "status.truncated");
	if (typeof truncated.batches !== "boolean" || typeof truncated.jobs !== "boolean") {
		throw new TypeError("status truncation flags are invalid");
	}
	for (const [field, isTruncated] of [
		["next_cursor", truncated.batches],
		["next_job_cursor", truncated.jobs],
	]) {
		if (isTruncated) {
			statusText(document[field], `status.${field}`, { max: 1024 });
		} else if (document[field] !== null) {
			throw new TypeError(`status.${field} must be null when its page is complete`);
		}
	}
	for (const field of ["batches", "jobs"]) {
		if (!Array.isArray(document[field]) || document[field].length > document.limit) {
			throw new TypeError(`status ${field} is invalid`);
		}
	}
	if (!Array.isArray(document.gpus) || document.gpus.length > 1024) {
		throw new TypeError("status gpus is invalid");
	}

	const batchNames = new Map();
	for (const [index, batch] of document.batches.entries()) {
		statusRecord(batch, `status.batches[${index}]`);
		statusKnownKeys(batch, STATUS_BATCH_KEYS, `status.batches[${index}]`);
		const id = statusText(batch.id, `status.batches[${index}].id`);
		const name = statusText(batch.name, `status.batches[${index}].name`);
		if (batch.batch_id !== id || batch.batch_name !== name) {
			throw new TypeError(`status.batches[${index}] identity is inconsistent`);
		}
		if (batchNames.has(id)) throw new TypeError(`status has duplicate batch id ${id}`);
		if (!STATUS_BATCH_STATES.has(batch.status)) throw new TypeError(`status batch state ${batch.status} is unknown`);
		if (!Number.isInteger(batch.revision) || batch.revision < 0) {
			throw new TypeError(`status.batches[${index}].revision is invalid`);
		}
		if (!Array.isArray(batch.depends_on)) {
			throw new TypeError(`status.batches[${index}].depends_on is invalid`);
		}
		for (const dependency of batch.depends_on) statusText(dependency, `status.batches[${index}].depends_on`);
		statusText(batch.progress, `status.batches[${index}].progress`, { max: 64 });
		batchNames.set(id, name);
	}

	const jobIds = new Set();
	for (const [index, job] of document.jobs.entries()) {
		statusRecord(job, `status.jobs[${index}]`);
		statusKnownKeys(job, STATUS_JOB_KEYS, `status.jobs[${index}]`);
		const id = statusText(job.id, `status.jobs[${index}].id`, { max: 512 });
		const batchId = statusText(job.batch_id, `status.jobs[${index}].batch_id`);
		const batchName = statusText(job.batch_name, `status.jobs[${index}].batch_name`);
		statusText(job.task, `status.jobs[${index}].task`);
		if (jobIds.has(id)) throw new TypeError(`status has duplicate job id ${id}`);
		if (batchNames.get(batchId) !== batchName) {
			throw new TypeError(`status.jobs[${index}] refers to an absent or mismatched batch`);
		}
		if (!Number.isInteger(job.version) || job.version < 1) {
			throw new TypeError(`status.jobs[${index}].version is invalid`);
		}
		if (!STATUS_JOB_STATES.has(job.status)) throw new TypeError(`status job state ${job.status} is unknown`);
		if (job.wait_reason !== null && !["quota", "dependency", "project_gpu_disabled", "cpu", "host_memory", "gpu", "parallel", "draining", "batch_blocked"].includes(job.wait_reason)) {
			throw new TypeError(`status.jobs[${index}].wait_reason is invalid`);
		}
		jobIds.add(id);
	}

	const gpuIds = new Set();
	for (const [index, gpu] of document.gpus.entries()) {
		statusRecord(gpu, `status.gpus[${index}]`);
		statusKnownKeys(gpu, STATUS_GPU_KEYS, `status.gpus[${index}]`);
		if (!Number.isInteger(gpu.idx) || gpu.idx < 0 || gpuIds.has(gpu.idx)) {
			throw new TypeError(`status.gpus[${index}].idx is invalid`);
		}
		if (
			!STATUS_GPU_STATES.has(gpu.status)
			|| ![0, 1].includes(gpu.quarantined)
			|| !Number.isInteger(gpu.revision)
			|| gpu.revision < 0
		) {
			throw new TypeError(`status.gpus[${index}] state is invalid`);
		}
		if (gpu.job !== null) statusText(gpu.job, `status.gpus[${index}].job`, { max: 512 });
		try {
			canonicalGpuAssignments(gpu.assignments);
		} catch (error) {
			throw new TypeError(`status.gpus[${index}].assignments is invalid: ${error.message}`);
		}
		gpuIds.add(gpu.idx);
	}
	if (document.cpu !== undefined) {
		const cpu = statusRecord(document.cpu, "status.cpu");
		statusKnownKeys(cpu, new Set(["used", "total"]), "status.cpu");
		if (![cpu.used, cpu.total].every((value) => Number.isInteger(value) && value >= 0)) {
			throw new TypeError("status.cpu is invalid");
		}
	}
	if (document.host_memory !== undefined) {
		const memory = statusRecord(document.host_memory, "status.host_memory");
		statusKnownKeys(memory, new Set(["used_gib", "total_gib", "reserve_gib", "default_job_gib", "available_gib"]), "status.host_memory");
		for (const key of ["used_gib", "total_gib", "reserve_gib", "default_job_gib", "available_gib"]) {
			if (key === "available_gib" && memory[key] === null) continue;
			if (typeof memory[key] !== "number" || !Number.isFinite(memory[key]) || memory[key] < 0
				|| (["total_gib", "default_job_gib"].includes(key) && memory[key] === 0)) {
				throw new TypeError(`status.host_memory.${key} is invalid`);
			}
		}
	}
	if (document.daemon_health !== undefined) {
		const health = statusRecord(document.daemon_health, "status.daemon_health");
		if (Object.keys(health).length > 32) throw new TypeError("status.daemon_health is too large");
		for (const value of Object.values(health)) {
			if (value !== null && !["string", "number", "boolean"].includes(typeof value)) {
				throw new TypeError("status.daemon_health contains a non-scalar field");
			}
		}
	}
	return document;
}
function mutationPreconditionError(message, httpStatus = 409) {
	const error = new Error(message);
	error.httpStatus = httpStatus;
	return error;
}

function assertMutationPreconditions(document, precondition = { kind: "none" }) {
	const canonical = canonicalStatusDocument(document);
	const kind = String(precondition?.kind ?? "none");
	if (kind === "none") return canonical;
	const id = String(precondition?.id ?? "");
	const expectedStatus = precondition?.expectedStatus;
	if (
		!id
		|| typeof expectedStatus !== "string"
		|| !expectedStatus
		|| !Number.isInteger(precondition.expectedRevision)
		|| precondition.expectedRevision < 0
	) {
		throw mutationPreconditionError("mutation requires an exact id, status, and revision", 400);
	}
	if (kind === "batch") {
		const batch = canonical.batches.find((candidate) => candidate.id === id);
		if (!batch) {
			const detail = canonical.truncated.batches ? "status page is truncated" : "batch is absent";
			throw mutationPreconditionError(`batch precondition failed: ${detail}`);
		}
		if (batch.status !== expectedStatus || batch.revision !== precondition.expectedRevision) {
			throw mutationPreconditionError(
				`batch precondition changed: expected ${expectedStatus} revision ${precondition.expectedRevision},`
				+ ` found ${batch.status} revision ${batch.revision}`,
			);
		}
		return canonical;
	}
	if (kind === "task") {
		if (!Number.isInteger(precondition.expectedVersion) || precondition.expectedVersion < 1) {
			throw mutationPreconditionError("task mutation requires an exact expected version", 400);
		}
		const task = canonical.jobs.find(
			(candidate) => `${candidate.batch_id}:${candidate.task}` === id,
		);
		if (!task) {
			const detail = canonical.truncated.jobs ? "status page is truncated" : "task is absent";
			throw mutationPreconditionError(`task precondition failed: ${detail}`);
		}
		const batch = canonical.batches.find((candidate) => candidate.id === task.batch_id);
		if (
			task.status !== expectedStatus
			|| task.version !== precondition.expectedVersion
			|| batch?.revision !== precondition.expectedRevision
		) {
			throw mutationPreconditionError(
				`task precondition changed: expected ${expectedStatus} v${precondition.expectedVersion}`
				+ ` revision ${precondition.expectedRevision}, found ${task.status} v${task.version}`
				+ ` revision ${batch?.revision ?? "absent"}`,
			);
		}
		return canonical;
	}
	if (kind === "gpu") {
		const gpu = canonical.gpus.find((candidate) => String(candidate.idx) === id);
		if (!gpu) throw mutationPreconditionError("GPU precondition failed: GPU is absent");
		let expectedAssignments;
		try {
			expectedAssignments = canonicalGpuAssignments(precondition.expectedAssignments);
		} catch (error) {
			throw mutationPreconditionError(error.message, 400);
		}
		if (
			gpu.status !== expectedStatus
			|| gpu.revision !== precondition.expectedRevision
			|| JSON.stringify(gpu.assignments) !== JSON.stringify(expectedAssignments)
			|| (
				precondition.expectedQuarantined !== undefined
				&& gpu.quarantined !== precondition.expectedQuarantined
			)
		) {
			throw mutationPreconditionError(
				`GPU precondition changed: expected status ${expectedStatus}`
				+ ` revision ${precondition.expectedRevision}`
				+ (
					precondition.expectedQuarantined === undefined
						? ""
						: ` quarantine ${precondition.expectedQuarantined}`
				)
				+ ` assignments ${JSON.stringify(expectedAssignments)}, found ${gpu.status}`
				+ ` revision ${gpu.revision} quarantine ${gpu.quarantined}`
				+ ` assignments ${JSON.stringify(gpu.assignments)}`,
			);
		}
		return canonical;
	}
	throw mutationPreconditionError(`unsupported mutation precondition kind: ${kind}`, 400);
}

function isCanonicalStatusDocument(document) {
	try {
		canonicalStatusDocument(document);
		return true;
	} catch {
		return false;
	}
}

async function collectWriterStatusPages(fetchPage, {
	target,
	maxPages = 100,
} = {}) {
	if (typeof fetchPage !== "function") throw new Error("status page loader is required");
	if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100) {
		throw new Error("status paging limit must be between 1 and 100");
	}
	const batches = new Map();
	const jobs = new Map();
	const taskRefs = new Map();
	const seenBatchCursors = new Set();
	let first;
	let gpuSnapshot;
	let targetPage;
	let batchCursor = null;
	let calls = 0;
	do {
		const batchCursorKey = batchCursor ?? "";
		if (seenBatchCursors.has(batchCursorKey)) throw new Error("status batch cursor loop");
		seenBatchCursors.add(batchCursorKey);
		const seenJobCursors = new Set();
		let jobCursor = null;
		let batchPage;
		let batchSnapshot;
		do {
			const jobCursorKey = jobCursor ?? "";
			if (seenJobCursors.has(jobCursorKey)) throw new Error("status job cursor loop");
			seenJobCursors.add(jobCursorKey);
			if (++calls > maxPages) throw new Error("status paging limit exceeded");
			const page = canonicalStatusDocument(await fetchPage({
				cursor: batchCursor,
				jobCursor,
			}));
			if (first === undefined) {
				first = page;
				gpuSnapshot = JSON.stringify(page.gpus);
			} else if (JSON.stringify(page.gpus) !== gpuSnapshot) {
				throw new Error("status GPUs changed during paging");
			}
			if (batchPage === undefined) {
				batchPage = page;
				batchSnapshot = JSON.stringify(page.batches);
			} else if (JSON.stringify(page.batches) !== batchSnapshot) {
				throw new Error("status batches changed during job paging");
			}
			for (const batch of page.batches) {
				const previous = batches.get(batch.id);
				if (previous && JSON.stringify(previous) !== JSON.stringify(batch)) {
					throw new Error(`batch ${batch.id} changed during paging`);
				}
				batches.set(batch.id, batch);
				if (target?.kind === "batch" && batch.id === target.id) targetPage ??= page;
			}
			for (const job of page.jobs) {
				const previous = jobs.get(job.id);
				if (previous && JSON.stringify(previous) !== JSON.stringify(job)) {
					throw new Error(`job ${job.id} changed during paging`);
				}
				const ref = `${job.batch_id}:${job.task}`;
				const previousRef = taskRefs.get(ref);
				if (previousRef && JSON.stringify(previousRef) !== JSON.stringify(job)) {
					throw new Error(`task ${ref} changed during paging`);
				}
				jobs.set(job.id, job);
				taskRefs.set(ref, job);
				if (target?.kind === "task" && ref === target.id) targetPage ??= page;
			}
			jobCursor = page.truncated.jobs ? page.next_job_cursor : null;
		} while (jobCursor !== null);
		batchCursor = batchPage.truncated.batches ? batchPage.next_cursor : null;
	} while (batchCursor !== null);
	return {
		first,
		targetPage,
		batches: [...batches.values()],
		jobs: [...jobs.values()],
	};
}

/** Condensed current-status summary. */
function summarizeStatus(document) {
	const canonical = canonicalStatusDocument(document);
	const batches = canonical.batches;
	const jobs = canonical.jobs;
	const terminalBatchStatuses = new Set(["done", "cancelled", "discarded"]);
	const knownBatchStatuses = new Set(["queued", "active", "blocked", ...terminalBatchStatuses]);
	const active = batches.filter((batch) => !terminalBatchStatuses.has(batch.status));
	const batchCount = canonical.truncated.batches
		? `${batches.length} shown on this page (more pages available)`
		: `${batches.length} total`;
	const batchBreakdown = canonical.truncated.batches
		? `${batches.length - active.length} terminal shown, ${active.length} active/blocked shown`
		: `${batches.length - active.length} terminal, ${active.length} active/blocked`;
	const lines = [
		`batches: ${batchCount} (${batchBreakdown})`,
	];
	for (const batch of active) {
		const status = knownBatchStatuses.has(batch.status) ? batch.status : `${batch.status} unknown`;
		lines.push(`  batch ${batch.name ?? batch.batch_name} [${status}] ${batch.progress ?? ""}${batch.depends_on?.length ? ` dep=[${batch.depends_on.join(",")}]` : ""}`);
	}
	const knownJobStatuses = new Set([
		"pending",
		"running",
		"done",
		"skip",
		"failed",
		"blocked",
		"cancelled",
		"timed_out",
		"interrupted",
	]);
	const live = jobs.filter((job) => job.status === "pending" || job.status === "running");
	const byStatus = {};
	for (const job of jobs) byStatus[job.status] = (byStatus[job.status] ?? 0) + 1;
	const jobsScoped = canonical.truncated.batches || canonical.truncated.jobs;
	const jobCount = jobsScoped
		? `${jobs.length} shown in current scope/page`
			+ (canonical.truncated.jobs ? " (more job pages available)" : " (more batch pages available)")
		: `${jobs.length} total`;
	const liveLabel = jobsScoped ? `${live.length} shown` : String(live.length);
	const statusLabel = jobsScoped ? "by-status shown" : "by-status";
	lines.push(`jobs: ${jobCount} — live ${liveLabel}, ${statusLabel} ${JSON.stringify(byStatus)}`);
	for (const job of jobs.slice(0, 50)) {
		if (!(job.status === "pending" || job.status === "running") && knownJobStatuses.has(job.status)) continue;
		const status = knownJobStatuses.has(job.status) ? job.status : `${job.status} unknown`;
		const batch = job.batch_id ?? "?";
		lines.push(`  job ${batch}:${job.task} [${status}]${job.wait_reason ? ` wait_reason=${job.wait_reason}` : ""}${job.gpu != null ? ` gpu=${job.gpu}` : ""}${job.started_at ? ` since ${job.started_at}` : ""}`);
	}
	for (const gpu of canonical.gpus) {
		const assignments = gpu.assignments.length > 0
			? ` assignments=${JSON.stringify(gpu.assignments)}`
			: "";
		lines.push(`  gpu${gpu.idx} [${gpu.status}]${assignments}${gpu.quarantined ? " QUARANTINED" : ""}`);
	}
	if (canonical.cpu) lines.push(`cpu reserved: ${canonical.cpu.used}${canonical.cpu.total ? ` / ${canonical.cpu.total} cores` : " (no cap)"} (not measured utilization)`);
	if (canonical.host_memory) {
		const m = canonical.host_memory;
		lines.push(`host memory reserved: ${m.used_gib} / ${m.total_gib} GiB; node available: ${m.available_gib === null ? "unknown" : m.available_gib.toFixed(1) + " GiB"}`);
	}
	if (canonical.daemon_health?.draining) lines.push("dispatch paused (draining)");
	return lines.join("\n");
}

const HISTORY_TOP_LEVEL_KEYS = new Set([
	"schema_version",
	"history",
	"limit",
	"truncated",
	"next_cursor",
]);
const HISTORY_ROW_KEYS = new Set([
	"id",
	"batch_id",
	"batch_name",
	"task",
	"status",
	"version",
	"rc",
	"gpu",
	"started_at",
	"finished_at",
	"duration_seconds",
	"failure",
]);

function canonicalHistoryDocument(document) {
	statusRecord(document, "history");
	statusKnownKeys(document, HISTORY_TOP_LEVEL_KEYS, "history");
	if (
		document.schema_version !== 1
		|| !Number.isInteger(document.limit)
		|| document.limit < 1
		|| document.limit > 200
		|| typeof document.truncated !== "boolean"
		|| !Array.isArray(document.history)
		|| document.history.length > document.limit
	) {
		throw new TypeError("history envelope is invalid");
	}
	if (document.truncated) {
		statusText(document.next_cursor, "history.next_cursor", { max: 1024 });
	} else if (document.next_cursor !== null) {
		throw new TypeError("history.next_cursor must be null on the final page");
	}
	const ids = new Set();
	for (const [index, row] of document.history.entries()) {
		statusRecord(row, `history.history[${index}]`);
		statusKnownKeys(row, HISTORY_ROW_KEYS, `history.history[${index}]`);
		const id = statusText(row.id, `history.history[${index}].id`, { max: 512 });
		statusText(row.batch_id, `history.history[${index}].batch_id`, { max: 512 });
		statusText(row.batch_name, `history.history[${index}].batch_name`, { max: 512 });
		statusText(row.task, `history.history[${index}].task`, { max: 512 });
		if (ids.has(id)) throw new TypeError(`history has duplicate id ${id}`);
		if (!STATUS_JOB_STATES.has(row.status) || !Number.isInteger(row.version) || row.version < 1) {
			throw new TypeError(`history.history[${index}] status/version is invalid`);
		}
		for (const field of ["started_at", "finished_at", "failure"]) {
			if (row[field] !== null) statusText(row[field], `history.history[${index}].${field}`, { max: 4096 });
		}
		if (
			row.duration_seconds !== null
			&& (typeof row.duration_seconds !== "number" || !Number.isFinite(row.duration_seconds) || row.duration_seconds < 0)
		) {
			throw new TypeError(`history.history[${index}].duration_seconds is invalid`);
		}
		if (row.rc !== null && !Number.isInteger(row.rc)) {
			throw new TypeError(`history.history[${index}].rc is invalid`);
		}
		ids.add(id);
	}
	return document;
}

async function serveTerminalWebSocket({
	ws,
	clients,
	slots,
	maxSlots = 4,
	opening: reservedOpening,
	openShell,
	openDeadlineAt,
	alias,
	cols,
	rows,
}) {
	const HIGH_WATER = 1024 * 1024;
	const LOW_WATER = 512 * 1024;
	let session;
	let drainTimer;
	let paused = false;
	let cleaned = false;
	let sessionClosed = false;
	let openSettled = false;
	const outputDecoder = new StringDecoder("utf8");
	const opening = reservedOpening ?? beginPendingOpen(slots, maxSlots);
	if (!opening) {
		try { ws.close(1013, "too many terminal sessions"); } catch { /* gone */ }
		return false;
	}
	const { controller } = opening;
	const closeSession = () => {
		if (!session || sessionClosed) return;
		sessionClosed = true;
		try { session.close(); } catch { /* already closed */ }
	};
	const cleanup = () => {
		if (!cleaned) {
			cleaned = true;
			controller.abort(new Error("terminal websocket closed"));
			clearInterval(drainTimer);
			clients.delete(ws);
			if (openSettled) opening.settle();
		}
		closeSession();
	};
	clients.add(ws);
	ws.on("close", cleanup);
	ws.on("error", cleanup);
	if (ws.readyState !== ws.OPEN) {
		cleanup();
		openSettled = true;
		opening.settle();
		return false;
	}
	try {
		session = await openShell(alias, { cols, rows }, {
			signal: controller.signal,
			deadlineAt: openDeadlineAt,
		});
		openSettled = true;
		if (cleaned || ws.readyState !== ws.OPEN) {
			cleanup();
			return;
		}
		const maybePause = () => {
			if (ws.bufferedAmount > 4 * 1024 * 1024) {
				try { ws.close(1009, "terminal output buffer exceeded"); } catch { /* gone */ }
				return;
			}
			const over = ws.bufferedAmount > HIGH_WATER;
			if (over && !paused) {
				paused = true;
				session.pause?.();
			} else if (ws.bufferedAmount < LOW_WATER && paused) {
				paused = false;
				session.resume?.();
			}
		};
		drainTimer = setInterval(maybePause, 50);
		drainTimer.unref?.();
		ws.send(JSON.stringify({ type: "ready", alias }));
		const sendOutput = (text) => {
			const buffer = Buffer.from(text, "utf8");
			for (let offset = 0; offset < buffer.length;) {
				let end = Math.min(offset + 64 * 1024, buffer.length);
				if (end < buffer.length) {
					while (end > offset && (buffer[end] & 0xc0) === 0x80) end -= 1;
				}
				if (end === offset) end = Math.min(offset + 64 * 1024, buffer.length);
				ws.send(JSON.stringify({
					type: "output",
					data: buffer.subarray(offset, end).toString("utf8"),
				}));
				offset = end;
			}
		};
		session.onData = (data) => {
			if (ws.readyState !== ws.OPEN) return;
			const buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8");
			sendOutput(outputDecoder.write(buffer));
			maybePause();
		};
		session.onExit = (code, error) => {
			try {
				sendOutput(outputDecoder.end());
				ws.send(JSON.stringify({
					type: "exit",
					code,
					error: error ? safeError(error) : undefined,
				}));
			} catch { /* gone */ }
			try { ws.close(); } catch { /* gone */ }
		};
		let messageWindowAt = Date.now();
		let messageCount = 0;
		ws.on("message", (raw) => {
			const now = Date.now();
			if (now - messageWindowAt >= 1000) {
				messageWindowAt = now;
				messageCount = 0;
			}
			messageCount += 1;
			if (messageCount > 100 || raw.length > 64 * 1024) {
				ws.close(1008, "terminal input rate exceeded");
				return;
			}
			try {
				const frame = JSON.parse(raw.toString());
				if (frame.type === "input") {
					const input = String(frame.data ?? "");
					if (Buffer.byteLength(input, "utf8") > 32 * 1024) {
						ws.close(1009, "terminal input too large");
						return;
					}
					session.send(input);
				} else if (frame.type === "resize") {
					session.resize(
						clamp(parseInt(frame.cols, 10) || 80, 20, 500),
						clamp(parseInt(frame.rows, 10) || 24, 10, 200),
					);
				}
			} catch { /* malformed frame */ }
		});
	} catch (error) {
		cleanup();
		if (ws.readyState === ws.OPEN) {
			try {
				ws.send(JSON.stringify({ type: "exit", code: null, error: safeError(error) }));
				ws.close();
			} catch { /* gone */ }
		}
	} finally {
		openSettled = true;
		if (cleaned || !session || ws.readyState !== ws.OPEN) opening.settle();
	}
	return true;
}

/**
 * @param {import('cordis').Context} ctx
 * @param {{ sshEntry: string, schedBin: string, probeCommand: string, connectTimeoutSec: number, pollFallbackSec: number }} config
 */
/**
 * apply MUST be synchronous: preset standing mounts register model-facing
 * rows during composition, and touching scoped services after an await hits
 * an inactive context ("cannot get required service ... in inactive context").
 * The activation probe therefore runs in the background and degrades loudly
 * instead of failing the mount.
 */
export function assertHostPlatform(platform = process.platform) {
	if (platform !== "linux" && platform !== "darwin") {
		throw new Error("node-sched host requires Linux or macOS for private file permissions and durable directory commits; on Windows, run dsh inside WSL2 with its data in the Linux filesystem.");
	}
}

function apply(ctx, config) {
	assertHostPlatform();
	const accessToken = ctx.webServer ? loadOrCreateAccessToken() : null;
	const browserAuth = ctx.webServer
		? new TrustedBrowserAuth({ masterToken: accessToken })
		: null;
	// ── B24: 内嵌 SSH 引擎（先于 runRemote 创建：绑定后 sched 命令走引擎通道）──
	const sshStore = new HostStore();
	const sshEngine = new SshEngine(sshStore);
	let observedSshStoreGeneration = sshStore.externalGeneration();
	const hostTrustBroker = new HostTrustBroker();
	const localTransport = new LocalTransport();
	/** 绑定的 sched 主机别名；null = 严格复用系统 OpenSSH ControlMaster。 */
	let boundAlias = null;
	/** @type {SystemOpenSshTransport | null} */
	let systemOpenSshTransport = null;
	const entryFile = path.join(os.homedir(), ".dsh", "nodesched_entry.json");
	let transportMode = config.transport === "local" ? "local" : "auto";
	try {
		if (fs.existsSync(entryFile)) {
			const ov = JSON.parse(fs.readFileSync(entryFile, "utf-8"));
			if (ov && (ov.mode === "auto" || ov.mode === "local")) transportMode = ov.mode;
			if (ov && typeof ov.sshEntry === "string" && ov.sshEntry.trim()) {
				config.sshEntry = ov.sshEntry.trim();
				ctx.logger.info("[node-sched] ssh 入口覆盖(持久化): %s", config.sshEntry);
			}
			if (ov && typeof ov.schedAlias === "string" && ov.schedAlias.trim() && transportMode !== "local") {
				boundAlias = ov.schedAlias.trim();
				ctx.logger.info("[node-sched] sched 主机绑定(持久化): %s (引擎模式)", boundAlias);
			}
		}
	} catch (e) {
		ctx.logger.warn("[node-sched] 入口覆盖文件读取失败(忽略): %s", e);
	}
	const useLocalTransport = () => transportMode === "local";
	const persistEntryOverride = (patch) => writeEntryOverride({ fs, file: entryFile, patch });
	const disposeSystemOpenSshTransport = () => {
		try { systemOpenSshTransport?.dispose(); } catch { /* already disposed */ }
		systemOpenSshTransport = null;
	};
	const createSystemOpenSshTransport = (sshEntry) => new SystemOpenSshTransport({
		sshEntry: validateSshEntry(String(sshEntry).trim()),
		connectTimeoutSec: config.connectTimeoutSec,
	});
	const systemOpenSshFor = (sshEntry = config.sshEntry) => {
		const entry = validateSshEntry(String(sshEntry).trim());
		if (systemOpenSshTransport?.sshEntry === entry && !systemOpenSshTransport.disposed) {
			return systemOpenSshTransport;
		}
		disposeSystemOpenSshTransport();
		systemOpenSshTransport = createSystemOpenSshTransport(entry);
		return systemOpenSshTransport;
	};

	// Authentication challenges are independent state machines. A dashboard
	// disconnect does not cancel SSH authentication; the challenge remains
	// replayable until its own deadline.
	let broadcastFn = null;
	let authAudienceAvailable = () => false;
	const authBroker = new AuthChallengeBroker({
		timeoutMs: 180_000,
		hasVisibleAudience: () => authAudienceAvailable(),
		broadcast: (event) => broadcastFn?.(event),
	});
	sshEngine.setInteractivePrompter((request) => authBroker.request(request));
	// Transport switches drop the old alias's connections (dropAlias); cancel
	// its pending challenges too, so a stale "等待输入<old host>" banner cannot
	// linger for up to 3 minutes after switching transports.
	sshEngine.onAliasDrop = (alias) => {
		try { authBroker.cancelAllForAliases([alias]); } catch { /* broker keeps its own invariants */ }
	};

	const runRemoteCli = makeRunner(cp, config);
	/**
	 * 绑定 sched 主机后走内嵌 ssh2 引擎；未绑定时严格复用终端已经认证的
	 * OpenSSH ControlMaster。两种模式都不会相互静默回退。
	 */
	function captureTransportTarget() {
		if (useLocalTransport()) return { mode: "local" };
		if (boundAlias) return { mode: "engine", alias: boundAlias };
		const sshEntry = String(config.sshEntry ?? "").trim();
		try {
			return {
				mode: "system-openssh",
				sshEntry: validateSshEntry(sshEntry),
				transport: systemOpenSshFor(sshEntry),
			};
		} catch (error) {
			// Startup and read paths must degrade visibly on an unsupported platform
			// or malformed persisted entry, so the UI can still select the engine.
			return {
				mode: "system-openssh",
				sshEntry,
				transport: null,
				error,
			};
		}
	}

	function runOnTarget(target, args, opts = {}) {
		if (target.mode === "local") return localTransport.exec(args, opts);
		if (target.mode === "engine") {
			const execute = opts.retryable && typeof sshEngine.execRetryable === "function"
				? sshEngine.execRetryable.bind(sshEngine)
				: sshEngine.execOnce.bind(sshEngine);
			return execute(target.alias, args, opts.timeoutMs, opts).then(
				(result) => ({
					ok: result.success,
					code: result.exitCode ?? -1,
					stdout: result.stdout,
					stderr: result.stderr + (result.error ? `\n${result.error}` : ""),
				}),
				(error) => ({
					ok: false,
					code: -1,
					errorCode: error?.code,
					stdout: "",
					stderr: `[ssh-engine:${target.alias}] ${formatSshError(error)}`,
				}),
			);
		}
		if (target.mode === "system-openssh") {
			const transport = target.transport;
			if (!transport || transport.sshEntry !== target.sshEntry) {
				return Promise.resolve({
					ok: false,
					code: -1,
					stdout: "",
					stderr: `[system-openssh:${target.sshEntry}] ${safeError(target.error || "captured transport is unavailable")}`,
					errorCode: target.error?.code ?? "system_openssh_target_unavailable",
				});
			}
			return transport.exec(args, opts).catch((error) => ({
				ok: false,
				code: -1,
				stdout: "",
				stderr: `[system-openssh:${target.sshEntry}] ${safeError(error)}`,
				errorCode: error?.code,
			}));
		}
		return runRemoteCli(args, { ...opts, sshEntry: target.sshEntry });
	}

	function runRemote(args, opts = {}) {
		return runOnTarget(captureTransportTarget(), args, opts);
	}

	// A screen writer is supported only when both its SSH target and session
	// are explicit deployment configuration. Direct local/engine/ssh writers
	// execute mutations exactly once without this relay.
	const INBOX = "$HOME/.sched/inbox";
	const SCREEN_RESULT_PREFIX_BYTES = 2 * 1024 * 1024;
	const MAX_SCREEN_STUFF_BYTES = 1024;
	let screenExecSeq = 0;
	async function screenExec(cmd, { timeoutMs = 60_000, writer } = {}) {
		if (writer?.mode !== "screen" || !writer.sshEntry || !writer.session) {
			throw new Error("screen mutation writer requires explicit target and session");
		}
		const id = `se${Date.now().toString(36)}${++screenExecSeq}`;
		const out = `${INBOX}/${id}.out`;
		const markerOut = `${INBOX}/${id}.done`;
		const cancelOut = `${INBOX}/${id}.cancel`;
		const remoteOpts = { timeoutMs: 15_000, sshEntry: writer.sshEntry };
		const cleanup = () => runRemoteCli(
			`rm -f ${out} ${markerOut} ${cancelOut}`,
			{ ...remoteOpts, maxOutputBytes: 128 },
		).catch(() => {});
		const wrapped = `{ umask 077; echo "--- begin ${id}"; (${cmd}); rc=$?; if [ ! -e ${cancelOut} ]; then printf "\\n--- end rc=%s id=${id}\\n" "$rc" > ${markerOut}; chmod 600 ${markerOut}; fi; (sleep 60; rm -f ${out} ${markerOut} ${cancelOut}) >/dev/null 2>&1 & } > ${out} 2>&1`;
		const stuff = `umask 077; mkdir -p ${INBOX} && chmod 700 ${INBOX} && rm -f ${out} ${markerOut} ${cancelOut} && ${wrapped}\n`;
		if (Buffer.byteLength(stuff, "utf8") > MAX_SCREEN_STUFF_BYTES) {
			throw new Error(`screenExec command too long (max ${MAX_SCREEN_STUFF_BYTES} bytes)`);
		}
		let started = false;
		let markerSeen = false;
		try {
			const start = await runRemoteCli(
				`screen -S ${shellQuote(writer.session)} -X stuff ${shellQuote(stuff)}`,
				{ ...remoteOpts, maxOutputBytes: 4096 },
			);
			if (!start.ok) {
				throw new Error(`screen stuff failed rc=${start.code}: ${(start.stderr || start.stdout).trim().slice(0, 200)}`);
			}
			started = true;
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 1500));
				const markerResult = await runRemoteCli(
					`cat ${markerOut} 2>/dev/null`,
					{ ...remoteOpts, maxOutputBytes: 1024 },
				);
				const marker = parseScreenEnd(markerResult.stdout, id);
				if (!marker) continue;
				markerSeen = true;
				const prefix = await runRemoteCli(
					`head -c ${SCREEN_RESULT_PREFIX_BYTES} ${out} 2>/dev/null`,
					{ ...remoteOpts, maxOutputBytes: SCREEN_RESULT_PREFIX_BYTES + 1024 },
				);
				if (!prefix.ok) {
					const detail = prefix.stderr || prefix.stdout || `exit ${prefix.code}`;
					return { ok: false, code: marker.code, stdout: "", stderr: detail };
				}
				const sizeResult = await runRemoteCli(
					`wc -c < ${out} 2>/dev/null`,
					{ ...remoteOpts, maxOutputBytes: 128 },
				);
				const outputBytes = Number.parseInt(sizeResult.stdout.trim(), 10);
				const result = parseScreenResult(
					`${prefix.stdout}\n--- end rc=${marker.code} id=${id}\n`,
					id,
				);
				if (!result) {
					return {
						ok: false,
						code: marker.code,
						stdout: prefix.stdout,
						stderr: "screen output framing invalid",
					};
				}
				if (Number.isFinite(outputBytes) && outputBytes > SCREEN_RESULT_PREFIX_BYTES) {
					result.stdout += `\n…[truncated ${outputBytes - SCREEN_RESULT_PREFIX_BYTES} bytes]`;
				}
				return result;
			}
			throw new Error(`screenExec timed out after ${timeoutMs}ms`);
		} finally {
			if (!started || markerSeen) {
				await cleanup();
			} else {
				await runRemoteCli(`touch ${cancelOut}`, { ...remoteOpts, maxOutputBytes: 128 }).catch(() => {});
			}
		}
	}
	const gate = new WriteGate();
	let auditSeq = 0;

	const S = config.schedBin;

	function configuredMutationWriter() {
		const expectedNode = String(config.mutationExpectedNode ?? "").trim();
		if (!expectedNode) throw new Error("mutationExpectedNode is required for an enabled mutation writer");
		switch (config.mutationMode) {
			case "local":
				return { mode: "local", expectedNode };
			case "engine": {
				const alias = String(config.mutationTarget ?? "").trim();
				if (!alias) throw new Error("engine mutation writer requires mutationTarget");
				return { mode: "engine", alias, expectedNode };
			}
			case "ssh": {
				const sshEntry = String(config.mutationTarget ?? "").trim();
				if (!sshEntry) throw new Error("ssh mutation writer requires mutationTarget");
				return { mode: "cli", sshEntry, expectedNode };
			}
			case "screen": {
				const sshEntry = String(config.mutationTarget ?? "").trim();
				const session = String(config.mutationSession ?? "").trim();
				if (!sshEntry || !session) throw new Error("screen mutation writer requires mutationTarget and mutationSession");
				return { mode: "screen", sshEntry, session, expectedNode };
			}
			default:
				throw new Error("explicit mutation writer is disabled");
		}
	}

	function writerTransportTarget(writer) {
		return writer.mode === "screen"
			? { mode: "cli", sshEntry: writer.sshEntry }
			: writer;
	}

	async function executeWriterRead(writer, command, timeoutMs = 30_000) {
		if (writer.mode === "screen") return screenExec(command, { timeoutMs, writer });
		return runOnTarget(writer, command, { timeoutMs, retryable: true });
	}

	async function executeWriterMutation(writer, command, timeoutMs) {
		if (writer.mode === "screen") return screenExec(command, { timeoutMs, writer });
		return runOnTarget(writer, command, { timeoutMs, retryable: false });
	}


	// ── Activation probe (background): loud degradation on entry/network mismatch. ──
	let probeOk = false;
	runRemote(`${S} ${config.probeCommand}`, { timeoutMs: config.connectTimeoutSec * 2000 })
		.then((probe) => {
			if (!probe.ok) {
				ctx.logger.error(
					"[node-sched] PROBE FAILED via ssh entry \"%s\" (code %d) — check network environment " +
						"and the configured alias before retrying (HPDC uses ssh HPDC). stderr: %s",
					config.sshEntry, probe.code, (probe.stderr || "").trim().slice(0, 400),
				);
				return;
			}
			probeOk = true;
			ctx.logger.info("[node-sched] probe ok via %s", config.sshEntry);
		});

	/** Read-only remote query; only this path may retry transient failures. */
	async function query(args, opts = {}) {
		opts.signal?.throwIfAborted();
		const target = opts.target ?? captureTransportTarget();
		const runOpts = {
			...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
			signal: opts.signal,
			retryable: true,
		};
		let res = await runOnTarget(target, args, runOpts);
		opts.signal?.throwIfAborted();
		if (target.mode === "cli" && !res.ok && isTransientSshError(res.stderr)) {
			res = await runOnTarget(target, args, runOpts);
		}
		opts.signal?.throwIfAborted();
		return envelope(res, opts);
	}

	/**
	 * Side-effectful operation. The explicit writer is attested immediately
	 * before the exactly-once command; no identity result is cached.
	 */
	async function operate(
		key,
		args,
		{
			timeoutMs,
			preflight,
			precondition = { kind: "none" },
			prepare,
			requestId,
		} = {},
	) {
		try {
			if (typeof requestId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(requestId)) {
				const error = new Error("valid requestId is required for every scheduler mutation");
				error.httpStatus = 400;
				throw error;
			}
			return await gate.run(key, async () => {
				const configuredWriter = configuredMutationWriter();
				const result = await verifyAndExecuteMutation({
					configuredWriter,
					command: args,
					timeoutMs,
					schedBin: S,
					executeRead: executeWriterRead,
					prepare,
					preflight: async (writer, preflightTimeoutMs) => {
						const pageTimeoutMs = preflightTimeoutMs ?? 30_000;
						const fetchPage = async ({ cursor = null, jobCursor = null } = {}) => {
							const rawStatus = await executeWriterRead(
								writer,
								buildStatusCommand({
									schedBin: S,
									limit: 1000,
									cursor,
									jobCursor,
								}),
								pageTimeoutMs,
							);
							const status = envelope(rawStatus);
							if (!status.ok) {
								throw new Error(status.text || "status command failed");
							}
							return status.raw;
						};
						let statusDocument;
						try {
							const kind = String(precondition?.kind ?? "none");
							if (kind === "batch" || kind === "task") {
								const pages = await collectWriterStatusPages(fetchPage, {
									target: precondition,
									maxPages: 100,
								});
								statusDocument = pages.targetPage ?? pages.first;
							} else {
								statusDocument = canonicalStatusDocument(await fetchPage());
							}
						} catch (cause) {
							const error = new Error(
								`writer status preflight unavailable: ${cause?.message || "invalid status document"}`,
							);
							error.httpStatus = 503;
							throw error;
						}
						// sched request checks its durable receipt before atomically
						// comparing preconditions. Comparing them here would block a
						// replay after the original operation changed the revision.
						if (preflight) await preflight(writer, preflightTimeoutMs, statusDocument);
					},
					executeMutation: async (writer, command, operationTimeoutMs) => {
						const durableCommand = buildIdempotentMutationCommand(
							command,
							S,
							requestId,
							precondition,
						);
						ctx.logger.warn(
							"[node-sched] audit #%d op=%s request=%s",
							++auditSeq,
							key,
							requestId,
						);
						return executeWriterMutation(writer, durableCommand, operationTimeoutMs);
					},
				});
				return envelope(result, { json: false });
			});
		} catch (error) {
			return {
				ok: false,
				code: -1,
				text: clip(safeError(error)),
				raw: undefined,
				httpStatus: Number.isInteger(error?.httpStatus) ? error.httpStatus : undefined,
			};
		}
	}
		function presentRead(title) {
			return () => ({ card: "generic", title, kind: "read" });
		}

		const textOutput = {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: { text: { type: "string", required: true } },
			},
			render: (_args, value) => [{ type: "text", text: value.text }],
		};

		// ── Read-only agent tools (writes arrive in M3 behind dry-run + confirmation). ──
		const disposers = [
			ctx.tools.register(defineTool({
				name: "sched_status",
				description:
					"Snapshot of the remote sched GPU/CPU scheduler: active batches (progress, dependencies), live jobs " +
					"(state, GPU assignment), per-GPU state (free/assigned/releasing/unmanaged), and CPU quota. " +
					"History is summarized as counts. The authoritative status source — never guess by ssh-ing into " +
					"nodes to run nvidia-smi/ps.",
				parameters: {
					limit: { type: "number", description: "Rows per batch/job page, clamped to [1, 1000]." },
					cursor: { type: "string", description: "Previous page next_cursor for batch paging." },
					job_cursor: { type: "string", description: "Previous page next_job_cursor for job paging." },
				},
				output: textOutput,
				execute: async (args, exec) => {
					const { raw, text } = await query(buildStatusCommand({
						schedBin: S,
						limit: args.limit,
						cursor: args.cursor,
						jobCursor: args.job_cursor,
					}), { signal: exec?.signal });
					return { text: raw ? summarizeStatus(raw) : text };
				},
				presentCall: presentRead("Query sched status"),
			})),

			ctx.tools.register(defineTool({
				name: "sched_gpus",
				description:
					"GPU inventory of the scheduler node: per-GPU state (free/assigned/releasing/unmanaged/quarantined), " +
					"memory capacity, and owning job.",
				parameters: {},
				output: textOutput,
				execute: async (_args, exec) => ({ text: (await query(`${S} list-gpus`, { json: false, signal: exec?.signal })).text }),
				presentCall: presentRead("List scheduler GPUs"),
			})),

			ctx.tools.register(defineTool({
				name: "sched_task",
				description:
					"One-stop diagnosis for a single task: state timeline, failure reason, artifact checks, log tail. " +
					"Task id format `<batch>:<task>`.",
				parameters: {
					task_id: { type: "string", required: true, description: "`<batch>:<task>` identifier." },
				},
				output: textOutput,
				execute: async (args, exec) => {
					const result = await query(buildTaskCommand("task", args.task_id, { schedBin: S }), { signal: exec?.signal });
					return { text: result.raw ? JSON.stringify(result.raw, null, 2) : result.text };
				},
			})),

			ctx.tools.register(defineTool({
				name: "sched_history",
				description: "Historical batches/tasks with final states and durations (not just currently active ones).",
				parameters: {
					batch: { type: "string", description: "Optional batch name filter." },
					limit: { type: "number", description: "History rows, clamped to [1, 200]." },
					cursor: { type: "string", description: "Previous page next_cursor." },
				},
				output: textOutput,
				execute: async (args, exec) => ({
					text: (await query(buildHistoryCommand({
						schedBin: S,
						batch: args.batch,
						limit: args.limit === undefined ? undefined : clamp(args.limit, 1, 200),
						cursor: args.cursor,
					}), { signal: exec?.signal })).text,
				}),
				presentCall: presentRead("Query sched history"),
			})),

			ctx.tools.register(defineTool({
				name: "sched_log",
				description:
					"Tail a task's log (last N lines, default 100). Logs are diagnostic only — status questions belong " +
					"to sched_status/sched_task. Streaming follow (`-f`) is deliberately not exposed to the model.",
				parameters: {
					task_id: { type: "string", required: true, description: "`<batch>:<task>` identifier." },
					lines: { type: "number", description: "Tail length, clamped to [1, 2000]." },
				},
				output: textOutput,
				execute: async (args, exec) => ({
					text: (await query(`${S} log ${shellQuote(args.task_id)} -n ${clamp(args.lines ?? 100, 1, 2000)}`, { json: false, signal: exec?.signal })).text,
				}),
				presentCall: (a) => ({ card: "generic", title: `Tail log ${a.task_id}`, kind: "read" }),
			})),

			ctx.tools.register(defineTool({
				name: "sched_markers",
				description: "One-line-per-batch terminal-state markers (done/blocked) across history.",
				parameters: {},
				output: textOutput,
				execute: async (_args, exec) => ({ text: (await query(`${S} markers`, { json: false, signal: exec?.signal })).text }),
				presentCall: presentRead("Batch terminal markers"),
			})),
		];

		ctx.systemPrompt.section({
			name: "tool:node-sched",
			order: 106,
			text:
				"sched is the remote node-level GPU/CPU batch scheduler. Query state only through the sched_* tools " +
				"(the registry is authoritative; physical commands like nvidia-smi/ps on the node mislead). " +
				"Do not busy-poll: statuses change on the order of minutes. Mutating operations (submit/cancel/" +
				"retry/resubmit/GPU management) are not exposed as tools yet — if the user asks for them, say they " +
				"run through the dashboard or CLI, and note that resubmit deletes declared artifacts.",
		});

	ctx.logger.warn("[node-sched] %d read tools registered", disposers.length);

	// ── Dashboard plumbing (M2): HTTP snapshots + WS event stream over the shared webserver. ──
		let _targetEpoch = 0;
		let _statusInFlight = null;
		let _daemonInFlight = null;
		let _refreshTimer;
		let restartTailForTargetChange = () => {};

		const REFRESH_MS = Math.max(1_000, Number(config.pollFallbackSec) * 1000 || 30_000);
		const statusCache = new FreshStatusCache({ ttlMs: REFRESH_MS });
		const daemonCache = new FreshStatusCache({ ttlMs: REFRESH_MS });

		function statusTargetKey() {
			if (useLocalTransport()) return "local";
			if (boundAlias) return `engine:${boundAlias}`;
			return `system-openssh:${config.sshEntry}`;
		}

		function invalidateTargetCaches() {
			_targetEpoch += 1;
			_statusInFlight = null;
			_daemonInFlight = null;
			statusCache.clear();
			daemonCache.clear();
			restartTailForTargetChange();
			if (_refreshTimer) refreshCaches().catch(() => {});
		}

		function cacheStatus(raw, targetKey = statusTargetKey()) {
			const canonical = canonicalStatusDocument(raw);
			return statusCache.recordSuccess(targetKey, {
				ok: true,
				summary: summarizeStatus(canonical),
				raw: canonical,
				daemon_health: canonical.daemon_health ?? null,
			});
		}

		function visibleCacheBody(view, unavailableText) {
			const metadata = {
				fresh: view.fresh,
				stale: view.stale,
				ageMs: view.ageMs,
				lastError: view.lastError == null ? null : safeError(view.lastError),
			};
			if (view.fresh) return { ...view.body, ...metadata };
			if (view.body) {
				return {
					...view.body,
					ok: false,
					text: metadata.lastError ?? unavailableText,
					...metadata,
				};
			}
			return { ok: false, text: metadata.lastError ?? unavailableText, ...metadata };
		}

		function refreshStatusCache() {
			const targetKey = statusTargetKey();
			const epoch = _targetEpoch;
			if (_statusInFlight?.targetKey === targetKey) return _statusInFlight.promise;
			const request = query(buildStatusCommand({ schedBin: S })).then((result) => {
				if (_targetEpoch !== epoch || statusTargetKey() !== targetKey) return result;
				if (result.ok && isCanonicalStatusDocument(result.raw)) {
					cacheStatus(result.raw, targetKey);
				} else {
					statusCache.recordFailure(targetKey, new Error(result.text || "status JSON unavailable"));
				}
				return result;
			}, (error) => {
				if (_targetEpoch === epoch && statusTargetKey() === targetKey) {
					statusCache.recordFailure(targetKey, error);
				}
				throw error;
			});
			const current = { targetKey, promise: request };
			_statusInFlight = current;
			request.finally(() => {
				if (_statusInFlight === current) _statusInFlight = null;
			}).catch(() => {});
			return request;
		}

		function refreshDaemonCache() {
			const targetKey = statusTargetKey();
			const epoch = _targetEpoch;
			if (_daemonInFlight?.targetKey === targetKey) return _daemonInFlight.promise;
			const startedAt = Date.now();
			const request = query(`${S} daemon status --json`).then((result) => {
				if (_targetEpoch !== epoch || statusTargetKey() !== targetKey) return result;
				try {
					if (!result.ok) throw new Error(result.text || "daemon status unavailable");
					const raw = canonicalDaemonHealth(result.raw);
					daemonCache.recordSuccess(targetKey, { ok: true, raw, sampleAgeMs: Date.now() - startedAt });
				} catch (error) {
					daemonCache.recordFailure(targetKey, error);
				}
				return result;
			}, (error) => {
				if (_targetEpoch === epoch && statusTargetKey() === targetKey) {
					daemonCache.recordFailure(targetKey, error);
				}
				throw error;
			});
			const current = { targetKey, promise: request };
			_daemonInFlight = current;
			request.finally(() => {
				if (_daemonInFlight === current) _daemonInFlight = null;
			}).catch(() => {});
			return request;
		}

		async function refreshCaches() {
			await Promise.allSettled([refreshDaemonCache(), refreshStatusCache()]);
		}

		function startRefresher() {
			if (_refreshTimer) return;
			refreshCaches();
			_refreshTimer = setInterval(refreshCaches, REFRESH_MS);
		}

		function stopRefresher() {
			if (_refreshTimer) { clearInterval(_refreshTimer); _refreshTimer = undefined; }
		}
	const routeDisposers = [];
	let postApplyCleanup = () => {
		disposeSystemOpenSshTransport();
		hostTrustBroker.dispose();
		localTransport.dispose();
		sshEngine.dispose();
	};
	let heartbeat;
	if (ctx.webServer) {
		const json = async (res, body, code = 200) => {
			res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
			res.end(JSON.stringify(body));
		};
		const readGuard = (req, res) => guardReadRequest(req, res, browserAuth);
		const writeGuard = (req, res) => guardMutationRequest(req, res, browserAuth);
		const OPS = {
			cancel: { cmd: (id) => buildOperationCommand("cancel", id, S), needsId: true },
			retry: { cmd: (id) => buildOperationCommand("retry", id, S), needsId: true },
			resubmit: { cmd: (id) => buildOperationCommand("resubmit", id, S), needsId: true },
			"gpu-free": { cmd: (id) => buildOperationCommand("gpu-free", id, S), needsId: true, pattern: /^\d+$/ },
			"gpu-ignore": { cmd: (id) => buildOperationCommand("gpu-ignore", id, S), needsId: true, pattern: /^\d+$/ },
			"gpu-ok": { cmd: (id) => buildOperationCommand("gpu-ok", id, S), needsId: true, pattern: /^\d+$/ },
			"daemon-start": { cmd: () => buildOperationCommand("daemon-start", "", S), needsId: false },
			"daemon-stop": { cmd: () => buildOperationCommand("daemon-stop", "", S), needsId: false },
		};


		const uploadRemote = async (
			content,
			target = captureTransportTarget(),
			{ name: requestedName } = {},
		) => {
			if (!/^\s*\{/.test(content)) throw new Error("content is not a JSON object");
			parseBoundedJson(content);
			const name = requestedName ?? `nodesched-upload-${Date.now()}-${randomUUID()}.json`;
			if (!/^nodesched-upload-[A-Za-z0-9_.:-]{1,180}\.json$/.test(name)) {
				throw new Error("upload name is invalid");
			}
			// Transport-local mode writes directly beside the local daemon.
			if (target.mode === "local") {
				const inboxDir = path.join(os.homedir(), ".sched", "inbox");
				return writePrivateUpload(inboxDir, name, content);
			}
			// 内置引擎与 system-openssh 都保留 stdin 字节；后者严格要求活跃 master。
			if (target.mode === "engine") {
				const remotePath = `$HOME/.sched/inbox/${name}`;
				const r = await sshEngine.execStdin(
					target.alias,
					buildRemoteInboxWriteCommand(remotePath),
					content,
					60_000,
				);
				if (!r.success) throw new Error(r.stderr || r.error || "upload failed");
				return parseUploadedPath(r.stdout, name);
			}
			const result = await runOnTarget(
				target,
				buildRemoteInboxWriteCommand(`$HOME/.sched/inbox/${name}`),
				{
					timeoutMs: 60_000,
					maxOutputBytes: 64 * 1024,
					stdinData: Buffer.from(content, "utf8"),
				},
			);
			if (!result.ok) throw new Error(result.stderr || result.stdout || "upload failed");
			return parseUploadedPath(result.stdout, name);
		};
		const MAX_JSON_BODY_BYTES = 2 * 1024 * 1024;
		const readBodyJson = async (req) => {
			const chunks = [];
			let bytes = 0;
			for await (const chunk of req) {
				const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
				bytes += buffer.length;
				if (bytes > MAX_JSON_BODY_BYTES) {
					throw new Error("request body exceeds 2 MiB limit");
				}
				chunks.push(buffer);
			}
			return parseBoundedJson(Buffer.concat(chunks, bytes).toString("utf8"));
		};
		const exactObjectBody = (body, allowedKeys) => {
			if (!body || typeof body !== "object" || Array.isArray(body)) {
				throw new DeviceAuthError("request body must be a JSON object");
			}
			const allowed = new Set(allowedKeys);
			if (Object.keys(body).some((key) => !allowed.has(key))) {
				throw new DeviceAuthError("request body contains an unsupported field");
			}
			return body;
		};
		const authError = async (res, error) => {
			if (error instanceof DeviceAuthError) {
				return json(res, { ok: false, error: error.message, code: error.code }, error.status);
			}
			if (error instanceof SyntaxError) {
				return json(res, { ok: false, error: "request body is not valid JSON", code: "invalid_json" }, 400);
			}
			ctx.logger.warn("[node-sched] browser authentication failed: %s", safeError(error));
			return json(res, { ok: false, error: "browser authentication failed", code: "auth_error" }, 500);
		};
		const bindingSnapshot = () => {
			if (useLocalTransport()) {
				return { alias: null, mode: "local", sshEntry: config.sshEntry };
			}
			if (boundAlias) {
				return { alias: boundAlias, mode: "engine", sshEntry: config.sshEntry };
			}
			return { alias: null, mode: "system-openssh", sshEntry: config.sshEntry };
		};
		const sameBinding = (left, right) => left.mode === right.mode
			&& left.alias === right.alias
			&& left.sshEntry === right.sshEntry;
		const currentBinding = async ({ checkMaster = true, retryOnChange = true } = {}) => {
			const snapshot = bindingSnapshot();
			if (snapshot.mode !== "system-openssh" || !checkMaster) return snapshot;
			let master;
			try {
				master = await systemOpenSshFor(snapshot.sshEntry).checkMaster();
			} catch (error) {
				master = {
					ready: false,
					checkedAt: new Date().toISOString(),
					code: error?.code ?? "system_openssh_unavailable",
					error: safeError(error),
				};
			}
			const latest = bindingSnapshot();
			if (!sameBinding(snapshot, latest)) {
				return retryOnChange
					? currentBinding({ checkMaster, retryOnChange: false })
					: latest;
			}
			return { ...snapshot, master };
		};

		startRefresher();

		routeDisposers.push(
			ctx.webServer.register({
				kind: "prefix",
				path: "/sched/api/auth",
				handler: async (req, res) => {
					let pathname;
					try {
						pathname = new URL(req.url ?? "/", "http://node-sched.invalid").pathname;
					} catch {
						return void json(res, { ok: false, error: "invalid request path" }, 400);
					}
					const knownPaths = new Set([
						"/sched/api/auth/challenge",
						"/sched/api/auth/verify",
						"/sched/api/auth/pair",
						"/sched/api/auth/session",
						"/sched/api/auth/forget",
						"/sched/api/auth/me",
						"/sched/api/auth/list",
					]);
					if (!knownPaths.has(pathname)) {
						return void json(res, { ok: false, error: "authentication endpoint not found" }, 404);
					}
					const bootstrap = pathname === "/sched/api/auth/challenge"
						|| pathname === "/sched/api/auth/verify";
					const masterOnly = pathname === "/sched/api/auth/pair"
						|| pathname === "/sched/api/auth/session";
					if (bootstrap) {
						if (!guardSameOriginPostRequest(req, res)) return;
					} else if (masterOnly) {
						if (!guardMutationRequest(req, res, accessToken)) return;
					} else if (!guardMutationRequest(req, res, browserAuth)) {
						return;
					}
					const origin = requestCredentialOrigin(req);
					try {
						if (pathname === "/sched/api/auth/challenge") {
							const body = exactObjectBody(await readBodyJson(req), ["clientId"]);
							const challenge = browserAuth.createChallenge(body.clientId, origin);
							return void json(res, { ok: true, ...challenge });
						}
						if (pathname === "/sched/api/auth/verify") {
							const body = exactObjectBody(
								await readBodyJson(req),
								["clientId", "challengeId", "signature"],
							);
							const session = browserAuth.verifyChallenge(body, origin);
							return void json(res, { ok: true, ...session });
						}
						if (pathname === "/sched/api/auth/pair") {
							const body = exactObjectBody(
								await readBodyJson(req),
								["clientId", "publicKeyJwk", "label", "trustDays"],
							);
							const session = browserAuth.pair(body, origin);
							return void json(res, { ok: true, ...session });
						}
						if (pathname === "/sched/api/auth/session") {
							exactObjectBody(await readBodyJson(req), []);
							const session = browserAuth.createMasterSession(origin);
							return void json(res, { ok: true, ...session });
						}
						const principal = bearerPrincipal(req, browserAuth);
						if (!principal) {
							rejectUnauthorized(res);
							return;
						}
						if (pathname === "/sched/api/auth/forget") {
							const body = exactObjectBody(await readBodyJson(req), ["clientId"]);
							const clientId = String(body.clientId ?? "").trim();
							if (principal.kind !== "master" && principal.clientId !== clientId) {
								return void json(res, { ok: false, error: "a browser session may only forget itself" }, 403);
							}
							const removed = browserAuth.revoke(clientId);
							return void json(res, { ok: true, clientId, removed });
						}
						if (pathname === "/sched/api/auth/me") {
							exactObjectBody(await readBodyJson(req), []);
							return void json(res, {
								ok: true,
								kind: principal.kind,
								clientId: principal.clientId,
								expiresAt: principal.expiresAt,
							});
						}
						exactObjectBody(await readBodyJson(req), []);
						return void json(res, { ok: true, devices: browserAuth.list() });
					} catch (error) {
						return void await authError(res, error);
					}
				},
			}),
		);

		routeDisposers.push(
			ctx.webServer.register({
				kind: "prefix",
				path: "/sched/api/status",
				handler: async (req, res) => {
					if (!readGuard(req, res)) return;
					try {
						const url = new URL(req.url ?? "/", "http://x");
						const cursor = url.searchParams.get("cursor");
						const jobCursor = url.searchParams.get("job_cursor");
						const explicitPage = cursor !== null
							|| jobCursor !== null
							|| url.searchParams.has("limit");
						if (explicitPage) {
							const command = buildStatusCommand({
								schedBin: S,
								limit: boundedLimit(url.searchParams.get("limit"), 200, 1000),
								cursor,
								jobCursor,
							});
							const result = await query(command);
							if (!result.ok) {
								return void json(res, { ok: false, text: result.text, fresh: false }, 503);
							}
							const raw = canonicalStatusDocument(result.raw);
							return void json(res, {
								ok: true,
								summary: summarizeStatus(raw),
								raw,
								daemon_health: raw.daemon_health ?? null,
								fresh: true,
								stale: false,
								ageMs: 0,
								lastError: null,
							});
						}
						const targetKey = statusTargetKey();
						const cached = statusCache.read(targetKey);
						if (cached.fresh) {
							return void json(res, visibleCacheBody(cached, "status unavailable"));
						}
						const epoch = _targetEpoch;
						await refreshStatusCache().catch(() => {});
						if (_targetEpoch !== epoch || statusTargetKey() !== targetKey) {
							return void json(res, { ok: false, text: "status target changed; retry" }, 503);
						}
						const view = statusCache.read(targetKey);
						return void json(
							res,
							visibleCacheBody(view, "status unavailable"),
							view.fresh ? 200 : 503,
						);
					} catch (error) {
						return void json(res, { ok: false, text: safeError(error), fresh: false }, 400);
					}
				},
			}),

			ctx.webServer.register({
				kind: "prefix",
				path: "/sched/api/history",
				handler: async (req, res) => {
					if (!readGuard(req, res)) return;
					try {
						const url = new URL(req.url ?? "/", "http://x");
						const result = await query(buildHistoryCommand({
							schedBin: S,
							batch: url.searchParams.get("batch") || undefined,
							limit: boundedLimit(url.searchParams.get("limit"), 50, 200),
							cursor: url.searchParams.get("cursor"),
						}));
						if (!result.ok) {
							return void json(res, { ok: false, text: result.text }, 503);
						}
						const raw = canonicalHistoryDocument(result.raw);
						return void json(res, { ok: true, raw, text: result.text });
					} catch (error) {
						return void json(res, { ok: false, text: safeError(error) }, 400);
					}
				},
			}),

			ctx.webServer.register({
				kind: "prefix",
				path: "/sched/api/gpus",
				handler: async (req, res) => {
					if (!readGuard(req, res)) return;
					const r = await query(`${S} list-gpus`, { json: false });
					await json(res, { ok: r.ok, text: r.text });
				},
			}),

			ctx.webServer.register({
				kind: "prefix",
				path: "/sched/api/entry",
				handler: async (req, res) => {
					try {
						if (req.method === "GET") {
							if (!readGuard(req, res)) return;
							return void json(res, { ok: true, ...(await currentBinding()) });
						}
						if (!writeGuard(req, res)) return;
						// Consume through the shared bounded parser so deprecated clients
						// cannot leave an unread or unbounded request body on the socket.
						await readBodyJson(req);
						return void json(res, {
							ok: false,
							code: "entry_update_moved",
							text: "Use POST /sched/ssh/use-system to select a system OpenSSH entry.",
						}, 410);
					} catch (e) {
						await json(res, { ok: false, text: safeError(e) }, 400);
					}
				},
			}),

			ctx.webServer.register({
				kind: "prefix",
				path: "/sched/api/incidents",
				handler: async (req, res) => {
					if (!readGuard(req, res)) return;
					try {
						const u = new URL(req.url, "http://x");
						const id = u.searchParams.get("id");
						const job = u.searchParams.get("job");
						const gpu = u.searchParams.get("gpu");
						const lim = parseInt(u.searchParams.get("limit") || "30", 10) || 30;
						let cmd = `${S} incidents --json --limit ${lim}`;
						if (id && /^\d+$/.test(id)) {
							cmd = `${S} incidents ${parseInt(id, 10)} --json`;
						} else {
							if (job) cmd += ` --job ${shellQuote(job)}`;
							if (gpu !== null && /^\d+$/.test(gpu)) cmd += ` --gpu ${parseInt(gpu, 10)}`;
						}
						const r = await query(cmd);
						await json(res, { ok: r.ok, text: r.text });
					} catch (e) {
						await json(res, { ok: false, text: safeError(e) }, 400);
					}
				},
			}),

			ctx.webServer.register({
				kind: "prefix",
				path: "/sched/api/config",
				handler: async (req, res) => {
					try {
						if (req.method === "GET") {
							if (!readGuard(req, res)) return;
							const r = await query(`${S} config get`);
							await json(res, { ok: r.ok, text: r.text });
							return;
						}
						if (!writeGuard(req, res)) return;
						const body = await readBodyJson(req);
						if (!body.patch || typeof body.patch !== "object" || Array.isArray(body.patch)) {
							return void json(res, { ok: false, text: "patch (object) required" }, 400);
						}
						const result = await operate(
							"config-set",
							null,
							{
								timeoutMs: 90_000,
								requestId: body.requestId,
								prepare: async (writer) => {
									if (writer.mode === "screen") {
										throw new Error("screen mutation writer cannot attest an uploaded config payload");
									}
									const uploadTarget = writerTransportTarget(writer);
									const uploadContent = JSON.stringify(body.patch);
									const remotePath = await uploadRemote(
										uploadContent,
										uploadTarget,
										{ name: durableUploadName(body.requestId, uploadContent) },
									);
									return {
										command: `${S} config set -f ${shellQuote(remotePath)} --yes`,
										cleanup: async () => runOnTarget(
											uploadTarget,
											`rm -f ${shellQuote(remotePath)}`,
											{ retryable: false },
										).catch(() => {}),
									};
								},
							},
						);
						await json(
							res,
							operationHttpResult(result),
							result.httpStatus ?? 200,
						);
					} catch (e) {
						await json(res, { ok: false, code: -1, text: safeError(e) }, 400);
					}
				},
			}),

			ctx.webServer.register({
				kind: "prefix",
				path: "/sched/api/dryrun",
				handler: async (req, res) => {
					if (!writeGuard(req, res)) return;
					try {
						const target = captureTransportTarget();
						const { content } = await readBodyJson(req);
						const remotePath = await uploadRemote(String(content), target);
						try {
							const r = await query(`${S} submit --dry-run ${shellQuote(remotePath)}`, { json: false, target });
							await json(res, { ok: r.ok && !r.text.startsWith("[error"), text: r.text });
						} finally {
							await runOnTarget(target, `rm -f ${shellQuote(remotePath)}`).catch(() => {});
						}
					} catch (e) {
						await json(res, { ok: false, text: safeError(e) }, 400);
					}
				},
			}),

			ctx.webServer.register({
				kind: "prefix",
				path: "/sched/api/submit",
				handler: async (req, res) => {
					if (!writeGuard(req, res)) return;
					try {
						const { content, requestId } = await readBodyJson(req);
						const result = await operate(
							"submit",
							null,
							{
								requestId,
								prepare: async (writer) => {
									if (writer.mode === "screen") {
										throw new Error("screen mutation writer cannot attest an uploaded submit payload");
									}
									const uploadTarget = writerTransportTarget(writer);
									const uploadContent = String(content);
									const remotePath = await uploadRemote(
										uploadContent,
										uploadTarget,
										{ name: durableUploadName(requestId, uploadContent) },
									);
									return {
										command: `${S} submit ${shellQuote(remotePath)}`,
										cleanup: async () => runOnTarget(
											uploadTarget,
											`rm -f ${shellQuote(remotePath)}`,
											{ retryable: false },
										).catch(() => {}),
									};
								},
							},
						);
						await json(
							res,
							operationHttpResult(result),
							result.httpStatus ?? 200,
						);
					} catch (e) {
						await json(res, { ok: false, code: -1, text: safeError(e) }, 400);
					}
				},
			}),

			ctx.webServer.register({
				kind: "prefix",
				path: "/sched/api/daemon",
				handler: async (req, res) => {
					if (!readGuard(req, res)) return;
					const targetKey = statusTargetKey();
					let view = daemonCache.read(targetKey);
					if (!view.fresh) {
						await refreshDaemonCache().catch(() => {});
						view = daemonCache.read(targetKey);
					}
					json(
						res,
						{ ...visibleCacheBody(view, "daemon status unavailable"), ttlMs: REFRESH_MS },
						view.fresh ? 200 : 503,
					);
				},
			}),

			ctx.webServer.register({
				kind: "prefix",
				path: "/sched/api/op",
				handler: async (req, res) => {
					if (!writeGuard(req, res)) return;

					let body;
					try {
						body = await readBodyJson(req);
					} catch (error) {
						const tooLarge = String(error?.message ?? "").includes("2 MiB");
						return void json(
							res,
							{ ok: false, error: tooLarge ? "request body too large" : "bad request" },
							tooLarge ? 413 : 400,
						);
					}
					const {
						op,
						id,
						requestId,
						expectedStatus,
						expectedVersion,
						expectedQuarantined,
						expectedRevision,
						expectedAssignments,
					} = body && typeof body === "object" ? body : {};
					const spec = Object.hasOwn(OPS, op) ? OPS[op] : undefined;
					if (!spec || typeof (id ?? "") !== "string") {
						return void json(res, { ok: false, error: "bad op/id" }, 400);
					}
					if (spec.needsId && (!id || !(spec.pattern ?? /^[\w:.-]+$/).test(id))) {
						return void json(res, { ok: false, error: "bad id for op" }, 400);
					}
					let precondition = { kind: "none" };
					if (spec.needsId) {
						const kind = op.startsWith("gpu-")
							? "gpu"
							: (id.includes(":") ? "task" : "batch");
						precondition = {
							kind,
							id,
							expectedStatus,
							expectedRevision,
							...(kind === "task" ? { expectedVersion } : {}),
							...(kind === "gpu" ? {
								expectedQuarantined,
								expectedAssignments,
							} : {}),
						};
					}
					const result = await operate(
						`${op}:${id ?? ""}`,
						spec.cmd(id),
						{ requestId, precondition },
					);
					await json(
						res,
						operationHttpResult(result),
						result.httpStatus ?? 200,
					);
				},
			}),

			ctx.webServer.register({
				kind: "prefix",
				path: "/sched/api/log",
				handler: async (req, res) => {
					if (!readGuard(req, res)) return;
					const url = new URL(req.url ?? "/", "http://x");
					const task = url.searchParams.get("task") ?? "";
					const lines = clamp(Number(url.searchParams.get("lines") ?? 200) || 200, 1, 5000);
					if (!task) return void ((res.writeHead(400), res.end("missing ?task=<batch>:<task>")));
					const r = await query(`${S} log ${shellQuote(task)} -n ${lines}`, { json: false });
					res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
					res.end(r.text);
				},
			}),
		);

		// WS event stream: tail the remote dispatcher decision log line-by-line.
		// Source is ~/.sched/<remote-hostname>/scheduler.log (the B6 events dir is
		// unimplemented upstream); frames are `{type:'log', line}` plus a periodic
		// `{type:'status', summary}` heartbeat so clients survive quiet stretches.
		const wss = new WebSocketServer({
			noServer: true,
			maxPayload: 4096,
			handleProtocols: selectAuthenticatedWebSocketProtocol,
		});
		/** @type {Set<import('ws').WebSocket>} */
		const clients = new Set();
		const authAudiences = new Map();
		/** @type {import('node:child_process').ChildProcess | undefined} */
		let tailChild;
		let tailGroupPid;
		/** @type {import('./ssh-engine.js').ExecStream | undefined} */
		let tailStream;
		const pendingTailOpens = new Set();
		let tailOpen;
		let tailRestartTimer;
		let tailDisposed = false;
		let tailGeneration = 0;
		const NORMAL_TAIL_RETRY_MS = 5_000;
		const NO_MASTER_TAIL_RETRY_MS = Math.max(30_000, Math.min(REFRESH_MS, 60_000));
		let tailRetryMs = NORMAL_TAIL_RETRY_MS;
		let tailLastFailureCode;

		function broadcast(obj) {
			const msg = JSON.stringify(obj);
			for (const ws of clients) {
				if (ws.readyState !== ws.OPEN) continue;
				if (ws.bufferedAmount > 4 * 1024 * 1024) {
					try { ws.close(1009, "event output buffer exceeded"); } catch { /* gone */ }
					continue;
				}
				try { ws.send(msg); } catch { /* socket closing */ }
			}
		}
		function stopTail() {
			tailGeneration++;
			clearTimeout(tailRestartTimer);
			tailRestartTimer = undefined;
			abortPendingOpens(pendingTailOpens, new Error("event tail stopped"));
			const stream = tailStream;
			tailStream = undefined;
			try { stream?.close(); } catch { /* already closed */ }
			const child = tailChild;
			const groupPid = tailGroupPid;
			tailChild = undefined;
			tailGroupPid = undefined;
			if (child) stopProcessTreeWithGrace(child, groupPid);
		}

		const removeClient = (ws) => {
			clients.delete(ws);
			authAudiences.delete(ws);
			authBroker.audienceDisconnected();
			if (clients.size === 0) stopTail();
		};

		function scheduleTailRestart() {
			if (tailDisposed || clients.size === 0 || tailRestartTimer) return;
			tailRestartTimer = setTimeout(() => {
				tailRestartTimer = undefined;
				startTail().catch(() => {});
			}, tailRetryMs);
			tailRestartTimer.unref?.();
		}
		restartTailForTargetChange = () => {
			stopTail();
			tailRetryMs = NORMAL_TAIL_RETRY_MS;
			tailLastFailureCode = undefined;
			if (clients.size > 0) scheduleTailRestart();
		};
		const recordTailFailure = (code, message) => {
			const failureCode = code || "tail_unavailable";
			tailRetryMs = failureCode === "no_control_master" || failureCode === "SSH_NO_EXISTING_CONNECTION"
				|| failureCode.startsWith("SSH_INTERACTIVE_AUTH_")
				? NO_MASTER_TAIL_RETRY_MS
				: NORMAL_TAIL_RETRY_MS;
			if (tailLastFailureCode !== failureCode) {
				ctx.logger.warn("[node-sched] event tail unavailable (%s): %s", failureCode, message);
			}
			tailLastFailureCode = failureCode;
		};
		const recordTailReady = () => {
			tailRetryMs = NORMAL_TAIL_RETRY_MS;
			tailLastFailureCode = undefined;
		};
		// The UI explicitly reports whether its panel is visible. A connected
		// hidden dashboard is not allowed to start a new auth challenge.
		broadcastFn = broadcast;
		authAudienceAvailable = () => [...authAudiences.values()].some(Boolean);

		/** Tail the dispatcher decision log; restart with backoff while clients exist.
		 * State dir partitions by the configured COMPUTE node (~/.sched/<node>/),
		 * NOT the ssh-landing host (an outside entry lands on the gateway whose
		 * own hostname dir is empty) — so resolve `node` from the remote
		 * ~/.sched/config.json rather than `hostname`. */
		async function resolveNode(signal, deadlineAt, target) {
			if (target.mode === "local") {
				try {
					return {
						node: JSON.parse(fs.readFileSync(path.join(os.homedir(), ".sched", "config.json"), "utf8")).node,
					};
				} catch {
					return { errorCode: "sched_config_unavailable", error: "cannot read local sched config" };
				}
			}
			const res = await runOnTarget(target, "cat $HOME/.sched/config.json", {
				signal,
				deadlineAt,
				timeoutMs: Math.max(1, deadlineAt - Date.now()),
				interactiveAuth: false,
				requireExistingConnection: true,
			});
			if (!res.ok) {
				return {
					errorCode: res.errorCode,
					error: res.stderr || res.stdout || "cannot read remote sched config",
				};
			}
			try { return { node: JSON.parse(res.stdout).node }; } catch {
				return { errorCode: "sched_config_invalid", error: "remote sched config is invalid" };
			}
		}

		async function startTail() {
			if (tailDisposed || tailChild || tailStream || pendingTailOpens.size > 0 || clients.size === 0) return;
			const generation = ++tailGeneration;
			const target = captureTransportTarget();
			const opening = beginPendingOpen(pendingTailOpens, 1);
			if (!opening) return;
			tailOpen = opening;
			const openDeadlineAt = sshOpenDeadlineAt(sshEngine);
			const releaseOpening = () => {
				opening.settle();
				if (tailOpen === opening) tailOpen = undefined;
				if (!tailDisposed && clients.size > 0 && !tailChild && !tailStream) scheduleTailRestart();
			};
			const resolvedNode = await resolveNode(opening.controller.signal, openDeadlineAt, target);
			if (tailDisposed || generation !== tailGeneration || clients.size === 0) {
				releaseOpening();
				return;
			}
			const nodeName = resolvedNode.node;
			if (!nodeName) {
				recordTailFailure(
					resolvedNode.errorCode,
					safeError(resolvedNode.error || "cannot resolve sched node from ~/.sched/config.json"),
				);
				releaseOpening();
				return;
			}
			const safeNode = String(nodeName).replace(/[^a-zA-Z0-9.-]/g, "");
			const remoteCmd = `tail -n 50 -F $HOME/.sched/${safeNode}/scheduler.log 2>/dev/null`;
			const framer = new ByteLineFramer({
				maxLineBytes: 3_000,
				onLine: (line) => {
					if (tailDisposed || generation !== tailGeneration || clients.size === 0) return;
					broadcast({ type: "log", line });
				},
			});
			const onData = (chunk) => {
				if (tailDisposed || generation !== tailGeneration || clients.size === 0) return;
				framer.push(chunk);
			};
			let ended = false;
			const onEnd = () => {
				if (ended || generation !== tailGeneration) return;
				ended = true;
				framer.flush();
				tailChild = undefined; tailStream = undefined;
				tailGroupPid = undefined;
				if (tailDisposed) return;
				scheduleTailRestart();
			};
			if (target.mode === "local") {
				localTransport.openStream(remoteCmd).then((stream) => {
					if (tailDisposed || generation !== tailGeneration || tailChild || tailStream || clients.size === 0) { stream.close(); return; }
					recordTailReady();
					tailStream = stream;
					stream.onData = onData;
					stream.onClose = onEnd;
				}).catch((e) => {
					ctx.logger.warn("[node-sched] local tail failed: %s", safeError(e));
					onEnd();
				}).finally(releaseOpening);
				return;
			}
			if (target.mode === "engine") {
				const { controller } = opening;
				// The tail is an invisible background poller: a mid-session SSH
				// reconnect here must fail fast instead of raising a challenge
				// modal nobody can see.
				openExecStream(sshEngine, target.alias, remoteCmd, {
					signal: controller.signal,
					deadlineAt: openDeadlineAt,
					interactiveAuth: false,
					requireExistingConnection: true,
				}).then((stream) => {
					if (tailDisposed || generation !== tailGeneration || tailChild || tailStream || clients.size === 0) {
						try { stream.close(); } catch {}
						return;
					}
					recordTailReady();
					tailStream = stream;
					stream.onData = onData;
					stream.onClose = onEnd;
				}).catch((e) => {
					if (!controller.signal.aborted) {
						recordTailFailure(e?.code, safeError(e));
					}
					onEnd();
				}).finally(releaseOpening);
				return;
			}
			const { controller } = opening;
			target.transport.openStream(remoteCmd, {
				signal: controller.signal,
				masterCheckTimeoutMs: Math.max(1, openDeadlineAt - Date.now()),
			}).then((stream) => {
				if (tailDisposed || generation !== tailGeneration || tailChild || tailStream || clients.size === 0) {
					try { stream.close(); } catch { /* stale open */ }
					return;
				}
				recordTailReady();
				tailStream = stream;
				stream.onData = onData;
				stream.onClose = onEnd;
			}).catch((error) => {
				if (!controller.signal.aborted) {
					recordTailFailure(error?.code, safeError(error));
				}
				onEnd();
			}).finally(releaseOpening);
		}
		heartbeat = setInterval(async () => {
			if (clients.size === 0) return;
			try {
				const targetKey = statusTargetKey();
				let view = statusCache.read(targetKey);
				if (!view.fresh) {
					const epoch = _targetEpoch;
					await refreshStatusCache();
					if (_targetEpoch !== epoch || statusTargetKey() !== targetKey) return;
					view = statusCache.read(targetKey);
				}
				broadcast({
					type: "status",
					summary: view.fresh ? (view.body?.summary ?? null) : null,
					fresh: view.fresh,
					stale: view.stale,
					ageMs: view.ageMs,
					lastError: view.lastError == null ? null : safeError(view.lastError),
					ts: Date.now(),
				});
			} catch { /* transient */ }
		}, config.pollFallbackSec * 1000);

		routeDisposers.push(
			ctx.webServer.registerUpgrade({
				path: "/sched/ws/events",
				handler: (req, socket, head) => {
					const principal = websocketRequestPrincipal(req, browserAuth);
					if (!principal || clients.size >= 8) {
						socket.destroy();
						return;
					}
					wss.handleUpgrade(req, socket, head, (ws) => {
						browserAuth.trackConnection(ws, principal);
						clients.add(ws);
						authAudiences.set(ws, false);
						try {
							authBroker.replay((event) => ws.send(JSON.stringify(event)));
						} catch {
							removeClient(ws);
							try { ws.close(); } catch { /* already closed */ }
							return;
						}
						let messageWindowAt = Date.now();
						let messageCount = 0;
						ws.on("message", (raw) => {
							const now = Date.now();
							if (now - messageWindowAt >= 1000) {
								messageWindowAt = now;
								messageCount = 0;
							}
							messageCount += 1;
							if (messageCount > 20 || raw.length > 4096) {
								ws.close(1008, "event input rate exceeded");
								return;
							}
							try {
								const frame = JSON.parse(raw.toString());
								if (frame?.type === "auth-audience") {
									authAudiences.set(ws, frame.visible === true);
								}
							} catch { /* malformed audience frame */ }
						});
						ws.on("close", () => removeClient(ws));
						ws.on("error", () => removeClient(ws));
						startTail().catch(() => {});
					});
				},
			}),
		);

		// ── B22: 内嵌 SSH 引擎（复刻自 Apache-2.0 dsh-ssh，见 ssh-engine.js）──
		// 引擎实例在 apply() 顶部创建（B24: runRemote 双通道需要）；此处仅注册清理。
		postApplyCleanup = () => {
			tailDisposed = true;
			stopTail();
			authBroker.cancelAll();
			for (const ws of clients) {
				try { ws.close(1001, "node-sched disposed"); } catch { /* gone */ }
			}
			clients.clear();
			try { wss.close(); } catch { /* already closed */ }
			localTransport.dispose();
			disposeSystemOpenSshTransport();
			hostTrustBroker.dispose();
			sshEngine.dispose();
		};
		const boundTargetUsesAlias = (alias) => {
			if (alias === boundAlias) return true;
			const active = boundAlias ? sshStore.find(boundAlias) : undefined;
			return Array.isArray(active?.proxyJump) && active.proxyJump.includes(alias);
		};
		const invalidateAliasAndDependents = (alias) => {
			for (const entry of sshStore.list()) {
				if (entry.alias === alias || (entry.proxyJump ?? []).includes(alias)) {
					sshEngine.dropAlias(entry.alias);
				}
			}
		};
		const refreshSshStore = () => {
			const aliases = sshStore.list().map((entry) => entry.alias);
			sshStore.refresh();
			const generation = sshStore.externalGeneration();
			if (generation === observedSshStoreGeneration) return false;
			observedSshStoreGeneration = generation;
			for (const alias of new Set([...aliases, ...sshStore.list().map((entry) => entry.alias)])) {
				sshEngine.dropAlias(alias);
			}
			return true;
		};

		routeDisposers.push(
			ctx.webServer.register({
				kind: "prefix",
				path: "/sched/ssh/hosts",
				handler: async (req, res) => {
					try {
						if (req.method === "GET") {
							if (!readGuard(req, res)) return;
							refreshSshStore();
							const url = new URL(req.url, "http://x");
							return void json(res, {
								storeRevision: sshStore.revision(),
								hosts: sshEngine.list(url.searchParams.get("query") ?? undefined),
							});
						}
						if (!writeGuard(req, res)) return;
						refreshSshStore();
						const body = await readBodyJson(req);
						const action = String(body?.action ?? "");
						if (action === "create") {
							exactObjectBody(body, ["action", "host"]);
							if (Object.hasOwn(body.host ?? {}, "hostKeys")) {
								return void json(res, { error: "hostKeys provenance is internal; use hostKey for a manual pin" }, 400);
							}
							const entry = sshStore.create(body.host);
							return void json(res, { host: sshStore.summarize(entry) }, 201);
						}
						exactObjectBody(body, ["action", "alias", "patch", "expectedHostRevision"]);
						const alias = String(body?.alias ?? "").trim();
						if (!alias) return void json(res, { error: "alias is required" }, 400);
						if (!["update", "delete"].includes(action)) {
							return void json(res, { error: "action must be create, update, or delete" }, 400);
						}
						if (boundTargetUsesAlias(alias)) {
							return void json(res, { error: "unbind the active target before editing or deleting it or its proxy hop" }, 409);
						}
						if (!Number.isInteger(body.expectedHostRevision) || body.expectedHostRevision < 0) {
							return void json(res, { error: "expectedHostRevision is required" }, 400);
						}
						if (action === "update") {
							if (Object.hasOwn(body.patch ?? {}, "hostKeys")) {
								return void json(res, { error: "hostKeys provenance is internal; use hostKey for a manual pin" }, 400);
							}
							const entry = sshStore.update(alias, body.patch, {
								expectedRevision: body.expectedHostRevision,
							});
							invalidateAliasAndDependents(alias);
							return void json(res, { host: sshStore.summarize(entry) });
						}
						const referenced = sshStore.list().filter(
							(entry) => entry.alias !== alias && (entry.proxyJump ?? []).includes(alias),
						);
						if (referenced.length > 0) {
							return void json(res, {
								error: `alias '${alias}' is used by ProxyJump target '${referenced[0].alias}'`,
								code: "SSH_PROXY_JUMP_IN_USE",
							}, 409);
						}
						const removed = sshStore.remove(alias, { expectedRevision: body.expectedHostRevision });
						invalidateAliasAndDependents(alias);
						return void json(res, { removed });
					} catch (e) {
						if (e?.code === "SSH_HOST_STORE_CONFLICT") refreshSshStore();
						json(res, { error: safeError(e), code: e?.code }, e?.status ?? (["SSH_HOST_REVISION_CONFLICT", "SSH_HOST_STORE_CONFLICT"].includes(e?.code) ? 409 : 400));
					}
				},
			}),

			ctx.webServer.register({
				kind: "prefix",
				path: "/sched/ssh/import",
				handler: async (req, res) => {
					if (!writeGuard(req, res)) return;
					try {
						refreshSshStore();
						const result = sshStore.importSshConfig();
						const updates = [];
						const conflicts = [];
						const lookupErrors = [];
						let unsupported = 0;
						let revoked = 0;
						for (const entry of sshStore.list()) {
							const trusted = trustedHostKeyRecords(entry);
							let lookup;
							try {
								lookup = lookupKnownHostKeys({
									host: entry.host,
									port: entry.port,
									hostKeyAlias: entry.hostKeyAlias,
									files: defaultKnownHostsFiles(),
								});
							} catch (error) {
								lookupErrors.push({ alias: entry.alias, error: safeError(error) });
								continue;
							}
							revoked += lookup.revoked.length;
							const revokedFingerprints = new Set(lookup.revoked.map((key) => key.fingerprint));
							const revokedPins = trusted.filter((key) => revokedFingerprints.has(key.fingerprint));
							if (revokedPins.length > 0) {
								conflicts.push({
									alias: entry.alias,
									code: "SSH_HOST_KEY_REVOKED",
									fingerprints: revokedPins.map((key) => key.fingerprint),
								});
								continue;
							}
							if (trusted.length > 0) continue;
							unsupported += lookup.unsupported.length;
							const hostKeys = knownHostTrustRecords(lookup.keys);
							if (hostKeys.length === 0) continue;
							updates.push({
								alias: entry.alias,
								expectedRevision: entry.revision ?? 0,
								hostKeys,
								hostKey: hostKeys[0].fingerprint,
							});
						}
						const changed = sshStore.updateHostKeys(updates);
						for (const entry of changed) invalidateAliasAndDependents(entry.alias);
						json(res, {
							result: {
								...result,
								pinned: changed.length,
								pending: sshStore.list().filter((entry) => trustedHostKeyRecords(entry).length === 0).length,
								conflicts,
								revoked,
								unsupported,
								lookupErrors,
							},
						});
					} catch (e) {
						if (e?.code === "SSH_HOST_STORE_CONFLICT") refreshSshStore();
						json(res, { error: safeError(e), code: e?.code }, e?.status ?? 400);
					}
				},
			}),

			ctx.webServer.register({
				kind: "prefix",
				path: "/sched/ssh/host-key",
				handler: async (req, res) => {
					if (!writeGuard(req, res)) return;
					const principal = bearerPrincipal(req, browserAuth);
					if (!principal) return void rejectUnauthorized(res);
					let body;
					try {
						refreshSshStore();
						body = await readBodyJson(req);
						if (!body || typeof body !== "object" || Array.isArray(body)) {
							return void json(res, { ok: false, error: "request body must be an object", code: "SSH_TRUST_INVALID_REQUEST" }, 400);
						}
						const principalKey = hostTrustPrincipalKey(principal);
						const action = String(body.action ?? "");
						const allowedFields = {
							cancel: ["action", "challengeId", "targetAlias"],
							prepare: ["action", "targetAlias", "expectedHostRevision", "mode", "hostAlias"],
							confirm: ["action", "targetAlias", "expectedHostRevision", "hostAlias", "challengeId", "fingerprint"],
						}[action];
						if (!allowedFields) {
							return void json(res, { ok: false, error: "action must be prepare, confirm, or cancel", code: "SSH_TRUST_INVALID_REQUEST" }, 400);
						}
						exactObjectBody(body, allowedFields);
						if (action === "cancel") {
							const challengeId = body.challengeId === undefined ? undefined : String(body.challengeId);
							const targetAlias = body.targetAlias === undefined ? undefined : String(body.targetAlias).trim();
							if (targetAlias !== undefined && (targetAlias.length > 128 || !/^[A-Za-z0-9_.-]+$/.test(targetAlias))) {
								return void json(res, { ok: false, error: "invalid target alias", code: "SSH_TRUST_INVALID_REQUEST" }, 400);
							}
							const cancelledProbe = hostTrustBroker.cancelProbe(principalKey, targetAlias);
							const cancelledChallenge = challengeId === undefined
								? hostTrustBroker.cancelForPrincipal(principalKey) > 0
								: hostTrustBroker.cancel(challengeId, principalKey);
							return void json(res, {
								ok: true,
								state: "cancelled",
								cancelled: cancelledProbe || cancelledChallenge,
							});
						}

						const targetAlias = String(body.targetAlias ?? "").trim();
						if (targetAlias.length > 128 || !/^[A-Za-z0-9_.-]+$/.test(targetAlias)) {
							return void json(res, { ok: false, error: "invalid target alias", code: "SSH_TRUST_INVALID_REQUEST" }, 400);
						}
						const target = sshStore.find(targetAlias);
						if (!target) {
							return void json(res, { ok: false, error: `alias '${targetAlias}' not found`, code: "SSH_HOST_NOT_FOUND" }, 404);
						}
						if (!Number.isInteger(body.expectedHostRevision) || body.expectedHostRevision < 0) {
							return void json(res, { ok: false, error: "expectedHostRevision is required", code: "SSH_TRUST_INVALID_REQUEST" }, 400);
						}
						if (body.expectedHostRevision !== (target.revision ?? 0)) {
							return void json(res, { ok: false, error: "host changed since it was loaded", code: "SSH_HOST_REVISION_CONFLICT" }, 409);
						}

						if (action === "prepare") {
							if (body.mode !== undefined && !["initial", "rotate"].includes(body.mode)) {
								return void json(res, { ok: false, error: "mode must be initial or rotate", code: "SSH_TRUST_INVALID_REQUEST" }, 400);
							}
							const mode = body.mode ?? "initial";
							const requestedHostAlias = body.hostAlias === undefined ? undefined : String(body.hostAlias);
							if (
								requestedHostAlias !== undefined
								&& (requestedHostAlias.length > 128 || !/^[A-Za-z0-9_.-]+$/.test(requestedHostAlias))
							) {
								return void json(res, { ok: false, error: "invalid host alias", code: "SSH_TRUST_INVALID_REQUEST" }, 400);
							}
							let knownHostsWarnings = [];
							const route = resolveHostRoute(sshStore, target);
							const knownHostsByAlias = new Map();
							for (const entry of route) {
								let lookup;
								try {
									lookup = lookupKnownHostKeys({
										host: entry.host,
										port: entry.port,
										hostKeyAlias: entry.hostKeyAlias,
									});
								} catch (error) {
									knownHostsWarnings.push({ alias: entry.alias, error: safeError(error) });
									continue;
								}
								knownHostsByAlias.set(entry.alias, lookup);
								if (lookup.warnings.length > 0 || lookup.unsupported.length > 0) {
									knownHostsWarnings.push({
										alias: entry.alias,
										warnings: lookup.warnings.length,
										unsupported: lookup.unsupported.length,
									});
								}
							}
							if (mode === "rotate") {
								const hostAlias = requestedHostAlias ?? targetAlias;
								if (boundTargetUsesAlias(hostAlias)) {
									return void json(res, { ok: false, error: "unbind the active target before rotating its host key", code: "SSH_TRUST_BOUND_TARGET" }, 409);
								}
							} else {
								const updates = [];
								for (const entry of route) {
									const trusted = trustedHostKeyRecords(entry);
									const lookup = knownHostsByAlias.get(entry.alias);
									if (!lookup) continue;
									const revokedFingerprints = new Set(lookup.revoked.map((key) => key.fingerprint));
									const revokedPins = trusted.filter((key) => revokedFingerprints.has(key.fingerprint));
									if (revokedPins.length > 0) {
										return void json(res, {
											ok: false,
											error: `known_hosts revokes the currently trusted key for '${entry.alias}'`,
											code: "SSH_HOST_KEY_REVOKED",
										}, 409);
									}
									if (trusted.length > 0) continue;
									const hostKeys = knownHostTrustRecords(lookup.keys);
									if (hostKeys.length > 0) {
										updates.push({
											alias: entry.alias,
											expectedRevision: entry.revision ?? 0,
											hostKeys,
											hostKey: hostKeys[0].fingerprint,
										});
									}
								}
								const imported = sshStore.updateHostKeys(updates);
								for (const entry of imported) invalidateAliasAndDependents(entry.alias);
								const refreshed = hostTrustRouteSnapshot(sshStore, targetAlias);
								if (refreshed.route.every((entry) => trustedHostKeyRecords(entry).length > 0)) {
									ctx.logger.warn(
										"[node-sched] audit #%d ssh-host-trust known_hosts target=%s imported=%d",
										++auditSeq,
										targetAlias,
										imported.length,
									);
									return void json(res, {
										ok: true,
										state: imported.length > 0 ? "trusted_from_known_hosts" : "already_trusted",
										imported: imported.map((entry) => sshStore.summarize(entry)),
										warnings: knownHostsWarnings,
									});
								}
							}

							const routeBeforeProbe = hostTrustRouteSnapshot(sshStore, targetAlias);
							const controller = new AbortController();
							const abort = () => controller.abort(new Error("host key probe request was cancelled"));
							const abortDisconnected = () => {
								if (!res.writableEnded) abort();
							};
							const probeOperation = hostTrustBroker.beginProbe({
								principalKey,
								targetAlias,
								abort,
							});
							req.once("aborted", abort);
							res.once("close", abortDisconnected);
							try {
								const observation = await probeHostKey(sshEngine, targetAlias, {
									probeAlias: mode === "rotate" ? (requestedHostAlias ?? targetAlias) : undefined,
									signal: controller.signal,
								});
								refreshSshStore();
								if (!probeOperation.isCurrent()) {
									const error = new Error("host key probe was superseded by a newer request");
									error.code = "SSH_TRUST_SUPERSEDED";
									error.status = 409;
									throw error;
								}
								const routeAfterProbe = hostTrustRouteSnapshot(sshStore, targetAlias);
								if (routeAfterProbe.digest !== routeBeforeProbe.digest) {
									const error = new Error("SSH host or ProxyJump route changed during the probe");
									error.code = "SSH_TRUST_ROUTE_CHANGED";
									error.status = 409;
									throw error;
								}
								if (observation.state === "already_trusted") {
									return void json(res, { ok: true, state: "already_trusted", warnings: knownHostsWarnings });
								}
								const revokedFingerprints = new Set(
									(knownHostsByAlias.get(observation.alias)?.revoked ?? [])
										.map((key) => key.fingerprint),
								);
								if (revokedFingerprints.has(observation.fingerprint)) {
									const error = new Error(
										`known_hosts revokes the observed key for '${observation.alias}'`,
									);
									error.code = "SSH_HOST_KEY_REVOKED";
									error.status = 409;
									throw error;
								}
								const currentTarget = sshStore.find(targetAlias);
								const challenge = hostTrustBroker.create({
									principalKey,
									targetAlias,
									targetRevision: currentTarget?.revision ?? 0,
									alias: observation.alias,
									host: observation.host,
									port: observation.port,
									algorithm: observation.algorithm,
									fingerprint: observation.fingerprint,
									routeDigest: routeBeforeProbe.digest,
								});
								ctx.logger.warn(
									"[node-sched] audit #%d ssh-host-trust probe target=%s observed=%s",
									++auditSeq,
									targetAlias,
									observation.alias,
								);
								return void json(res, {
									ok: true,
									state: "confirmation_required",
									challenge,
									warnings: knownHostsWarnings,
								});
							} finally {
								req.removeListener("aborted", abort);
								res.removeListener("close", abortDisconnected);
								probeOperation.finish();
							}
						}

						if (action === "confirm") {
							const challengeId = String(body.challengeId ?? "");
							const hostAlias = String(body.hostAlias ?? "");
							const fingerprint = String(body.fingerprint ?? "");
							if (!/^[A-Za-z0-9_.-]+$/.test(hostAlias) || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(fingerprint)) {
								return void json(res, { ok: false, error: "invalid host trust confirmation", code: "SSH_TRUST_INVALID_REQUEST" }, 400);
							}
							if (boundTargetUsesAlias(hostAlias)) {
								return void json(res, { ok: false, error: "unbind the active target before changing its host key", code: "SSH_TRUST_BOUND_TARGET" }, 409);
							}
							const route = hostTrustRouteSnapshot(sshStore, targetAlias);
							const challenge = hostTrustBroker.consume(challengeId, {
								principalKey,
								targetAlias,
								alias: hostAlias,
								fingerprint,
								routeDigest: route.digest,
							});
							const entry = sshStore.find(hostAlias);
							if (!entry) throw new Error(`alias '${hostAlias}' disappeared after the probe`);
							const changed = sshStore.updateHostKeys([{
								alias: hostAlias,
								expectedRevision: entry.revision ?? 0,
								hostKey: fingerprint,
								hostKeys: [{
									algorithm: challenge.algorithm,
									fingerprint,
									source: "probe",
									trustedAt: Date.now(),
								}],
							}])[0];
							invalidateAliasAndDependents(hostAlias);
							const complete = resolveHostRoute(sshStore, sshStore.find(targetAlias))
								.every((candidate) => trustedHostKeyRecords(candidate).length > 0);
							ctx.logger.warn(
								"[node-sched] audit #%d ssh-host-trust confirm target=%s host=%s",
								++auditSeq,
								targetAlias,
								hostAlias,
							);
							return void json(res, {
								ok: true,
								state: complete ? "trusted" : "next_required",
								host: sshStore.summarize(changed),
							});
						}

					} catch (error) {
						if (error?.code === "SSH_HOST_STORE_CONFLICT") refreshSshStore();
						if (res.destroyed || res.writableEnded) return;
						const conflictCodes = new Set([
							"SSH_HOST_REVISION_CONFLICT",
							"SSH_HOST_STORE_CONFLICT",
							"SSH_PROXY_JUMP_INVALID",
							"SSH_PROXY_JUMP_MISSING",
							"SSH_PROXY_JUMP_NESTED",
							"SSH_TRUST_DEPENDENCY",
							"SSH_TRUST_ROUTE_CHANGED",
							"SSH_TRUST_SUPERSEDED",
						]);
						const status = error?.status
							?? (conflictCodes.has(error?.code)
								? 409
								: error?.code === "SSH_OPEN_DEADLINE" ? 504 : 400);
						json(res, { ok: false, error: safeError(error), code: error?.code }, status);
					}
				},
			}),

			ctx.webServer.register({
				kind: "prefix",
				path: "/sched/ssh/test",
				handler: async (req, res) => {
					if (!writeGuard(req, res)) return;
					try {
						refreshSshStore();
						const body = await readBodyJson(req);
						const result = await sshEngine.test(String(body.alias ?? ""));
						if (result.ok && String(body.alias ?? "") === boundAlias) invalidateTargetCaches();
						if (!result.ok && result.error) result.error = safeError(result.error);
						json(res, result);
					} catch (e) {
						json(res, { ok: false, error: safeError(e) });
					}
				},
			}),

			ctx.webServer.register({
				kind: "prefix",
				path: "/sched/ssh/exec",
				handler: async (req, res) => {
					if (!writeGuard(req, res)) return;
					try {
						refreshSshStore();
						const body = await readBodyJson(req);
						const command = String(body.command ?? "").trim();
						if (!command) return void json(res, { error: "command required" }, 400);
						ctx.logger.warn(
							"[node-sched] audit ssh-exec %s: %s",
							redactCommand(body.alias, 80),
							redactCommand(command),
						);
						sshEngine.resumeAuthentication(String(body.alias ?? ""));
						const result = await executeGenericSsh(
							sshEngine,
							String(body.alias ?? ""),
							command,
							{ timeoutMs: body.timeoutMs },
						);
						json(res, result);
					} catch (e) {
						json(res, { success: false, exitCode: null, timedOut: false, stdout: "", stderr: "", durationMs: 0, error: safeError(e) });
					}
				},
			}),

			ctx.webServer.register({
				kind: "prefix",
				path: "/sched/ssh/binding",
				handler: async (req, res) => {
					if (!readGuard(req, res)) return;
					refreshSshStore();
					json(res, await currentBinding());
				},
			}),

			ctx.webServer.register({
				kind: "prefix",
				path: "/sched/ssh/use-system",
				handler: async (req, res) => {
					if (!writeGuard(req, res)) return;
					let candidateTransport;
					let ownsCandidateTransport = false;
					try {
						const body = exactObjectBody(await readBodyJson(req), ["sshEntry"]);
						if (useLocalTransport()) {
							return void json(res, { ok: false, code: "local_transport", error: "system OpenSSH is unavailable in local transport" }, 409);
						}
						const sshEntry = validateSshEntry(String(body.sshEntry ?? "").trim());
						const activeSystemEntry = !boundAlias
							? String(config.sshEntry ?? "").trim()
							: null;
						if (activeSystemEntry === sshEntry) {
							candidateTransport = systemOpenSshFor(sshEntry);
						} else {
							// Probe a proposed alias in isolation. A failed check must not
							// dispose or abort the currently active transport.
							candidateTransport = createSystemOpenSshTransport(sshEntry);
							ownsCandidateTransport = true;
						}
						// This is the user's explicit recheck action: bypass a recent
						// negative cache while still coalescing any live probe.
						const master = await candidateTransport.checkMaster({ force: true });
						if (!master.ready) {
							return void json(res, {
								ok: false,
								code: master.code ?? "no_control_master",
								error: master.error,
								master,
							}, 409);
						}
						const previousAlias = boundAlias;
						const previousEntry = config.sshEntry;
						persistEntryOverride({ sshEntry, schedAlias: null });
						config.sshEntry = sshEntry;
						boundAlias = null;
						if (ownsCandidateTransport) {
							const previousTransport = systemOpenSshTransport;
							systemOpenSshTransport = candidateTransport;
							ownsCandidateTransport = false;
							try { previousTransport?.dispose(); } catch { /* already disposed */ }
						}
						if (previousAlias) sshEngine.dropAlias(previousAlias);
						invalidateTargetCaches();
						ctx.logger.warn(
							"[node-sched] audit #%d sched transport -> system-openssh:%s (from %s)",
							++auditSeq,
							sshEntry,
							previousAlias ? `engine:${previousAlias}` : `system-openssh:${previousEntry}`,
						);
						const binding = { alias: null, mode: "system-openssh", sshEntry, master };
						return void json(res, { ok: true, ...binding, binding });
					} catch (error) {
						const code = error instanceof NoOpenSshMasterError
							? "no_control_master"
							: (error?.code ?? "invalid_system_openssh_request");
						return void json(res, { ok: false, code, error: safeError(error) }, code === "no_control_master" ? 409 : 400);
					} finally {
						if (ownsCandidateTransport) {
							try { candidateTransport?.dispose(); } catch { /* already disposed */ }
						}
					}
				},
			}),

			ctx.webServer.register({
				kind: "prefix",
				path: "/sched/ssh/bind",
				handler: async (req, res) => {
					if (!writeGuard(req, res)) return;
					if (useLocalTransport()) {
						return void json(res, { ok: false, error: "SSH binding unavailable in local transport" }, 409);
					}
					try {
						refreshSshStore();
						const body = await readBodyJson(req);
						const alias = String(body.alias ?? "").trim();
						if (!alias || !/^[A-Za-z0-9_.-]+$/.test(alias)) {
							return void json(res, { ok: false, error: "invalid alias" }, 400);
						}
						if (!sshStore.find(alias)) {
							return void json(res, { ok: false, error: `alias '${alias}' not in host store` }, 404);
						}
						// 诚实反馈：主机必须可达才允许绑定；daemon 状态只提示不强阻
						const reach = await sshEngine.test(alias);
						if (!reach.ok) {
							return void json(res, { ok: false, error: `主机不可达: ${safeError(reach.error ?? "?")}`, reachable: false });
						}
						let probeText = "";
						try {
							const pr = typeof sshEngine.execRetryable === "function"
								? await sshEngine.execRetryable(alias, `${S} daemon status`, 25_000)
								: await sshEngine.execOnce(alias, `${S} daemon status`, 25_000);
							probeText = sanitizeLogText((pr.stdout || pr.stderr || "").split("\n")[0], 100);
						} catch (e) {
							probeText = "\u63a2\u6d4b\u5931\u8d25: " + safeError(e, 80);
						}
						const previousAlias = boundAlias;
						persistEntryOverride({ sshEntry: config.sshEntry, schedAlias: alias });
						boundAlias = alias;
						disposeSystemOpenSshTransport();
						if (previousAlias && previousAlias !== alias) sshEngine.dropAlias(previousAlias);
						invalidateTargetCaches();
						ctx.logger.warn("[node-sched] audit #%d sched-bind -> %s (engine mode)", ++auditSeq, alias);
						json(res, { ok: true, mode: "engine", alias, latencyMs: reach.latencyMs, probeText });
					} catch (e) {
						json(res, { ok: false, error: safeError(e) }, 400);
					}
				},
			}),

			ctx.webServer.register({
				kind: "prefix",
				path: "/sched/ssh/unbind",
				handler: async (req, res) => {
					if (!writeGuard(req, res)) return;
					const prev = boundAlias;
					try {
						persistEntryOverride({ sshEntry: config.sshEntry, schedAlias: null });
					} catch (error) {
						json(res, { ok: false, error: safeError(error) }, 500);
						return;
					}
					boundAlias = null;
					if (prev) sshEngine.dropAlias(prev);
					invalidateTargetCaches();
					ctx.logger.warn("[node-sched] audit #%d sched-unbind <- %s", ++auditSeq, prev);
					json(res, { ok: true, prev, ...(await currentBinding()) });
				},
			}),

			ctx.webServer.register({
				kind: "prefix",
				path: "/sched/api/client-log",
				handler: async (req, res) => {
					if (!writeGuard(req, res)) return;
					try {
						const body = await readBodyJson(req);
						// ctx.logger 只进内存缓冲不落盘 —— 直接追加共享盘文件供远程排查读取
						const line = `[${sanitizeLogText(body.ts, 80)}] ${sanitizeLogText(body.kind, 80)} ${sanitizeLogText(body.detail, 500)}\n`;
						appendPrivateClientLog(os.homedir(), line);
						json(res, { ok: true });
					} catch (e) {
						json(res, { ok: false }, 400);
					}
				},
			}),

			ctx.webServer.register({
				kind: "prefix",
				path: "/sched/ssh/auth-pending",
				handler: async (req, res) => {
					if (!readGuard(req, res)) return;
					json(res, { pending: authBroker.pendingIds() });
				},
			}),

			ctx.webServer.register({
				kind: "prefix",
				path: "/sched/ssh/auth-answer",
				handler: async (req, res) => {
					if (!writeGuard(req, res)) return;
					try {
						const body = await readBodyJson(req);
						const id = String(body.id ?? "");
						const answer = body.answer;
						if (!authBroker.pendingIds().includes(id)) {
							return void json(res, { ok: false, error: "\u8bf7\u6c42\u4e0d\u5b58\u5728\u6216\u5df2\u8fc7\u671f" }, 404);
						}
						if (!answer || typeof answer !== "object" || !["cancel", "answers"].includes(answer.kind)) {
							return void json(res, { ok: false, error: "invalid authentication answer" }, 400);
						}
						if (answer.kind === "cancel") {
							ctx.logger.warn("[node-sched] audit auth-cancel id=%s (user)", id);
							authBroker.cancel(id);
						} else {
							authBroker.answer(id, answer.answers);
							ctx.logger.warn(
								"[node-sched] audit auth-answer id=%s answers=%d",
								id,
								answer.answers.length,
							);
						}
						json(res, { ok: true });
					} catch (e) {
						json(res, { ok: false, error: safeError(e) }, 400);
					}
				},
			}),
		);

		// Web 终端：WS 升级 -> 独立 PTY shell 连接。帧协议与 dsh-ssh 相同：
		// server->client {ready|output|exit}, client->server {input|resize}。
		{
			const termWss = new WebSocketServer({
				noServer: true,
				maxPayload: 64 * 1024,
				handleProtocols: selectAuthenticatedWebSocketProtocol,
			});
			const terminalClients = new Set();
			const terminalSlots = new Set();
			routeDisposers.push(
				ctx.webServer.registerUpgrade({
					path: "/sched/ws/ssh-terminal",
					handler: (req, socket, head) => {
						const principal = websocketRequestPrincipal(req, browserAuth);
						if (!principal) {
							socket.destroy();
							return;
						}
						let alias;
						let requestedTransport;
						let openShell;
						let openDeadlineAt;
						try {
							const requestUrl = new URL(req.url, "http://x");
							alias = requestUrl.searchParams.get("alias") ?? "";
							requestedTransport = requestUrl.searchParams.get("transport") || "engine";
							if (requestedTransport === "system-openssh") {
								const target = captureTransportTarget();
								if (target.mode !== "system-openssh" || alias !== target.sshEntry || !target.transport) {
									throw new Error("system OpenSSH terminal target is not active");
								}
								const transport = target.transport;
								openShell = (_alias, size, options) => transport.openPty(size, options);
								openDeadlineAt = Date.now() + Math.max(5_000, config.connectTimeoutSec * 1000);
							} else if (requestedTransport === "engine") {
								refreshSshStore();
								openShell = (...args) => sshEngine.openShell(...args);
								openDeadlineAt = sshOpenDeadlineAt(sshEngine);
							} else {
								throw new Error("unsupported terminal transport");
							}
						} catch {
							socket.destroy();
							return;
						}
						const opening = beginPendingOpen(terminalSlots, 4);
						if (!opening) {
							socket.destroy();
							return;
						}
						let handedOff = false;
						let admissionClosed = false;
						const releaseUnhanded = () => {
							if (handedOff) return;
							admissionClosed = true;
							opening.settle();
						};
						socket.once?.("close", releaseUnhanded);
						socket.once?.("error", releaseUnhanded);
						try {
							termWss.handleUpgrade(req, socket, head, (ws) => {
								if (admissionClosed) {
									try { ws.close(1013, "terminal admission closed"); } catch { /* gone */ }
									return;
								}
								socket.off?.("close", releaseUnhanded);
								socket.off?.("error", releaseUnhanded);
								handedOff = true;
								browserAuth.trackConnection(ws, principal);
								const u = new URL(req.url, "http://x");
								const cols = clamp(parseInt(u.searchParams.get("cols") || "80", 10) || 80, 20, 500);
								const rows = clamp(parseInt(u.searchParams.get("rows") || "24", 10) || 24, 10, 200);
								void serveTerminalWebSocket({
									ws,
									clients: terminalClients,
									slots: terminalSlots,
									maxSlots: 4,
									opening,
									openShell,
									openDeadlineAt,
									alias,
									cols,
									rows,
								});
							});
						} catch {
							releaseUnhanded();
							socket.destroy();
						}
					},
				}),
			);
			routeDisposers.push(() => {
				for (const ws of terminalClients) {
					try { ws.close(1001, "node-sched disposed"); } catch { /* gone */ }
				}
				abortPendingOpens(terminalSlots, new Error("node-sched disposed"));
				terminalClients.clear();
				try { termWss.close(); } catch { /* already closed */ }
			});
		}
	}

	return () => {
		for (const d of disposers) { try { d?.(); } catch { /* already gone */ } }
		for (const d of routeDisposers) { try { d?.(); } catch { /* already gone */ } }
		clearInterval(heartbeat);
		stopRefresher();
		postApplyCleanup?.();
		browserAuth?.close();
	};
}

export {
	AuthChallengeBroker,
	ByteLineFramer,
	FreshStatusCache,
	WriteGate,
	Config,
	apply,
	buildRemoteInboxWriteCommand,
	buildHistoryCommand,
	buildOperationCommand,
	buildStatusCommand,
	buildTaskCommand,
	executeGenericSsh,
	guardMutationRequest,
	guardSameOriginPostRequest,
	canonicalHistoryDocument,
	canonicalStatusDocument,
	isCanonicalStatusDocument,
	appendPrivateClientLog,
	parseBoundedJson,
	guardReadRequest,
	beginPendingOpen,
	inject,
	makeRunner,
	loadOrCreateAccessToken,
	websocketRequestAllowed,
	websocketRequestPrincipal,
	name,
	operationHttpResult,
	resolveMutationWriter,
	verifyAndExecuteMutation,
	assertMutationPreconditions,
	gcPrivateUploads,
	writePrivateUpload,
	buildIdempotentMutationCommand,
	durableUploadName,
	serveTerminalWebSocket,
	stopProcessTreeWithGrace,
	summarizeStatus,
};
export default { name, inject, Config, apply };
