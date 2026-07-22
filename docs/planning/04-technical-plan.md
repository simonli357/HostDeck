# Technical Plan

Owns the active-version architecture, process and trust boundaries, selected dependencies, service lifecycle, storage ownership, and migration policy. Detailed sequences and task ordering live in `docs/planning/04a-implementation-blueprint.md`.

## Architecture Status

- Direction: app-server-first runtime under `DEC-018` plus Tailscale-first remote ingress under `DEC-027`.
- Release state: no-go. Existing packages prove reusable foundations, not the selected production vertical.
- Legacy state: `INT-V1-008` removed the tmux adapter and executable runtime after structured acceptance. Published migration data remains inert as `legacy_unmigrated`; tmux is test-only for exact Codex TUI evidence.
- Remote boundary: the phone reaches HostDeck only through private Tailscale Serve HTTPS. HostDeck itself remains loopback-only; Codex app-server remains on a user-private Unix socket.
- Compatibility baseline: exact `codex-cli 0.144.0`, reviewed experimental binding identity, and `DEC-021`; upgrades fail closed pending regeneration and review.

## Hard Requirements

The architecture is acceptable for V1 only when all of the following are true:

- One typed adapter owns every Codex protocol request, response, notification, server request, timeout, capability, and compatibility error.
- Codex is the source of truth for threads, turns, approvals, goals, model state, and full history; HostDeck stores a bounded projection, not a competing transcript.
- Foreground and user-service modes have explicit process ownership and can restart HostDeck without killing the dedicated app-server process in service mode.
- Browser replay plus live subscription has a tested no-gap handoff, bounded queues, disconnect cleanup, heartbeat, and shutdown behavior.
- A phone on an unrelated network reaches a trusted HTTPS origin without a public HostDeck listener, router change, or manually installed CA; remote reads and writes still require HostDeck pairing and authorization.
- HostDeck observes one explicitly selected saved personal Tailscale profile, never switches profiles automatically, and cannot mutate unrelated company-profile or Serve configuration.
- V1 is a single-user-host design: processes able to access the laptop loopback namespace are inside the existing local-admin trust boundary. Proxy metadata never turns that local trust into paired remote authority, and V1 does not claim protection from malicious code already running on the host.
- App-server schema/version drift, state-directory conflicts, invalid permissions, failed retention, and impossible lifecycle transitions fail visibly.
- Phone Mission Control and Session Detail can be built entirely from typed API contracts without parsing terminal text.

## System Architecture

| Layer | Responsibility | Boundary |
| --- | --- | --- |
| Domain/core | HostDeck ids and aliases, normalized lifecycle/status/attention, write eligibility, event cursor, approval intent, audit action/outcome, bounded errors. | Pure TypeScript. No process, network, storage, Codex, or UI imports. |
| Contracts | Zod schemas for HostDeck API, persistence, config, event projection, trust, runtime compatibility, and UI fixtures. | HostDeck-owned stable contract. It does not expose raw app-server unions directly. |
| Codex adapter | App-server process discovery, initialize/capability handshake, generated protocol bindings, request correlation, Unix-socket WebSocket client, thread/turn/control/approval operations, notifications, reconnect. | Only package allowed to import generated Codex protocol types or `ws`. |
| Application services | Session mapping, event projection, attention, write/control dispatch, approval routing, replay/fanout, runtime health, pairing, lock/remote-ingress policy, audit orchestration. | Depends on ports for Codex, storage, clock, ids, Tailscale observation/configuration, and process supervision. |
| Storage | SQLite migrations and repositories for mappings/projections, compatibility, auth, settings, audit, retention boundaries, and daemon lease metadata. | No Codex process or HTTP imports. Full Codex history is not copied. |
| Host interface | Loopback Fastify HTTP API/SSE/static dashboard, exact Tailscale Serve proxy admission, CLI client/admin commands, lifecycle and service install commands. | Browser-facing application trust boundary behind private HTTPS. App-server is not proxied raw. |
| UI | Phone-first React dashboard using HostDeck API contracts. | No storage, Codex protocol, terminal parsing, or direct app-server access. |

## Selected Stack

