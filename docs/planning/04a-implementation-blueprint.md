# Implementation Blueprint

Owns detailed module design, invariants, cross-module sequences, capability-block mapping, migration order, and rollout gates for V1. Local block detail lives under `docs/planning/05-blocks/`; executable leaf tasks live under `docs/tracking/backlog/`.

## Approval Criteria

This blueprint is implementation-ready only when:

- every requirement in `02-requirements.md` resolves to defined leaf tasks and evidence;
- generated Codex bindings are isolated behind a normalized adapter contract;
- real turn, approval, structured controls, multi-client TUI, reconnect, and restart behavior are proven for the pinned Codex version;
- LAN certificate enrollment is proven on a real phone;
- storage migration and legacy tmux disposition are explicit;
- the production Fastify/SSE/auth path has one lifecycle owner and bounded resources;
- replacement mobile mockups pass the screen/state gate and receive human selection before React screen work;
- no task must decide product scope, architecture, security policy, or validation while implementing.

## Maturity Truth

| Area | Current evidence | V1 maturity now | Missing production proof |
| --- | --- | --- | --- |
| Workspace/conventions | Pinned workspace, strict TypeScript, Biome, Vitest, package shells. | Reusable foundation. | Real build/package, planning checker, new adapter package. |
| Core/contracts | Session/write/error/storage/UI schemas and fixture classifiers. | Implemented for superseded tmux-shaped model. | Thread/turn/event/approval/runtime-compatibility rebaseline and invariant hardening. |
| Storage | Migrations, settings, sessions, metadata, auth, audit, retention repositories. | Strong package-local base. | App-server mapping migration, production cleanup invocation, CSRF rotation, permissions, daemon lease, audit outcomes. |
| Tmux adapter | Real target/start/send/capture/reconcile tests with fake Codex producer. | Legacy integration evidence. | Not the selected V1 runtime. Disposition waits for structured vertical. |
| Codex adapter | Local architecture spike only. | Not implemented. | Generated bindings, IPC client, broker, real session/turn/control/approval/restart proof. |
| API/CLI | Headless handlers, custom Node listener, source-level CLI shell/tests. | Partial foundation, not packaged production path. | Fastify/SSE/static build, selected adapter wiring, full auth, HTTPS, timeouts, service units, runnable `bin`. |
| Web | View-model helpers/fixtures only. Existing mockups rejected. | Pre-implementation. | Mobile state rebaseline, two options, selection, React/Vite UI, screenshots/device evidence. |
| Release | Baseline commands pass; developer/command docs record gaps. | No-go. | Clean package/service/phone/security/aggregate evidence. |

Done task records remain historical evidence for their stated scope. They do not imply the selected V1 block is complete.

## Normalized Domain Contracts

| Contract | Required shape/invariant | Owner |
| --- | --- | --- |
| `ManagedSession` | HostDeck id, alias, Codex thread id, cwd/project, optional branch, runtime version/source, archived state. Ids are immutable and distinct. | core/contracts |
| `SessionProjection` | Lifecycle, turn state, attention, summary, last activity, model/goal cue, last HostDeck cursor, freshness/degraded reason. | core/contracts |
| `ProjectedEvent` | Session id, safe integer cursor, normalized kind, Codex event id/type when available, timestamp, bounded payload, redaction/truncation/boundary metadata. | contracts/storage |
| `RuntimeCompatibility` | Codex version, generated binding identity, negotiated capabilities, check result/time, bounded incompatibility reason. | contracts/codex adapter/storage |
| `ControlIntent` | Prompt, model, goal, plan, usage, compact, skills, approval response, interrupt, archive. Exactly one typed target. | core/contracts |
| `PendingApproval` | Session/thread, app-server request id, action/scope/reason, created/expiry, state, response policy. | contracts/server ephemeral projection |
| `TrustContext` | Loopback/local-admin or paired device identity, read/write permission, expiry/revocation, CSRF generation, origin. | contracts/server |
| `AuditOutcome` | `accepted`, `succeeded`, `failed`, `rejected`, or `incomplete`; accepted is never treated as terminal success. | core/contracts/storage |

Timestamps use strict RFC 3339/ISO 8601 parsing with round-trip calendar validation. Cursors and counts are non-negative safe integers. Lifecycle transitions use explicit normal and reconciliation transition tables.

## Codex Adapter Interfaces

