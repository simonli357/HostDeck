# Technical Plan

Owns active-version high-level architecture, dependencies, services, environment, security, and setup policy. Detailed module design and sequencing belong in `docs/planning/04a-implementation-blueprint.md`.

## Architecture Hardening Criteria

The V1 architecture is good enough for approval only when these are true:

- Process topology is explicit: the daemon, CLI, API, dashboard, tmux, Codex processes, storage, and stream readers each have one owner.
- Headless contracts can be tested without a live Codex account through fake Codex and fake or isolated tmux adapters.
- Every write path passes through trust, lock, target-session, audit, and tmux-send checks in that order.
- The system has a defined restart story: durable state reloads, tmux sessions reconcile, stale sessions are visible, and stale writes fail.
- Local-first security is enforceable by default: localhost bind, explicit LAN enablement, revocable local tokens, and CLI-only unlock.
- API route families, package boundaries, storage ownership, and service lifecycle are concrete enough for the implementation blueprint and backlog to decompose.
- Remaining uncertainty is represented as named spikes with exit evidence, not hidden in implementation tasks.

## Architecture

| Layer | Responsibility | Notes |
| --- | --- | --- |
| Domain/core | Session model, lifecycle states, attention/status classification, output cursor model, trust/permission state, audit event rules, validation errors, and command intent types. | Pure TypeScript modules with no tmux, HTTP, filesystem, or UI imports. Core owns invariants and test fixtures. |
| Application services | Session registry, session lifecycle orchestration, output ingestion/fanout, write dispatcher, slash-command dispatcher, pairing/token service, lock/LAN policy, audit writer, and host status. | Services depend on explicit ports/interfaces for storage, tmux, clock, ids, and event streams so fake adapters can test V1 without live Codex. |
| Adapters | tmux/Codex process control, local SQLite storage, output log reader, HTTP/WebSocket API, CLI client, config/state directory, filesystem, git branch lookup, and local service startup. | Adapters are thin and fail loudly on missing binaries, invalid cwd, bad config, stale sessions, or malformed writes. |
| UI | Mobile-responsive web dashboard with mission-control session cards, session detail, prompt composer, safe slash-command controls, trust/lock/LAN states, and advanced raw fallback. | UI consumes API contracts only; it does not parse tmux output or own product state transitions. |

## Proposed Stack

| Area | Decision | Why |
| --- | --- | --- |
| Language | TypeScript for host agent, CLI, shared contracts, and web UI. | One typed language across API contracts, core state, CLI, and dashboard reduces contract drift. |
| Host runtime | Maintained Node.js LTS pinned during scaffold. | Mature local CLI/server runtime with strong filesystem/process/network support on Ubuntu. |
| Backend/API | Fastify HTTP plus WebSocket support. | Small local API, schema validation hooks, good testability, and lower ceremony than a full framework. |
| CLI | Commander-style command parser wrapping local services/API. | Conventional command surface for `codexdeck` operations. |
| UI | React plus Vite. | Standard mobile-responsive dashboard path with component tests and shared TypeScript contracts. |
| Contracts | Zod schemas shared by server, CLI, and UI. | Runtime validation for API/config plus generated/static TypeScript types. |
| Storage | Local SQLite database in the HostDeck state directory using `better-sqlite3` when storage implementation starts. | Durable local registry, auth state, audit log, and output metadata without external services; driver decision recorded in `DEC-014`. |
| Terminal backend | tmux-managed sessions with per-session tmux targets and output capture. | Detachable sessions, laptop attach path, and compatibility with the intended Ubuntu terminal workflow. |

## Package Boundaries

The scaffold should use a `pnpm` workspace with these intended packages unless the implementation blueprint proves a better split:

