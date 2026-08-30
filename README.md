# dsh-node-sched

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**English** | [中文](README.zh-CN.md)

A [dsh](https://github.com/deepseek-ai/deepseek-harness) plugin suite that turns [sched](https://github.com/Gczmy/sched) — a node-level GPU/CPU batch scheduler — into a fully operable web dashboard and agent tool surface.

The design principle is **strict adapter architecture**: all scheduling intelligence lives in the remote `sched` daemon. The plugin never reimplements scheduling logic — it only provides transport (SSH), presentation, and operation forwarding.

```
┌─────────────────────────────┐         ┌──────────────────────────────────┐
│  dsh (browser)              │         │  remote compute node             │
│                             │         │                                  │
│  ┌───────────────────────┐  │  HTTP   │  ┌────────────┐   ┌───────────┐  │
│  │ node-sched-ui         │  │◄────────┼─►│ sched CLI  │◄──│ sched     │  │
│  │ full-screen dashboard │  │  /WS    │  │ (--json)   │   │ daemon    │  │
│  └──────────┬────────────┘  │  + SSH  │  └────────────┘   └─────┬─────┘  │
│             │ RPC           │         │                         │        │
│  ┌──────────▼────────────┐  │         │                  ┌──────▼─────┐  │
│  │ node-sched (host)     │──┼─────────┼─────────────────►│ state.db   │  │
│  │ proxy · audit · gate  │  │         │                  └────────────┘  │
│  └───────────────────────┘  │         │       GPUs 0..N                  │
└─────────────────────────────┘         └──────────────────────────────────┘
```

## Packages

| Package | Type | Description |
|---|---|---|
| [`packages/node-sched`](packages/node-sched) | host plugin | SSH proxy to the remote `sched` CLI, read-only agent tools, dashboard RPC/WS plumbing, write-op concurrency gate + audit log |
| [`packages/node-sched-ui`](packages/node-sched-ui) | client plugin | Full-screen dashboard: batch grid with segmented progress bars, GPU panel, live event stream, dry-run-gated submit |

## Features

- **Batch grid** — one card per batch with name, project badge, segmented progress bar (done / skipped / running / pending / failed), and task counts. Filter by project via dropdown.
- **GPU panel** — per-GPU status (free / assigned / unmanaged / quarantined) with the occupying job.
- **Paged history** — stable cursor paging across terminal task history without presenting a truncated page length as a total.
- **Live event stream** — dispatcher decisions streamed over WebSocket (`tail -F` on `scheduler.log`).
- **Task log viewer** — click any task to stream its stdout/stderr.
- **Dry-run-gated submit** — paste a `batch.json`, preview the expansion and SKIP verdicts before committing; destructive operations (cancel / resubmit / GPU free / daemon stop) require typed confirmation.
- **Multi-project aware** — surfaces per-project GPU quotas, priorities, and hard-affinity isolation as configured by sched's B11c multi-project mode.

### Query and mutation targets

Read-only queries and mutations are deliberately configured as separate paths. `transport` plus the current dashboard binding selects the query target; `mutationMode`, `mutationTarget`, `mutationSession`, and `mutationExpectedNode` select exactly one writer. Binding or unbinding a dashboard host never changes the writer, and `sshEntry` is only the explicit fallback query entry unless it is also named separately as the mutation target.

Mutations are disabled by default. The optional `screen` writer is a compatibility transport only: it has no built-in session name and cannot run until both its SSH target and session are explicitly configured. Operators should use the plugin or `sched` CLI rather than attaching to or typing into an infrastructure screen.

## Getting Started

### Prerequisites

- Node.js ≥ 22
- A reachable host running [sched](https://github.com/Gczmy/sched) with SSH access configured
- dsh ≥ matching your installed version

### Install

```bash
# add both packages to a dsh profile
dsh plugin --profile nodesched add ./packages/node-sched ./packages/node-sched-ui
```

Declare bundle order in the profile's `package.json`:

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@zzc/dsh-node-sched",
        "@zzc/dsh-node-sched-ui"
      ]
    }
  }
}
```

Configure every deployment-facing value in `cordis.patch.yml` (see [`profile/cordis.patch.yml`](profile/cordis.patch.yml)):

```yaml
- insert:
    - id: node-sched-proxy
      name: "@zzc/dsh-node-sched"
      config:
        sshEntry: "my-cluster"       # explicit fallback query SSH Host alias
        schedBin: "$HOME/bin/sched"  # full path for non-interactive execution
        probeCommand: "status"
        connectTimeoutSec: 20
        pollFallbackSec: 30
        transport: "auto"            # auto, or local when dsh runs on the sched node

        mutationMode: "disabled"     # fail closed until one writer is selected
        mutationTarget: ""
        mutationSession: ""
        mutationExpectedNode: ""

    - id: node-sched-ui
      name: "@zzc/dsh-node-sched-ui"