| Area | Decision | Rationale |
| --- | --- | --- |
| Runtime | Pinned Node.js 22.22.2 and strict TypeScript. | Matches the current workspace and Ubuntu evidence. Runtime changes require compatibility smoke. |
| Workspace | `pnpm` monorepo. | Existing validated scaffold. |
| Host API | Exact `fastify` 5.10.0 and `zod` 4.4.3 with HostDeck-owned local type-provider/validator/serializer compilers. | Lifecycle hooks, limits, injection, stable errors, and controlled shutdown replace the current ad hoc listener without pulling Swagger/OpenAPI peers into V1. |
| Browser stream | Exact `@fastify/sse` 0.5.0 with SSE-only routes and Readable-backed event sources. | Negotiation, headers, heartbeat, and `Last-Event-ID` are reused; HostDeck owns replay, bounds, abort, and source health. Direct async-iterable sends are forbidden because the pinned plugin does not settle a backpressured drain wait on socket close. |
| Static dashboard | Exact `@fastify/static` 9.3.0 with a validated asset root, explicit browser routes, and deny-by-policy dotfile/path filtering. | Hashed asset caching and MIME/HEAD behavior are reused without allowing API-to-HTML fallback or implicit index exposure. |
| Codex transport | Exact `ws` 8.21.0 IPC client using app-server's Unix-socket WebSocket endpoint. | The maintained MIT package documents `ws+unix:` IPC support; HostDeck adds its own frame, queue, heartbeat, timeout, and no-TCP-fallback policy. The socket remains user-private and supports both HostDeck and the normal TUI. |
| CLI | Existing strict parser/client shell pending a packaged `bin` entry; exact `qrcode` 1.5.4 renders terminal pairing QR codes. | The current shell remains acceptable only while its help, exit, bounds, privacy, and packaging contracts pass; QR encoding is delegated to a maintained MIT implementation. |
| UI | Exact React 19.2.8, React Router 8.2.0, Radix Dialog 1.1.20, Lucide React 1.25.0, Vite 8.1.4, `zod` 4.4.3, and `@playwright/test` 1.61.1 after the visual-selection gate. | The Focus Rail two-route phone shell and exact 34-route bounded JSON client are implemented. SSE, in-memory CSRF coordination, real screens/actions, packaged assets, broad responsive/accessibility coverage, and final fidelity remain downstream. |
| Storage | `better-sqlite3` with first-party migrations. | Existing `DEC-014` evidence remains valid. |
| Daemon lease | Exact `fs-ext` 2.1.1 native binding to Linux `flock(2)`. | Node 22 has no first-party file-lock API; a kernel-held nonblocking descriptor lock releases on process death. Directory/mtime lockfile libraries were rejected because they require stale-owner heuristics instead of providing the selected OS-lock contract. |
| Service mode | Unprivileged systemd user units on Ubuntu. | Separate app-server and HostDeck ownership, restart policy, logs, and no root requirement. |
| Remote ingress | Supported system Tailscale client plus private Tailscale Serve HTTPS on one human-selected saved personal profile. | Cross-network NAT traversal, trusted `.ts.net` HTTPS, and optional proxy source metadata are delegated to Tailscale while HostDeck remains loopback-only. Exact supported version and Serve behavior are frozen by `IFC-V1-070`; current development evidence is Tailscale 1.98.8, not yet the release range. |
| App authorization | Existing HostDeck one-time pairing, Secure/HttpOnly cookie, in-memory CSRF, lock, and device revoke. | Tailnet connectivity is necessary but not sufficient application authority. QR/link enrollment removes manual code and CA ceremony without granting all tailnet members access. |

All dependencies are pinned in the lockfile, license-checked when added, and recorded in the owning task. No dependency is considered selected solely because it appears in this plan.

## Resource Budget And Deadline Contract

`@hostdeck/contracts` owns one strict flat `resourceBudgetSchema` with 91 integer limits: HTTP (14), SSE (11), admission/rate/concurrency (14), Codex protocol/control (34), lifecycle (3), remote observation (5), CLI (6), and browser HTTP (4). Every entry records a unit, minimum/default/maximum, owner, breach code/action, and `hostdeck.resource.<key>` observation name. Missing fields resolve only to reviewed defaults; unknown, zero, fractional, non-finite, contradictory, or above-maximum values fail before production startup side effects.

- Fastify `requestTimeout` receives only the request and uses `http_request_receive_timeout_ms`; it must finish strictly before `handlerTimeout`, which owns the full route deadline and aborts the one `request.signal`. Header, idle socket, keep-alive, connection, request-per-socket, body, URL, parameter, and in-flight limits remain distinct. Inclusive header byte/count budgets use separately exposed one-unit Node parser sentinels so exact-boundary requests pass while overflow cannot truncate silently.
- HTTP application/protocol layers receive one `OperationDeadline` view over that exact Fastify signal and may use only decreasing remaining milliseconds. They do not create a replacement signal or extend a timeout.
- Startup, shutdown, and future CLI boundaries without an existing framework signal use the timer-owning monotonic `OperationDeadline`; owner disposal clears timer/listener state. A peer process cannot share a monotonic timestamp, so CLI bounds its outer HTTP call while request disconnect propagates into the server-owned signal.
- Selected JSON server output uses `http_response_max_bytes`; CLI and browser response capacities must each cover it. The browser client additionally owns a 35-second outer deadline, 64 KiB request body, 1 MiB streamed response, and eight-request in-flight ceiling. It dispatches only catalog-owned root-relative paths with browser-managed same-origin credentials, no redirect/retry, fatal UTF-8 and exact Zod response parsing, and bounded public failures. SSE and in-memory CSRF generation ownership remain separate downstream clients.
- `codexResourceOptionsFromBudget` maps all 20 protocol values into transport, connection/broker, event-pipeline, thread, model, and Plan-client inputs. Model, Plan, and uncertain-goal control capacities consume their three separate validated control limits. Low-level adapters retain small test-only timing support, but production composition must pass the validated mapping and cannot fall back to a larger local value.
- Public breach families are explicit: `request_too_large` (413), `rate_limited` (429), `service_overloaded` (503), and `operation_timeout` (504). Counters/health observations use the registry key; detailed logging remains bounded and redacted.