| Package | Owns | May depend on | Must not depend on |
| --- | --- | --- | --- |
| `@hostdeck/core` | Domain types, state machines, status heuristics, attention sorting, command intents, validation errors, fixture classifiers. | Shared TypeScript utilities only. | HTTP, React, tmux, filesystem, SQLite, process spawning. |
| `@hostdeck/contracts` | Zod schemas and TypeScript types for API requests/responses, stream events, config, audit events, and persisted records. | `@hostdeck/core` types where useful. | Fastify route handlers, React components, tmux adapter code. |
| `@hostdeck/server` | Application services, API routes, WebSocket streams, trust enforcement, registry orchestration, audit orchestration, startup checks. | `core`, `contracts`, storage and tmux adapter packages. | React UI internals. |
| `@hostdeck/cli` | `codexdeck` command parser, local client calls, bootstrap/admin operations, user-facing CLI output. | `contracts`, local API client, minimal admin storage helper for bootstrap/lock/unlock only. | UI components, test-only fakes outside test builds. |
| `@hostdeck/tmux-adapter` | tmux command execution, target naming, output capture/pipe setup, stale target detection, fake adapter interface implementation. | `core`, `contracts`. | Fastify or React. |
| `@hostdeck/storage` | SQLite schema, migrations, repositories for registry, output metadata, auth state, settings, and audit events. | `core`, `contracts`, `better-sqlite3`. | tmux process execution, React. |
| `@hostdeck/web` | Mobile-responsive dashboard, API client, WebSocket client, UI state, visual states, advanced raw fallback. | `contracts`, generated or hand-written API client. | Direct storage, tmux, Codex process control. |
| `@hostdeck/test-fixtures` | Fake Codex command, representative Codex-like outputs, fake adapter helpers, UI fixture data. | `core`, `contracts`. | Production runtime packages. |

## Process Topology

| Process / actor | Owner | Lifecycle | Communication |
| --- | --- | --- | --- |
| `codexdeck serve` | Host daemon process | Foreground dev mode or long-running local service mode. Runs startup checks, opens storage, reconciles tmux, serves API/dashboard, and owns stream readers. | Binds `127.0.0.1` by default; optional LAN bind after explicit enablement. |
| `codexdeck` CLI commands | Local user shell | Short-lived processes. Prefer calling the daemon API when it is running; bootstrap/admin commands may use direct local storage/config paths where required. | Local HTTP API for normal operations; direct filesystem/admin path for initial `serve` setup, `pair` code creation if daemon is unavailable, and CLI-only `unlock`. |
| Web dashboard | Browser client | Served by daemon. Keeps no authoritative state. Reconnects to streams with cursor markers. | Typed HTTP plus WebSocket/SSE stream endpoint. |
| tmux server/session | Ubuntu user process | Created and managed by HostDeck for V1 sessions. Survives dashboard disconnect and can survive daemon restart. | Accessed only by tmux adapter commands. |
| Codex CLI process | Child process inside tmux target | Started as new managed `codex` session in a validated cwd. | Receives literal prompt/slash/raw input through tmux; output is captured by tmux adapter. |
| SQLite database | Local state file | Opened by daemon and short-lived admin CLI paths. Migrations run before service accepts requests. | Storage repositories only; no direct UI access. |
| Output capture worker | Daemon-owned service | One logical reader per live session or a supervised shared reader. Reconciled on restart. | Writes ordered output events/cursors to storage/fanout. |

Normal CLI operations should fail with an actionable "daemon not running" message unless they are explicitly bootstrap/admin operations. This avoids two independent writers managing tmux and storage at the same time.

## Cross-Block Interfaces

Blocks own local design; this table owns the system-level contracts between blocks.

