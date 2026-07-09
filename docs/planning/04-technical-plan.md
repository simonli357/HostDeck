# Technical Plan

Owns the active-version architecture, process and trust boundaries, selected dependencies, service lifecycle, storage ownership, and migration policy. Detailed sequences and task ordering live in `docs/planning/04a-implementation-blueprint.md`.

## Architecture Status

- Direction: app-server-first rebaseline approved by `DEC-018`.
- Release state: no-go. Existing packages prove reusable foundations, not the selected production vertical.
- Legacy state: tmux/TUI adapter and capture evidence remain in the repo until `INT-V1-008` decides removal after the structured vertical passes.
- Public boundary: the phone talks only to HostDeck. Codex app-server is private to the Ubuntu user and never binds LAN.

## Hard Requirements

The architecture is acceptable for V1 only when all of the following are true:

- One typed adapter owns every Codex protocol request, response, notification, server request, timeout, capability, and compatibility error.
- Codex is the source of truth for threads, turns, approvals, goals, model state, and full history; HostDeck stores a bounded projection, not a competing transcript.
- Foreground and user-service modes have explicit process ownership and can restart HostDeck without killing the dedicated app-server process in service mode.
- Browser replay plus live subscription has a tested no-gap handoff, bounded queues, disconnect cleanup, heartbeat, and shutdown behavior.
- LAN carries no plaintext session data or credential. Reads and writes are paired and authorized.
- App-server schema/version drift, state-directory conflicts, invalid permissions, failed retention, and impossible lifecycle transitions fail visibly.
- Phone Mission Control and Session Detail can be built entirely from typed API contracts without parsing terminal text.

## System Architecture

| Layer | Responsibility | Boundary |
| --- | --- | --- |
| Domain/core | HostDeck ids and aliases, normalized lifecycle/status/attention, write eligibility, event cursor, approval intent, audit action/outcome, bounded errors. | Pure TypeScript. No process, network, storage, Codex, or UI imports. |
| Contracts | Zod schemas for HostDeck API, persistence, config, event projection, trust, runtime compatibility, and UI fixtures. | HostDeck-owned stable contract. It does not expose raw app-server unions directly. |
| Codex adapter | App-server process discovery, initialize/capability handshake, generated protocol bindings, request correlation, Unix-socket WebSocket client, thread/turn/control/approval operations, notifications, reconnect. | Only package allowed to import generated Codex protocol types or `ws`. |
| Application services | Session mapping, event projection, attention, write/control dispatch, approval routing, replay/fanout, runtime health, pairing, lock/LAN policy, audit orchestration. | Depends on ports for Codex, storage, clock, ids, certificates, and process supervision. |
| Storage | SQLite migrations and repositories for mappings/projections, compatibility, auth, settings, audit, retention boundaries, and daemon lease metadata. | No Codex process or HTTP imports. Full Codex history is not copied. |
| Host interface | Fastify same-origin HTTP/HTTPS API, SSE, static dashboard, CLI client/admin commands, lifecycle and service install commands. | Browser-facing trust boundary. App-server is not proxied raw. |
| UI | Phone-first React dashboard using HostDeck API contracts. | No storage, Codex protocol, terminal parsing, or direct app-server access. |

## Selected Stack

| Area | Decision | Rationale |
| --- | --- | --- |
| Runtime | Pinned Node.js 22.22.2 and strict TypeScript. | Matches the current workspace and Ubuntu evidence. Runtime changes require compatibility smoke. |
| Workspace | `pnpm` monorepo. | Existing validated scaffold. |
| Host API | Fastify 5-compatible stack with JSON schema/Zod boundary adapters. | Lifecycle hooks, body limits, request timeouts, testing, and controlled shutdown replace the current ad hoc listener. |
| Browser stream | SSE through a maintained Fastify plugin. | One-way ordered events fit the product; mutations remain auditable HTTP requests. |
| Codex transport | `ws` IPC client using app-server's Unix-socket WebSocket endpoint. | `ws` documents `ws+unix:` IPC support; the socket remains user-private and supports both HostDeck and the normal TUI. |
| CLI | Commander or an equivalently maintained parser plus a packaged `bin` entry. | Existing custom shell can be adapted only if it meets help, exit-code, and packaging criteria. |
| UI | React plus Vite and Playwright. | Component contracts, mobile browser implementation, built static assets, and screenshot validation. |
| Storage | `better-sqlite3` with first-party migrations. | Existing `DEC-014` evidence remains valid. |
| Service mode | Unprivileged systemd user units on Ubuntu. | Separate app-server and HostDeck ownership, restart policy, logs, and no root requirement. |
| LAN security | HTTPS-only explicit opt-in with a tested local-certificate enrollment path. | Required by `DEC-020`; exact certificate library/enrollment is selected by `IFC-V1-015` after real phone proof. |

