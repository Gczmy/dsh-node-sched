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
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { WebSocketServer } from "ws";

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
	pollFallbackSec: z.number().min(10).max(600).default(30)
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
	return function runRemote(args, { timeoutMs = 120_000 } = {}) {
		// spawn with an argv array: no local shell => no local $-expansion;
		// the remote command reaches the remote bash verbatim ($HOME expands there).
		const child = cp.spawn(
			"ssh",
			["-o", `ConnectTimeout=${cfg.connectTimeoutSec}`, "-o", "BatchMode=yes", cfg.sshEntry, args],
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
	const runRemote = makeRunner(cp, config);
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
			let res = await runRemote(args);
			if (!res.ok && /Connection timed out|Connection refused|kex_exchange/i.test(res.stderr)) {
				res = await runRemote(args);
			}

			return envelope(res, opts);
		}

			/**
			 * Side-effectful operation. Serialized per key by WriteGate, audited,
			 * NEVER auto-retried (a timed-out killpg may still have taken effect;
			 * unknown outcome => report and ask a human to check `sched status`).
			 */
			async function operate(key, args, { timeoutMs } = {}) {
				return gate.run(key, async () => {
					ctx.logger.warn("[node-sched] audit #%d op=%s cmd=`%s`", ++auditSeq, key, args);
					const res = await runRemote(args, { timeoutMs });
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
		let _daemonCache = { ts: 0, body: null };
		let _statusCache = null;
		let _refreshTimer;

		// B11c: 后台统一刷新器 -- 定时经 ssh 查询远程状态并缓存,
		// 所有 API 路由即时返回缓存值, 网络抖动对浏览器完全透明。
		const REFRESH_MS = config.pollFallbackSec * 1000;

		async function refreshCaches() {
			try {
				const r = await query(`${S} daemon status`, { json: false });
				_daemonCache = {
					ts: Date.now(),
					body: { ok: r.ok, text: r.text },
				};
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
	let heartbeat;
	if (ctx.webServer) {
		const json = async (res, body, code = 200) => {
			res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
			res.end(JSON.stringify(body));
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

		// batch.json 上传：内容经 ssh stdin 写远端临时文件（本地不落盘），
		// dry-run 纯只读预览；submit 走 operate() 门+审计。两者用后即删临时文件。
		const uploadRemote = (content) => new Promise((resolve, reject) => {
			const name = `nodesched-upload-${Date.now()}.json`;
			if (!/^\s*\{/.test(content)) return reject(new Error("content is not a JSON object"));
			JSON.parse(content);
			const child = cp.spawn(
				"ssh",
				["-o", `ConnectTimeout=${config.connectTimeoutSec}`, "-o", "BatchMode=yes",
					config.sshEntry, `cat > /tmp/${name}`],
			);
			let err = "";
			child.stderr.on("data", (d) => { err += d; });
			child.on("error", reject);
			child.on("close", (code) => code === 0 ? resolve(`/tmp/${name}`) : reject(new Error(err || "upload failed")));
			child.stdin.end(content);
		});
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
					if (_statusCache) return void json(res, _statusCache.body);
					const { raw, text } = await query(`${S} status --json`);
					const body = raw ? { ok: true, summary: summarizeStatus(raw), raw } : { ok: false, text };
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
				path: "/sched/api/config",
				handler: async (req, res) => {
					try {
						if (req.method === "GET") {
							const r = await query(`${S} config get`);
							await json(res, { ok: r.ok, text: r.text });
							return;
						}
						// POST {patch} -> 上传补丁文件 + WriteGate 串行执行 set --yes
						const body = await readBodyJson(req);
						if (!body.patch || typeof body.patch !== "object") {
							return void json(res, { ok: false, text: "patch (object) required" }, 400);
						}
						const remotePath = await uploadRemote(JSON.stringify(body.patch));
						try {
							// 配置是双项目共享的 —— 写操作走 WriteGate 单飞 + 审计
							const r = await gate.run("config-set", async () => {
								ctx.logger.warn("[node-sched] audit #%d op=config-set", ++auditSeq);
								return runRemote(
									`${S} config set -f ${shellQuote(remotePath)} --yes && rm -f ${shellQuote(remotePath)}`,
									{ timeoutMs: 60_000 },
								);
							});
							await json(res, {
								ok: r.ok,
								text: r.ok ? (r.text || "已写入并请求热重载") : (r.stderr || r.text || "set 失败"),
							});
						} finally {
							await runRemote(`rm -f ${shellQuote(remotePath)}`).catch(() => {});
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
					try {
						const { content } = await readBodyJson(req);
						const remotePath = await uploadRemote(String(content));
						try {
							const r = await query(`${S} submit --dry-run ${shellQuote(remotePath)}`, { json: false });
							await json(res, { ok: r.ok && !r.text.startsWith("[error"), text: r.text });
						} finally {
							await runRemote(`rm -f ${shellQuote(remotePath)}`);
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
					try {
						const { content } = await readBodyJson(req);
						const remotePath = await uploadRemote(String(content));
						try {
							const r = await operate(`submit:${remotePath}`, `${S} submit ${shellQuote(remotePath)}`);
							await json(res, { ok: r.ok, code: r.code, text: clip((r.stdout || r.stderr || "").trim(), 2000) });
						} finally {
							await runRemote(`rm -f ${shellQuote(remotePath)}`);
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
					if (req.method !== "POST") return void ((res.writeHead(405), res.end()));
					let body = "";
					for await (const chunk of req) body += chunk;
					let op, id;
					try { ({ op, id } = JSON.parse(body)); } catch { }
					const spec = OPS[op];
					if (!spec || typeof (id ?? "") !== "string") {
						return void json(res, { ok: false, error: "bad op/id" }, 400);
					}
					if (spec.needsId && (!id || !(spec.pattern ?? /^[\w:.-]+$/).test(id))) {
						return void json(res, { ok: false, error: "bad id for op" }, 400);
					}
					const r = await operate(`${op}:${id ?? ""}`, spec.cmd(id));
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
		let tailRestartTimer;

		function broadcast(obj) {
			const msg = JSON.stringify(obj);
			for (const ws of clients) {
				try { ws.send(msg); } catch { /* socket closing */ }
			}
		}

		/** Tail the dispatcher decision log; restart with backoff while clients exist.
		 * State dir partitions by the configured COMPUTE node (~/.sched/<node>/),
		 * NOT the ssh-landing host (an outside entry lands on the gateway whose
		 * own hostname dir is empty) — so resolve `node` from the remote
		 * ~/.sched/config.json rather than `hostname`. */
		async function resolveNode() {
			const res = await runRemote("cat $HOME/.sched/config.json");
			if (!res.ok) return undefined;
			try { return JSON.parse(res.stdout).node; } catch { return undefined; }
		}

		async function startTail() {
			if (tailChild || clients.size === 0) return;
			const nodeName = await resolveNode();
			if (!nodeName) {
				ctx.logger.error("[node-sched] cannot resolve sched node from remote ~/.sched/config.json");
				return;
			}
			const safeNode = String(nodeName).replace(/[^a-zA-Z0-9.-]/g, "");
			const remoteCmd = `tail -n 50 -F $HOME/.sched/${safeNode}/scheduler.log 2>/dev/null`;
			const child = cp.spawn(
				"ssh",
				["-o", `ConnectTimeout=${config.connectTimeoutSec}`, "-o", "BatchMode=yes", config.sshEntry, remoteCmd],
			);
			tailChild = child;
			let buffer = "";
			child.stdout.on("data", (d) => {
				buffer += d.toString();
				let at;
				while ((at = buffer.indexOf("\n")) !== -1) {
					const line = buffer.slice(0, at).trimEnd();
					buffer = buffer.slice(at + 1);
					if (line) broadcast({ type: "log", line });
				}
			});
			child.on("close", () => {
				tailChild = undefined;
				if (clients.size > 0 && !tailRestartTimer) {
					tailRestartTimer = setTimeout(() => {
						tailRestartTimer = undefined;
						startTail().catch(() => {});
					}, 5_000);
				}
			});
		}

		// Periodic status heartbeat so quiet stretches still refresh dashboards.
		heartbeat = setInterval(async () => {
			if (clients.size === 0) return;
			try {
				const { raw } = await query(`${S} status --json`);
				broadcast({ type: "status", summary: raw ? summarizeStatus(raw) : null, ts: Date.now() });
			} catch { /* transient */ }
		}, config.pollFallbackSec * 1000);

		routeDisposers.push(
			ctx.webServer.registerUpgrade({
				path: "/sched/ws/events",
				handler: (req, socket, head) => {
					wss.handleUpgrade(req, socket, head, (ws) => {
						clients.add(ws);
						ws.on("close", () => clients.delete(ws));
						ws.on("error", () => clients.delete(ws));
						startTail().catch(() => {});
					});
				},
			}),
		);
	}

	return () => {
		for (const d of disposers) { try { d?.(); } catch { /* already gone */ } }
		for (const d of routeDisposers) { try { d?.(); } catch { /* already gone */ } }
		clearInterval(heartbeat);
		stopRefresher();
	};
}

export { name, inject, Config, apply };
export default { name, inject, Config, apply };