```ts
interface CodexRuntimeAdapter {
  connect(signal: AbortSignal): Promise<RuntimeCompatibility>;
  close(reason: string): Promise<void>;
  listThreads(input: ListThreadsInput): Promise<ThreadPage>;
  startThread(input: StartThreadInput): Promise<ThreadSnapshot>;
  readThread(threadId: string): Promise<ThreadSnapshot>;
  archiveThread(threadId: string): Promise<void>;
  startTurn(input: StartTurnInput): Promise<TurnSnapshot>;
  steerTurn(input: SteerTurnInput): Promise<TurnSnapshot>;
  interruptTurn(input: InterruptTurnInput): Promise<void>;
  invokeControl(input: StructuredControlInput): Promise<ControlResult>;
  resolveApproval(input: ApprovalResponseInput): Promise<void>;
  subscribe(listener: CodexRuntimeListener): Unsubscribe;
}
```

The adapter implementation contains:

| Component | Responsibility | Failure rule |
| --- | --- | --- |
| Binding loader | Generated app-server types/schema identity for the pinned compatibility policy. | Missing/drifted required type blocks build/startup. |
| IPC transport | `ws+unix:` connection, open/close/ping, bounded frame size, socket error mapping. | No TCP fallback. |
| Handshake | `initialize`/`initialized`, client identity, capabilities. | Pre-initialize message or repeat initialize is fatal to connection. |
| Request broker | Id assignment, pending map, deadlines, cancellation, response validation, max in-flight. | Timeout/disconnect yields typed unknown outcome for mutations. |
| Notification decoder | Validate and normalize required events. | Unknown optional events counted; unknown required semantics degrade compatibility. |
| Server-request router | Approval and other supported server-initiated requests. | Unsupported request gets explicit protocol error and runtime degradation. |
| Fake adapter | Deterministic operations/events/failures matching normalized interface. | Cannot bypass contract parsing in tests. |

Raw generated app-server types never cross into storage, API, or UI packages.

## Application Services

| Service | Inputs | Outputs | Key invariant |
| --- | --- | --- | --- |
| Runtime supervisor | Mode, Codex path, socket path, process port, clock. | Process/socket readiness and ownership. | Kills only processes it owns; service mode keeps app-server independent of HostDeck restart. |
| Compatibility service | Adapter handshake and policy. | Ready/degraded/incompatible state. | Mutation readiness requires current successful compatibility result. |
| Session service | Codex adapter, mapping repo, projection repo. | Start/list/detail/resume/archive. | Never creates a second thread to hide an uncertain first start. |
| Turn/control dispatcher | Trust, lock, compatibility, target, audit, adapter. | Accepted/rejected/terminal result. | Validation -> auth/origin/CSRF -> lock -> target/capability -> audit accepted -> dispatch -> audit terminal outcome. |
| Approval service | Pending server requests, trust, lock, audit, adapter. | Exact approve/deny response. | At most one terminal response per request id. |
| Projection service | Normalized runtime events, transaction, classifier. | Committed event plus updated session projection. | Publish only after durable commit and retention. |
| Replay/fanout hub | Projection repo, per-session queues, abort signals. | Ordered replay/live SSE source. | No gap/duplicate at handoff; bounded slow-client queue. |
| Trust service | Pairing/device repos, cookie/CSRF/origin/rate policy. | Read/write trust context. | Raw device token never enters JS-readable durable storage or database. |
| Host health | Storage, runtime, projector, fanout, listener, cert/lease. | Bounded readiness/degradation snapshot. | Health updates after startup; it is not a frozen boot result. |

## Storage Migration

The selected runtime requires a new migration, not in-place reinterpretation of tmux fields.

1. Add app-server compatibility and normalized projected-event tables/columns.
2. Add `codex_thread_id`, runtime source/version, projection freshness, and archive semantics to managed sessions.
3. Preserve old tmux fields as nullable legacy columns until migration disposition is complete.
4. Mark pre-release tmux records `legacy_unmigrated`; do not expose them as live app-server sessions.
5. Provide a local reset/archive path for pre-release data if thread identity cannot be proven.
6. Remove legacy columns only in a later reviewed migration after `INT-V1-008`.

Session start uses a recoverable saga because Codex thread creation and SQLite cannot share a transaction:

1. Validate request and reserve HostDeck id/alias as `starting` in SQLite.
2. Call `thread/start` with a client operation id where supported.
3. Persist returned thread id and initial projection transactionally.
4. If Codex fails before a thread id, remove/mark failed reservation for safe retry.
5. If Codex returns a thread id but persistence fails, retain an explicit recovery record outside the failed transaction or query by operation metadata; never create another thread automatically.
6. A response-serialization failure after success does not retry start.

## Critical Sequences

### Startup

1. Resolve paths/config and acquire owner-only daemon lease.
2. Open/migrate storage and validate settings/certificates.
3. Start or await mode-owned app-server and private socket.
4. Complete compatibility handshake and start adapter reader.
5. Load managed mappings and reconcile each against `thread/read`/list.
6. Mark uncertain prior active states interrupted/stale; never infer running from persistence alone.
7. Subscribe to managed thread events and rebuild bounded projections where supported.
8. Run due retention and initialize live health.
9. Start Fastify HTTPS/HTTP listener, routes, SSE, and static assets.
10. Report ready only when required dependencies are current.

