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
| [`packages/node-sched-ui`](packages/node-sched-ui) | client plugin | Native main-panel dashboard: batch grid with segmented progress bars, GPU panel, live event stream, dry-run-gated submit |

## Features

- **Batch grid** — one card per batch with name, project badge, segmented progress bar (done / skipped / running / pending / failed), and task counts. Filter by project via dropdown.
- **GPU panel** — per-GPU status (free / assigned / unmanaged / quarantined) with the occupying job.
- **Paged history** — stable cursor paging across terminal task history without presenting a truncated page length as a total.
- **Live event stream** — dispatcher decisions streamed over WebSocket (`tail -F` on `scheduler.log`).
- **Task log viewer** — click any task to stream its stdout/stderr.
- **Dry-run-gated submit** — paste a `batch.json`, preview the expansion and SKIP verdicts before committing; destructive operations (cancel / resubmit / GPU free / daemon stop) require typed confirmation.
- **Daemon maintenance** — `drain` pauses new dispatch while running jobs finish, `drain + stop` exits when idle, and `resume` removes the drain. A stopped daemon needs a separate `start` after `resume`.
- **Multi-project aware** — surfaces per-project GPU quotas, priorities, and hard-affinity isolation as configured by sched's B11c multi-project mode.
- **DSH navigation and cancellation** — the dashboard participates in the host's main-panel navigation and settings page; stopping an agent turn cancels its in-flight sched query.

### Project GPU access

Project settings expose `projects.<name>.gpu_enabled` (boolean, omitted means
`true`) independently of `gpu_quota`; quota `0` remains unlimited. Disabling
rejects new GPU submissions and manual GPU retry/resubmit, holds queued GPU work,
and lets running jobs and CPU-only work continue. Re-enabling resumes the existing
queued versions. The dashboard preserves explicit `false` and zero quota in the
saved patch and shows disabled / unlimited / limited access plus task wait reasons.