Exact defaults, cross-field invariants, and downstream consumers are recorded in `artifacts/ifc-v1-020-resource-budget-deadline.md`.

## Package Boundaries

| Package | Owns | Must not own |
| --- | --- | --- |
| `@hostdeck/core` | Normalized domain types, state transitions, eligibility, attention ordering, audit outcomes. | Zod, HTTP, SQLite, Codex bindings, React. |
| `@hostdeck/contracts` | HostDeck runtime schemas and exported types. | Route handlers, generated Codex protocol implementation, UI components. |
| `@hostdeck/codex-adapter` | Generated Codex bindings, compatibility matrix, Unix-socket client, request broker, event decoder, fake adapter. | Browser auth, SQLite, Fastify, React. |
| `@hostdeck/storage` | Migrations and repositories for HostDeck-owned durable state. | Full Codex transcript, process spawning, HTTP, React. |
| `@hostdeck/server` | Application services, Fastify routes/SSE/static hosting, exact Tailscale adapter/ingress policy, process/runtime health, auth/audit orchestration. | React internals, terminal parsing, generic trusted-proxy mode, Tailscale key access, or profile switching. |
| `@hostdeck/cli` | Packaged commands, local API client, local-admin bootstrap/security/service operations. | Hidden direct session mutation that bypasses application services. |
| `@hostdeck/web` | Mission Control, Session Detail, sheets/dialogs, API/SSE clients, UI state. | Codex protocol, filesystem, storage, terminal input. |
| `@hostdeck/test-fixtures` | Normalized Codex event fixtures, fake adapters, API/UI fixtures, and redacted remote-ingress/profile states. | Production secrets, Tailscale node keys, company profile metadata, or model-dependent fixtures. |

### Production Output Foundation

`IFC-V1-021` emits one private self-contained `dist/hostdeck` runtime from the exact selected server/CLI transitive graph, currently 611 source modules across `core`, `contracts`, `codex-adapter`, `storage`, `server`, and `cli`. The shared browser-resource policy enters through the server resource registry; independent web and test-fixture roots remain excluded. Each selected source emits Node ESM JavaScript plus declarations; HostDeck TypeScript, tests, source maps, fixtures, secrets, temporary state, and historical interface code cannot enter the owned output.

The runtime tree carries rewritten exact package manifests and the production dependency graph resolved offline from the frozen lockfile. Every link is relative and contained; no deployed path may resolve to the checkout, package store, home directory, or staging tree. Package identity binds the workspace version, exact Node/pnpm/platform/architecture/ABI contract, reviewed Codex binding, source closure, output content, entrypoints, dependencies, and native modules without timestamps or private paths. Ordinary files are non-executable and non-writable by group/other; dependency-declared binaries, native modules, and the one verified `codexdeck -> ./dist/shell.js` command retain execute bits.

A dependency-free schema-3 verifier rejects runtime, manifest, command/bin/shebang/mode/content, service-host, native-module, or link drift before load. Package acceptance copies the tree to an unrelated path, makes it read-only, imports all six roots plus the inert service host and pure unit generator without a TypeScript loader, proves the 22-registration/35-route descriptor, and exercises five command layouts. Exact process smokes separately prove direct foreground ownership, external service ownership, and runtime-only exact systemd unit behavior. Real Vite assets, persistent install lifecycle, and clean-machine parity remain `IFC-V1-053` and `IFC-V1-056` to `IFC-V1-058`.

## Process Topology

### Foreground Development

This is the accepted foreground sequence. `IFC-V1-054` connects the compiled command to the selected route/application/listener owners; `INT-V1-008` removed the historical tmux/custom-listener implementation with no fallback.

1. `codexdeck serve` acquires the state-directory lease.
2. It creates a `0700` runtime directory below `$XDG_RUNTIME_DIR/hostdeck`.
3. It starts a dedicated `codex app-server --listen unix://<socket>` child and waits for a bounded compatibility handshake.
4. It opens storage, reconciles managed threads, starts projection subscriptions, then starts Fastify.
5. On shutdown it stops accepting requests, drains SSE and storage, closes the Codex client, terminates the owned app-server child, releases the lease, and removes owned runtime files.

