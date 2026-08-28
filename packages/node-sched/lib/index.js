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
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { WebSocketServer } from "ws";
import { HostStore, SshEngine, openExecStream } from "./ssh-engine.js";
import { LocalTransport } from "./transport.js";
import { isLoopbackAddress, loopbackRequestAllowed, originHostAllowed } from "./request-guard.js";
import { parseUploadedPath } from "./upload-path.js";
import { mergeEntryOverride } from "./entry-override.js";

const name = "node-sched";

/**
 * Config is deployment truth only — no account/node/path may leak into code
 * (same discipline as sched's own I/J-class config separation). The ssh entry
 * MUST be explicit: HPDC (campus) vs HPDC_outside; the plugin never switches
 * entries on its own (AGENTS.md §1 discipline).
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
	/** Transport for sched commands: auto keeps SSH compatibility, local runs on this host. */
	transport: z.union([z.const("auto"), z.const("local")]).default("auto")
});

const inject = ["tools", "systemPrompt", "webServer"];

/** One in-flight write operation per target, so double-clicks cannot double-kill. */
class WriteGate {
	constructor() {
		/** @type {Map<string, Promise<unknown>>} */
		this.inflight = new Map();
	}

	run(key, fn) {
		if (this.inflight.has(key)) {
			return Promise.reject(
				new Error(`node-sched: operation already in flight: ${key} (refusing concurrent write)`),
			);
		}
		const p = fn().finally(() => this.inflight.delete(key));
		this.inflight.set(key, p);
		return p;
	}
}

function makeRunner(cp, cfg) {
return function runRemote(args, {
		timeoutMs = 120_000,
		maxOutputBytes = 2 * 1024 * 1024,
		sshEntry = cfg.sshEntry,
	} = {}) {
		// spawn with an argv array: no local shell => no local $-expansion;
		// the remote command reaches the remote bash verbatim ($HOME expands there).
		const child = cp.spawn(
			"ssh",
			["-o", `ConnectTimeout=${cfg.connectTimeoutSec}`, "-o", "BatchMode=yes", sshEntry, args],
			{ timeout: timeoutMs },
		);
		return new Promise((resolve) => {
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (d) => { stdout += d; });
			child.stderr.on("data", (d) => { stderr += d; });
			child.on("error", (err) => resolve({ ok: false, code: -1, stdout, stderr: `${stderr}${err.message}` }));
			child.on("close", (code) => resolve({ ok: code === 0, code: code ?? -1, stdout, stderr }));
		});
	};
}

function shellQuote(s) {
	return `'${String(s).replaceAll("'", `'\\''`)}'`;
}

function clamp(n, lo, hi) {
	return Math.min(Math.max(Math.trunc(n), lo), hi);
}

function clip(text, max = 20_000) {
	text = String(text ?? "");
	return text.length <= max ? text : `${text.slice(0, max)}\n…[truncated ${text.length - max} bytes]`;
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

/**
 * Condensed status summary — raw `status --json` is ~1MB (thousands of
 * historical jobs), far beyond what a tool result should carry. Active rows
 * in full, history as counts.
 */
function summarizeStatus(d) {
	const lines = [];
	const active = (d.batches ?? []).filter((b) => !["done", "skip"].includes(b.status));
	const doneBatches = (d.batches ?? []).length - active.length;
	lines.push(`batches: ${d.batches?.length ?? 0} total (${doneBatches} terminal, ${active.length} active/blocked)`);
	for (const b of active) {
		lines.push(`  batch ${b.name} [${b.status}] ${b.progress ?? ""}${b.depends_on?.length ? ` dep=[${b.depends_on.join(",")}]` : ""}`);
	}
	const live = (d.jobs ?? []).filter((j) => ["running", "pending", "waiting_dep"].includes(j.status));
	const byStatus = {};
	for (const j of d.jobs ?? []) byStatus[j.status] = (byStatus[j.status] ?? 0) + 1;
	lines.push(`jobs: ${d.jobs?.length ?? 0} total — live ${live.length}, by-status ${JSON.stringify(byStatus)}`);
	for (const j of live.slice(0, 50)) {
		lines.push(`  job ${j.batch}:${j.task} [${j.status}]${j.gpu != null ? ` gpu=${j.gpu}` : ""}${j.started_at ? ` since ${j.started_at}` : ""}`);
	}
	for (const g of d.gpus ?? []) {
		lines.push(`  gpu${g.idx} [${g.status}]${g.job ? ` job=${g.job}` : ""}${g.quarantined ? " QUARANTINED" : ""}`);
	}
	if (d.cpu) lines.push(`cpu: ${d.cpu.used} in use${d.cpu.total ? ` / ${d.cpu.total} cap` : " (no cap)"}`);
	return lines.join("\n");
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
function apply(ctx, config) {
	// ── B24: 内嵌 SSH 引擎（先于 runRemote 创建：绑定后 sched 命令走引擎通道）──
	const sshStore = new HostStore();
	const sshEngine = new SshEngine(sshStore);
	const localTransport = new LocalTransport();
	/** 绑定的 sched 主机别名；null = 传统 ssh CLI 模式 (config.sshEntry)。 */
	let boundAlias = null;
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
	const persistEntryOverride = (patch) => {
		let existing = {};
		try {
			existing = JSON.parse(fs.readFileSync(entryFile, "utf-8"));
		} catch {
			// Missing or malformed overrides are replaced by the validated patch.
		}
		fs.mkdirSync(path.dirname(entryFile), { recursive: true });
		fs.writeFileSync(
			entryFile,
			JSON.stringify(mergeEntryOverride(existing, patch), null, 2),
		);
	};

	// ── B24c: 交互式 2FA 桥接 ──
	// 质询 → WS 广播给看板 → 用户输入动态码 → POST /sched/ssh/2fa-answer 回来。
	// broadcastFn 由 webServer 块后置绑定；无看板在线时快速失败并给出明确提示。
	const pending2fa = new Map(); // id -> resolver
	let broadcastFn = null;
	sshEngine.setInteractivePrompter(({ alias, instr, prompts }) => new Promise((resolve) => {
		if (typeof broadcastFn !== "function") {
			throw new Error("2FA \u8d28\u8be2\u9700\u8981\u770b\u677f\u5728\u7ebf\u4ea4\u4e92\uff08\u5f53\u524d\u65e0\u6d4f\u89c8\u5668\u8fde\u63a5\uff09");
		}
		const id = `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
		pending2fa.set(id, resolve);
		setTimeout(() => {
			if (pending2fa.delete(id)) {
				ctx.logger.warn("[node-sched] audit 2fa-timeout id=%s alias=%s", id, alias);
				resolve("");
			}
		}, 180_000);
		ctx.logger.warn("[node-sched] audit 2fa-request id=%s alias=%s", id, alias);
		broadcastFn({
			type: "kbdint",
			id, alias,
			prompt: (prompts && prompts[0] && prompts[0].text) || instr || "Verification code:",
		});
	}));

	const runRemoteCli = makeRunner(cp, config);
	/**
	 * B24: 双通道调度。绑定 sched 主机（ssh 面板设置）后，所有 sched 命令
	 * 走内嵌引擎的 ssh2 持久连接池（复用 TCP、无进程 fork 开销）；未绑定时
	 * 回落传统 ssh CLI 子进程 (config.sshEntry)。引擎故障诚实报错，不静默回退。
	 */
	function captureTransportTarget() {
		if (useLocalTransport()) return { mode: "local" };
		if (boundAlias) return { mode: "engine", alias: boundAlias };
		return { mode: "cli", sshEntry: config.sshEntry };
	}

	function runOnTarget(target, args, opts = {}) {
		if (target.mode === "local") return localTransport.exec(args, opts);
		if (target.mode === "engine") {
			return (opts.retry === false
				? sshEngine.execOnce(target.alias, args, opts.timeoutMs)
				: sshEngine.exec(target.alias, args, opts.timeoutMs)).then(
				(r) => ({
					ok: r.success,
					code: r.exitCode ?? -1,
					stdout: r.stdout,
					stderr: r.stderr + (r.error ? `\n${r.error}` : ""),
				}),
				(e) => ({
					ok: false, code: -1, stdout: "",
stderr: `[ssh-engine:${target.alias}] ${formatSshError(e)}`,
				}),
			);
		}
		return runRemoteCli(args, { ...opts, sshEntry: target.sshEntry });
	}

	function runRemote(args, opts = {}) {
		return runOnTarget(captureTransportTarget(), args, opts);
	}

		// batch.json 上传：内容经 ssh stdin 写远端临时文件（本地不落盘），
	// dry-run 纯只读预览；submit 走 operate() 门+审计。两者用后即删临时文件。
	// ── B24e: 写操作统一走 ambiorix 本机执行 (screen 注入) ──────────────
	// B24d 守卫 + NFS+WAL 双主机丢数据实测: 网关上的 sched 写操作会被
	// daemon 检查点静默抹掉 (2026-08-26 sd_repro_v3 事故)。所有产生状态
	// 变更的命令必须在计算节点上跑。通道: 往 ambior1 screen 注入命令行,
	// 输出重定向到共享盘结果文件, 轮询该文件取回 stdout/stderr。
	const SCREEN_SESSION = "3323979.ambior1";
	const INBOX = "$HOME/.sched/inbox";
