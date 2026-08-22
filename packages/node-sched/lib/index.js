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

const inject = ["tools", "systemPrompt"];

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
	if (!res.ok) {
		return { text: clip(`[error exit=${res.code}] ${(res.stderr || res.stdout || "(no output)").trim()}`), raw: undefined };
	}
	const body = (res.stdout ?? "").trim();
	if (!json) return { text: clip(body || "(no output)"), raw: undefined };
	const parsed = (() => { try { return JSON.parse(body); } catch { return undefined; } })();
	return {
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

	return () => {
		for (const d of disposers) { try { d?.(); } catch { /* already gone */ } }
	};
}

export { name, inject, Config, apply };
export default { name, inject, Config, apply };