### Long-Running User Service

| Unit | Ownership | Restart behavior |
| --- | --- | --- |
| `hostdeck-codex.service` | Dedicated app-server process and private Unix socket. | Restarts independently; an unexpected restart marks active projections interrupted/unknown until reconciliation. |
| `hostdeck.service` | HostDeck storage, Codex client, loopback API/SSE, built dashboard, remote-ingress observation, and audit. | Depends on app-server readiness, not on remote availability. A HostDeck-only restart leaves Codex running; `tailscaled` is external and never restarted by HostDeck. |

The service-mode HostDeck process is distinct from `codexdeck serve`. It starts the same selected resource, application, listener, and shutdown graph with the runtime supervisor fixed to `service_owned`; it validates the exact Codex executable for compatibility/resume identity but can only await the external socket. It has no child-process port, process-exit observer, socket-unlink path, or fallback to foreground ownership. App-server disconnect/restart therefore drives the accepted reconnect/reconciliation state while the HostDeck process remains alive. HostDeck shutdown releases only its listener, application resources, storage, and state lease.

The packaged CLI library generates and verifies deterministic versioned user-unit descriptors without writing or contacting the manager; `IFC-V1-056` owns persistent installation and lifecycle commands. `hostdeck-codex.service` alone owns the systemd runtime-directory lifecycle; `hostdeck.service` observes that canonical owner-only directory and socket without creating, repairing, or removing them. The HostDeck unit uses only `Wants=` plus `After=` for weak startup/ordering and never `Requires=`, `BindsTo=`, `PartOf=`, or another stop/restart propagation directive. Both are `Type=exec` user services with fixed restart/start-limit/timeouts, mode-`0077` umask, and journal output. Only HostDeck is installable through `default.target`; the Codex unit is a static independently restartable dependency. Neither unit depends on `tailscaled`. Systemd active state means process setup succeeded; the loopback health endpoint remains application readiness. The CLI does not edit arbitrary user units, `systemctl --user` failures are actionable, and foreground mode remains available.

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
| Unapplied next-turn model/Plan intent | HostDeck process | Revisioned ephemeral control state only; restart drops unapplied intent and never replays it. Model has a read-back path; exact 0.144.0 has no read-only collaboration-mode endpoint, so Plan mode is `unknown` until committed settings state is rehydrated by restart reconciliation. |
| Session alias and HostDeck-managed membership | HostDeck | `managed_sessions`. |
| Attention, recent summary, last HostDeck cursor | HostDeck projection derived from Codex events | `session_projection`. Recomputable and marked stale when disconnected. |
| Device trust, lock, selected remote origin/profile comparison identity and desired ingress mode | HostDeck | Auth/settings repositories. Raw Tailscale login, company profile details, and node keys are not retained. |
| Active Tailscale profile/device state, Serve configuration, HTTPS certificate and network path | Tailscale | Observed through bounded adapter snapshots only; Tailscale remains authoritative. |
| Remote mutation audit | HostDeck | Bounded audit repository. |
| Live subscribers, pending protocol requests, pending SSE queues | HostDeck process | Ephemeral only. |

HostDeck never edits Codex rollout files or app-server state databases directly.

## Codex Adapter Contract

### Compatibility Handshake

1. Discover `codex` from configured absolute path or `PATH`; require exact `codex-cli 0.144.0` output.
2. Regenerate the experimental TypeScript binding to a temporary directory and compare the reviewed whole-tree identity in build/validation paths.
3. Connect to the Unix socket and send one `initialize` with HostDeck client identity and `experimentalApi: true`; `/plan` requires this pinned opt-in.
4. Corroborate the app-server version from the returned `hostdeck/<version>` user agent and require Linux/Unix platform fields.
5. Validate required product capability evidence against private generated methods, events, fields, approval responses, and the live `Plan`/`Default` collaboration catalog. The initialize response does not enumerate product methods.
6. Persist observed version, generated binding identity, capability states, and check result.
7. Expose `ready`, `degraded`, `incompatible`, or `disconnected`; incompatible never degrades to terminal injection.

Generated bindings are version-specific artifacts. `pnpm check:codex-bindings` regenerates to a temporary directory, applies deterministic NodeNext import normalization, and fails on unreviewed path/content or manifest drift. Generated types stay private to the adapter; normalized HostDeck schemas absorb additive changes and reject unknown required semantics.

Exact 0.144.0 may emit bounded notifications after the successful initialize response but before the client can send `initialized`. The connection queues only that correlated response/ack window in order under the pending server-message bound, flushes after acknowledgement, and still terminates for a message before the response or queue overflow.

### Required Operations