All dependencies are pinned in the lockfile, license-checked when added, and recorded in the owning task. No dependency is considered selected solely because it appears in this plan.

## Package Boundaries

| Package | Owns | Must not own |
| --- | --- | --- |
| `@hostdeck/core` | Normalized domain types, state transitions, eligibility, attention ordering, audit outcomes. | Zod, HTTP, SQLite, Codex bindings, React. |
| `@hostdeck/contracts` | HostDeck runtime schemas and exported types. | Route handlers, generated Codex protocol implementation, UI components. |
| `@hostdeck/codex-adapter` | Generated Codex bindings, compatibility matrix, Unix-socket client, request broker, event decoder, fake adapter. | Browser auth, SQLite, Fastify, React. |
| `@hostdeck/storage` | Migrations and repositories for HostDeck-owned durable state. | Full Codex transcript, process spawning, HTTP, React. |
| `@hostdeck/server` | Application services, Fastify routes/SSE/static hosting, process/runtime health, auth/audit orchestration. | React internals or terminal parsing. |
| `@hostdeck/cli` | Packaged commands, local API client, local-admin bootstrap/security/service operations. | Hidden direct session mutation that bypasses application services. |
| `@hostdeck/web` | Mission Control, Session Detail, sheets/dialogs, API/SSE clients, UI state. | Codex protocol, filesystem, storage, terminal input. |
| `@hostdeck/test-fixtures` | Normalized Codex event fixtures, fake adapter, API/UI fixtures, test certificates where safe. | Production secrets or model-dependent fixtures. |
| `@hostdeck/tmux-adapter` | Legacy evidence only until `INT-V1-008`. | New selected-runtime behavior. |

## Process Topology

### Foreground Development

1. `codexdeck serve` acquires the state-directory lease.
2. It creates a `0700` runtime directory below `$XDG_RUNTIME_DIR/hostdeck`.
3. It starts a dedicated `codex app-server --listen unix://<socket>` child and waits for a bounded compatibility handshake.
4. It opens storage, reconciles managed threads, starts projection subscriptions, then starts Fastify.
5. On shutdown it stops accepting requests, drains SSE and storage, closes the Codex client, terminates the owned app-server child, releases the lease, and removes owned runtime files.

### Long-Running User Service

| Unit | Ownership | Restart behavior |
| --- | --- | --- |
| `hostdeck-codex.service` | Dedicated app-server process and private Unix socket. | Restarts independently; an unexpected restart marks active projections interrupted/unknown until reconciliation. |
| `hostdeck.service` | HostDeck storage, Codex client, API/SSE, built dashboard, certificates, and audit. | Depends on app-server readiness. A HostDeck-only restart leaves Codex running. |

The CLI installs/removes versioned user-unit files and verifies them. It does not edit arbitrary user units. `systemctl --user` failures are actionable, and foreground mode remains available.

### Laptop TUI

`codexdeck resume <session>` resolves the stable thread id and executes:

```bash
codex resume --remote unix://PATH THREAD_ID
```

The TUI and HostDeck may connect to the same app-server. Multi-client correctness is a blocking integration test, not an assumption.

## Source Of Truth

| Fact | Owner | HostDeck persistence |
| --- | --- | --- |
| Full conversation, turns, items, active runtime status, goal, model, approvals | Codex/app-server | Stable thread id plus bounded projection only. |
| Session alias and HostDeck-managed membership | HostDeck | `managed_sessions`. |
| Attention, recent summary, last HostDeck cursor | HostDeck projection derived from Codex events | `session_projection`. Recomputable and marked stale when disconnected. |
| Device trust, lock, LAN/certificate settings | HostDeck | Auth/settings repositories. |
| Remote mutation audit | HostDeck | Bounded audit repository. |
| Live subscribers, pending protocol requests, pending SSE queues | HostDeck process | Ephemeral only. |