```

To enable mutations, replace the four mutation values as one unit:

| Writer | Exact configuration |
|---|---|
| Local process | `mutationMode: "local"`; leave target/session empty; set `mutationExpectedNode` |
| Embedded SSH engine | `mutationMode: "engine"`; set `mutationTarget` to a host-store alias; leave session empty; set `mutationExpectedNode` |
| Generic OpenSSH | `mutationMode: "ssh"`; set `mutationTarget` to an SSH config `Host` alias; leave session empty; set `mutationExpectedNode` |
| Explicit screen relay | `mutationMode: "screen"`; set `mutationTarget` to an SSH config `Host` alias, `mutationSession` to the exact session, and `mutationExpectedNode` |

Immediately before every mutation, the selected writer runs `hostname` and `sched config get` on that same transport. The writer hostname, `config.node`, and `mutationExpectedNode` must match exactly after case/trailing-dot normalization; otherwise the operation fails closed. No successful attestation is reused for a later mutation. Read bindings and dry-run traffic remain independent of this writer.

### Run

```bash
dsh --profile nodesched
# open http://127.0.0.1:<port> and click the ⚡ sched entry in the sidebar footer
```
On first use, copy the token from `~/.dsh/node-sched-access-token` into the dashboard prompt. The host plugin creates that file with mode `0600`; the UI keeps the value in browser `sessionStorage` only. Every HTTP request requires `Authorization: Bearer <token>`. WebSocket upgrades use the exact subprotocol pair `sched-auth, <token>` and never put the token in the URL.


## HTTP API

All endpoints are served by the host plugin under `/sched/api/*`. Read responses use a bounded-TTL server-side cache and expose freshness/age/last-error metadata. Once a successful entry expires, it is no longer returned as a fresh success; the host refreshes or reports an explicit stale failure.

| Endpoint | Method | Description |
|---|---|---|
| `/sched/api/status?limit=&cursor=&job_cursor=` | GET | One canonical status page; batch and job cursors are independent and truncation never implies a total count |
| `/sched/api/history?batch=&limit=&cursor=` | GET | One canonical history page with stable cursor/truncation metadata |
| `/sched/api/gpus` | GET | GPU table text |
| `/sched/api/log?batch=&task=` | GET | Task log tail |
| `/sched/api/daemon` | GET | Daemon liveness |
| `/sched/api/dryrun` | POST | Dry-run preview of a batch spec (no side effects) |
| `/sched/api/op` | POST | Whitelisted operations: `cancel` / `retry` / `resubmit` / `gpu-free` / `gpu-ignore` / `gpu-ok` / `daemon-start` / `daemon-stop` |
| `/sched/ws/events` | WS | Live dispatcher event stream |

### sched JSON contracts

- `sched status --json` uses `schema_version: 1`, defaults to a 200 limit, and clamps it to 1–1000. It selects bounded current/newest batches first, then emits only latest-version jobs whose `batch_id` is present in the returned batch list. `batch_id` is the sole machine reference; `batch_name` is display-only. Jobs use canonical `status`; scheduler blocking is represented as `status: "pending"` with `wait_reason: "quota"` or `"dependency"`. `truncated.batches`/`next_cursor` and `truncated.jobs`/`next_job_cursor` are independent stable pagination lanes (`--cursor` and `--job-cursor`). Batch and GPU records include a non-negative `revision`; GPU records also include sorted exact `{job_id,vram_gib}` assignments.
- `sched task <batch-id>:<task> --json` is the task-detail protocol and includes the owning `batch_revision`. `sched history --json` uses `schema_version: 1`, defaults to 50 records, and bounds the limit to 1–200. Its `history` records keep `batch_id` and `batch_name` separate, and its top-level `truncated`/`next_cursor` pair drives `--cursor` pagination.

## Safety Model

- **Explicit query target and SSH identity** — `sshEntry` is pinned in config; probe failures raise an error instead of silently switching hosts. A dashboard engine binding affects reads only. Every embedded SSH target and every ProxyJump hop must also have an exact OpenSSH `SHA256:...` host-key pin in the private `~/.dsh/dsh-ssh.json` host store. Missing or mismatched pins fail closed; imported unpinned hosts cannot test or open terminals until an operator sets the pin.
- **Verified, fail-closed writer** — mutations stay disabled until one local, engine, or SSH writer is fully configured. Immediately before every mutation, that writer is re-attested against the exact expected sched node; verification is never cached across operations. The screen compatibility writer cannot prove uploaded-command channel equivalence and therefore refuses upload-backed mutations.
- **Durable at-most-once mutations** — writes are serialized through a single-flight gate. Browser tabs atomically claim unresolved request IDs in IndexedDB, so reloads, tab replacement, and concurrent tabs reuse the same binding. Every `sched request` includes `--expect-revision`; task requests also bind exact status/version, while GPU requests bind quarantine and the complete sorted assignment set. Unbound submit, daemon, and config mutations use revision zero. Codes `-1` (transport unknown) and `75` (scheduler outcome unknown) retain both the request binding and staged payload; only definitive outcomes remove them. Retained payloads are age-collected.
- **Guarded sensitive routes** — every HTTP route requires the private local bearer token and a loopback peer. Every mutation, including SSH host management/import/unbind, generic execution, authentication answers, and client logging, is `POST`-only and additionally requires a present, exact same-origin `Origin` matching `Host`; missing or foreign origins fail closed. WebSockets require the bearer token in their negotiated subprotocol, cap payload/rate/client counts and buffered output, and never accept URL credentials.
- **Bounded input, output, and staging** — JSON request bodies and uploaded batch/config objects are capped at 2 MiB and bounded by nesting/node counts. CLI and SSH stdout/stderr are capped at 2 MiB per stream with explicit byte-counted truncation markers; event-tail partial lines are byte-bounded and framed only after complete UTF-8 decoding. Local and remote staging use unique private temporary files, file `fsync`, atomic replacement, and directory `fsync`; remote mode-0700 directories and mode-0600 files are enforced before execution. CLI SSH processes receive TERM, a grace interval, then KILL only through their tracked process group, and settle from the close event.
- **Authentication audience and lifecycle** — interactive SSH and every ProxyJump hop/`forwardOut` share one absolute connection deadline. Challenges require a visible dashboard audience and remain replayable across a short dashboard reconnect only while their SSH connection is alive. Explicit answers—including an explicit zero-answer response—are the only outcomes sent to ssh2; cancellation, expiry, connection failure, or abort destroys the client, clears the pending challenge, and emits one matching terminal frame without submitting answers.
- **Typed confirmation** — cancel, artifact-clearing resubmit, GPU release, and daemon stop all require typing an explicit confirmation word.
- **Audit log** — every forwarded operation is recorded with caller, arguments, and result; sensitive command material is redacted.
- **Server and browser freshness** — status and daemon caches have finite server TTLs and report stale age plus the last refresh error. The browser additionally applies a local TTL, rejects out-of-order poll completions, and fails stale/error snapshots closed for mutations. Status/history views consume every stable cursor page; while a page is truncated, its row count is displayed only as “loaded” or “shown”, never as a total.

## Development

```bash
pnpm install
node scripts/build-client.mjs                    # direct client bundle; uses already-installed deps
pnpm build                                       # install check + rebuild every package
node --check packages/*/lib/*.js
```

If pnpm blocks installation because the approved-build policy has not authorized esbuild, stop and have the repository or policy owner approve `esbuild` with the organization-approved `pnpm approve-builds` workflow, then rerun `pnpm install`. Do not disable script controls, allow all dependency builds, or relax the approved-build policy as a workaround. When dependencies are already installed and only the client source changed, `node scripts/build-client.mjs` rebuilds that bundle without running an install or changing the approval policy.

Implementation notes and pitfalls live in [`docs/implementation-notes.md`](docs/implementation-notes.md).

## License

MIT — see [LICENSE](LICENSE).