| Product action | App-server operation class | HostDeck rule |
| --- | --- | --- |
| Start/list/read/resume/archive | Thread methods | Store and target stable thread id. Arbitrary import is rejected. |
| Prompt | `turn/start`; `turn/steer` only after matching `turn/started` | Response means accepted, not yet steerable. Exact thread/turn plus client message id; stale/early steer rejects. |
| Interrupt | Turn interrupt | Never reported as archive or completion. |
| Model | Model list plus `turn/start.model`/`effort` | UI choices come from the bounded live runtime catalog. Exact model/effort and pending revision remain separate from confirmed current state until matching settings or later read-back; loaded `thread/resume.model` is not a selection control. |
| Goal | Thread goal get/set/clear plus goal/turn events | Full goal state carries an optimistic revision. Set/edit is paused and passive; resume is agentic acceptance, requires an idle thread and no pending model/Plan setting, and never implies turn completion. Pause does not interrupt. Complete/clear require pause plus idle state. Internal materialization goals stay paused. |
| Plan | Plan/Default catalog mask plus `turn/start.collaborationMode` | Mode is revisioned pending next-turn state. One outer per-session claim composes an optional pending model revision into collaboration settings, with no ignored top-level model/effort. The same exact settings event settles both revisions; plan item/delta/update plus terminal-turn events prove execution state. Unknown post-restart mode stays explicit. No zero-turn update or blind `/plan`. |
| Usage/compact/skills | Account usage, thread compact, skills list | Usage scope is explicit. Compact `{}` is accepted only; completion requires authoritative context-compaction item/turn evidence. |
| Approval | Server request plus exact correlated response | Pending request id/scope/connection generation; HostDeck owns expiry, exactly-once resolution, and audit. |

### Request Broker

- Monotonic local request ids are unique per connection.
- In-flight requests are capped and have operation-specific deadlines.
- Unknown response ids, duplicate terminal responses, malformed messages, and impossible server requests degrade the runtime and emit bounded errors.
- Reconnect fails in-flight mutations as unknown outcome unless idempotency proves safe retry.
- Notifications are validated before projection. Unknown additive notifications are counted and ignored only when documented as optional; required unknown semantics mark compatibility degraded/incompatible.

## Event Projection And Fanout

1. Admit the raw notification through the `protocol_max_pending_notifications` registry gate, classify the selected method, and extract only its bounded thread identity; runtime/account events remain unscoped.
2. Resolve identity before deep parsing. Valid unmanaged TUI threads produce content-free observations and are not exposed as sessions; a managed classification/durable-mapping race requires reconciliation.
3. Strictly normalize one managed event and validate connection-local clock, identity, capacity, and thread/turn/item order.
4. In one storage transaction, append the bounded projection event, assign the next HostDeck cursor, update session projection/attention/activity, and run due retention cleanup.
5. Publish the committed event to the per-session hub before normalizing the next raw frame.
6. Stop the connection-generation pipeline and record runtime health when managed validation, projection, storage, or publication fails.

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
| Sessions | Start, list, detail, projected events, stream, resume metadata, interrupt, archive. | Remote reads require admitted Serve ingress plus pairing; mutations require write permission and unlocked host. |
| Controls | Prompt, model, goal, plan, usage, compact, skills. | One thread, write permission where mutating, capability check, audit. |
| Approvals | Read pending projected approval and approve/deny exact request. | Write permission, unlocked host, pending request, confirmation policy, audit. |
| Access | Pair claim, CSRF bootstrap/rotate, security state, device list/revoke, lock. | Rate-limited; local-admin restrictions for unlock and broad device administration as specified. |
| Remote ingress | Read bounded active-profile/Serve/origin/reachability state. `remote enable/status/disable` remains local-admin CLI. | The browser cannot switch profiles or mutate Tailscale. |

Every route has schema validation, request/body limits, stable errors, explicit timeout, and a route-manifest test. CORS is disabled by default because the dashboard is same-origin.

The selected base is `createHostDeckFastifyApp`: an unbound Fastify instance built only from one complete frozen resource policy, a required internal-error observer, and uniquely named explicit route registrations. Registrations declare `api`, `sse`, or `static`; API routes require at least one local-Zod response schema, while streaming/static exceptions remain named surfaces. Incoming request ids are ignored in favor of generated correlation ids. Root error handling plus `frameworkErrors` normalize pre-routing and route errors into the same bounded envelopes, including `route_not_found`, `method_not_allowed`, and `unsupported_media_type`.