HostDeck never edits Codex rollout files or app-server state databases directly.

## Codex Adapter Contract

### Compatibility Handshake

1. Discover `codex` from configured absolute path or `PATH` and record `codex --version`.
2. Reject versions outside the tested compatibility policy before mutation.
3. Connect to the Unix socket and send `initialize` with a HostDeck client identity and only required capabilities.
4. Validate `initialize` response and required method/event support against the generated binding identity.
5. Persist observed version, schema identity, capabilities, and result.
6. Expose `ready`, `degraded`, or `incompatible`; incompatible never degrades to terminal injection.

Generated bindings are version-specific artifacts. The build/check path regenerates to a temporary directory and fails on unreviewed drift. Generated types stay private to the adapter; normalized HostDeck schemas absorb additive changes and reject unknown required semantics.

### Required Operations

| Product action | App-server operation class | HostDeck rule |
| --- | --- | --- |
| Start/list/read/resume/archive | Thread methods | Store and target stable thread id. Arbitrary import is rejected. |
| Prompt | `turn/start` or `turn/steer` according to active-turn state | Exact thread, idempotency/client message id where supported, bounded timeout. |
| Interrupt | Turn interrupt | Never reported as archive or completion. |
| Model | Model list plus turn/thread model override | UI choices come from runtime catalog. |
| Goal | Thread goal methods | Preserve objective/lifecycle semantics. |
| Plan | Tested collaboration/plan operation for supported Codex version | No blind `/plan` text fallback. Unsupported blocks the control. |
| Usage/compact/skills | Account usage, thread compact, skills list | Capability-gated structured surfaces. |
| Approval | Server request plus exact correlated response | Pending request id, scope, expiry/resolution, audit. |

### Request Broker

- Monotonic local request ids are unique per connection.
- In-flight requests are capped and have operation-specific deadlines.
- Unknown response ids, duplicate terminal responses, malformed messages, and impossible server requests degrade the runtime and emit bounded errors.
- Reconnect fails in-flight mutations as unknown outcome unless idempotency proves safe retry.
- Notifications are validated before projection. Unknown additive notifications are counted and ignored only when documented as optional; required unknown semantics mark compatibility degraded/incompatible.

## Event Projection And Fanout

1. Validate and normalize an app-server event.
2. Resolve it to one managed thread; unmanaged threads are not exposed automatically.
3. In one storage transaction, append the bounded projection event, assign the next HostDeck cursor, update session projection/attention/activity, and run due retention cleanup.
4. Publish the committed event to the per-session hub.
5. Record runtime health when validation, storage, or publication fails.

Replay/live handoff uses a per-session high-water protocol:

1. Register a paused subscriber and capture the committed high-water cursor.
2. Replay durable events after the client cursor through that high-water mark.
3. Emit a boundary first if retention crossed the requested cursor.
4. Drain queued events above the high-water mark in cursor order, then enter live mode.
5. Close slow subscribers when their bounded queue is exceeded and send a reconnectable reason when possible.

SSE sends heartbeat comments, honors `Last-Event-ID` and explicit cursor input, removes subscribers on abort, and closes before server shutdown deadline.

## HostDeck API

Same-origin route families:

| Family | Operations | Authorization |
| --- | --- | --- |
| Health/runtime | Liveness, readiness, bounded host/runtime status. | Liveness reveals no sensitive state; detailed status is loopback local or paired. |
| Sessions | Start, list, detail, projected events, stream, resume metadata, interrupt, archive. | LAN reads paired; mutations require write permission and unlocked host. |
| Controls | Prompt, model, goal, plan, usage, compact, skills. | One thread, write permission where mutating, capability check, audit. |
| Approvals | Read pending projected approval and approve/deny exact request. | Write permission, unlocked host, pending request, confirmation policy, audit. |
| Access | Pair claim, CSRF bootstrap/rotate, security state, device list/revoke, lock. | Rate-limited; local-admin restrictions for unlock and broad device administration as specified. |
| Network | Read network/certificate state. LAN configure/enable/disable remains local-admin CLI. | No remote mutation in V1. |