### Prompt Or Structured Control

1. Fastify validates path, body, content type, and size.
2. Trust service validates configured Host, Origin, device cookie/permission, CSRF generation, expiry/revocation, and rate/concurrency limit.
3. Dispatcher checks host lock.
4. Load exact managed session and current runtime/projection state.
5. Check runtime compatibility and operation capability.
6. Validate operation-specific input and active-turn conflict behavior.
7. Append bounded audit `accepted` in a transaction.
8. Dispatch once with request deadline/idempotency metadata where supported.
9. Append `succeeded`, `failed`, or `incomplete` outcome.
10. Return accepted/terminal response consistent with the owning operation; later turn outcome arrives by event stream.

### Approval

1. Adapter receives a supported app-server server request and validates it.
2. Approval service registers one pending request with expiry/connection generation and projects it to the session.
3. Browser receives the committed approval projection.
4. Approve/deny passes the normal mutation gate and verifies request is still pending on the same connection generation.
5. Audit `accepted`, send exactly one app-server response, then audit terminal outcome.
6. Duplicate, expired, disconnected, or superseded responses reject without sending.
7. Reconnect expires prior connection-bound pending approvals unless app-server reissues them.

### Replay To Live SSE

1. Authenticate read and validate session/cursor.
2. Register paused subscriber; capture committed high-water cursor.
3. Query retained projection after requested cursor through high-water.
4. Emit boundary if requested history was pruned, then ordered replay.
5. Drain queued committed events above high-water and switch to live.
6. Send heartbeat comments within idle timeout.
7. On request abort, queue overflow, auth revocation, session archive, or shutdown, unregister immediately and close with bounded reason where possible.

### Runtime Reconnect

1. Mark compatibility/runtime disconnected and projections stale; reject new mutations.
2. Fail pending requests with `incomplete`/unknown outcome as appropriate and expire connection-bound approvals.
3. Retry connection with capped exponential backoff and jitter while host remains active.
4. Repeat handshake/version checks.
5. Reconcile managed threads and current statuses without starting turns.
6. Persist an explicit replay boundary when events during disconnect cannot be recovered.
7. Resume subscriptions and mutation readiness only after reconciliation.

### Browser Pair/Reload/Revoke

1. Local CLI creates one-time hashed code with permission and expiry.
2. HTTPS claim validates origin/host/rate, atomically consumes code, creates hashed device token, sets cookie, and audits outcome.
3. Browser calls CSRF bootstrap; server rotates generation/hash and returns raw token to memory.
4. Reload repeats bootstrap using HttpOnly cookie.
5. Revoke invalidates device and CSRF state, audits outcome, and causes active SSE/mutations to fail on next authorization check.

### Graceful Shutdown

1. Set not-ready and reject new mutations.
2. Stop accepting HTTP connections.
3. Close SSE and fanout queues by deadline.
4. Stop reconnect loops and fail pending broker requests truthfully.
5. Flush projection/audit work and close SQLite.
6. Close adapter transport.
7. Terminate app-server only when foreground ownership says HostDeck owns it.
8. Release socket/runtime files and daemon lease.

## Failure And Concurrency Matrix

| Case | Required behavior | Test owner |
| --- | --- | --- |
| Invalid calendar timestamp or unsafe cursor | Contract rejection before persistence/dispatch. | `FND-V1-016` |
| Two starts with same alias | One reservation succeeds; the other gets duplicate conflict. | `DAT-V1-018`, `INT-V1-006` |
| Thread created, DB write fails | No automatic second thread; explicit recoverable/incomplete result. | `INT-V1-006` |
| App-server disconnect after accepted mutation | Audit becomes incomplete/unknown unless a terminal event proves outcome. | `INT-V1-007` |
| HostDeck restart while turn runs | Service-mode app-server continues; reconciliation restores projection or explicit boundary. | `INT-V1-007`, `IFC-V1-018` |
| Approval double tap/two clients | Exactly one response wins; loser sees resolved conflict. | `INT-V1-006`, `IFC-V1-019` |
| CSRF reload/revoke race | Rotated/revoked generation invalidates stale header; no bearer token exposure. | `DAT-V1-021`, `IFC-V1-017` |
| Slow SSE subscriber | Subscriber closes at bounded queue without blocking projector/other clients. | `IFC-V1-018`, `IFC-V1-020` |
| Retention during replay | Transactional boundary and high-water handoff remain ordered. | `DAT-V1-020`, `IFC-V1-018` |
| Duplicate daemon | Second owner exits before opening DB/listener/runtime mutation. | `DAT-V1-019` |
| LAN HTTP/mismatched Host/Origin | Startup/request rejected; no cookie or data. | `IFC-V1-015`, `IFC-V1-017` |
| Unsupported `/plan` semantic | Control disabled/incompatible; no literal slash fallback. | `INT-V1-003`, `INT-V1-006`, `FE-V1-021` |
| TUI plus HostDeck clients | Both address the same thread without subscription corruption. | `INT-V1-006` |