| From block | To block | Contract / dependency | Failure behavior |
| --- | --- | --- | --- |
| Host agent/core | tmux adapter | Create, stop, attach target, send literal text, send Enter, capture target state, and mark stale/unavailable sessions. | Missing tmux, failed tmux command, stale target, or unsupported session state returns a typed error; no silent recreate or buffered write. |
| Host agent/core | Codex launcher | Start new managed `codex` process in a tmux target using a validated cwd and environment inherited from the host process. | Missing Codex executable, invalid cwd, duplicate name, or failed launch fails before registry success is recorded. |
| Output ingestion | Storage and stream fanout | Append ordered output events with per-session cursors, truncation metadata, and `DEC-016` bounded retention. | Reader errors surface in host status and session state; dashboard shows stream disconnected or stale output boundary. |
| API/CLI | Trust service | Read-only access can inspect allowed state; writes require paired/trusted token and unlocked host. | Untrusted, locked, revoked, expired, or read-only clients get explicit authorization errors. |
| Dashboard | Local API | Dashboard uses typed HTTP/WebSocket contracts for sessions, output, writes, slash commands, pairing, lock state, and LAN state. | Contract failures render visible error states and do not retry writes indefinitely. |
| Audit writer | Storage | Every write/risky/control action records bounded action metadata before or with the action result. | If audit cannot be recorded for a write action, the write fails unless the action is a local emergency lock. |
| CLI | Daemon API | Normal CLI commands call the same API/service contracts as the dashboard so behavior stays consistent. | If daemon is unreachable, normal commands fail visibly; bootstrap/admin commands state that they are using direct local mode. |
| Storage | Migration runner | Schema version is checked before server accepts requests. | Migration failure blocks startup and reports the failing version. |

## Local API Contract

Exact route names can be refined in the implementation blueprint, but V1 route families must cover these contracts:

| Route family | Required operations | Auth mode | Failure behavior |
| --- | --- | --- | --- |
| Host status | `GET /api/host/status` returns version, bind mode, lock state, LAN state, storage health, tmux health, startup checks, stale count, stream health. | Read allowed locally; LAN follows read policy. | Never reports healthy if required checks are failing. |
| Sessions read | `GET /api/sessions`, `GET /api/sessions/:id`, `GET /api/sessions/:id/output?after=<cursor>`. | Read token or local read policy. | Unknown/stale sessions return typed not-found or stale-state errors. |
| Session stream | `GET /api/sessions/:id/stream?after=<cursor>` via WebSocket or SSE. | Read token or local read policy. | Stream reconnect is cursor-based; stale cursor returns replay boundary, not fake continuity. |
| Session writes | `POST /api/sessions/:id/input`, `POST /api/sessions/:id/slash`, `POST /api/sessions/:id/stop`, optional `POST /api/sessions/:id/raw-input`. | Trusted write token, unlocked host, writable session state. | Rejects untrusted, locked, stale, stopped, crashed, unknown, or multi-session writes before tmux send. |
| Pairing/token | `POST /api/pair/claim` or equivalent token claim; optional `GET /api/pair/status`. | Short-lived local pairing code; host-only `HttpOnly` device-token cookie after claim; CSRF token required for same-origin browser writes. | Expired/used/revoked codes fail explicitly and are audited; cookie-only requests do not grant ambient write permission. |
| Lock/LAN state | `GET /api/security/state`, `POST /api/security/lock`, `GET /api/network/state`; LAN enable/disable is CLI/admin-only unless blueprint approves API control. | Lock can be dashboard write-trusted; unlock is CLI-only. LAN state read is allowed; LAN mutation is CLI/admin. | Lock must work even if normal audit is degraded; unlock cannot be performed from a remote browser in V1. |

API responses use shared contract schemas with a stable error envelope: `code`, `message`, optional `field`, optional `session_id`, optional `retryable`, and optional `details` bounded for safe display.

## Trust And Permission Lifecycle

| State / action | Behavior | Storage / audit |
| --- | --- | --- |
| Unpaired browser | Can load dashboard shell and read only what local policy allows; write controls disabled. | No token record. Permission-denied UI state is visible. |
| Pair requested | CLI or local admin path creates a short-lived one-time pairing code. | Store hashed code, expiry, created time, permission mode, and audit `pair_requested`. |
| Token claimed | Browser submits code and receives a host-only `HttpOnly` device-token cookie plus a non-secret CSRF token for same-origin write headers. | Store hashed token, hashed CSRF token, client label if available, created/last-used time, permission mode, revoked flag, and audit `pair_claimed`. |
| Trusted write | Prompt/slash/stop/raw requests require valid cookie token, matching CSRF header, write permission, unlocked host, allowed action, writable session, same-origin request, and successful audit preflight. | Audit action type, session id, client id, bounded payload summary, result. |
| Lock | Dashboard or CLI can set locked state to block further writes. | Audit `lock`; lock should succeed even if noncritical services are degraded. |
| Unlock | CLI-only local admin action in V1. | Audit `unlock`; remote browser cannot unlock. |
| Revoke/expire | Token revocation or expiry removes write authority without deleting sessions or audit history. | Store revoked/expired state and audit `token_revoked` when explicit. |
| LAN enable/disable | CLI/admin action changes bind policy and requires daemon restart or controlled rebind, as defined in blueprint. | Audit `lan_enable` and `lan_disable`; dashboard shows LAN state. |