`startHostDeckFastifyLifecycle` is the selected listener owner. It receives a runtime controller with start/SSE-close/startup-close authority before the first side effect, applies constructor and mutable Node HTTP limits, completes Fastify readiness while unbound, then binds and verifies only the runtime-approved loopback address. V1 production admits no HostDeck TLS, private-IP, wildcard, LAN, or public bind. Tailscale Serve terminates external HTTPS and proxies to this loopback listener through a separately validated ingress context. Close initiates listener refusal, bounds SSE/listener/Fastify/startup cleanup under the lifecycle policy, reaps newly idle sockets during the listener grace period, then force-closes any tracked HTTP sockets that outlive that grace and waits for their close events. It aggregates every failure and exposes frozen `ready`/`draining`/`closed`/`failed` snapshots. `INT-V1-008` removed the executable historical custom listener; retained direct-LAN contracts/data modules remain outside selected composition pending `IFC-V1-067`.

One admitted request remains counted until both its original handler lifecycle and response/abort lifecycle finish. Fastify handler timeout aborts the unchanged request signal but cannot forcibly stop ignored JavaScript work, so a timed-out noncooperative handler retains its slot until it actually settles. Handler instrumentation preserves sync and `FastifyReply` returns and attaches settlement only to actual Promises; it must not convert plugin handlers to async.

Selected event streams register through `createHostDeckSseTransportRegistration`. The pinned SSE plugin owns media-range negotiation, framing, headers, and heartbeat; HostDeck normalizes its 406 body, reconciles canonical query/header cursors, and passes one composite cancellation signal to a required source. That signal preserves the request's abort/deadline semantics and adds paired-device authority invalidation before source open, so a revoke can stop an opening or active stream without replacing the request deadline view. Every selected event is schema/session/order/wire-byte validated before a one-object-high-water `Readable.from` yields it. Direct plugin AsyncIterable sends are forbidden. Iterator return is cleanup-deadline bounded and observed. Because `@fastify/sse` 0.5.0 swallows Readable pipeline errors and leaves the committed raw response open, HostDeck captures the Readable error and explicitly ends that response.

The same pinned plugin also leaves a real raw response open after natural finite Readable completion even though injection settles. HostDeck therefore ends a still-writable raw response from the Readable `end` event; real finite response, active lifecycle shutdown, and same-port restart regressions own this behavior.

## Trust And Network Security

### Modes

| Mode | Listener/ingress | Access policy |
| --- | --- | --- |
| Local | HostDeck HTTP on one configured loopback address only. | Local browser policy allows bounded local behavior; mutations still use paired or explicit local-admin authority as selected routes require. |
| Remote ready | The same loopback listener behind one exact private Tailscale Serve HTTPS origin on the selected active personal profile. | Every remote data read requires a paired device; writes additionally require permission, current CSRF, unlocked host, exact target, and audit. |
| Remote unavailable | Tailscale stopped/signed out, wrong profile, unsupported version, Serve missing/drifted, or external origin not proven. | Local Codex/HostDeck continue; remote readiness is false and HostDeck never auto-switches or silently repairs ambiguous external state. |

App-server remains on a `0600` socket in a `0700` runtime directory. It is never reverse-proxied or bound to LAN. Only the HostDeck loopback HTTP service is a Serve target.

### Browser Trust

1. Local CLI creates a high-entropy one-time pairing code with permission and short expiry, then renders a bounded HTTPS URL/QR whose secret is carried in a URL fragment and removed from browser history before claim.
2. Claim is admitted only through the exact configured external origin or explicit local-admin path, rate-limited by a trusted non-collapsed source identity, and records accepted/failed outcome.
3. Server sets a host-only Secure, HttpOnly, SameSite=Strict device cookie on HTTPS with an absolute expiry matching the policy-bounded stored device expiry. V1 permits 1 to 365 days and defaults to 90 days.
4. A same-origin CSRF bootstrap endpoint validates the cookie and returns a rotated raw CSRF token held only in page memory; storage retains its hash/version.
5. Every mutation validates Host, Origin, device permission/revocation/expiry, CSRF, host lock, target state, capability, rate/concurrency policy, and audit preflight before dispatch.
6. Reload repeats CSRF bootstrap; logout/revoke rotates or invalidates server state.

Host allowlists are derived from the persisted selected external origin plus loopback origin, never reflected request headers. The proxy adapter accepts only the exact reviewed Tailscale Serve header set on the dedicated loopback ingress contract and rejects unknown or contradictory forwarding/proxy context. Any process in the host loopback namespace can imitate headers, so V1 states that single-user host trust boundary explicitly: Serve-provided identity is only bounded source context and never proves paired remote authority or replaces HostDeck pairing. Existing local-admin request forms remain a separate local policy. Non-loopback callers cannot reach the listener. Credentialed wildcard CORS is forbidden. Pair claim, auth failures, and mutations have bounded per-trusted-source/device rate limits.

### Tailscale Ingress Ownership

