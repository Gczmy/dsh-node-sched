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
- **Live event stream** — dispatcher decisions streamed over WebSocket (`tail -F` on `scheduler.log`).
- **Task log viewer** — click any task to stream its stdout/stderr.
- **Dry-run-gated submit** — paste a `batch.json`, preview the expansion and SKIP verdicts before committing; destructive operations (cancel / resubmit / GPU free / daemon stop) require typed confirmation.
- **Multi-project aware** — surfaces per-project GPU quotas, priorities, and hard-affinity isolation as configured by sched's B11c multi-project mode.

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

Configure the SSH entry in `cordis.patch.yml` (see [`profile/cordis.patch.yml`](profile/cordis.patch.yml)):

```yaml
- insert:
    - id: node-sched-proxy
      name: "@zzc/dsh-node-sched"
      config:
        sshEntry: "my-cluster"      # ssh config Host alias — explicit, never auto-switched
        connectTimeoutSec: 20
        pollFallbackSec: 30

    - id: node-sched-ui
      name: "@zzc/dsh-node-sched-ui"
```

### Run

```bash
dsh --profile nodesched
# open http://127.0.0.1:<port> and click the ⚡ sched entry in the sidebar footer
```

## HTTP API

All endpoints are served by the host plugin under `/sched/api/*`. Responses are cached server-side by a background refresher, so browser polling is instant and network flakiness upstream is transparent.

| Endpoint | Method | Description |
|---|---|---|
| `/sched/api/status` | GET | Full snapshot: batches, tasks, jobs, GPUs, projects (+ summary text) |
| `/sched/api/gpus` | GET | GPU table text |
| `/sched/api/log?batch=&task=` | GET | Task log tail |
| `/sched/api/daemon` | GET | Daemon liveness |
| `/sched/api/dryrun` | POST | Dry-run preview of a batch spec (no side effects) |
| `/sched/api/op` | POST | Whitelisted operations: `cancel` / `retry` / `resubmit` / `gpu-free` / `gpu-ignore` / `gpu-ok` / `daemon-start` / `daemon-stop` |
| `/sched/ws/events` | WS | Live dispatcher event stream |

## Safety Model

- **Explicit SSH entry** — the cluster alias is pinned in config; probe failures raise an error instead of silently switching hosts.
- **Write gate** — write operations are serialized through a single-flight gate; no automatic retries when the outcome is unknown.
- **Typed confirmation** — cancel, artifact-clearing resubmit, GPU release, and daemon stop all require typing an explicit confirmation word.
- **Audit log** — every forwarded operation is recorded with caller, arguments, and result.
- **Server-side cache** — read paths serve from a background refresher; a flaky SSH link degrades staleness, never correctness of past observations.

## Development

```bash
pnpm install
pnpm build          # rebuilds the client bundle (esbuild → __ModuleLoader__ factory format)
node --check packages/*/lib/*.js
```

Implementation notes and pitfalls live in [`docs/implementation-notes.md`](docs/implementation-notes.md).

## License

MIT — see [LICENSE](LICENSE).