Every route has schema validation, request/body limits, stable errors, explicit timeout, and a route-manifest test. CORS is disabled by default because the dashboard is same-origin.

## Trust And Network Security

### Modes

| Mode | Listener | Access policy |
| --- | --- | --- |
| Default loopback | HTTP or HTTPS on configured loopback address only. | Local browser policy may allow bounded status/read; mutations still use paired or explicit local-admin authority. Exact cookie behavior is browser-tested. |
| LAN | HTTPS on one explicit configured address/port. | All session/status reads require paired read or write permission. No plaintext fallback. |

App-server remains on a `0600` socket in a `0700` runtime directory. It is never reverse-proxied or bound to LAN.

### Browser Trust

1. Local CLI creates a high-entropy one-time pairing code with permission and short expiry.
2. Claim is rate-limited and records accepted/failed outcome.
3. Server sets a host-only Secure, HttpOnly, SameSite=Strict device cookie on HTTPS.
4. A same-origin CSRF bootstrap endpoint validates the cookie and returns a rotated raw CSRF token held only in page memory; storage retains its hash/version.
5. Every mutation validates Host, Origin, device permission/revocation/expiry, CSRF, host lock, target state, capability, rate/concurrency policy, and audit preflight before dispatch.
6. Reload repeats CSRF bootstrap; logout/revoke rotates or invalidates server state.

Host allowlists are derived from configured origin/certificate names, not reflected request headers. Credentialed wildcard CORS is forbidden. Pair claim, auth failures, and mutations have bounded per-source/device rate limits.

### LAN Certificates

`IFC-V1-015` must select and prove one enrollment workflow on a real phone. It must produce:

- owner-only CA/key and leaf-key storage;
- SAN coverage for the configured host/IP;
- fingerprint and expiry inspection;
- renewal/reconfiguration behavior;
- browser trust instructions and failure recovery;
- no secret in logs, QR payloads, or command history;
- explicit refusal to start LAN when certificate, host allowlist, or permissions are invalid.

## Storage Model

| Area | Minimum ownership |
| --- | --- |
| `managed_sessions` | HostDeck id/alias, Codex thread id, cwd/project, branch, runtime source/version, created/archived timestamps. |
| `session_projection` | Lifecycle/turn state, attention, summary, last activity, last HostDeck cursor, stale/degraded reason. |
| `projected_events` | Session, cursor, Codex event identity/type where available, timestamp, bounded normalized payload, redaction/truncation/boundary metadata. |
| `runtime_compatibility` | Codex version, binding/schema identity, negotiated capabilities, check timestamp/result/error. |
| `auth_devices` / `pairing_codes` | Hashes and lifecycle metadata only, including CSRF generation/rotation state. |
| `settings` | Lock, bind/origin/certificate metadata, retention/timeouts, state schema version. |
| `audit_events` | Actor/device, action, target, accepted/result/incomplete outcome, bounded summary/error. |

Defaults remain 10,000 projected events or 10 MB per session and 5,000 audit events or 30 days globally until measurement changes `DEC-016`. Cleanup runs on production append plus bounded startup maintenance; it is never test-only.

Default paths:

- State: `${XDG_STATE_HOME:-$HOME/.local/state}/hostdeck`, mode `0700`.
- Runtime: `$XDG_RUNTIME_DIR/hostdeck`, mode `0700`; startup fails when no secure user runtime is available in service mode.
- Config: `${XDG_CONFIG_HOME:-$HOME/.config}/hostdeck`, owner-only where it contains sensitive paths/settings.

A nonblocking OS file lock in the state directory enforces one HostDeck daemon owner. SQLite remains the transactional data owner; the lock is not a substitute for transactions.

## Service Lifecycle

### Startup Order