- Tailscale owns node keys, tailnet membership, NAT traversal/relay, `.ts.net` DNS, external HTTPS certificates, and Serve listener state. HostDeck does not read key files or issue certificates.
- The human selects and activates a saved personal profile before `remote enable`. HostDeck records only the exact external origin and a bounded comparison identity sufficient to detect the wrong profile; it never stores company login/profile details or invokes `tailscale switch`.
- The adapter uses exact argv with no shell, bounded JSON/stdout/stderr, deadlines, version/capability checks, and sanitized failures. It may inspect the active profile and HostDeck-owned Serve entry; mutation occurs only for an ownership-proven entry under explicit local `remote enable` or `remote disable`.
- Existing unrelated Serve configuration is preserved byte-for-byte or semantically equivalent. Ambiguous ownership, port/path collision, HTTPS consent requirements, unsupported version, or profile change fails before mutation.
- Switching to another saved profile makes remote ingress unavailable but leaves local HostDeck/Codex running. On return, HostDeck only observes: an exact persisted mapping becomes ready, while a missing/drifted mapping stays unavailable until explicit local `remote enable`. HostDeck never repairs Serve automatically.
- `remote disable` closes HostDeck's remote-admission generation before external cleanup. It removes only the exact owned mapping; ambiguous or failed cleanup remains a visible disabled-with-cleanup-conflict state and cannot leave HostDeck admitting remote requests or claim successful cleanup.
- `IFC-V1-015` and direct-LAN certificate code remain historical security evidence only. They cannot satisfy remote V1 transport, setup, UI, or release gates.

## Storage Model

| Area | Minimum ownership |
| --- | --- |
| `managed_sessions` | HostDeck id/alias, Codex thread id, cwd/project, branch, runtime source/version, created/archived timestamps. |
| `session_projection` | Lifecycle/turn state, attention, summary, last activity, last HostDeck cursor, stale/degraded reason. |
| `projected_events` | Session, cursor, Codex event identity/type where available, timestamp, bounded normalized payload, redaction/truncation/boundary metadata. |
| `runtime_compatibility` | Codex version, binding/schema identity, negotiated capabilities, check timestamp/result/error. |
| `auth_devices` / `pairing_codes` | Hashes and lifecycle metadata only, including CSRF generation/rotation state. |
| `settings` | Lock, historical bind policy, retention/timeouts, state directory, and state schema version. |
| `selected_remote_ingress_state` | One generation-controlled row with desired remote intent, exact external origin, bounded selected-profile comparison identity, HostDeck-owned Serve descriptor, and last normalized observation/reason; no Tailscale credential or raw output. |
| `audit_events` | Actor/device, action, target, accepted/result/incomplete outcome, bounded summary/error. |

Defaults remain 10,000 projected events or 10 MB per session and 5,000 audit events or 30 days globally until measurement changes `DEC-016`. Cleanup runs on production append plus bounded startup maintenance; it is never test-only.

Default paths:

- State: `${XDG_STATE_HOME:-$HOME/.local/state}/hostdeck`, mode `0700`.
- Runtime: `$XDG_RUNTIME_DIR/hostdeck`, mode `0700`; startup fails when no secure user runtime is available in service mode.
- Config: `${XDG_CONFIG_HOME:-$HOME/.config}/hostdeck`, owner-only where it contains sensitive paths/settings.
- Database: `hostdeck.sqlite` below the state directory, mode `0600`; overrides outside state reject.
- Daemon lease: `hostdeck.lock` below the state directory, mode `0600`; it is stable and is not deleted for handoff.

A nonblocking OS file lock in the state directory enforces one HostDeck daemon owner. SQLite remains the transactional data owner; the lock is not a substitute for transactions.

The lease prevents cooperating HostDeck daemons from sharing one state directory and is released by the kernel on descriptor/process death. Owner-only permissions isolate other Ubuntu users, but they do not sandbox a malicious process already running as the same uid; release review must not overstate that boundary.

## Service Lifecycle

### Startup Order

1. Parse CLI/bootstrap config and purely resolve absolute, non-overlapping paths.
2. Validate/create only the owner-only state directory and stable lease file.
3. Acquire the nonblocking daemon lease; fail before other local mutation when an owner exists.
4. Validate/create owner-only config/runtime/database-parent paths and hold a path-identity guard across SQLite open.
5. Verify SQLite integrity/version and run migrations transactionally.
6. Load settings; validate loopback listener policy and remote-ingress configuration shape without switching or mutating Tailscale.
7. Start or await the mode-owned app-server process/socket.
8. Complete Codex compatibility handshake.
9. Reconcile managed session mappings and mark uncertain active projections stale/interrupted.
10. Subscribe/rebuild bounded projections without starting turns.
11. Run bounded retention maintenance.
12. Bind Fastify on loopback, register routes/SSE/static assets, then observe active Tailscale profile/Serve state without mutation. Report local readiness independently and remote readiness only when the exact external ingress is proven; Serve changes require an explicit local command.

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
| Unsupported/stopped Tailscale, wrong profile, or missing/drifted Serve entry | Keep local work available, mark remote ingress unavailable, reject remote-readiness claims, and never auto-switch or mutate an unowned profile/configuration. |
| Proxy/origin/permission failure | Reject the request before data, credential, audit success, or dispatch. Never trust generic forwarding headers or downgrade to direct LAN/plaintext. |
| Partial session start | Reconcile returned thread id if created; persist a recoverable failed mapping or archive the created empty thread according to tested compensation. |
| Response serialization failure after mutation | Record unknown client delivery with operation id; do not repeat mutation automatically. |