const SCREEN_RESULT_PREFIX_BYTES = 2 * 1024 * 1024;
	const MAX_SCREEN_STUFF_BYTES = 640;
	let screenExecSeq = 0;
	async function screenExec(cmd, { timeoutMs = 60_000, target = captureTransportTarget() } = {}) {
		if (target.mode === "local") return runOnTarget(target, cmd, { timeoutMs });
		if (target.mode === "engine") {
			return runOnTarget(target, cmd, { timeoutMs, retry: false });
		}
		const id = `se${Date.now().toString(36)}${++screenExecSeq}`;
		const out = `${INBOX}/${id}.out`;
		const markerOut = `${INBOX}/${id}.done`;
		const remoteOpts = { timeoutMs: 15_000, sshEntry: target.sshEntry };
		const cleanup = () => runRemoteCli(
			`rm -f ${out} ${markerOut}`,
			{ ...remoteOpts, maxOutputBytes: 128 },
		).catch(() => {});
		const wrapped = `{ echo "--- begin ${id}"; (${cmd}); rc=$?; printf "\\n--- end rc=%s id=${id}\\n" "$rc" > ${markerOut}; } > ${out} 2>&1`;
		const stuff = `mkdir -p ${INBOX} && ${wrapped}\n`;
		if (Buffer.byteLength(stuff, "utf8") > MAX_SCREEN_STUFF_BYTES) {
			throw new Error(`screenExec command too long (max ${MAX_SCREEN_STUFF_BYTES} bytes)`);
		}
		try {
			await new Promise((resolve, reject) => {
				let errBuf = "";
				const child = cp.spawn("ssh",
					["-o", `ConnectTimeout=${config.connectTimeoutSec}`, "-o", "BatchMode=yes",
						target.sshEntry,
						`screen -S ${SCREEN_SESSION} -X stuff ${shellQuote(stuff)}`],
					{ timeout: 15_000 });
				child.stderr.on("data", (d) => { errBuf += d; });
				child.on("close", (c) => c === 0 ? resolve() : reject(new Error(`screen stuff failed rc=${c}: ${errBuf.trim().slice(0, 200)}`)));
			});
			// 轮询结果文件 (NFS 延迟容忍). Completion lives in a separate
			// marker file so descendants retaining stdout cannot hide the result.
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				await new Promise((r) => setTimeout(r, 1500));
				const markerResult = await runRemoteCli(
					`cat ${markerOut} 2>/dev/null`,
					{ ...remoteOpts, maxOutputBytes: 1024 },
				);
				const marker = parseScreenEnd(markerResult.stdout, id);
				if (!marker) continue;
				const prefix = await runRemoteCli(
					`head -c ${SCREEN_RESULT_PREFIX_BYTES} ${out} 2>/dev/null`,
					{ ...remoteOpts, maxOutputBytes: SCREEN_RESULT_PREFIX_BYTES + 1024 },
				);
				if (!prefix.ok) {
					const detail = prefix.stderr || prefix.stdout || `exit ${prefix.code}`;
					return {
						ok: marker.code === 0,
						code: marker.code,
						stdout: `[screen output unavailable: ${detail}]`,
						stderr: detail,
					};
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
						ok: marker.code === 0,
						code: marker.code,
						stdout: `${prefix.stdout}\n[screen output framing invalid]`,
						stderr: "screen output framing invalid",
					};
				}
				if (Number.isFinite(outputBytes) && outputBytes > SCREEN_RESULT_PREFIX_BYTES) {
					return {
						...result,
						stdout: `${result.stdout}\n…[screen output truncated after ${SCREEN_RESULT_PREFIX_BYTES} bytes]`,
					};
				}
				return result;
			}
			throw new Error(`screenExec 超时 (${timeoutMs}ms): ${cmd.slice(0, 80)}`);
		} finally {
			await cleanup();
		}
	}
	const gate = new WriteGate();
	let auditSeq = 0;

	const S = config.schedBin;

	// ── Activation probe (background): loud degradation on entry/network mismatch. ──
	let probeOk = false;
	runRemote(`${S} ${config.probeCommand}`, { timeoutMs: config.connectTimeoutSec * 2000 })
		.then((probe) => {
			if (!probe.ok) {
				ctx.logger.error(
					"[node-sched] PROBE FAILED via ssh entry \"%s\" (code %d) — check network environment " +
					"(campus=HPDC / outside=HPDC_outside) before retrying. stderr: %s",
					config.sshEntry, probe.code, (probe.stderr || "").trim().slice(0, 400),
				);
				return;
			}
			probeOk = true;
			ctx.logger.info("[node-sched] probe ok via %s", config.sshEntry);
		});

		/** Read-only remote query; one retry on transient ssh failure. */
		async function query(args, opts = {}) {
			const target = opts.target ?? captureTransportTarget();
			const runOpts = opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs };
			let res = await runOnTarget(target, args, runOpts);
			if (!res.ok && isTransientSshError(res.stderr)) {
				res = await runOnTarget(target, args, runOpts);
			}

			return envelope(res, opts);
		}

			/**
			 * Side-effectful operation. Serialized per key by WriteGate, audited,
			 * NEVER auto-retried (a timed-out killpg may still have taken effect;
			 * unknown outcome => report and ask a human to check `sched status`).
			 */
			async function operate(key, args, { timeoutMs, target = captureTransportTarget() } = {}) {
				return gate.run(key, async () => {
					ctx.logger.warn("[node-sched] audit #%d op=%s cmd=`%s`", ++auditSeq, key, args);
					// B24e: 写操作走 ambiorix 本机通道 (NFS+WAL 跨主机写会丢数据)
					const res = await screenExec(args, { timeoutMs, target });
					return envelope(res, { json: false });
				});
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
				parameters: {},
				output: textOutput,
				execute: async () => {
					const { raw, text } = await query(`${S} status --json`);
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
				execute: async () => ({ text: (await query(`${S} list-gpus`, { json: false })).text }),
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
				execute: async (args) =>
					({ text: (await query(`${S} diag ${shellQuote(args.task_id)}`, { json: false })).text }),
				presentCall: (a) => ({ card: "generic", title: `Diagnose task ${a.task_id}`, kind: "read" }),
			})),

			ctx.tools.register(defineTool({
				name: "sched_history",
				description: "Historical batches/tasks with final states and durations (not just currently active ones).",
				parameters: {
					batch: { type: "string", description: "Optional batch name filter." },
				},
				output: textOutput,
				execute: async (args) => ({
					text: (await query(args.batch ? `${S} history --json ${shellQuote(args.batch)}` : `${S} history --json`)).text,
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
				execute: async (args) => ({
					text: (await query(`${S} log ${shellQuote(args.task_id)} -n ${clamp(args.lines ?? 100, 1, 2000)}`, { json: false })).text,
				}),
				presentCall: (a) => ({ card: "generic", title: `Tail log ${a.task_id}`, kind: "read" }),
			})),

			ctx.tools.register(defineTool({
				name: "sched_markers",
				description: "One-line-per-batch terminal-state markers (done/blocked) across history.",
				parameters: {},
				output: textOutput,
				execute: async () => ({ text: (await query(`${S} markers`, { json: false })).text }),
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
		let _daemonCache = { ts: 0, targetKey: null, body: null };
		let _targetEpoch = 0;
		let _statusCache = null;
		let _refreshTimer;

		// B11c: 后台统一刷新器 -- 定时经 ssh 查询远程状态并缓存,
		// 所有 API 路由即时返回缓存值, 网络抖动对浏览器完全透明。
		const REFRESH_MS = config.pollFallbackSec * 1000;

		function statusTargetKey() {
			if (useLocalTransport()) return "local";
			if (boundAlias) return `engine:${boundAlias}`;
			return `cli:${config.sshEntry}`;
		}

		function invalidateTargetCaches() {
			_targetEpoch += 1;
			_statusInFlight = null;
			_statusCache = null;
			_daemonCache = { ts: 0, targetKey: statusTargetKey(), body: null };
			stopTail();
			if (clients.size > 0) scheduleTailRestart();
			if (_refreshTimer) refreshCaches().catch(() => {});
		}

		function hasStatusCache() {
			return _statusCache?.targetKey === statusTargetKey()
				&& _statusCache.body?.ok
				&& _statusCache.body.raw;
		}

		function cacheStatus(raw, targetKey = statusTargetKey()) {
			_statusCache = {
				ts: Date.now(),
				targetKey,
				body: {
					ok: true,
					summary: summarizeStatus(raw),
					raw,
					daemon_health: raw.daemon_health ?? null,
				},
			};
		}

		function refreshStatusCache() {
			const targetKey = statusTargetKey();
			const epoch = _targetEpoch;
			if (_statusInFlight?.targetKey === targetKey) return _statusInFlight.promise;
			const request = query(`${S} status --json`).then((sr) => {
				if (_targetEpoch === epoch && statusTargetKey() === targetKey && sr.ok && sr.raw) {
					cacheStatus(sr.raw, targetKey);
				}
				return sr;
			});
			const current = { targetKey, promise: request };
			_statusInFlight = current;
			request.finally(() => {
				if (_statusInFlight === current) _statusInFlight = null;
			}).catch(() => {});
			return request;
		}

		async function refreshCaches() {
			try {
				const targetKey = statusTargetKey();
				const epoch = _targetEpoch;
				const r = await query(`${S} daemon status`, { json: false });
				if (_targetEpoch === epoch && statusTargetKey() === targetKey) {
					_daemonCache = {
						ts: Date.now(),
						targetKey,
						body: { ok: r.ok, text: r.text },
					};
				}
			} catch { /* keep old */ }
			try {
				await refreshStatusCache();
			} catch { /* keep old */ }
		}
			} catch { /* keep old */ }
			try {
				const sr = await query(`${S} status --json`);
				if (sr.ok && sr.raw) {
					_statusCache = {
						ts: Date.now(),
						body: { ok: true, summary: summarizeStatus(sr.raw), raw: sr.raw },
					};
				}
			} catch { /* keep old */ }
		}

		function startRefresher() {
			if (_refreshTimer) return;
			refreshCaches(); // 首次立即加载
			_refreshTimer = setInterval(refreshCaches, REFRESH_MS);
		}

		function stopRefresher() {
			if (_refreshTimer) { clearInterval(_refreshTimer); _refreshTimer = undefined; }
		}
	const routeDisposers = [];
	let postApplyCleanup = () => {
		localTransport.dispose();
		sshEngine.dispose();
	};
	let heartbeat;
	if (ctx.webServer) {
		const json = async (res, body, code = 200) => {
			res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
			res.end(JSON.stringify(body));
		};
		const writeGuard = (req, res) => {
			if (req?.method !== "POST") {
				json(res, { ok: false, error: "method not allowed: POST" }, 405);
				return false;
			}
			if (loopbackRequestAllowed(req)) return true;
			json(res, { ok: false, error: "forbidden: loopback Origin/Host required" }, 403);
			return false;
		};

		// Write operations: whitelisted, gated, audited (see operate()). The UI
		// owns the two-step confirm; the host refuses unknown ops outright.
		const OPS = {
			cancel: { cmd: (id) => `${S} cancel ${shellQuote(id)}`, needsId: true },
			retry: { cmd: (id) => `${S} retry ${shellQuote(id)}`, needsId: true },
			resubmit: { cmd: (id) => `${S} resubmit ${shellQuote(id)}`, needsId: true },
			"gpu-free": { cmd: (id) => `${S} gpu-free ${id} --yes`, needsId: true, pattern: /^\d+$/ },
			"gpu-ignore": { cmd: (id) => `${S} gpu-ignore ${id}`, needsId: true, pattern: /^\d+$/ },
			"gpu-ok": { cmd: (id) => `${S} gpu-ok ${id}`, needsId: true, pattern: /^\d+$/ },
			"daemon-start": { cmd: () => `${S} daemon start`, needsId: false },
			"daemon-stop": { cmd: () => `${S} daemon stop`, needsId: false },
		};


		const uploadRemote = async (content, target = captureTransportTarget()) => {
			if (!/^\s*\{/.test(content)) throw new Error("content is not a JSON object");
			JSON.parse(content);
			const name = `nodesched-upload-${Date.now()}-${randomUUID()}.json`;
			// Transport-local mode writes directly beside the local daemon.
			if (target.mode === "local") {
				const inboxDir = path.join(os.homedir(), ".sched", "inbox");
				const localPath = path.join(inboxDir, name);
				fs.mkdirSync(inboxDir, { recursive: true, mode: 0o700 });
				fs.writeFileSync(localPath, content, { encoding: "utf8", mode: 0o600 });
				return localPath;
			}
			// B24: 引擎模式走连接池 exec+stdin；CLI 模式走 ssh 子进程 stdin
			if (target.mode === "engine") {
				const remotePath = `~/.sched/inbox/${name}`;
				const r = await sshEngine.execStdin(
					target.alias,
					`mkdir -p ~/.sched/inbox && cat > ${remotePath} && printf '%s\\n' "$HOME/.sched/inbox/${name}"`,
					content,
					60_000,
				);
				if (!r.success) throw new Error(r.stderr || r.error || "upload failed");
				return parseUploadedPath(r.stdout, name);
			}
			return await new Promise((resolve, reject) => {
				const child = cp.spawn(
					"ssh",
					["-o", `ConnectTimeout=${config.connectTimeoutSec}`, "-o", "BatchMode=yes",
						target.sshEntry, `mkdir -p ~/.sched/inbox && cat > ~/.sched/inbox/${name} && printf '%s\\n' "$HOME/.sched/inbox/${name}"`],
				);
				let output = "";
				let err = "";
				child.stdout.on("data", (d) => { output += d; });
				child.stderr.on("data", (d) => { err += d; });
				child.on("error", reject);
				child.on("close", (code) => {
					if (code !== 0) {
						reject(new Error(err || "upload failed"));
						return;
					}
					try {
						resolve(parseUploadedPath(output, name));
					} catch (error) {
						reject(error);
					}
				});
				child.stdin.end(content);
			});
		};
		const readBodyJson = async (req) => {
			let body = "";
			for await (const chunk of req) body += chunk;
			return JSON.parse(body);
		};

		startRefresher();

		routeDisposers.push(
			ctx.webServer.register({
				kind: "prefix",
				path: "/sched/api/status",
				handler: async (_req, res) => {
					if (hasStatusCache()) {
						return void json(res, _statusCache.body);
					}
					const targetKey = statusTargetKey();
					const epoch = _targetEpoch;
					const { raw, text } = await refreshStatusCache();
					if (_targetEpoch !== epoch || statusTargetKey() !== targetKey) {
						return void json(res, { ok: false, text: "status target changed; retry" }, 503);
					}
					if (hasStatusCache()) {
						return void json(res, _statusCache.body);
					}
					// B26: daemon 健康透传 (CLI 已解析出 raw.daemon_health)
					const parsedRaw = (() => {
						if (!raw) return null;
						if (typeof raw === "object") return raw;
						try { return JSON.parse(text); } catch (_) { return null; }
					})();
					const dhealth = parsedRaw?.daemon_health ?? null;
					const body = parsedRaw
						? { ok: true, summary: summarizeStatus(raw), raw: parsedRaw, daemon_health: dhealth }
						: { ok: false, text };
					_statusCache = { ts: Date.now(), body };
					json(res, body);
				},
			}),

			ctx.webServer.register({
				kind: "prefix",
				path: "/sched/api/gpus",
				handler: async (_req, res) => {
					const r = await query(`${S} list-gpus`, { json: false });
					await json(res, { ok: r.text.startsWith("[error") ? false : true, text: r.text });
				},
			}),

			ctx.webServer.register({
				kind: "prefix",
				path: "/sched/api/entry",
				handler: async (req, res) => {
					try {
						if (req.method === "GET") {
							// B24f: 统一通道描述结构 {alias, mode, sshEntry}（与 /sched/ssh/binding 一致）
						return void json(res, {
							ok: true,
							alias: boundAlias ?? null,
							mode: useLocalTransport() ? "local" : (boundAlias ? "engine" : "cli"),
							sshEntry: config.sshEntry,
						});
						}
						if (!writeGuard(req, res)) return;
						const body = await readBodyJson(req);
						const entry = String(body.entry || "").trim();
						if (!/^[A-Za-z0-9_.-]+$/.test(entry)) {
							return void json(res, { ok: false, text: "非法入口名" }, 400);
						}
						const prev = config.sshEntry;
						persistEntryOverride({ sshEntry: entry });
						config.sshEntry = entry;   // runRemote 每次调用时读取, 即刻生效
persistEntryOverride({ sshEntry: entry });
						invalidateTargetCaches();
						ctx.logger.warn("[node-sched] audit #%d ssh-entry %s -> %s",
							++auditSeq, prev, entry);
						// 用新入口立即探测 daemon 可达性 (诚实反馈, 不假装成功)
						let probeText = "";
						try {
							const pr = await runRemote(`${S} daemon status`, { timeoutMs: 25_000 });
							const body = (pr.text || pr.stdout || "").trim();
							probeText = (pr.ok ? "" : "[不可达] ") + body.split("\n")[0].slice(0, 80);
						} catch (e) {
							probeText = "探测失败: " + String(e.message ?? e).slice(0, 60);
						}
						await json(res, { ok: true, entry, prev, probeText });
					} catch (e) {
						await json(res, { ok: false, text: String(e.message ?? e) }, 400);
					}
				},
			}),

			ctx.webServer.register({
				kind: "prefix",
				path: "/sched/api/incidents",
				handler: async (req, res) => {
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
						await json(res, { ok: false, text: String(e.message ?? e) }, 400);
					}
				},
			}),

			ctx.webServer.register({
				kind: "prefix",
				path: "/sched/api/config",
				handler: async (req, res) => {
					try {
						if (req.method === "GET") {
							const r = await query(`${S} config get`);
							await json(res, { ok: r.ok, text: r.text });
							return;
						}
						if (!writeGuard(req, res)) return;
						const target = captureTransportTarget();
						const body = await readBodyJson(req);
						if (!body.patch || typeof body.patch !== "object") {
							return void json(res, { ok: false, text: "patch (object) required" }, 400);
						}
						const remotePath = await uploadRemote(JSON.stringify(body.patch), target);
						try {
							// 配置是双项目共享的 —— 写操作走 WriteGate 单飞 + 审计
							const r = await gate.run("config-set", async () => {
								ctx.logger.warn("[node-sched] audit #%d op=config-set", ++auditSeq);
								// B24e: 配置写入必须在计算节点上落库 (NFS+WAL 守卫)
								return screenExec(
									`${S} config set -f ${shellQuote(remotePath)} --yes && rm -f ${shellQuote(remotePath)}`,
									{ timeoutMs: 90_000, target },
								);
							});
							await json(res, {
								ok: r.ok,
								text: r.ok ? (r.text || "已写入并请求热重载") : (r.stderr || r.text || "set 失败"),
							});
						} finally {
							await runOnTarget(target, `rm -f ${shellQuote(remotePath)}`).catch(() => {});
						}
					} catch (e) {
						await json(res, { ok: false, text: String(e.message ?? e) }, 400);
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
						await json(res, { ok: false, text: String(e.message ?? e) }, 400);
					}
				},
			}),

			ctx.webServer.register({
				kind: "prefix",
				path: "/sched/api/submit",
				handler: async (req, res) => {
					if (!writeGuard(req, res)) return;
					try {
						const target = captureTransportTarget();
						const { content } = await readBodyJson(req);
						const remotePath = await uploadRemote(String(content), target);
						try {
							const r = await operate("submit", `${S} submit ${shellQuote(remotePath)}`, { target });
							await json(res, { ok: r.ok, code: r.code, text: clip((r.stdout || r.stderr || "").trim(), 2000) });
						} finally {
							await runOnTarget(target, `rm -f ${shellQuote(remotePath)}`).catch(() => {});
						}
					} catch (e) {
						await json(res, { ok: false, text: String(e.message ?? e) }, 400);
					}
				},
			}),

			ctx.webServer.register({
				kind: "prefix",
				path: "/sched/api/daemon",
					handler: async (_req, res) => {
						json(res, _daemonCache.body || { ok: false, text: "尚未查询" });
					},
				}),

			ctx.webServer.register({
				kind: "prefix",
				path: "/sched/api/op",
				handler: async (req, res) => {
					if (!writeGuard(req, res)) return;
					const target = captureTransportTarget();
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
					const { op, id } = body && typeof body === "object" ? body : {};
					const spec = OPS[op];
					if (!spec || typeof (id ?? "") !== "string") {
						return void json(res, { ok: false, error: "bad op/id" }, 400);
					}
					if (spec.needsId && (!id || !(spec.pattern ?? /^[\w:.-]+$/).test(id))) {
						return void json(res, { ok: false, error: "bad id for op" }, 400);
					}
					const r = await operate(`${op}:${id ?? ""}`, spec.cmd(id), { target });
					await json(res, { ok: r.ok, code: r.code, text: (r.stdout || r.stderr || "").trim().slice(0, 2000) });
				},
			}),

			ctx.webServer.register({
				kind: "prefix",
				path: "/sched/api/log",
				handler: async (req, res) => {
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
		const wss = new WebSocketServer({ noServer: true });
		/** @type {Set<import('ws').WebSocket>} */
		const clients = new Set();
		/** @type {import('node:child_process').ChildProcess | undefined} */
		let tailChild;
		/** @type {import('./ssh-engine.js').ExecStream | undefined} */
		let tailStream;
		let tailRestartTimer;
		let tailDisposed = false;
		let tailGeneration = 0;

		function broadcast(obj) {
			const msg = JSON.stringify(obj);
			for (const ws of clients) {
				try { ws.send(msg); } catch { /* socket closing */ }
			}
		}
		function stopTail() {
			tailGeneration++;
			clearTimeout(tailRestartTimer);
			tailRestartTimer = undefined;
			const stream = tailStream;
			tailStream = undefined;
			try { stream?.close(); } catch { /* already closed */ }
			const child = tailChild;
			tailChild = undefined;
			try { child?.kill("SIGTERM"); } catch { /* already closed */ }
		}

		const removeClient = (ws) => {
			clients.delete(ws);
			if (clients.size === 0) stopTail();
		};

		function scheduleTailRestart() {
			if (tailDisposed || clients.size === 0 || tailRestartTimer) return;
			tailRestartTimer = setTimeout(() => {
				tailRestartTimer = undefined;
				startTail().catch(() => {});
			}, 5_000);
		}
		// B24c: 引擎 prompter 复用同一条事件通道
		broadcastFn = broadcast;

		/** Tail the dispatcher decision log; restart with backoff while clients exist.
		 * State dir partitions by the configured COMPUTE node (~/.sched/<node>/),
		 * NOT the ssh-landing host (an outside entry lands on the gateway whose
		 * own hostname dir is empty) — so resolve `node` from the remote
		 * ~/.sched/config.json rather than `hostname`. */
		async function resolveNode() {
			if (useLocalTransport()) {
				try {
					return JSON.parse(fs.readFileSync(path.join(os.homedir(), ".sched", "config.json"), "utf8")).node;
				} catch {
					return undefined;
				}
			}
			const res = await runRemote("cat $HOME/.sched/config.json");
			if (!res.ok) return undefined;
			try { return JSON.parse(res.stdout).node; } catch { return undefined; }
		}

		async function startTail() {
			if (tailDisposed || tailChild || tailStream || clients.size === 0) return;
			const generation = ++tailGeneration;
			const nodeName = await resolveNode();
			if (tailDisposed || generation !== tailGeneration || clients.size === 0) return;
			if (!nodeName) {
				ctx.logger.error("[node-sched] cannot resolve sched node from remote ~/.sched/config.json");
				scheduleTailRestart();
				return;
			}
			const safeNode = String(nodeName).replace(/[^a-zA-Z0-9.-]/g, "");
			const remoteCmd = `tail -n 50 -F $HOME/.sched/${safeNode}/scheduler.log 2>/dev/null`;
			let buffer = "";
			const onLine = (text) => {
				if (tailDisposed || generation !== tailGeneration || clients.size === 0) return;
				buffer += text;
				let at;
				while ((at = buffer.indexOf("\n")) !== -1) {
					if (tailDisposed || generation !== tailGeneration || clients.size === 0) {
						buffer = "";
						return;
					}
					const line = buffer.slice(0, at).trimEnd();
					buffer = buffer.slice(at + 1);
					if (line) broadcast({ type: "log", line });
				}
			};
			const onEnd = () => {
				if (generation !== tailGeneration) return;
				tailChild = undefined; tailStream = undefined;
				if (tailDisposed) return;
				scheduleTailRestart();
			};
			if (useLocalTransport()) {
				localTransport.openStream(remoteCmd).then((stream) => {
					if (tailDisposed || generation !== tailGeneration || tailChild || tailStream || clients.size === 0) { stream.close(); return; }
					tailStream = stream;
					stream.onData = (chunk) => onLine(chunk.toString("utf8"));
					stream.onClose = onEnd;
				}).catch((e) => {
					ctx.logger.warn("[node-sched] local tail failed: %s", String(e.message ?? e));
					onEnd();
				});
				return;
			}
			// B24: 引擎模式走独立 exec 流通道；CLI 模式走 ssh 子进程
			if (boundAlias) {
				openExecStream(sshEngine, boundAlias, remoteCmd).then((stream) => {
					if (tailDisposed || generation !== tailGeneration || tailChild || tailStream || clients.size === 0) { try { stream.close(); } catch {} return; }
					tailStream = stream;
					stream.onData = (chunk) => onLine(chunk.toString("utf8"));
					stream.onClose = onEnd;
				}).catch((e) => {
					ctx.logger.warn("[node-sched] engine tail failed (%s): %s", boundAlias, String(e.message ?? e));
					onEnd();
				});
				return;
			}
			const child = cp.spawn(
				"ssh",
				["-o", `ConnectTimeout=${config.connectTimeoutSec}`, "-o", "BatchMode=yes", config.sshEntry, remoteCmd],
			);
			tailChild = child;
			child.stdout.on("data", (d) => onLine(d.toString()));
			child.on("close", onEnd);
			child.on("error", onEnd);
		}

		// Periodic status heartbeat so quiet stretches still refresh dashboards.
		heartbeat = setInterval(async () => {
			if (clients.size === 0) return;
			try {
				if (hasStatusCache()) {
					broadcast({
						type: "status",
						summary: _statusCache.body.summary ?? null,
						ts: Date.now(),
					});
					return;
				}
				const targetKey = statusTargetKey();
				const epoch = _targetEpoch;
				const sr = await refreshStatusCache();
				if (_targetEpoch !== epoch || statusTargetKey() !== targetKey) return;
				const summary = sr.raw ? summarizeStatus(sr.raw) : null;
				broadcast({ type: "status", summary, ts: Date.now() });
			} catch { /* transient */ }
		}, config.pollFallbackSec * 1000);

		routeDisposers.push(
			ctx.webServer.registerUpgrade({
				path: "/sched/ws/events",
				handler: (req, socket, head) => {
					const remote = req.socket?.remoteAddress ?? "";
					if (!isLoopbackAddress(remote) || !originHostAllowed(req)) {
						socket.destroy();
						return;
					}
					wss.handleUpgrade(req, socket, head, (ws) => {
						clients.add(ws);
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
			localTransport.dispose();
			sshEngine.dispose();
		};
		/** Loopback-only fence: these endpoints execute remote commands. */
		const loopbackOnly = (req, res) => {
			const remote = req.socket?.remoteAddress ?? "";
			const isLo = isLoopbackAddress(remote);
			if (!isLo) {
				json(res, { error: "forbidden: loopback-only" }, 403);
				return false;
			}
			if (!originHostAllowed(req)) {
				json(res, { error: "forbidden: Origin/Host must be loopback" }, 403);
				return false;
			}
			return true;
		};
		const aliasOf = (req) => {
			const u = new URL(req.url, "http://x");
			return u.searchParams.get("alias") ?? "";
		};
		const boundTargetUsesAlias = (alias) => {
			if (alias === boundAlias) return true;
			const active = boundAlias ? sshStore.find(boundAlias) : undefined;
			return Array.isArray(active?.proxyJump) && active.proxyJump.includes(alias);
		};

		routeDisposers.push(
			ctx.webServer.register({
				kind: "prefix",
				path: "/sched/ssh/hosts",
				handler: async (req, res) => {
					if (!loopbackOnly(req, res)) return;
					try {
						const method = req.method ?? "GET";
						if (method === "GET") {
							const u = new URL(req.url, "http://x");
							return void json(res, { hosts: sshEngine.list(u.searchParams.get("query") ?? undefined) });
						}
						if (method === "POST") {
							const entry = sshStore.create(await readBodyJson(req));
							return void json(res, { host: sshStore.summarize(entry) }, 201);
						}
						const alias = aliasOf(req);
						if (!alias) return void json(res, { error: "alias query param required" }, 400);
						if ((method === "PATCH" || method === "DELETE") && boundTargetUsesAlias(alias)) {
							return void json(res, { error: "unbind the active target before editing or deleting it or its proxy hop" }, 409);
						}
						if (method === "PATCH") {
							const entry = sshStore.update(alias, await readBodyJson(req));
							sshEngine.dropAlias(alias); // 凭据/地址变更绝不复用旧连接
							if (alias === boundAlias) invalidateTargetCaches();
							return void json(res, { host: sshStore.summarize(entry) });
						}
						if (method === "DELETE") {
							const removed = sshStore.remove(alias);
							sshEngine.dropAlias(alias);
							if (removed && alias === boundAlias) {
								boundAlias = null;
								invalidateTargetCaches();
								persistEntryOverride({ sshEntry: config.sshEntry, schedAlias: null });
							}
							return void json(res, { removed });
						}
						json(res, { error: `method not allowed: ${method}` }, 405);
					} catch (e) {
						json(res, { error: String(e.message ?? e) }, 400);
					}
				},
			}),

			ctx.webServer.register({
				kind: "prefix",
				path: "/sched/ssh/import",
				handler: async (req, res) => {
					if (!loopbackOnly(req, res)) return;
					try {
						json(res, { result: sshStore.importSshConfig() });
					} catch (e) {
						json(res, { error: String(e.message ?? e) }, 400);
					}
				},
			}),

			ctx.webServer.register({
				kind: "prefix",
				path: "/sched/ssh/test",
				handler: async (req, res) => {
					if (!loopbackOnly(req, res)) return;
					try {
						const body = await readBodyJson(req);
						json(res, await sshEngine.test(String(body.alias ?? "")));
					} catch (e) {
						json(res, { ok: false, error: String(e.message ?? e) });
					}
				},
			}),

			ctx.webServer.register({
				kind: "prefix",
				path: "/sched/ssh/exec",
				handler: async (req, res) => {
					if (!loopbackOnly(req, res)) return;
					try {
						const body = await readBodyJson(req);
						const command = String(body.command ?? "").trim();
						if (!command) return void json(res, { error: "command required" }, 400);
						ctx.logger.warn("[node-sched] audit ssh-exec %s: %s", body.alias, command.slice(0, 120));
						// B24g: 引擎连接失败时回退 CLI 通道 (ControlMaster mux 可用时最可靠)
						let result;
						try {
							result = await sshEngine.exec(String(body.alias ?? ""), command, body.timeoutMs);
						} catch (engineErr) {
							if (String(body.alias ?? "") !== config.sshEntry) throw engineErr;
							const cli = await runRemoteCli(command, { timeoutMs: body.timeoutMs ?? 60_000 });
							result = { success: cli.ok, exitCode: cli.code, timedOut: false,
								stdout: cli.stdout, stderr: cli.stderr, durationMs: -1 };
						}
						json(res, result);
					} catch (e) {
						json(res, { success: false, exitCode: null, timedOut: false, stdout: "", stderr: "", durationMs: 0, error: String(e.message ?? e) });
					}
				},
			}),

			ctx.webServer.register({
				kind: "prefix",
				path: "/sched/ssh/binding",
				handler: async (req, res) => {
					if (!loopbackOnly(req, res)) return;
					json(res, {
						alias: boundAlias,
						mode: useLocalTransport() ? "local" : (boundAlias ? "engine" : "cli"),
						sshEntry: config.sshEntry,
					});
				},
			}),

			ctx.webServer.register({
				kind: "prefix",
				path: "/sched/ssh/bind",
				handler: async (req, res) => {
					if (!loopbackOnly(req, res)) return;
					if (useLocalTransport()) {
						return void json(res, { ok: false, error: "SSH binding unavailable in local transport" }, 409);
					}
					try {
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
							return void json(res, { ok: false, error: `\u4e3b\u673a\u4e0d\u53ef\u8fbe: ${reach.error ?? "?"}`, reachable: false });
						}
						let probeText = "";
						try {
							const pr = await sshEngine.exec(alias, `${S} daemon status`, 25_000);
							probeText = (pr.stdout || pr.stderr || "").split("\n")[0].slice(0, 100);
						} catch (e) {
							probeText = "\u63a2\u6d4b\u5931\u8d25: " + String(e.message ?? e).slice(0, 80);
						}
						const previousAlias = boundAlias;
						persistEntryOverride({ sshEntry: config.sshEntry, schedAlias: alias });
						boundAlias = alias;
						if (previousAlias && previousAlias !== alias) sshEngine.dropAlias(previousAlias);
						invalidateTargetCaches();
						ctx.logger.warn("[node-sched] audit #%d sched-bind -> %s (engine mode)", ++auditSeq, alias);
						json(res, { ok: true, mode: "engine", alias, latencyMs: reach.latencyMs, probeText });
					} catch (e) {
						json(res, { ok: false, error: String(e.message ?? e) }, 400);
					}
				},
			}),

			ctx.webServer.register({
				kind: "prefix",
				path: "/sched/ssh/unbind",
				handler: async (req, res) => {
					if (!loopbackOnly(req, res)) return;
					const prev = boundAlias;
					boundAlias = null;
					if (prev) sshEngine.dropAlias(prev);
					invalidateTargetCaches();
					try {
						persistEntryOverride({ sshEntry: config.sshEntry, schedAlias: null });
					} catch { /* \u6301\u4e45\u5316\u5931\u8d25\u4e0d\u963b\u585e\u89e3\u7ed1 */ }
					ctx.logger.warn("[node-sched] audit #%d sched-unbind <- %s", ++auditSeq, prev);
					json(res, { ok: true, prev, mode: "cli", sshEntry: config.sshEntry });
				},
			}),

			ctx.webServer.register({
				kind: "prefix",
				path: "/sched/api/client-log",
				handler: async (req, res) => {
					if (!loopbackOnly(req, res)) return;
					try {
						const body = await readBodyJson(req);
						// ctx.logger 只进内存缓冲不落盘 —— 直接追加共享盘文件供远程排查读取
						const line = `[${body.ts}] ${body.kind} ${String(body.detail ?? "").slice(0, 500)}\n`;
						fs.appendFileSync(path.join(os.homedir(), ".sched", "client-exceptions.log"), line);
						json(res, { ok: true });
					} catch (e) {
						json(res, { ok: false }, 400);
					}
				},
			}),

			ctx.webServer.register({
				kind: "prefix",
				path: "/sched/ssh/2fa-pending",
				handler: async (req, res) => {
					if (!loopbackOnly(req, res)) return;
					json(res, { pending: [...pending2fa.keys()] });
				},
			}),

			ctx.webServer.register({
				kind: "prefix",
				path: "/sched/ssh/2fa-answer",
				handler: async (req, res) => {
					if (!loopbackOnly(req, res)) return;
					try {
						const body = await readBodyJson(req);
						const id = String(body.id ?? "");
						const answer = body.answer ?? {};
						const resolver = pending2fa.get(id);
						if (!resolver) {
							return void json(res, { ok: false, error: "\u8bf7\u6c42\u4e0d\u5b58\u5728\u6216\u5df2\u8fc7\u671f" }, 404);
						}
						pending2fa.delete(id);
						if (answer.kind === "cancel") {
							ctx.logger.warn("[node-sched] audit 2fa-cancel id=%s (user)", id);
							resolver(""); // 空应答 = 放弃握手
						} else {
							const code = String(answer.code ?? "");
							ctx.logger.warn("[node-sched] audit 2fa-answer id=%s", id);
							resolver(code);
						}
						json(res, { ok: true });
					} catch (e) {
						json(res, { ok: false, error: String(e.message ?? e) }, 400);
					}
				},
			}),
		);

		// Web 终端：WS 升级 -> 独立 PTY shell 连接。帧协议与 dsh-ssh 相同：
		// server->client {ready|output|exit}, client->server {input|resize}。
		{
			const termWss = new WebSocketServer({ noServer: true });
			const HIGH_WATER = 1024 * 1024, LOW_WATER = 512 * 1024;
			routeDisposers.push(
				ctx.webServer.registerUpgrade({
					path: "/sched/ws/ssh-terminal",
					handler: (req, socket, head) => {
						const remote = req.socket?.remoteAddress ?? "";
						if (!isLoopbackAddress(remote) || !originHostAllowed(req)) {
							socket.destroy();
							return;
						}
						termWss.handleUpgrade(req, socket, head, async (ws) => {
							const u = new URL(req.url, "http://x");
							const alias = u.searchParams.get("alias") ?? "";
							const cols = parseInt(u.searchParams.get("cols") || "80", 10) || 80;
							const rows = parseInt(u.searchParams.get("rows") || "24", 10) || 24;
							let session;
							try {
								session = await sshEngine.openShell(alias, { cols, rows });
							} catch (e) {
								ws.send(JSON.stringify({ type: "exit", code: null, error: String(e.message ?? e) }));
								ws.close();
								return;
							}
							let paused = false;
							const maybePause = () => {
								// 传输背压：发送缓冲超限则暂停远端输出，排空后恢复
								const over = ws.bufferedAmount > HIGH_WATER;
								if (over && !paused) { paused = true; session.pause?.(); }
								else if (!over && paused) { paused = false; session.resume?.(); }
							};
							session.onData = (data) => {
								if (ws.readyState === ws.OPEN) {
									ws.send(JSON.stringify({ type: "output", data: data.toString("utf8") }));
									maybePause();
								}
							};
							session.onExit = (code, error) => {
								try { ws.send(JSON.stringify({ type: "exit", code, error })); } catch { /* gone */ }
								try { ws.close(); } catch { /* gone */ }
							};
							ws.send(JSON.stringify({ type: "ready", alias }));
							ws.on("message", (raw) => {
								try {
									const frame = JSON.parse(raw.toString());
									if (frame.type === "input") session.send(String(frame.data ?? ""));
									else if (frame.type === "resize") {
										session.resize(parseInt(frame.cols, 10) || 80, parseInt(frame.rows, 10) || 24);
									}
								} catch { /* malformed frame */ }
							});
							const bye = () => { try { session.close(); } catch { /* gone */ } };
							ws.on("close", bye);
							ws.on("error", bye);
						});
					},
				}),
			);
		}
	}

	return () => {
		for (const d of disposers) { try { d?.(); } catch { /* already gone */ } }
		for (const d of routeDisposers) { try { d?.(); } catch { /* already gone */ } }
		clearInterval(heartbeat);
		stopRefresher();
		postApplyCleanup?.();
	};
}

export { name, inject, Config, apply };
export default { name, inject, Config, apply };