## Storage Ownership

SQLite is the durable state owner for structured V1 records. Output bytes may be stored in SQLite or bounded local log files, but cursor metadata and retention state must be queryable through storage repositories.

| Store/table area | Owns | Retention / notes |
| --- | --- | --- |
| `schema_migrations` | Applied migration versions. | Blocks startup on mismatch or failed migration. |
| `sessions` | Session id, name, cwd, backend, tmux target, lifecycle state, created time, last known state, stale/unavailable reason. | Durable across daemon restart; reconciled against tmux. |
| `session_metadata` | Project/cwd display fields, git branch when available, last activity, status, attention, summary/recent-output cue. | Derived fields can be recomputed; stale values must be marked. |
| `output_events` or output log index | Per-session cursor, order, capture time, truncation/replay boundary, storage pointer or bounded payload. | V1 keeps 10,000 output events or 10 MB output payload per session, whichever is lower; exact boundary semantics in `DEC-016`. |
| `auth_devices` | Hashed device tokens, hashed CSRF tokens, permission mode, created/last-used time, revoked/expired state. | Does not store raw tokens or raw CSRF tokens. |
| `pairing_codes` | Hashed short-lived pairing codes and expiry/use state. | One-time use; cleanup policy in blueprint. |
| `settings` | Bind host/port, LAN enabled, locked state, state directory metadata, retention settings. | Mutated only by trusted service/admin paths. |
| `audit_events` | Bounded records for prompt, slash, stop, raw input, pair, lock, unlock, token revoke, LAN enable/disable, startup failures where useful. | V1 keeps 5,000 audit events or 30 days globally, whichever is lower; payload summaries are bounded/sanitized. |

## Output And Streaming Contract

- The tmux adapter owns ordered capture per session. Application services assign or preserve monotonically increasing cursors before fanout.
- Dashboard stream reconnect uses `after=<cursor>` and receives either contiguous events or an explicit replay boundary/truncation marker.
- Recent output APIs return bounded payload plus cursor metadata; they never imply full terminal history when retention has truncated earlier content.
- Status heuristics consume bounded output fixtures and must return `unknown` when confidence is low.
- Stream reader errors update host/session health and are visible in the dashboard; writes are not accepted when the target session is stale or unreconciled.

## Service Lifecycle

| Phase | Required behavior |
| --- | --- |
| Startup | Load config, validate bind policy, validate state directory, run migrations, validate required binaries, initialize storage, reconcile sessions with tmux, start output readers, then accept API requests. |
| Foreground dev mode | `codexdeck serve` runs in the terminal, logs bounded structured events to stderr/stdout, and exits nonzero on failed startup checks. |
| Long-running local mode | Uses the same server entrypoint with documented service wrapper or launch command; no privileged install required for V1. |
| Shutdown | Stop accepting new requests, close streams with reason, flush output/audit writes, stop readers, leave tmux/Codex sessions running unless explicitly stopped. |
| Restart | Reload durable registry/auth/audit/settings, reconcile tmux targets, mark missing targets stale, restart output readers, reject writes to unreconciled sessions. |
| Emergency lock | Must be available from CLI even when normal dashboard writes are not trusted; blocks write dispatch before tmux send. |

## Environment

