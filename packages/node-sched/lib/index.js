/**
 * @zzc/dsh-node-sched — dsh host plugin (M1 skeleton).
 *
 * Adapter over the remote `sched` node-level GPU/CPU scheduler. This plugin
 * never reimplements scheduling: it shells out to the remote CLI over ssh
 * (JSON interfaces are the contract), tails the remote events directory for
 * push updates, and exposes the surface as agent tools + dashboard RPC.
 *
 * Design doc: VeighNa_Trade/docs/04-scheduler/dsh_sched_plugin_research.md
 * Sched semantics: VeighNa_Trade/docs/04-scheduler/scheduler_design.md
 *
 * Status: M1 skeleton — schedProxy service is real; agent tools and WS tail
 * are stubbed pending runtime verification of the dsh tool/prompt APIs.
 */

const name = "node-sched";

/**
 * Config is deployment truth only — no account/node/path may leak into code
 * (same discipline as sched's own I/J-class config separation). The ssh entry
 * MUST be explicit: HPDC (campus) vs HPDC_outside; the plugin never switches
 * entries on its own (AGENTS.md §1 discipline).
 */
const Config = {
  type: "object",
  properties: {
    /** ssh entry alias; probed at activation with a short ConnectTimeout. */
    sshEntry: { type: "string", default: "HPDC" },
    /** Remote command used for probes; the daemon node resolves via config.node remotely. */
    probeCommand: { type: "string", default: "sched status --json" },
    /** ConnectTimeout passed to ssh for every invocation. */
    connectTimeoutSec: { type: "integer", minimum: 5, maximum: 120, default: 20 },
    /** Fallback polling interval (seconds) when the events tail is unavailable. */
    pollFallbackSec: { type: "integer", minimum: 10, maximum: 600, default: 30 }
  },
  additionalProperties: false
};

const inject = ["webServer", "logger"];

/** One in-flight write operation per target, so double-clicks cannot double-kill. */
class WriteGate {
  constructor() {
    /** @type {Map<string, Promise<unknown>>} */
    this.inflight = new Map();
  }

  /**
   * @param {string} key e.g. "cancel:batch:task" or "submit:<sha>"
   * @param {() => Promise<unknown>} fn
   */
  run(key, fn) {
    if (this.inflight.has(key)) {
      return Promise.reject(
        new Error(`operation already in flight: ${key} (refusing concurrent write)`),
      );
    }
    const p = fn().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }
}

/**
 * @param {import('node:child_process')} cp
 * @param {{ sshEntry: string, connectTimeoutSec: number }} cfg
 */
function makeRunner(cp, cfg) {
  return function runRemote(args, { timeoutMs = 60_000 } = {}) {
    const cmd = [
      "ssh", "-o", `ConnectTimeout=${cfg.connectTimeoutSec}`,
      "-o", "BatchMode=yes",
      cfg.sshEntry,
      args,
    ];
    return new Promise((resolve) => {
      cp.exec(cmd.join(" "), { timeout: timeoutMs, encoding: "utf8" }, (err, stdout, stderr) => {
        resolve({ ok: !err, code: err ? (err.code ?? -1) : 0, stdout, stderr });
      });
    });
  };
}

async function install(ctx, config) {
  const cp = await import("node:child_process");
  const runRemote = makeRunner(cp.default ?? cp, config);
  const gate = new WriteGate();
  let auditSeq = 0;

  /**
   * Read-only remote query. Retries once on transient ssh failure; results are
   * parsed as JSON when `json` is requested, else returned verbatim.
   */
  async function query(args, { json = true } = {}) {
    let res = await runRemote(args);
    if (!res.ok && isTransient(res)) res = await runRemote(args);
    return { ...res, parsed: json ? tryParseJson(res.stdout) : undefined };
  }

  /**
   * Side-effectful operation. Serialized per key, audited, never auto-retried
   * (unknown outcome => report and ask a human to verify `sched status`).
   */
  async function operate(key, args, { timeoutMs } = {}) {
    return gate.run(key, async () => {
      ctx.logger?.warn?.(`[node-sched] audit #${++auditSeq} op=${key} cmd=sched ${args}`);
      const res = await runRemote(args, { timeoutMs });
      // Do NOT retry writes: a timeout after killpg may have taken effect.
      return { ...res, parsed: tryParseJson(res.stdout) };
    });
  }

  function isTransient(res) {
    return /Connection timed out|Connection refused|kex_exchange/i.test(res.stderr ?? "");
  }

  function tryParseJson(text) {
    try { return JSON.parse(text); } catch { return undefined; }
  }

  // ── Activation probe: fail loud on entry/network mismatch (never switch). ──
  const probe = await runRemote(config.probeCommand, { timeoutMs: config.connectTimeoutSec * 2_000 });
  if (!probe.ok) {
    throw new Error(
      `[node-sched] probe failed via ssh entry "${config.sshEntry}" (code ${probe.code}). ` +
      `Check network environment (campus=HPDC / outside=HPDC_outside) before retrying. ` +
      `stderr: ${(probe.stderr || "").trim().slice(0, 400)}`,
    );
  }

  /**
   * Public service surface. Tools/RPC layers call into these only.
   * @type {typeof import('./index.js').SchedProxy}
   */
  const schedProxy = {
    status: () => query("sched status --json"),
    listGpus: () => query("sched list-gpus --json"),
    task: (id) => query(`sched diag ${shellQuote(id)}`),
    history: (batch) =>
      query(batch ? `sched history --json ${shellQuote(batch)}` : "sched history --json"),
    markers: () => query("sched markers"),
    logTail: (id, lines = 100) =>
      query(`sched log ${shellQuote(id)} -n ${Math.min(Math.max(lines, 1), 2000)}`, { json: false }),

    dryRunSubmit: (batchPath) =>
      query(`sched submit --dry-run ${shellQuote(batchPath)}`, { json: false }),
    dryRunRun: (cmdline) => query(`sched run --dry-run ${cmdline}`, { json: false }),

    submit: (batchPath) => operate(`submit:${batchPath}`, `sched submit ${shellQuote(batchPath)}`),
    cancel: (id) => operate(`cancel:${id}`, `sched cancel ${shellQuote(id)}`),
    retry: (id) => operate(`retry:${id}`, `sched retry ${shellQuote(id)}`),
    // Resubmit deletes declared artifacts upstream; UI must have confirmed twice.
    resubmit: (id) => operate(`resubmit:${id}`, `sched resubmit ${shellQuote(id)}`)
  };

  ctx.schedProxy = schedProxy;

  return () => {
    delete ctx.schedProxy;
  };
}

function shellQuote(s) {
  return `'${String(s).replaceAll("'", `'\\''`)}'`;
}

export { name, inject, Config, install };
export default { name, inject, Config, install };