## Migration From Current Code

1. Preserve current tests as regression evidence but relabel tmux completion as legacy/package-local.
2. Add normalized app-server contracts and adapter package without changing the public UI first.
3. Migrate session storage from tmux target ownership to Codex thread mapping with an explicit schema migration.
4. Run one real vertical: start thread, prompt, events, status, approval, control, interrupt, restart, TUI resume.
5. Integrate Fastify/SSE/auth plus the Tailscale Serve adapter and prove the different-network production path.
6. Remove the tmux runtime package, service, routes, CLI reachability, and dependencies while retaining only required migration data and test-only TUI terminal use. Complete under `INT-V1-008`.

No stored tmux session is silently converted to a Codex thread. Existing rows remain `legacy_unmigrated`; local `legacy status` reports only bounded disposition/count truth, and `legacy reset --confirm` transactionally removes only legacy session state without process action or selected-state mutation. Final legacy schema/export retirement remains a later reviewed migration under `IFC-V1-067`.

## Blocking Spikes And Gates

| ID | Question | Exit evidence | Blocks |
| --- | --- | --- | --- |
| `SPK-ARCH-005` / `INT-V1-002` | Should app-server replace tmux/TUI scraping? | Complete: `artifacts/int-v1-002-codex-integration-reassessment.md`, `DEC-018`. | Contract/runtime rebaseline. |
| `SPK-ARCH-006` / `INT-V1-003` | What exact Codex version/schema/capability policy is supported? | Generated binding drift check and compatibility matrix. | Adapter/session/control implementation. |
| `SPK-ARCH-007` / `INT-V1-006` | Do real turn, approval, plan, multi-client, reconnect, and restart semantics satisfy V1? | Real Codex vertical artifact with no fake producer. | Legacy disposition, UI mockups, runtime hardening. |
| `SPK-ARCH-008` / `IFC-V1-016` | Which exact Fastify 5, Zod 4, official SSE, and static stack satisfies V1 validation, streaming, asset, and lifecycle contracts on Node 22? | Complete: `artifacts/ifc-v1-016-fastify-stack-spike.md`; exact MIT dependencies, clean production audit, and six executable boundary probes. | `IFC-V1-020`, `IFC-V1-022` to `IFC-V1-025`. |
| `SPK-SEC-001` / `IFC-V1-015` | Which local HTTPS certificate enrollment works on supported phone browsers? | Historical complete evidence in `artifacts/ifc-v1-015-https-phone-enrollment.md`; superseded for selected V1 by `DEC-027`. | Optional direct-LAN work only. |
| `SPK-NET-001` / `IFC-V1-070` | What exact supported Tailscale version/profile/Serve behavior, request metadata, non-root control, config coexistence, SSE behavior, and switch persistence can V1 depend on? | Redacted real-client/profile-switch/Serve/phone spike with exact commands, config diffs, header captures, failure cases, and no company-profile mutation. | Remote contracts, storage, adapter, ingress trust, CLI, UI states, and release matrix. |

## External References

- Codex app-server: `https://developers.openai.com/codex/app-server`
- Codex Remote limitations and SSH/app-server model: `https://developers.openai.com/codex/remote-connections`
- Codex CLI options and maturity: `https://developers.openai.com/codex/cli/reference`
- `ws` IPC client syntax: `https://github.com/websockets/ws/blob/master/doc/ws.md`
- Fastify server lifecycle and limits: `https://fastify.dev/docs/latest/Reference/Server/`
- Node 22 HTTP limits/timeouts: `https://nodejs.org/download/release/v22.15.0/docs/api/http.html`
- Node 22 AbortController/AbortSignal: `https://nodejs.org/download/release/v22.15.0/docs/api/globals.html`
- Official Fastify SSE plugin: `https://github.com/fastify/sse`
- Official Fastify static plugin: `https://github.com/fastify/fastify-static`
- Rejected Fastify Zod type-provider candidate: `https://github.com/turkerdev/fastify-type-provider-zod`
- Tailscale Serve: `https://tailscale.com/docs/features/tailscale-serve`
- Tailscale connection types: `https://tailscale.com/docs/reference/connection-types`
- Tailscale fast user switching: `https://tailscale.com/docs/features/client/fast-user-switching`
- Tailscale Serve CLI: `https://tailscale.com/docs/reference/tailscale-cli/serve`