Deploy this plugin together with sched's project GPU access support before using
the switch. Status remains schema 1 and adds `wait_reason: "project_gpu_disabled"`
for pending GPU jobs; older strict plugin validators reject that new value. All
policy decisions and writes remain in sched; see the
[implementation notes](docs/implementation-notes.md#project-gpu-access-2026-09-07).

### Query transports and mutation targets

Read-only queries and mutations are deliberately configured as separate paths. `transport` plus the current dashboard binding selects the query transport and target; `mutationMode`, `mutationTarget`, `mutationSession`, and `mutationExpectedNode` select exactly one writer. Changing a dashboard binding never changes the writer, and `sshEntry` is an explicit OpenSSH `Host` alias rather than a host discovered by fallback.

The dashboard offers three query transports:

- **System OpenSSH** (`system-openssh`) reuses an already-authenticated OpenSSH `ControlMaster` for `sshEntry`. It is the recommended mode on macOS and Linux when a terminal login already completed password or 2FA authentication.
- **Embedded engine** (`engine`) keeps the existing ssh2 connection-pool, host-pin, and in-dashboard authentication path as an explicit alternative.
- **Local** (`local`) runs the sched CLI directly when dsh and sched are on the same node.

In embedded-engine mode, cancelling an SSH authentication challenge stops that attempt and suspends automatic authentication for that host. Background polling does not reopen the challenge. Use an explicit host test, bind, command, or terminal action in the SSH panel to try again. The live event stream opens a channel only on an already-authenticated pooled connection; if none is available, it waits for an explicit connection instead of creating a separate password/2FA login.

Mutations are disabled by default. The optional `screen` writer is a compatibility transport only: it has no built-in session name and cannot run until both its SSH target and session are explicitly configured. Operators should use the plugin or `sched` CLI rather than attaching to or typing into an infrastructure screen.

### Reuse a terminal SSH login

System OpenSSH mode deliberately reuses authentication; it does not copy or cache authentication material. Configure OpenSSH multiplexing for the same alias used by `sshEntry`, for example:

```sshconfig
Host my-cluster
    ControlMaster auto
    ControlPersist 30m
    ControlPath ~/.ssh/cm-%C-%n
```

Run `ssh my-cluster` in a local terminal and complete its password/2FA flow once, then choose **Reuse terminal login** in the SSH panel. dsh checks the existing master with `ssh -O check`; it never reads, receives, or stores the password, private-key passphrase, or OTP. `ControlPersist` determines how long the login can be reused after the original terminal exits.

The terminal and the dsh host process must run as the same local OS account and see the same `ControlPath` filesystem. A dsh instance running as another user, in an isolated container, or on another machine cannot reuse that socket.

Keep the `ControlPath` unique per original Host alias (`%n` above), especially when two aliases reach the same final host through different gateways. Keep the resulting socket path short enough for the operating system's Unix-socket limit; an explicit short path per Host is also valid.

Commands, live logs, and the Web terminal all use that same master in non-interactive `BatchMode`. If no matching master exists—or it expires—they fail closed, and the SSH panel shows a non-blocking banner asking the user to run `ssh <alias>` and recheck. They never silently open a fresh authentication flow, retry a mutation on another connection, or fall back to the embedded engine. Select the embedded engine explicitly when browser-mediated SSH authentication is required.

The passenger sessions also disable local/remote/dynamic, agent, X11, and tunnel forwarding, reject local commands, and cannot detach themselves. Command and log sessions force TTY off; the Web terminal receives a PTY but disables OpenSSH escape commands, so browser input remains remote-shell input rather than a local SSH control channel.

The host plugin runs on macOS or Linux. On Windows, run dsh inside WSL2 and keep its credential data in the Linux filesystem: the current stores require POSIX private permissions and directory fsync, including when the embedded engine is selected. Native Windows supports building the browser bundle, but cannot run the host plugin. The browser Web terminal uses `node-pty` to give system `ssh` a real PTY; command and log reuse do not depend on terminal emulation.

## Getting Started

### Prerequisites

- Node.js ≥ 22
- A reachable host running [sched](https://github.com/Gczmy/sched) with SSH access configured
- macOS or Linux (WSL2 on Windows, with credential data in the Linux filesystem)
- dsh `0.1.6-alpha.1` (the prerelease targeted by this compatibility update)

### Install

```bash
# run from this checkout; link both plugins into the named profile
npx @deepseek-ai/dsh@0.1.6-alpha.1 plugin --profile nodesched add \
  link:./packages/node-sched link:./packages/node-sched-ui
```

Keep only the official base and Web bundles in this example's `dsh.profile.bundles`. Merge this field into the profile's existing `package.json` (normally `~/.dsh/profiles/nodesched/package.json`), preserving its dependencies and other settings:

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app"
      ]
    }
  }
}
```

The two sched packages are ordinary linked plugin dependencies and do not declare `dsh.bundle`. Do not add them to `dsh.profile.bundles`: the profile loader expects a bundle patch and will reject them. A `declares no dsh.bundle` message during installation is expected. Activate both plugins by merging the following `insert` entries into the named profile's `cordis.patch.yml`, configuring every deployment-facing value (see [`profile/cordis.patch.yml`](profile/cordis.patch.yml)). Editing the example in this checkout alone does not update the active profile:

```yaml
- insert:
    - id: node-sched-proxy
      name: "@zzc/dsh-node-sched"
      config:
        sshEntry: "my-cluster"       # explicit OpenSSH Host alias for remote queries
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
npx @deepseek-ai/dsh@0.1.6-alpha.1 --profile nodesched
# open http://127.0.0.1:<port> and click the sched entry in the sidebar
```

If the `dsh` executable already resolves to this version, `dsh --profile nodesched` is equivalent. `--profile` takes a profile name, not a YAML path; `dsh web --profile ...` is not a supported invocation. The Web bundle in the named profile supplies the browser UI.

On the targeted DSH version, sched uses the native main panel and settings section. Switching to a conversation or using the DSH logo to start one leaves the sched panel through the host's navigation, so a separate overlay cannot continue covering the conversation. The settings page also exposes the sched status and dashboard entry.

Loading the surrounding DSH page does not authenticate, poll, or open a sched WebSocket. Opening the dashboard without a usable browser session shows a non-blocking banner, so the rest of the page remains visible; only clicking its connection button opens the token form. Cancelling that form returns to the banner and starts no protected dashboard work. Paste the master token from `~/.dsh/node-sched-access-token` once. By default the browser generates a non-exportable P-256 signing key, stores that private key in origin-scoped IndexedDB, and registers only its public key with the host for 30 days. Later opens reuse an unexpired short session or silently sign a one-time challenge to receive a new 15-minute bearer. The master token is never persisted in the browser. Uncheck **Trust this browser** to exchange it for a short session without registering a device.

Trusted-browser records are stored by the host in `~/.dsh/node-sched-trusted-browsers.json` with mode `0600` and are invalidated when the master token changes. **Forget this device** revokes its sessions and closes its authenticated WebSockets. Browser trust belongs to one browser profile and origin: changing between `localhost` and `127.0.0.1`, changing the port, using a private window, or clearing site data requires pairing again. A normal web page cannot read `~/.dsh/node-sched-access-token`, so the first pairing cannot safely be made silent without a separate trusted native/CLI hand-off.

Every protected HTTP request uses `Authorization: Bearer <master-or-short-session>`. WebSocket upgrades use the exact subprotocol pair `sched-auth, <token>` and never put credentials in the URL.

### SSH server trust

Browser/device trust and SSH server trust are separate. Browser trust controls access to the dashboard. In system-OpenSSH mode, the local OpenSSH client applies `~/.ssh/config` and `known_hosts` while dsh only verifies and reuses the existing `ControlMaster`. In embedded-engine mode, dsh's host-key store proves which remote server the engine reached; password, private-key, and agent authentication then prove who the user is. A client public key such as `id_ed25519.pub` or `kelvin2_key.pub` is therefore not a server host pin.

For the embedded engine, importing `~/.ssh/config` lets the SSH panel reuse exact entries from the owned, non-writable `~/.ssh/known_hosts` or `known_hosts2` files. Plain, comma-separated, non-default-port, hashed OpenSSH host names and multiple host-key algorithms are supported. Matching `@revoked` entries fail closed; `@cert-authority`, wildcard, malformed, unsafe, or unsupported entries are never silently converted into exact pins.

If no reusable entry exists, **Establish trust** performs only SSH key exchange. The candidate receives no password, private key, passphrase, ssh-agent signature, or keyboard-interactive answer. The UI displays the observed algorithm, endpoint, and SHA256 fingerprint; only an explicit, short-lived, browser-bound confirmation writes it to `~/.dsh/dsh-ssh.json`. This is trust on first use (TOFU): it pins later connections but cannot independently prove that the first network path was uncompromised. Cancelling aborts an in-flight probe and invalidates any pending confirmation. Once **Confirm and trust** starts the synchronous durable commit, cancel is disabled so the UI never claims an already-authorized save was undone.

ProxyJump routes are trusted from the first hop forward. Credentials may be used to authenticate already-pinned prefix hops so the tunnel can be opened, but are never sent to the currently observed, unconfirmed hop. Routes are an explicit flat alias list; a nested `ProxyJump` on one of those aliases fails closed and must be flattened on the target. Existing pins are never replaced automatically; rotation requires an unbound target and an explicit old/new confirmation.


## HTTP API

All endpoints are served by the host plugin under `/sched/api/*`. Read responses use a bounded-TTL server-side cache and expose freshness/age/last-error metadata. Once a successful entry expires, it is no longer returned as a fresh success; the host refreshes or reports an explicit stale failure.

| Endpoint | Method | Description |
|---|---|---|
| `/sched/api/status?limit=&cursor=&job_cursor=` | GET | One canonical status page; batch and job cursors are independent and truncation never implies a total count |
| `/sched/api/history?batch=&limit=&cursor=` | GET | One canonical history page with stable cursor/truncation metadata |
| `/sched/api/gpus` | GET | GPU table text |
| `/sched/api/log?batch=&task=` | GET | Task log tail |
| `/sched/api/daemon` | GET | Daemon liveness |
| `/sched/api/auth/session` | POST | Exchange the master token for a short, non-persistent browser session |
| `/sched/api/auth/pair` | POST | Register a browser P-256 public key using the master token |
| `/sched/api/auth/challenge` | POST | Issue one bounded, single-use trusted-browser challenge |
| `/sched/api/auth/verify` | POST | Verify the browser signature and issue a short session |
| `/sched/api/auth/forget` | POST | Revoke the current trusted browser and all of its sessions |
| `/sched/api/auth/me` | POST | Inspect the current master or short-session principal |
| `/sched/api/auth/list` | POST | List trusted browsers (authenticated callers only) |
| `/sched/api/dryrun` | POST | Dry-run preview of a batch spec (no side effects) |
| `/sched/api/op` | POST | Whitelisted operations: `cancel` / `retry` / `resubmit` / `gpu-free` / `gpu-ignore` / `gpu-ok` / `daemon-start` / `daemon-stop` / `daemon-drain` / `daemon-drain-stop-when-idle` / `daemon-resume` |
| `/sched/ssh/hosts` | GET/POST | Secret-free host summaries and revision-bound host management |
| `/sched/ssh/import` | POST | Import SSH config and safely reuse matching local known-host pins |
| `/sched/ssh/host-key` | POST | Prepare, confirm, or cancel one browser-bound host-key trust operation |
| `/sched/ssh/test` | POST | Run a normal, pinned and authenticated SSH connectivity test |
| `/sched/ssh/binding` | GET | Inspect the selected query transport and current ControlMaster readiness |
| `/sched/ssh/use-system` | POST | Select system OpenSSH only after a matching active ControlMaster is found |
| `/sched/ssh/unbind` | POST | Clear the embedded-engine binding and return to the configured system-OpenSSH entry |
| `/sched/ws/events` | WS | Live dispatcher event stream |
| `/sched/ws/ssh-terminal` | WS | Bounded PTY terminal over the explicitly selected SSH transport |

### sched JSON contracts

- `sched status --json` uses `schema_version: 1`, defaults to a 200 limit, and clamps it to 1–1000. It selects bounded current/newest batches first, then emits only latest-version jobs whose `batch_id` is present in the returned batch list. `batch_id` is the sole machine reference; `batch_name` is display-only. Jobs use canonical `status`; scheduler blocking is represented as `status: "pending"` with `wait_reason: "quota"` or `"dependency"`. `truncated.batches`/`next_cursor` and `truncated.jobs`/`next_job_cursor` are independent stable pagination lanes (`--cursor` and `--job-cursor`). Batch and GPU records include a non-negative `revision`; GPU records also include sorted exact `{job_id,vram_gib}` assignments.
- `sched task <batch-id>:<task> --json` is the task-detail protocol and includes the owning `batch_revision`. `sched history --json` uses `schema_version: 1`, defaults to 50 records, and bounds the limit to 1–200. Its `history` records keep `batch_id` and `batch_name` separate, and its top-level `truncated`/`next_cursor` pair drives `--cursor` pagination.

## Safety Model

- **Explicit query target and SSH identity** — `sshEntry` is pinned in config; probe failures raise an error instead of silently switching hosts. System OpenSSH accepts only a live master for that exact alias and never falls back to new authentication. An explicit dashboard engine binding affects reads only. Every embedded-engine target and every ProxyJump hop must have an exact trusted OpenSSH SHA256 host key in the private `~/.dsh/dsh-ssh.json` store. Safe matching entries are imported from the local OpenSSH trust store; otherwise an explicit, credential-free TOFU confirmation is required. Multiple exact algorithms are retained, while absent, revoked, stale, or mismatched keys fail closed. Existing trust is never silently replaced.
- **Concurrent host-store safety** — host edits carry per-host revisions. Durable writes take a private cross-process lock, securely reload the current document, compare the complete prior generation, and atomically replace it; stale writers receive a conflict and must reload instead of overwriting a newer pin. SSH routes refresh external generations and evict affected pooled connections before use.
- **Verified, fail-closed writer** — mutations stay disabled until one local, engine, or SSH writer is fully configured. Immediately before every mutation, that writer is re-attested against the exact expected sched node; verification is never cached across operations. The screen compatibility writer cannot prove uploaded-command channel equivalence and therefore refuses upload-backed mutations.
- **Maintenance capability checks** — the dashboard enables maintenance controls only from a fresh daemon sample that advertises the action. The backend then checks complete writer status and re-queries `daemon status --json` on the attested writer; missing capability or a mismatched node rejects the operation before `sched request`.
- **Durable at-most-once mutations** — writes are serialized through a single-flight gate. IndexedDB atomically stores each unresolved operation's full request and ID; reloads and refreshed snapshots replay the original preconditions. Every `sched request` includes `--expect-revision`; task requests bind exact status/version, while GPU requests bind quarantine and complete sorted assignments. The CLI checks its saved receipt before comparing current state atomically, so a successful operation remains replayable after changing that state. Unbound submit, daemon, and config mutations use revision zero. Transport errors, SSH exit `255`, signal exits, scheduler code `75`, and incomplete success responses retain the binding and staged payload. Only definitive outcomes remove them; retained payloads are age-collected. Legacy unresolved ID-only records require manual result reconciliation before reuse.
- **Guarded sensitive routes** — every protected HTTP route requires either the private master bearer or an unexpired short browser session and a loopback peer. Browser pairing and session exchange require the master bearer; challenge verification requires the registered non-exportable browser key. Every POST, including authentication bootstrap, SSH host management/import/host-key confirmation/unbind, generic execution, authentication answers, and client logging, additionally requires a present, exact same-origin `Origin` matching `Host`; missing or foreign origins fail closed. Browser and host-key challenges are single-use, short-lived, rate/cap bounded, and bound to their exact principal and state. WebSockets require a bearer in their negotiated subprotocol, close when its short session expires or is revoked, cap payload/rate/client counts and buffered output, and never accept URL credentials.
- **Bounded input, output, and staging** — JSON request bodies and uploaded batch/config objects are capped at 2 MiB and bounded by nesting/node counts. CLI and SSH stdout/stderr are capped at 2 MiB per stream with explicit byte-counted truncation markers; event-tail partial lines are byte-bounded and framed only after complete UTF-8 decoding. Local and remote staging use unique private temporary files, file `fsync`, atomic replacement, and directory `fsync`; remote mode-0700 directories and mode-0600 files are enforced before execution. CLI SSH processes receive TERM, a grace interval, then KILL only through their tracked process group, and settle from the close event.
- **Authentication audience and lifecycle** — embedded-engine interactive SSH and every ProxyJump hop/`forwardOut` share one absolute connection deadline. Challenges require a visible dashboard audience and remain replayable across a short dashboard reconnect only while their SSH connection is alive. Explicit answers—including an explicit zero-answer response—are the only outcomes sent to ssh2; cancellation, expiry, connection failure, or abort destroys the client, clears the pending challenge, and emits one matching terminal frame without submitting answers. System OpenSSH has no browser challenge path: it accepts only a terminal-created master and uses `BatchMode` throughout.
- **Typed confirmation** — cancel, artifact-clearing resubmit, GPU release, and daemon stop all require typing an explicit confirmation word.
- **Audit log** — every forwarded operation is recorded with caller, arguments, and result; sensitive command material is redacted.
- **Server and browser freshness** — status and daemon caches have finite server TTLs and report stale age plus the last refresh error. The browser additionally applies a local TTL, rejects out-of-order poll completions, and fails stale/error snapshots closed for mutations. Status/history views consume every stable cursor page; while a page is truncated, its row count is displayed only as “loaded” or “shown”, never as a total.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for supported tool versions, Linux regression tests, privacy checks and the optional local pre-commit hook.

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm build
```

The workspace explicitly permits the `esbuild` install script and keeps native PTY and optional SSH acceleration build scripts disabled. Review any new dependency before changing this allowlist; do not enable all scripts or disable the policy. With dependencies installed, `node scripts/build-client.mjs` rebuilds only the browser bundle.

Implementation notes and pitfalls live in [`docs/implementation-notes.md`](docs/implementation-notes.md).

## License

MIT — see [LICENSE](LICENSE).