1. Parse CLI/bootstrap config and resolve canonical paths.
2. Validate/create owner-only config, state, and runtime directories.
3. Acquire daemon lease; fail on existing owner.
4. Open SQLite, verify integrity/version, and run migrations transactionally.
5. Load settings; validate loopback or LAN HTTPS/origin/certificate policy.
6. Start or await the mode-owned app-server process/socket.
7. Complete Codex compatibility handshake.
8. Reconcile managed session mappings and mark uncertain active projections stale/interrupted.
9. Subscribe/rebuild bounded projections without starting turns.
10. Run bounded retention maintenance.
11. Bind Fastify, register routes/SSE/static assets, and report ready only after required checks pass.

### Shutdown Order

1. Mark not ready and reject new mutations.
2. Stop accepting new connections.
3. Close SSE subscribers with bounded reason/deadline and remove hubs.
4. Cancel/fail pending HostDeck protocol requests without claiming Codex outcome.
5. Flush audit/projection work and close repositories.
6. Close the Codex client.
7. Foreground mode terminates only the app-server child it owns; service mode leaves the sibling unit running on HostDeck-only stop.
8. Remove owned runtime files and release daemon lease.

## Failure Policy

| Failure | Required result |
| --- | --- |
| Unsupported Codex version/schema | Host not mutation-ready; UI/CLI show update/compatibility error. No tmux fallback. |
| App-server disconnect | Mark runtime degraded and projections stale; fail in-flight mutation as unknown unless proven; reconnect/reconcile with backoff. |
| Malformed/unknown required protocol event | Quarantine bounded detail, mark compatibility degraded/incompatible, do not invent status. |
| Storage append/retention failure | Stop publication of uncommitted event, mark storage/runtime degraded, block mutations requiring audit/durability. |
| Audit preflight failure | Reject mutation except emergency lock; emergency result records deferred/incomplete audit state observably. |
| Slow SSE client | Close that subscriber at queue limit; preserve global/runtime health. |
| Certificate/origin/permission failure | Reject LAN startup or request explicitly. Never downgrade to plaintext. |
| Partial session start | Reconcile returned thread id if created; persist a recoverable failed mapping or archive the created empty thread according to tested compensation. |
| Response serialization failure after mutation | Record unknown client delivery with operation id; do not repeat mutation automatically. |

## Migration From Current Code

1. Preserve current tests as regression evidence but relabel tmux completion as legacy/package-local.
2. Add normalized app-server contracts and adapter package without changing the public UI first.
3. Migrate session storage from tmux target ownership to Codex thread mapping with an explicit schema migration.
4. Run one real vertical: start thread, prompt, events, status, approval, control, interrupt, restart, TUI resume.
5. Integrate Fastify/SSE/auth/HTTPS and prove the production path.
6. Only then remove or formally defer tmux runtime code and update dependencies/docs.

No stored tmux session is silently converted to a Codex thread. V1 pre-release data can require an explicit reset/migration command if conversion cannot be proven.

## Blocking Spikes And Gates

| ID | Question | Exit evidence | Blocks |
| --- | --- | --- | --- |
| `SPK-ARCH-005` / `INT-V1-002` | Should app-server replace tmux/TUI scraping? | Complete: `artifacts/int-v1-002-codex-integration-reassessment.md`, `DEC-018`. | Contract/runtime rebaseline. |
| `SPK-ARCH-006` / `INT-V1-003` | What exact Codex version/schema/capability policy is supported? | Generated binding drift check and compatibility matrix. | Adapter/session/control implementation. |
| `SPK-ARCH-007` / `INT-V1-006` | Do real turn, approval, plan, multi-client, reconnect, and restart semantics satisfy V1? | Real Codex vertical artifact with no fake producer. | Legacy disposition, UI mockups, runtime hardening. |
| `SPK-SEC-001` / `IFC-V1-015` | Which local HTTPS certificate enrollment works on supported phone browsers? | Real phone install/connect/renew/reject evidence and dependency decision. | LAN implementation, pairing UI, release smoke. |

## External References

- Codex app-server: `https://developers.openai.com/codex/app-server`
- Codex Remote limitations and SSH/app-server model: `https://developers.openai.com/codex/remote-connections`
- Codex CLI options and maturity: `https://developers.openai.com/codex/cli/reference`
- `ws` IPC client syntax: `https://github.com/websockets/ws/blob/master/doc/ws.md`