| Item | Decision |
| --- | --- |
| Runtime | Node.js maintained LTS with strict TypeScript; exact version pinned when the app scaffold is created. |
| Package manager | `pnpm` workspace for host, CLI, shared contracts, and web packages. |
| Local services | No required external service. Host uses local tmux, Codex CLI, SQLite state, and localhost HTTP/WebSocket. |
| Docker/devcontainer policy | Not required for V1; tests must run as a normal Ubuntu user because tmux/Codex integration is host-local. |
| Secret handling | Pairing codes and device tokens are random local secrets; store only hashes/metadata where practical; never log full tokens or unbounded prompt/output payloads. |
| Default bind | `127.0.0.1` only. LAN bind requires explicit enablement and is reversible. |
| State directory | Configurable local state directory with documented default; contains SQLite DB, output logs if used, and local config. |

## Dependencies

| Dependency | Version/source | License | Why | Risk |
| --- | --- | --- | --- | --- |
| Node.js | Maintained LTS, pinned during scaffold | Open-source runtime, not bundled in repo | Host runtime and local server/CLI execution | Version drift; mitigate with `.nvmrc` or equivalent and setup docs. |
| TypeScript | npm, pinned | Apache-2.0 | Shared typed contracts and strict core modules | Build complexity; mitigate with small workspace boundaries. |
| Fastify | npm, pinned | MIT | Local HTTP API and validation lifecycle | Plugin/version compatibility; keep plugin set small. |
| WebSocket plugin | Fastify-compatible npm package, pinned | MIT-compatible, verify before add | Session output streaming and reconnect cursors | Reconnect semantics must be tested with fixtures. |
| Zod | npm, pinned | MIT | Runtime config/API validation and shared schemas | Overuse can duplicate types; schemas should be contract boundaries only. |
| Commander or equivalent | npm, pinned | MIT-compatible, verify before add | `codexdeck` CLI command parsing | CLI behavior must stay contract-tested. |
| React | npm, pinned | MIT | Dashboard UI | UI can sprawl; keep components contract-driven. |
| Vite | npm, pinned | MIT | Dashboard dev/build tooling | Build config churn; keep frontend package isolated. |
| SQLite engine and Node driver | Local SQLite plus `better-sqlite3@12.11.1`, pinned in `DAT-V1-010` | SQLite is public domain; `better-sqlite3` is MIT | Durable local registry, auth, audit, and output metadata | Native driver install friction; `pnpm-workspace.yaml` allows the `better-sqlite3` build script and clean Ubuntu install smoke must prove the supported path. |
| tmux | Ubuntu package | ISC | Detachable session backend and laptop attach path | Platform dependency; startup checks must fail loudly if missing. |
| Codex CLI | User-installed external binary | Not bundled; verify current license before packaging references | Managed agent process | Output/contracts may change; treat status parsing as advisory. |

## Reuse Checks

| Capability | Candidates checked | Decision |
| --- | --- | --- |
| Terminal session backend | tmux, direct PTY management, arbitrary terminal discovery | Use tmux for V1; defer direct PTY and arbitrary import. |
| Output capture | tmux `capture-pane` polling, tmux `pipe-pane` logs, direct PTY stream | Prefer tmux output log/pipe ingestion with capture fallback for snapshots; exact mechanism finalized in blueprint. |
| Raw terminal UI | Full xterm.js terminal, preformatted bounded output with raw input box | Use bounded raw fallback first; defer full terminal emulator unless V1 evidence proves it is needed. |
| Local storage | SQLite, JSON files plus JSONL audit, embedded KV store | Use SQLite for structured durable state; output logs may remain file-backed if needed for streaming performance. |
| API validation | Handwritten validation, OpenAPI-first, Zod schemas | Use shared Zod contracts first; generate OpenAPI later only if useful. |
| Remote access | Hosted relay, SSH tunnel, Tailscale, LAN, localhost | V1 uses localhost default plus explicit LAN opt-in; relay/tunnel is V2. |

## Architecture Spikes To Carry Forward

These are required before backlog decomposition if they remain unresolved after the implementation blueprint:

