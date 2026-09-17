import cp from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
	appendLimitedOutput,
	createLimitedOutput,
	finalizeLimitedOutput,
	limitedOutputText,
} from "./output-limit.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MASTER_CHECK_TIMEOUT_MS = 5_000;
const DEFAULT_TERM_GRACE_MS = 1_000;
const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const DEFAULT_PTY_EARLY_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_CONFIG_OUTPUT_BYTES = 256 * 1024;
const DEFAULT_MISSING_MASTER_TTL_MS = 30_000;
const MAX_SSH_ENTRY_BYTES = 255;
const SSH_ENTRY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@%+:[\]-]*$/;
const require = createRequire(import.meta.url);

function loadNodePty() {
	try {
		return require("node-pty");
	} catch (cause) {
		const error = new Error(
			"system OpenSSH terminal requires the optional native node-pty runtime",
			{ cause },
		);
		error.code = "system_openssh_pty_unavailable";
		throw error;
	}
}

function positiveNumber(value, fallback) {
	return Number.isFinite(value) && value > 0 ? value : fallback;
}

function nonNegativeNumber(value, fallback) {
	return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function normalizeOutputLimit(value, fallback = DEFAULT_MAX_OUTPUT_BYTES) {
	if (!Number.isFinite(value)) return fallback;
	return Math.max(0, Math.floor(value));
}

export function validateSshEntry(value) {
	if (
		typeof value !== "string"
		|| Buffer.byteLength(value, "utf8") > MAX_SSH_ENTRY_BYTES
		|| !SSH_ENTRY_PATTERN.test(value)
	) {
		throw new TypeError(
			"sshEntry must be at most 255 bytes, start with a letter or digit, and use only common OpenSSH Host alias characters",
		);
	}
	return value;
}

export function parseOpenSshControlPath(output, { home = os.homedir() } = {}) {
	if (typeof output !== "string") throw new TypeError("ssh -G output must be a string");
	const values = [];
	for (const line of output.split(/\r?\n/)) {
		const match = /^controlpath\s+(.+)$/i.exec(line.trim());
		if (match) values.push(match[1].trim());
	}
	if (values.length > 1) throw new TypeError("ssh -G returned multiple OpenSSH ControlPath values");
	let [value] = values;
	if (!value || value.toLowerCase() === "none") return null;
	if (value.startsWith("~/")) value = path.join(home, value.slice(2));
	if (value.includes("\0") || value.includes("\r") || value.includes("\n")) {
		throw new TypeError("OpenSSH ControlPath contains a control character");
	}
	if (value.includes("%")) {
		throw new TypeError("OpenSSH ControlPath still contains an unresolved token");
	}
	if (!path.isAbsolute(value)) {
		throw new TypeError("OpenSSH ControlPath must resolve to an absolute path");
	}
	if (Buffer.byteLength(value, "utf8") > 4096) {
		throw new TypeError("OpenSSH ControlPath is too long");
	}
	return value;
}

function validateRemoteCommand(command) {
	if (typeof command !== "string" || command.includes("\0")) {
		throw new TypeError("remote command must be a string without NUL bytes");
	}
	return command;
}

function errorText(error) {
	if (!error) return "";
	return error instanceof Error ? error.message : String(error);
}

function appendError(target, message, maxOutputBytes) {
	if (!message) return;
	appendLimitedOutput(
		target,
		Buffer.from(`${target.bytes || target.pending?.length ? "\n" : ""}${message}`, "utf8"),
		maxOutputBytes,
	);
}

function terminateProcessTree(child, signal, groupPid, killProcess) {
	if (process.platform !== "win32" && Number.isInteger(groupPid)) {
		try {
			killProcess(-groupPid, signal);
			return;
		} catch {
			// The tracked group may already be gone. Fall back only to this child.
		}
	}
	try { child?.kill?.(signal); } catch { /* process is already gone */ }
}

function abortedResult(started) {
	return {
		ok: false,
		code: -1,
		signal: null,
		stdout: "",
		stderr: "operation aborted",
		error: "operation aborted",
		timedOut: false,
		aborted: true,
		durationMs: Date.now() - started,
	};
}

function runProcess({
	childProcess,
	killProcess,
	file,
	args,
	timeoutMs,
	termGraceMs,
	maxOutputBytes,
	stdinData,
	signal,
	onStart,
	onProcessClose,
}) {
	const started = Date.now();
	if (signal?.aborted) return Promise.resolve(abortedResult(started));

	return new Promise((resolve) => {
		const stdout = createLimitedOutput();
		const stderr = createLimitedOutput();
		const detached = process.platform !== "win32";
		let child;
		let groupPid;
		let leaderExited = false;
		let leaderCode = -1;
		let leaderSignal = null;
		let settled = false;
		let timedOut = false;
		let aborted = false;
		let terminalError = "";
		let deadlineTimer;
		let graceTimer;
		let stopping = false;

		const finish = (code = leaderCode, closeSignal = leaderSignal) => {
			if (settled) return;
			settled = true;
			groupPid = undefined;
			clearTimeout(deadlineTimer);
			clearTimeout(graceTimer);
			signal?.removeEventListener?.("abort", abort);
			onProcessClose?.(child);
			if (terminalError) appendError(stderr, terminalError, maxOutputBytes);
			finalizeLimitedOutput(stdout);
			finalizeLimitedOutput(stderr);
			resolve({
				ok: !terminalError && !timedOut && !aborted && code === 0,
				code: code ?? -1,
				signal: closeSignal ?? null,
				stdout: limitedOutputText(stdout),
				stderr: limitedOutputText(stderr).trim(),
				error: terminalError || undefined,
				timedOut,
				aborted,
				durationMs: Date.now() - started,
			});
		};

		const stop = (reason, { timedOut: didTimeOut = false, aborted: wasAborted = false } = {}) => {
			if (settled || stopping) return;
			stopping = true;
			timedOut ||= didTimeOut;
			aborted ||= wasAborted;
			terminalError ||= reason;
			if (leaderExited) {
				finish();
				return;
			}
			terminateProcessTree(child, "SIGTERM", groupPid, killProcess);
			graceTimer = setTimeout(() => {
				graceTimer = undefined;
				if (!leaderExited) terminateProcessTree(child, "SIGKILL", groupPid, killProcess);
				finish();
			}, termGraceMs);
		};

		const abort = () => stop("operation aborted", { aborted: true });

		try {
			child = childProcess.spawn(file, args, {
				stdio: ["pipe", "pipe", "pipe"],
				detached,
				shell: false,
				windowsHide: true,
			});
			if (detached && Number.isInteger(child.pid)) groupPid = child.pid;
			onStart?.(child, stop);
		} catch (error) {
			terminalError = errorText(error);
			finish(-1);
			return;
		}

		deadlineTimer = setTimeout(() => {
			stop(`process timed out after ${timeoutMs} ms`, { timedOut: true });
		}, timeoutMs);
		child.stdout?.on?.("data", (data) => appendLimitedOutput(stdout, data, maxOutputBytes));
		child.stderr?.on?.("data", (data) => appendLimitedOutput(stderr, data, maxOutputBytes));
		child.on?.("exit", (code, exitSignal) => {
			leaderExited = true;
			leaderCode = code ?? -1;
			leaderSignal = exitSignal ?? null;
			// Never retain a process-group ID after its leader exits: the PID can be reused.
			groupPid = undefined;
		});
		child.on?.("error", (error) => {
			terminalError ||= errorText(error);
			if (!Number.isInteger(child.pid)) finish(-1);
		});
		child.on?.("close", (code, closeSignal) => {
			finish(code ?? leaderCode, closeSignal ?? leaderSignal);
		});
		signal?.addEventListener?.("abort", abort, { once: true });
		if (signal?.aborted) {
			abort();
			return;
		}

		child.stdin?.on?.("error", (error) => {
			if (error?.code === "EPIPE") return;
			terminalError ||= errorText(error);
		});
		try {
			child.stdin?.end?.(stdinData);
		} catch (error) {
			if (error?.code !== "EPIPE") {
				terminalError ||= errorText(error);
			}
		}
	});
}

function masterFailure(sshEntry, result, checkedAt, controlPath) {
	if (result.aborted) {
		return {
			ready: false,
			checkedAt,
			code: "operation_aborted",
			error: "OpenSSH ControlMaster check was aborted.",
		};
	}
	// Diagnose WHY the mux check failed so the dashboard banner says more than
	// "log in first": the common real-world causes (master never started,
	// ControlPersist expired, stale socket, ControlPath longer than the OS
	// Unix-socket limit) are otherwise indistinguishable.
	let diagnosis = "";
	if (result.timedOut) {
		diagnosis = "The ControlMaster check timed out.";
	} else if (controlPath) {
		const stderr = String(result.stderr ?? result.error ?? "").trim();
		const controlPathBytes = Buffer.byteLength(controlPath, "utf8");
		if (!socketExists(controlPath)) {
			diagnosis = `mux socket ${controlPath} does not exist — no ControlMaster for this host is running (or ControlPersist already expired). Connect with ssh ${sshEntry} in a terminal first.`;
			if (controlPathBytes > 100) {
				diagnosis += ` ControlPath is ${controlPathBytes} bytes; most platforms cannot bind sockets above ~104 bytes, so shorten ControlPath in ~/.ssh/config.`;
			}
		} else if (stderr) {
			diagnosis = `mux socket ${controlPath} exists but 'ssh -O check' failed: ${stderr}. The socket may be stale — reconnect with ssh ${sshEntry}.`;
		} else {
			diagnosis = `mux socket ${controlPath} exists but 'ssh -O check' failed (exit code ${result.code ?? "?"}). The socket may be stale — reconnect with ssh ${sshEntry}.`;
		}
	}
	const suffix = result.timedOut && !diagnosis
		? " (ControlMaster check timed out)"
		: "";
	return {
		ready: false,
		checkedAt,
		code: "no_control_master",
		error: `No active OpenSSH ControlMaster for ${sshEntry}${suffix}. ${diagnosis || `Connect with ssh ${sshEntry} in a terminal first.`}`.trim(),
	};
}

function socketExists(controlPath, fsModule = fs) {
	try {
		return Boolean(fsModule.existsSync?.(controlPath));
	} catch {
		return false;
	}
}

function controlPathFailure(sshEntry, result, checkedAt, detail) {
	if (result?.aborted) {
		return {
			ready: false,
			checkedAt,
			code: "operation_aborted",
			error: "OpenSSH ControlPath resolution was aborted.",
		};
	}
	const suffix = result?.timedOut ? " (ssh -G timed out)" : "";
	return {
		ready: false,
		checkedAt,
		code: "no_control_master",
		error: `No usable OpenSSH ControlPath for ${sshEntry}${suffix}. ${detail || `Configure ControlMaster/ControlPath and connect with ssh ${sshEntry} first.`}`.trim(),
	};
}

export function systemOpenSshControlMasterSupported(platform = process.platform) {
	return platform !== "win32";
}

export class NoOpenSshMasterError extends Error {
	constructor(sshEntry, status) {
		super(status?.error || `No active OpenSSH ControlMaster for ${sshEntry}`);
		this.name = "NoOpenSshMasterError";
		this.code = "no_control_master";
		this.sshEntry = sshEntry;
		this.checkedAt = status?.checkedAt;
	}
}

function controlMasterStatusError(sshEntry, status) {
	if (status?.code === "operation_aborted") {
		const error = new Error(status.error || "operation aborted");
		error.name = "AbortError";
		error.code = "operation_aborted";
		return error;
	}
	return new NoOpenSshMasterError(sshEntry, status);
}

/**
 * Transport that delegates to the user's system OpenSSH client so commands can
 * reuse an already authenticated ControlMaster. It never accepts or stores an
 * OTP/password and BatchMode prevents OpenSSH from prompting for one.
 */
export class SystemOpenSshTransport {
	constructor(options = {}) {
		if (!systemOpenSshControlMasterSupported(options.platform)) {
			const error = new Error("system OpenSSH ControlMaster transport is not supported on Windows");
			error.code = "system_openssh_unsupported";
			throw error;
		}
		for (const field of ["password", "otp", "passphrase", "credentials", "auth", "keyboardInteractive"]) {
			if (Object.hasOwn(options, field)) {
				throw new TypeError(`SystemOpenSshTransport does not accept authentication field '${field}'`);
			}
		}
		this.sshEntry = validateSshEntry(options.sshEntry);
		this.sshBinary = typeof options.sshBinary === "string" && options.sshBinary
			? options.sshBinary
			: "ssh";
		this.connectTimeoutSec = Math.max(1, Math.floor(positiveNumber(options.connectTimeoutSec, 20)));
		this.timeoutMs = positiveNumber(options.timeoutMs, DEFAULT_TIMEOUT_MS);
		this.masterCheckTimeoutMs = positiveNumber(
			options.masterCheckTimeoutMs,
			DEFAULT_MASTER_CHECK_TIMEOUT_MS,
		);
		this.missingMasterTtlMs = nonNegativeNumber(
			options.missingMasterTtlMs,
			DEFAULT_MISSING_MASTER_TTL_MS,
		);
		this.termGraceMs = nonNegativeNumber(options.termGraceMs, DEFAULT_TERM_GRACE_MS);
		this.maxOutputBytes = normalizeOutputLimit(options.maxOutputBytes);
		this.childProcess = options.childProcess || cp;
		this.killProcess = options.killProcess || process.kill.bind(process);
		this.ptyModule = options.ptyModule;
		this.ptyLoader = options.ptyLoader || loadNodePty;
		this.children = new Map();
		this.streams = new Set();
		this.ptys = new Set();
		this.masterCheckInFlight = null;
		this.missingMasterCache = null;
		this.disposed = false;
	}

	_assertActive() {
		if (this.disposed) throw new Error("SystemOpenSshTransport is disposed");
	}

	_commandArgs(command, controlPath) {
		return ["-T", ...this._masterOnlyArgs(), "-S", controlPath, this.sshEntry, validateRemoteCommand(command)];
	}

	_masterOnlyArgs() {
		return [
			"-o",
			"BatchMode=yes",
			"-o",
			"ControlMaster=no",
			"-o",
			"ClearAllForwardings=yes",
			"-o",
			"ForwardAgent=no",
			"-o",
			"ForwardX11=no",
			"-o",
			"PermitLocalCommand=no",
			"-o",
			"ForkAfterAuthentication=no",
			"-o",
			"Tunnel=no",
			"-o",
			"ProxyCommand=false",
			"-o",
			"ConnectionAttempts=1",
			"-o",
			`ConnectTimeout=${this.connectTimeoutSec}`,
		];
	}

	_ptyArgs(controlPath) {
		return ["-tt", "-e", "none", ...this._masterOnlyArgs(), "-S", controlPath, this.sshEntry];
	}

	_configArgs() {
		// -G exits before SSH transport/authentication. User configuration may still
		// run Match exec locally or perform DNS during hostname canonicalization.
		return ["-G", "-o", "BatchMode=yes", this.sshEntry];
	}

	_masterCheckArgs(controlPath) {
		// -O check only contacts this exact mux socket; it cannot create a new SSH session.
		return ["-o", "BatchMode=yes", "-S", controlPath, "-O", "check", this.sshEntry];
	}

	_run(args, options = {}) {
		this._assertActive();
		const timeoutMs = positiveNumber(options.timeoutMs, this.timeoutMs);
		const maxOutputBytes = normalizeOutputLimit(options.maxOutputBytes, this.maxOutputBytes);
		return runProcess({
			childProcess: this.childProcess,
			killProcess: this.killProcess,
			file: this.sshBinary,
			args,
			timeoutMs,
			termGraceMs: nonNegativeNumber(options.termGraceMs, this.termGraceMs),
			maxOutputBytes,
			stdinData: options.stdinData,
			signal: options.signal,
			onStart: (child, stop) => this.children.set(child, stop),
			onProcessClose: (child) => this.children.delete(child),
		}).finally(() => {
			// Spawn errors can settle without a close event.
			for (const [child] of this.children) {
				if (!Number.isInteger(child?.pid)) this.children.delete(child);
			}
		});
	}

	async _probeMaster(options = {}) {
		this._assertActive();
		const checkedAt = new Date().toISOString();
		const started = Date.now();
		const timeoutMs = Math.min(
			positiveNumber(options.timeoutMs, this.masterCheckTimeoutMs),
			this.masterCheckTimeoutMs,
		);
		const configResult = await this._run(this._configArgs(), {
			...options,
			timeoutMs,
			maxOutputBytes: DEFAULT_CONFIG_OUTPUT_BYTES,
			stdinData: undefined,
		});
		if (!configResult.ok) return controlPathFailure(this.sshEntry, configResult, checkedAt);

		let controlPath;
		try {
			controlPath = parseOpenSshControlPath(configResult.stdout);
		} catch (error) {
			return controlPathFailure(this.sshEntry, configResult, checkedAt, errorText(error));
		}
		if (!controlPath) {
			return controlPathFailure(this.sshEntry, configResult, checkedAt,
				"ssh -G reports no ControlPath (none) for this host — add 'ControlMaster auto' and 'ControlPath' under this Host in ~/.ssh/config, then connect with ssh once.");
		}
		const remainingMs = Math.max(1, timeoutMs - (Date.now() - started));
		const result = await this._run(this._masterCheckArgs(controlPath), {
			...options,
			timeoutMs: remainingMs,
			stdinData: undefined,
		});
		if (result.ok) return { ready: true, checkedAt, controlPath };
		return masterFailure(this.sshEntry, result, checkedAt, controlPath);
	}

	_waitForMasterProbe(record, { signal, timeoutMs } = {}) {
		if (signal?.aborted) {
			return Promise.resolve({
				ready: false,
				checkedAt: new Date().toISOString(),
				code: "operation_aborted",
				error: "OpenSSH ControlMaster check was aborted.",
			});
		}
		const waitMs = Math.min(
			positiveNumber(timeoutMs, this.masterCheckTimeoutMs),
			this.masterCheckTimeoutMs,
		);
		const waiterDeadlineAt = Date.now() + waitMs;
		if (!signal && waiterDeadlineAt >= record.deadlineAt) return record.promise;

		return new Promise((resolve, reject) => {
			let settled = false;
			let timer;
			const cleanup = () => {
				clearTimeout(timer);
				signal?.removeEventListener?.("abort", abort);
			};
			const finish = (value) => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve(value);
			};
			const fail = (error) => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(error);
			};
			const abort = () => finish({
				ready: false,
				checkedAt: new Date().toISOString(),
				code: "operation_aborted",
				error: "OpenSSH ControlMaster check was aborted.",
			});

			record.promise.then(finish, fail);
			signal?.addEventListener?.("abort", abort, { once: true });
			if (signal?.aborted) {
				abort();
				return;
			}
			timer = setTimeout(() => finish(masterFailure(
				this.sshEntry,
				{ timedOut: true },
				new Date().toISOString(),
				undefined,
			)), Math.max(1, waiterDeadlineAt - Date.now()));
		});
	}

	_checkMasterWithPath(options = {}) {
		this._assertActive();
		if (options.signal?.aborted) {
			return Promise.resolve({
				ready: false,
				checkedAt: new Date().toISOString(),
				code: "operation_aborted",
				error: "OpenSSH ControlMaster check was aborted.",
			});
		}
		if (options.force === true) this.missingMasterCache = null;
		const cached = this.missingMasterCache;
		if (options.force !== true && cached) {
			if (cached.expiresAt > Date.now()) return Promise.resolve(cached.status);
			this.missingMasterCache = null;
		}

		let record = this.masterCheckInFlight;
		if (!record) {
			const timeoutMs = Math.min(
				positiveNumber(options.timeoutMs, this.masterCheckTimeoutMs),
				this.masterCheckTimeoutMs,
			);
			record = {
				promise: null,
				deadlineAt: Date.now() + timeoutMs,
				// A caller with an unusually tiny total deadline must not poison
				// normal polling with a 30-second negative result.
				cacheMissing: timeoutMs >= this.masterCheckTimeoutMs,
			};
			const probeOptions = { ...options, timeoutMs, signal: undefined };
			delete probeOptions.force;
			record.promise = this._probeMaster(probeOptions)
				.then((status) => {
					if (!this.disposed && status.ready) {
						this.missingMasterCache = null;
					} else if (
						!this.disposed
						&& record.cacheMissing
						&& status.code === "no_control_master"
						&& this.missingMasterTtlMs > 0
					) {
						this.missingMasterCache = {
							status,
							expiresAt: Date.now() + this.missingMasterTtlMs,
						};
					}
					return status;
				})
				.finally(() => {
					if (this.masterCheckInFlight === record) this.masterCheckInFlight = null;
				});
			this.masterCheckInFlight = record;
		}
		return this._waitForMasterProbe(record, options);
	}

	async checkMaster(options = {}) {
		const { controlPath: _controlPath, ...status } = await this._checkMasterWithPath(options);
		return status;
	}

	async requireMaster(options = {}) {
		const status = await this._checkMasterWithPath(options);
		if (!status.ready) throw controlMasterStatusError(this.sshEntry, status);
		return status;
	}

	async exec(command, options = {}) {
		const started = Date.now();
		const timeoutMs = positiveNumber(options.timeoutMs, this.timeoutMs);
		const master = await this._checkMasterWithPath({
			signal: options.signal,
			timeoutMs: Math.min(timeoutMs, this.masterCheckTimeoutMs),
			maxOutputBytes: options.maxOutputBytes,
		});
		if (!master.ready) {
			if (master.code === "operation_aborted") return abortedResult(started);
			throw new NoOpenSshMasterError(this.sshEntry, master);
		}
		const remainingMs = Math.max(1, timeoutMs - (Date.now() - started));
		return this._run(this._commandArgs(command, master.controlPath), { ...options, timeoutMs: remainingMs });
	}

	execStdin(command, data, options = {}) {
		return this.exec(command, { ...options, stdinData: data });
	}

	async openStream(command, options = {}) {
		this._assertActive();
		const master = await this.requireMaster({
			signal: options.signal,
			timeoutMs: positiveNumber(options.masterCheckTimeoutMs, this.masterCheckTimeoutMs),
			maxOutputBytes: options.maxOutputBytes,
		});
		this._assertActive();
		if (options.signal?.aborted) throw new DOMException("operation aborted", "AbortError");

		const child = this.childProcess.spawn(this.sshBinary, this._commandArgs(command, master.controlPath), {
			stdio: ["ignore", "pipe", "pipe"],
			detached: process.platform !== "win32",
			shell: false,
			windowsHide: true,
		});
		let groupPid = process.platform !== "win32" && Number.isInteger(child.pid) ? child.pid : undefined;
		let closed = false;
		let closeNotified = false;
		let stopping = false;
		let leaderExited = false;
		let timedOut = false;
		let aborted = false;
		let terminalError = "";
		let onData;
		let onClose;
		let deadlineTimer;
		let graceTimer;
		const stdoutDecoder = new StringDecoder("utf8");
		const stderrDecoder = new StringDecoder("utf8");
		const pending = createLimitedOutput();
		const maxPendingBytes = normalizeOutputLimit(options.maxOutputBytes, this.maxOutputBytes);
		let resolveClosed;
		const closedPromise = new Promise((resolve) => { resolveClosed = resolve; });

		const notifyClose = (outcome) => {
			if (closed) return;
			closed = true;
			clearTimeout(deadlineTimer);
			clearTimeout(graceTimer);
			options.signal?.removeEventListener?.("abort", abort);
			this.children.delete(child);
			this.streams.delete(session);
			resolveClosed(outcome);
			if (onClose && !closeNotified) {
				closeNotified = true;
				onClose(outcome);
			}
		};

		const deliver = (text) => {
			if (!text) return;
			const chunk = Buffer.from(text, "utf8");
			if (onData) onData(chunk);
			else appendLimitedOutput(pending, chunk, maxPendingBytes);
		};

		const flushPending = () => {
			if (!onData || (!pending.bytes && !pending.pending.length && !pending.truncated)) return;
			finalizeLimitedOutput(pending);
			const text = limitedOutputText(pending);
			if (text) onData(Buffer.from(text, "utf8"));
			pending.text = "";
			pending.bytes = 0;
			pending.droppedBytes = 0;
			pending.truncated = false;
			pending.pending = Buffer.alloc(0);
		};

		const stop = (reason = "stream closed", flags = {}) => {
			if (closed || stopping) return;
			stopping = true;
			timedOut ||= flags.timedOut === true;
			aborted ||= flags.aborted === true;
			terminalError ||= reason;
			if (leaderExited) {
				notifyClose({ code: -1, signal: null, error: terminalError, timedOut, aborted });
				return;
			}
			terminateProcessTree(child, "SIGTERM", groupPid, this.killProcess);
			graceTimer = setTimeout(() => {
				graceTimer = undefined;
				terminateProcessTree(child, "SIGKILL", groupPid, this.killProcess);
				groupPid = undefined;
				notifyClose({ code: -1, signal: null, error: terminalError, timedOut, aborted });
			}, nonNegativeNumber(options.termGraceMs, this.termGraceMs));
		};

		const abort = () => stop("operation aborted", { aborted: true });
		const session = {
			get onData() { return onData; },
			set onData(handler) {
				onData = typeof handler === "function" ? handler : undefined;
				flushPending();
			},
			get onClose() { return onClose; },
			set onClose(handler) {
				onClose = typeof handler === "function" ? handler : undefined;
				if (closed && onClose && !closeNotified) {
					closeNotified = true;
					closedPromise.then(onClose);
				}
			},
			closed: closedPromise,
			close: () => stop(),
			pause: () => { child.stdout?.pause?.(); child.stderr?.pause?.(); },
			resume: () => { child.stdout?.resume?.(); child.stderr?.resume?.(); },
		};

		this.children.set(child, stop);
		this.streams.add(session);
		child.stdout?.on?.("data", (chunk) => deliver(stdoutDecoder.write(chunk)));
		child.stderr?.on?.("data", (chunk) => deliver(stderrDecoder.write(chunk)));
		child.on?.("exit", () => {
			leaderExited = true;
			groupPid = undefined;
		});
		child.on?.("error", (error) => {
			terminalError ||= errorText(error);
		});
		child.on?.("close", (code, closeSignal) => {
			deliver(stdoutDecoder.end());
			deliver(stderrDecoder.end());
			notifyClose({
				code: code ?? -1,
				signal: closeSignal ?? null,
				error: terminalError || undefined,
				timedOut,
				aborted,
			});
		});
		options.signal?.addEventListener?.("abort", abort, { once: true });
		if (options.signal?.aborted) abort();
		const streamTimeoutMs = nonNegativeNumber(options.timeoutMs, 0);
		if (streamTimeoutMs > 0) {
			deadlineTimer = setTimeout(
				() => stop(`stream timed out after ${streamTimeoutMs} ms`, { timedOut: true }),
				streamTimeoutMs,
			);
		}
		return session;
	}

	async openPty(size = {}, options = {}) {
		this._assertActive();
		const deadlineAt = Number.isFinite(options.deadlineAt) ? options.deadlineAt : undefined;
		const checkTimeoutMs = deadlineAt === undefined
			? this.masterCheckTimeoutMs
			: Math.max(1, Math.min(this.masterCheckTimeoutMs, deadlineAt - Date.now()));
		const master = await this.requireMaster({ signal: options.signal, timeoutMs: checkTimeoutMs });
		this._assertActive();
		if (options.signal?.aborted) throw new DOMException("operation aborted", "AbortError");
		if (deadlineAt !== undefined && deadlineAt <= Date.now()) {
			const error = new Error("system OpenSSH terminal open timed out");
			error.code = "system_openssh_pty_timeout";
			throw error;
		}

		let ptyModule;
		try {
			ptyModule = this.ptyModule || this.ptyLoader();
		} catch (cause) {
			if (cause instanceof Error && cause.code) throw cause;
			const error = new Error(`failed to load node-pty: ${errorText(cause)}`, { cause });
			error.code = "system_openssh_pty_unavailable";
			throw error;
		}
		if (typeof ptyModule?.spawn !== "function") {
			const error = new Error("node-pty runtime does not export spawn()");
			error.code = "system_openssh_pty_unavailable";
			throw error;
		}

		const cols = Math.max(20, Math.min(500, Math.floor(Number(size.cols) || 80)));
		const rows = Math.max(10, Math.min(200, Math.floor(Number(size.rows) || 24)));
		let ptyProcess;
		try {
			ptyProcess = ptyModule.spawn(this.sshBinary, this._ptyArgs(master.controlPath), {
				name: "xterm-256color",
				cols,
				rows,
				cwd: os.homedir(),
				env: { ...process.env, TERM: "xterm-256color" },
			});
		} catch (cause) {
			const error = new Error(`failed to start system OpenSSH PTY: ${errorText(cause)}`, { cause });
			error.code = "system_openssh_pty_unavailable";
			throw error;
		}

		let onData;
		let onExit;
		let exited = false;
		let closing = false;
		let exitValue;
		let earlyOutput = "";
		let earlyOutputBytes = 0;
		let earlyOverflow;
		let killTimer;
		const disposables = [];
		const maxEarlyBytes = normalizeOutputLimit(
			options.maxEarlyOutputBytes,
			DEFAULT_PTY_EARLY_OUTPUT_BYTES,
		);

		const disposeListeners = () => {
			while (disposables.length) {
				try { disposables.pop()?.dispose?.(); } catch { /* already detached */ }
			}
		};
		const kill = (signal = "SIGTERM") => {
			try { ptyProcess.kill(signal); } catch { /* already exited */ }
		};
		const close = () => {
			if (closing || exited) return;
			closing = true;
			kill("SIGTERM");
			killTimer = setTimeout(() => {
				killTimer = undefined;
				if (!exited) kill("SIGKILL");
			}, this.termGraceMs);
			killTimer.unref?.();
		};
		const replayExit = () => {
			if (!onExit || !exitValue) return;
			const { code, error } = exitValue;
			exitValue = undefined;
			onExit(code, error);
		};
		const session = {
			send: (data) => {
				if (exited || closing) return;
				try { ptyProcess.write(String(data)); } catch { /* already exited */ }
			},
			resize: (nextCols, nextRows) => {
				if (exited || closing) return;
				try {
					ptyProcess.resize(
						Math.max(20, Math.min(500, Math.floor(Number(nextCols) || 80))),
						Math.max(10, Math.min(200, Math.floor(Number(nextRows) || 24))),
					);
				} catch { /* already exited */ }
			},
			close,
			pause: () => { try { ptyProcess.pause?.(); } catch { /* already exited */ } },
			resume: () => { try { ptyProcess.resume?.(); } catch { /* already exited */ } },
			get onData() { return onData; },
			set onData(handler) {
				onData = typeof handler === "function" ? handler : undefined;
				if (onData && earlyOutput) {
					const buffered = earlyOutput;
					earlyOutput = "";
					earlyOutputBytes = 0;
					onData(buffered);
				}
			},
			get onExit() { return onExit; },
			set onExit(handler) {
				onExit = typeof handler === "function" ? handler : undefined;
				replayExit();
			},
		};

		this.ptys.add(session);
		disposables.push(ptyProcess.onData((data) => {
			if (exited) return;
			const text = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
			if (onData) {
				onData(text);
				return;
			}
			const bytes = Buffer.byteLength(text, "utf8");
			if (earlyOutputBytes + bytes <= maxEarlyBytes) {
				earlyOutput += text;
				earlyOutputBytes += bytes;
				return;
			}
			earlyOverflow = new Error(`system OpenSSH PTY early output exceeded ${maxEarlyBytes} bytes`);
			earlyOverflow.code = "system_openssh_pty_output_overflow";
			close();
		}));
		disposables.push(ptyProcess.onExit(({ exitCode, signal }) => {
			if (exited) return;
			exited = true;
			clearTimeout(killTimer);
			options.signal?.removeEventListener?.("abort", close);
			this.ptys.delete(session);
			disposeListeners();
			const detail = earlyOverflow
				?? (signal ? new Error(`system OpenSSH PTY exited on signal ${signal}`) : undefined);
			exitValue = { code: Number.isInteger(exitCode) ? exitCode : null, error: detail };
			replayExit();
		}));
		options.signal?.addEventListener?.("abort", close, { once: true });
		if (options.signal?.aborted) close();
		return session;
	}

	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		this.missingMasterCache = null;
		for (const pty of [...this.ptys]) pty.close();
		for (const stream of [...this.streams]) stream.close();
		for (const stop of this.children.values()) stop("transport disposed", { aborted: true });
	}
}