## Required Capability Blocks

| Block | Scope after rebaseline | Completion gate |
| --- | --- | --- |
| `BLK-V1-01` | Normalized contracts, events, approvals, compatibility, fixtures, planning validation. | Rebaseline tests and `FND-V1-091`; old tmux-shaped completion is insufficient. |
| `BLK-V1-02` | App-server mapping/projection migration, auth/CSRF, audit outcomes, production retention, permissions/lease. | Integration/storage evidence and `DAT-V1-091`. |
| `BLK-V1-03` | Codex adapter, private runtime, real thread/turn/control/approval/event/restart/TUI path. | Real vertical plus `INT-V1-091`; no fake producer. |
| `BLK-V1-04` | Fastify API/SSE/static, selected adapter orchestration, HTTPS/auth, CLI/build/service packaging, resource controls. | Packaged production path plus `IFC-V1-091`. |
| `BLK-V1-05` | Mobile state rebaseline, replacement visual options/selection, phone-first dashboard, approvals, controls, fidelity/device evidence. | `FE-V1-090`. |
| `BLK-V1-06` | Security/privacy, clean install/service/browser/phone, aggregate validation, completion matrix, go/no-go. | Release-readiness artifact and human acceptance. |

## Delivery Order

| Order | Gate/slice | Exit evidence |
| --- | --- | --- |
| 1 | Audit and planning integrity | `REL-V1-011`, `FND-V1-014`; owner docs/backlog/checker agree. |
| 2 | Normalized contract rebaseline | `FND-V1-015`, `FND-V1-016`, generated fixtures and strict invariants. |
| 3 | Codex compatibility and IPC adapter | `INT-V1-003`, `INT-V1-004`; handshake/broker/fake tests. |
| 4 | Mapping/projection/auth storage migration | `DAT-V1-018` to `DAT-V1-021`; secure/retained durable state. |
| 5 | Real structured vertical | `INT-V1-005` to `INT-V1-007`; real thread, prompt, events, controls, approval, TUI, restart. |
| 6 | Legacy disposition and integration hardening | `INT-V1-008`, `INT-V1-091`; one selected runtime remains. |
| 7 | HTTPS and production host interface | `IFC-V1-015` to `IFC-V1-021`; Fastify/SSE/auth/fanout/build/service. |
| 8 | Interface hardening | `IFC-V1-091`; slow clients, failure matrix, real production path. |
| 9 | Mobile state and visual gate | `FE-V1-004`, reopened `FE-V1-002`, human `FE-V1-003`. This precedes React screen implementation. |
| 10 | Dashboard implementation | `FE-V1-010` to `FE-V1-022`, then responsive/fidelity/copy tasks. |
| 11 | Module and release hardening | `FE-V1-090`, release/security/clean-install/aggregate tasks. |
| 12 | Human acceptance | `REL-V1-010`; explicit go/no-go. |

Tasks may overlap only when dependencies and shared contracts make the work independent. No UI screen implementation starts before order 9 is complete.

## Rollout And Rollback

- All app-server behavior is behind the new adapter and selected-runtime configuration during migration.
- Before pre-release migration, current tmux tests remain runnable to prevent accidental loss of evidence.
- If the real structured vertical fails a required semantic, V1 returns to planning. It does not silently ship both runtimes or resume TUI scraping.
- Database migrations are forward-only and tested on a copy; destructive pre-release reset requires explicit CLI confirmation and preserves an exportable diagnostic.
- Dependency additions are committed separately from UI work and include license/version rationale in the owning task.
- A completed block is reopened whenever its production outcome changes, even if historical package tests still pass.

## Pre-Implementation Checks

- `pnpm check:planning` passes and detects unknown refs, duplicate tasks, dependency cycles, invalid ready states, and uncovered requirements.
- Current queue contains only active in-progress/ready tasks and intentional human/external blockers.
- Every new task has status, block/requirement refs, real `Blocked by` and `Blocks`, description, criteria, and evidence.
- `docs/status.md` reports the rebaseline and no-go state without historical completion inventory.
- No product implementation claim relies on the rejected visual boards or fake-Codex tmux smoke.