| ID | Question | Method | Exit evidence | Blocks |
| --- | --- | --- | --- | --- |
| SPK-ARCH-001 | Can tmux `pipe-pane` or an equivalent mechanism provide ordered, reconnectable per-session output for V1? | Prototype fake Codex output through tmux, capture ordered events, restart reader, compare cursor replay and truncation behavior. | Spike artifact with command transcript, chosen capture method, failure modes, and fixture strategy. | Output ingestion tasks, stream API tasks. |
| SPK-ARCH-002 | Which SQLite Node driver should V1 use? | Compared `better-sqlite3`, `sqlite3`/`sqlite`, and pinned Node built-in SQLite availability for license, install friction, sync/async behavior, migrations, and test ergonomics. | Resolved by `DEC-014` and `artifacts/dat-v1-001-sqlite-driver-spike.md`: use `better-sqlite3` plus a first-party migration runner; no silent fallback to `node:sqlite`. | Storage tasks, setup docs. |
| SPK-ARCH-003 | What exact token transport should the dashboard use for local pairing? | Compared HttpOnly same-origin cookie against bearer token storage approaches under localhost and LAN opt-in. | Resolved by `DEC-015` and `artifacts/dat-v1-002-token-transport-spike.md`: use host-only `HttpOnly` cookie transport with CSRF write headers; reject browser durable bearer-token storage. | Pairing/auth tasks, API contract tasks. |
| SPK-ARCH-004 | What retention defaults keep output/audit useful without unbounded growth? | Measured current Codex-like fixture sizes and simulated bounded append/replay behavior. | Resolved by `DEC-016` and `artifacts/dat-v1-003-retention-caps-spike.md`: 10,000 output events or 10 MB per session; 5,000 audit events or 30 days globally; visible replay/audit boundaries. | Storage, output, and audit tasks. |

## Data, Privacy, Security

- Data stored: Session registry, tmux targets, cwd/name/project metadata, optional git branch, recent output metadata/buffers, status/attention state, pairing/token metadata, lock/LAN settings, and audit events.
- Sensitive data: Prompts, terminal output snippets, cwd paths, branch names, device tokens, pairing codes, and audit payload summaries.
- Auth/secrets: Pairing creates a short-lived local code and a longer-lived device token stored as hash/metadata records. Dashboard receives a host-only `HttpOnly` cookie and a same-origin CSRF token for writes; storage keeps only token and CSRF hashes. V1 rejects durable JavaScript-readable bearer token storage. Revoked/expired/locked states reject writes.
- Failure policy: Missing binaries, invalid cwd, schema mismatch, stale session, unwritable session state, failed audit write, and malformed input return explicit errors. Unknown status is visible and advisory, not success.
- Observability: Host status reports startup checks, bind mode, lock/LAN state, storage health, tmux health, stale session count, stream reader state, and last classified error. Detailed evidence belongs in artifacts during validation.
- Privacy boundary: V1 has no hosted relay, cloud sync, push provider, or external telemetry. All session data remains local unless the user independently exposes LAN access.

## Architecture Decisions To Resolve

| Question | Options | Recommended default | Owner |
| --- | --- | --- | --- |
| Which SQLite Node driver should V1 use? | `better-sqlite3`, async SQLite wrapper, Node built-in SQLite if stable in pinned runtime | Resolved in `DEC-014`: use `better-sqlite3`; revisit only if clean Ubuntu install fails or the pinned runtime changes. | Decision log and `DAT-V1-001`. |
| What are default retention caps? | Fixed per-session event count, fixed bytes, time-window retention, hybrid | Resolved in `DEC-016`: 10,000 output events or 10 MB per session; 5,000 audit events or 30 days globally; visible replay/audit boundaries. | Decision log and `DAT-V1-003`. |
| What token transport should the dashboard use after pairing? | HttpOnly same-origin cookie, bearer token in memory, bearer token in browser storage | Resolved in `DEC-015`: use host-only `HttpOnly` cookie transport with CSRF write headers; reject browser durable bearer-token storage. | Decision log and `DAT-V1-002`. |
| Is tmux `pipe-pane` required for V1 streaming? | Required, optional optimization, capture-pane polling only | Prefer `pipe-pane` or equivalent ordered log ingestion; prove with `SPK-ARCH-001` before backlog decomposition. | Implementation blueprint spike. |
