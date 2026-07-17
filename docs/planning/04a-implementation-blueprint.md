# Implementation Blueprint

Owns detailed module design, invariants, cross-module sequences, capability-block mapping, migration order, and rollout gates for V1. Local block detail lives under `docs/planning/05-blocks/`; executable leaf tasks live under `docs/tracking/backlog/`.

## Approval Criteria

This blueprint is implementation-ready only when:

- every requirement in `02-requirements.md` resolves to defined leaf tasks and evidence;
- generated Codex bindings are isolated behind a normalized adapter contract;
- real turn, approval, structured controls, multi-client TUI, reconnect, and restart behavior are proven for the pinned Codex version;
- the pinned Tailscale profile/Serve/header/SSE behavior and company-profile coexistence are proven by `IFC-V1-070`;
- storage migration and legacy tmux disposition are explicit;
- the production Fastify/SSE/auth path has one lifecycle owner and bounded resources;
- replacement mobile mockups pass the screen/state gate and receive human selection before React screen work;
- no task must decide product scope, architecture, security policy, or validation while implementing.

## Maturity Truth

| Area | Current evidence | V1 maturity now | Missing production proof |
| --- | --- | --- | --- |
| Workspace/conventions | Pinned workspace, strict TypeScript, Biome, Vitest, planning/scaffold/export/binding checks, nine package shells. | Reusable selected foundation. | Real build/package and clean-install proof. |
| Core/contracts | Selected thread/turn/event/approval/runtime/security/mobile schemas, strict invariants, fixtures, and hardened remote-ingress/access/proxy/audit contracts. | V1 foundation contract block complete. | Downstream storage, adapters, routes, and UI remain owned by Blocks 02, 04, and 05. |
| Storage | Historical repositories plus selected mapping/projection/event/compatibility/recovery, durable remote-ingress configuration/observation, versioned remote enable/disable audit with preserved LAN/certificate history, and phased owner-only path/daemon-lease startup. | V1 storage block complete after combined remote aggregate hardening. | Production consumers remain owned by Block 04. |
| Tmux adapter | Real target/start/send/capture/reconcile tests with fake Codex producer. | Legacy integration evidence. | Not the selected V1 runtime. Disposition waits for structured vertical. |
| Codex adapter | Exact 0.144.0 experimental binding, structural method-catalog drift check, bounded Unix IPC/broker/handshake/reconnect, hostile fake-protocol matrix, and real private-socket no-model smoke. | Transport and compatibility foundation implemented. | Real session/turn/control/approval, supervision, multi-client, and restart proof. |
| API/CLI | Headless handlers, custom Node listener, source-level CLI shell/tests, exact probed Fastify/Zod/SSE/static dependencies, completed Tailscale 1.98.8 behavior spike, bounded read-only observer, ownership-safe Serve manager, exact proxy trust, and normalized remote contracts. | Selected local and remote stack foundations, not a packaged production path. | Production composition, full app auth, timeouts, service units, runnable `bin`. |
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
| `UsageSnapshot` | Exact managed target, runtime version/generation, measured time, bounded account token summary/daily buckets, optional same-generation thread token/context observation, and optional same-generation runtime quota observation. Missing observations are explicit and no monetary field is inferred. | contracts/codex adapter/server ephemeral control |
| `PendingTurnSettings` | Exact session/thread, separate model and Plan catalog identities/revisions, baseline read-back, resolved collaboration settings, dispatch phase, accepted turn id, and bounded conflict/unknown cause. Claims are process-local and settle once from one turn outcome/settings boundary. | contracts/server ephemeral control |
| `PendingApproval` | Session/thread, app-server request id, action/scope/reason, created/expiry, state, response policy. | contracts/server ephemeral projection |
| `RemoteIngressState` | Tailscale availability, selected/active profile identity comparison, Serve ownership/configuration state, external origin, last observation, and bounded unavailable reason. No node key or reusable Tailscale credential. | contracts/server/storage |
| `TrustContext` | Loopback/local-admin or paired device identity, ingress provenance, read/write permission, expiry/revocation, CSRF generation, external origin, and bounded remote source identity where verified. | contracts/server |
| `AuditOutcome` | `accepted`, `succeeded`, `failed`, `rejected`, or `incomplete`; accepted is never treated as terminal success. | core/contracts/storage |

Timestamps use strict RFC 3339/ISO 8601 parsing with round-trip calendar validation. Cursors and counts are non-negative safe integers. Lifecycle transitions use explicit normal and reconciliation transition tables.

## Codex Adapter Interfaces

```ts
interface CodexRuntimeAdapter {
  connect(signal: AbortSignal): Promise<RuntimeCompatibility>;
  reconnect(signal: AbortSignal): Promise<RuntimeCompatibility>;
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

An involuntary disconnect remains explicitly reconnectable. `close` is terminal and releases adapter subscriptions; neither path automatically retries a mutation.

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

## Production Host Interface Contract

| Component | Ownership | Failure rule |
| --- | --- | --- |
| Typed app factory | `createHostDeckFastifyApp`, HostDeck-local Zod 4.4.3 type provider/compilers, resolved `ResourceBudget`, global content types/request ids/errors, and explicit `api`/`sse`/`static` registrations. | No listener/storage/process side effects; partial/mutable config, duplicate/invalid registrations, non-Zod API schemas, or raised route limits fail composition; pre-routing and route errors share bounded envelopes. |
| SSE transport | `createHostDeckSseTransportRegistration`, `@fastify/sse` 0.5.0 negotiation/headers/heartbeat, required selected-event source, canonical query/`Last-Event-ID` cursor, and one-object-high-water Readable conversion. | Never pass an AsyncIterable directly. One composite signal preserves request abort/deadline and adds paired-authority revoke during source open and delivery; schema/session/order/wire-byte failures are observed; iterator return is deadline-bounded; swallowed plugin pipeline errors trigger explicit raw-response end. |
| Static boundary | `@fastify/static` 9.3.0 asset prefix plus validated canonical roots and explicit browser-shell routes. | `index: false` for assets; send-level dotfile denial and dot-segment filtering; API misses never fall through to HTML; missing root/index fails startup. |
| Listener lifecycle | One composition owner for register/ready/listen/readiness/drain/close and reverse-order startup rollback; production binds explicit loopback HTTP only. | No wildcard, assigned-private-IP, or public bind; no listen before readiness; close is idempotent and attempts every bounded cleanup even when an earlier close step fails. |
| Tailscale ingress adapter | Observe the pinned CLI/status/profile contract and apply/remove only the HostDeck-owned Serve mapping under explicit local enable/disable. | Tailscale is an external prerequisite. HostDeck never switches profiles, owns `tailscaled`, reads node keys, auto-repairs Serve, or mutates an unrecognized/company profile. |

The SSE plugin does not own durable replay, high-water/live handoff, subscriber queues, auth, or runtime health. Its direct async-iterable send path is outside the selected contract because `IFC-V1-016` proved that a socket close can leave a backpressured drain wait suspended. The selected Readable path also has an explicit adapter guard: plugin pipeline errors are not rethrown and do not end the raw response, so HostDeck observes the Readable error and ends the committed response itself. Any selected-stack version change reruns both spike and adapter regression probes before implementation or lockfile acceptance.

The selected session-event source composes that transport with one sustained subscriber owner. Durable replay stays under replay limits; only post-high-water live events enter the per-subscriber event/wire-byte queue. Admission is atomic across global, paired-device, and session caps. A synchronous fanout sink never waits for a reader: it either satisfies one pending pull, enqueues, or closes only that subscriber at the first overflow. A branded source-lifecycle signal lets overflow, archive, source failure, service close, or explicit unsubscribe actively destroy an already-backpressured Readable. Request disconnect and paired-authority revoke continue through the transport's request signal. Every terminal path releases its handoff, listener, queue, and registry slot once; the queue layer introduces no timer and fabricates no projection event to report overflow.

The composition root calls `resolveResourceBudget` once before lease, storage, runtime, or listener mutation and injects the same frozen result. `fastifyResourceOptionsFromBudget` maps receive, handler, socket, body, router, and application caps without conflating them. Fastify `handlerTimeout` is the HTTP cancellation owner: every route gets one `OperationDeadline` view over the unchanged `request.signal` and the effective route-local/global timeout, and every application/protocol call receives that same view or its decreasing `timeoutMs(cap)`. The global error owner converts Fastify's native handler-timeout failure to the bounded `operation_timeout`/504 envelope. Capacity releases only after both handler settlement and response/abort completion; timed-out work that ignores cancellation remains counted. Startup/shutdown and future CLI process boundaries use the timer-owning deadline form. No downstream layer calls `AbortSignal.timeout`, creates a replacement request signal, resets elapsed time, or substitutes its own larger default.

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
| Remote ingress service | Tailscale observer, persisted selected profile/external origin/Serve descriptor, bounded command runner, audit. | Disabled, ready, or unavailable remote state. | Wrong/unknown profile is observation-only; local HostDeck remains available and no company profile is changed. |
| Host health | Storage, runtime, compatibility, projector, fanout, listener, remote ingress, lease. | Bounded local readiness plus separately generated remote-access state and a generation-bound mutation proof. | Every required local source must be explicitly ready; remote degradation cannot alter local truth or local mutation admission. |

### Mutable Host Health Boundary

- The local reducer has exactly seven required sources: storage, runtime, compatibility, projector, fanout, listener, and daemon lease. Each source reports a fixed state/reason pair under its own positive sequence; out-of-order older completion cannot overwrite a newer result.
- Local aggregate generation advances only for a material accepted observation. All seven sources must be ready before readiness and mutation admission open. A generation-bound proof is checked again immediately before dispatch so an intervening local failure cannot race a stale preflight.
- Remote health has a separate generation and consumes only normalized remote public state or one bounded observation failure. Tailscale stop, sign-out, profile mismatch, Serve drift/conflict, stale state, or observer failure cannot change local generation/readiness or invalidate a local mutation proof.
- Recovery is an explicit newer successful observation. No elapsed-time inference, retry, retained exception, or old ready field may clear failure. The reducer owns no timers, poller, restart, listener, command, storage, route, or shutdown side effect.
- Startup captures one cutoff, reconciles accepted-only audit orphans before retention, and maps both bounded results into the first storage observation. Any degraded, incomplete, failed, or unknown maintenance result keeps storage non-ready.

### Production Projection Append Boundary

- The projection service submits one target session id, an uncommitted normalized event with no session/cursor fields, a next session projection with no cursor, and the complete mapping/projection/cursor revision it read.
- Storage assigns the next contiguous cursor and derives retained count, UTF-8 bytes, earliest cursor, and replay-boundary metadata. Production callers cannot provide or adjust those fields.
- The immediate SQLite transaction re-reads and validates persisted rows, checks the complete optimistic revision, inserts the event, and updates the session projection. A metadata-only writer racing the append therefore conflicts instead of being overwritten.
- The required publisher is invoked synchronously in commit order only after the transaction returns. It receives the committed event, projection, and revision; it is never invoked for validation, conflict, corruption, or rollback failures.
- Publisher throw/rejection cannot undo durable truth. The append rejects with the committed result and `publication_unknown`; no automatic republish occurs because callback side effects may already have happened. Runtime health/fanout reconciliation owns recovery.
- `DAT-V1-022` extends this same transaction with pruning and replay-boundary writes before publication; it does not add a second append path.

### Exact Event Normalization Boundary

- `@hostdeck/codex-adapter` owns strict 0.144.0 required-notification parsing and exports only a normalized discriminated union; generated app-server payload types remain private.
- The production consumer first extracts a bounded selected-notification thread identity. A valid unmanaged TUI thread becomes a content-free identity/method observation before deep payload or lifecycle parsing; runtime-scoped events bypass thread routing. A managed classification that no longer matches durable mapping is fatal and requires reconciliation.
- One stateful decoder assigns a monotonic connection-local sequence, rejects clock regression, and validates managed thread/turn/item lifecycle order. Exact repeated thread-state snapshots for status, name, settings, or goal become bounded content-free redundant observations and do not reach projection or control observers. Stable transition thread/turn/item/goal/request identities remain retained until bounded capacity exhaustion; capacity, true transition duplicate, malformed, post-archive, and order failures latch the decoder stopped.
- Generated-but-unselected notifications produce bounded content-free method/count diagnostics. Unknown methods fail compatibility. Deprecated `thread/compacted` is unselected and cannot prove compaction; authoritative context-compaction item and terminal turn events remain required.
- `@hostdeck/server` admits raw notifications through the registry-owned `protocol_max_pending_notifications` gate, then serializes identity gating, managed normalization, durable mapping, one next-session reduction, `ProductionProjectionAppendPort`, and post-commit publication. A later frame is not normalized until earlier publication settles. Queue capacity or one normalization/projection/storage/publication failure stops the whole connection-generation pipeline until reconciliation.
- `account/rateLimits/updated` remains runtime/account scoped because its payload has no thread id; temporal proximity cannot assign it to a session. `serverRequest/resolved` proves request resolution only and cannot infer approve/deny or command success.

## Storage Migration

The selected runtime requires a new migration, not in-place reinterpretation of tmux fields.

1. Add app-server compatibility and normalized projected-event tables/columns.
2. Add `codex_thread_id`, runtime source/version, projection freshness, and archive semantics to managed sessions.
3. Preserve old tmux fields as nullable legacy columns after executable-runtime removal so published migrations remain forward-compatible.
4. Mark pre-release tmux records `legacy_unmigrated`; do not expose them as live app-server sessions.
5. Provide bounded local `legacy status` plus immediate transactional `legacy reset --confirm`; never inspect or mutate a tmux process or selected session state.
6. Add durable remote-ingress settings for the selected profile identity, canonical external origin, HostDeck-owned Serve descriptor, enablement state, and last known observation without storing Tailscale credentials.
7. Replace selected LAN/certificate audit actions with exact remote-enable and remote-disable contracts. Reuse the existing pair-request action for QR/link issuance, keep status read-only, represent profile/ownership failures as truthful operation outcomes, and preserve historical LAN diagnostic rows unchanged.
8. Remove legacy columns/contracts only in a later reviewed migration with `IFC-V1-067`; `INT-V1-008` intentionally preserves inert rows and published SQL.

Session start uses a recoverable saga because Codex thread creation and SQLite cannot share a transaction:

1. Validate request and reserve HostDeck id/alias as `starting` in SQLite.
2. Call `thread/start` in explicit legacy-history mode with a client operation marker. Codex 0.144.0 rejects advertised paginated history, and a zero-turn legacy thread is initially loaded but not stored.
3. Persist the returned thread id in the recovery row before any operation that can materialize the rollout.
4. Set the requested thread name, then use a version-scoped internal **paused** `thread/goal/set` plus `thread/goal/clear` transaction to materialize the zero-turn rollout without a model call. A recovered prior active marker is paused before clear; any other marker state fails. Verify idle state, empty turns, no turn/token/message event, stored list/read identity, final name, and an empty goal before exposing the mapping.
5. Treat the durable HostDeck id/thread-id/cwd mapping as ownership after materialization. Codex 0.144.0 drops `threadSource` while writing the legacy rollout; do not require that marker during later read/archive/reconciliation.
6. Before the thread id is known, reconcile an unknown start only by bounded `thread/loaded/list` pagination plus exact `thread/read` marker/cwd matching. Never redispatch an ambiguous reservation.
7. After the thread id is known, resume any partial name/materialization/clear phase idempotently from that exact id. A missing thread or conflicting goal/name/source requires recovery; it does not create another thread.
8. If Codex proves no thread was sent, mark the reservation failed for explicit cleanup and safe retry. A response-serialization failure after success does not retry start.

## Critical Sequences

### Startup

1. Purely resolve and validate absolute, non-overlapping config/state/runtime paths plus an in-state database path. Derive the stable lease and app-server socket paths before filesystem mutation.
2. Create/inspect only the owner-owned mode-`0700` state directory and stable mode-`0600` lease file with no-follow, owner/type/hard-link, and descriptor/path-identity checks.
3. Acquire a nonblocking exclusive `flock(2)` lease. A held lease fails before config/runtime/database/listener/socket/app-server mutation; an unlocked stale file is reused, never unlinked for handoff.
4. The lease owner creates/repairs the mode-`0700` config, runtime, and database-parent directories, then holds a validated database descriptor across SQLite open/migration and rechecks identity/mode before releasing the guard.
5. Validate local settings and durable remote-ingress configuration without contacting or mutating Tailscale.
6. Start or await mode-owned app-server and private socket.
7. Complete compatibility handshake and start adapter reader.
8. Load managed mappings and reconcile each against `thread/read`/list.
9. Mark uncertain prior active states interrupted/stale; never infer running from persistence alone.
10. Subscribe to managed thread events and rebuild bounded projections where supported.
11. Capture one startup cutoff, reconcile accepted-only audit orphans, then run due retention. Initialize storage health from both bounded results; degraded or incomplete maintenance cannot claim ready.
12. Start the Fastify loopback HTTP listener, routes, SSE, and static assets.
13. Mark local HostDeck ready, then observe the active Tailscale profile and exact HostDeck-owned Serve state without mutation. Only an explicit local `remote enable` or `remote disable` may invoke the ownership-safe manager.
14. Report remote ready or a bounded remote-unavailable reason independently of local readiness. Every fatal local failure after lease acquisition closes mutable resources and releases the lease in reverse order.

The selected listener implementation requires cleanup authority before runtime start: one exact runtime controller exposes `start`, `closeSse`, and `closeStartup`; `start` returns only typed context plus a validated loopback bind. Fastify registration/readiness completes while unbound, Node limits apply before listen, and the actual address must equal that bind. Assigned-private-IP, wildcard, and public binds fail before listen. Tailscale Serve owns external HTTPS and proxies to this loopback listener; HostDeck owns neither TLS private keys nor a second network listener. Close transitions to draining, initiates listener refusal, bounds SSE and newly idle connection settlement, closes Fastify, then storage/lease startup ownership. Failure or timeout at one step is aggregated but cannot skip later cleanup; complete mutation/projector/audit/runtime drain remains `IFC-V1-037`.

### Prompt Or Structured Control

1. Fastify enforces header/request-receive/body/URL/parameter bounds, validates path/body/content type, and exposes one handler-owned `request.signal` plus monotonic deadline view.
2. Trust service validates configured Host, Origin, device cookie/permission, CSRF generation, expiry/revocation, and rate/concurrency limit.
3. Dispatcher checks host lock.
4. Load exact managed session and current runtime/projection state.
5. Check runtime compatibility and operation capability.
6. Validate operation-specific input and projected active-turn conflict behavior. `turn/start` response is accepted only; steer/interrupt eligibility begins at matching `turn/started`.
7. Append bounded audit `accepted` in a transaction.
8. Dispatch once with the same AbortSignal and only the remaining request duration; idempotency metadata is included where supported.
9. Append `succeeded`, `failed`, or `incomplete` outcome.
10. Return accepted/terminal response consistent with the owning operation; later turn outcome arrives by event stream.

### Exact 0.144.0 Control Rules

- Model catalog reads are visible-only, paginated, cursor-cycle checked, and capped at 128 entries. Catalog ids and runtime model names are independently unique; exactly one model and one effort per model are defaults. A null requested effort resolves to the catalog default before pending state is stored.
- Model selection is process-local, revisioned per exact session/thread, and separate from confirmed current state. Dispatch re-reads the current baseline, sends the resolved runtime model and effort only through `turn/start`, treats the response as accepted, and clears pending only after matching `thread/settings/updated` or later resume read-back. Known rejection restores pending; timeout/disconnect latches unknown without retry. Loaded `thread/resume.model` is prohibited.
- Plan/Default selection stores revisioned pending next-turn state and builds `turn/start.collaborationMode` from the exact bounded catalog mask. Plan owns the outer per-session transaction; it claims the exact optional model revision, resolves one settings object, dispatches once, then symmetrically settles both controls as accepted, known rejected, or unknown. A settings event received before the response is retained as early confirmation rather than clearing and later resurrecting model state. `collaborationMode.settings` carries selected model/effort and no contradictory top-level fields. Both revisions settle from the same validated settings event; Plan item/delta/update and terminal events separately prove execution. There is no zero-turn Plan toggle or slash fallback.
- Exact 0.144.0 has no read-only collaboration-mode query. Process restart drops pending mode and exposes confirmed mode as unknown until `INT-V1-029` rehydrates committed settings projection during reconciliation; it never infers mode from model, plan text, or a stale request.
- Goal snapshots include objective/status, token budget/use, time use, strict timestamps, and a SHA-256 optimistic revision over identity/control state rather than volatile usage counters. Set always writes paused state; passive set/pause/complete/clear require exact revision and authoritative response plus read-back. State-proven no-ops dispatch nothing. Replacing/completing/clearing an active goal requires pause first.
- Resume accepts only paused/blocked state on a proven idle thread and rejects while model or Plan state is unapplied because `thread/goal/set active` cannot carry those next-turn settings. Its response means agentic acceptance, not turn start/completion. Pause never implies interrupt. Known rejection remains retryable only as reported; possible-send timeout/protocol/read-back ambiguity enters a bounded per-session unknown latch until matching goal event/read-back or explicit conflict. Materialization markers never use active status.
- `turn/steer` waits for the matching `turn/started` event and sends `expectedTurnId`; an accepted `turn/start` response alone is not steerability proof. Stale or completed steer/interrupt is a remote rejection.
- Compact is an exact confirmed mutation for one current writable managed thread in a proven terminal turn state. The adapter requires the available exact-0.144.0 `compact` capability and one stable positive connection generation, sends exactly one `thread/compact/start` with only `{ threadId }`, validates the exact empty response, and never retries a possible send.
- The empty response creates only `accepted` progress with no turn id. Same-generation ordered `turn/started` plus `item/started: contextCompaction` binds the operation to one turn/item and advances it to `running`; an item completion alone still does not prove context reduction. `completed` requires both that exact item completion and `turn/completed: completed` for the same turn.
- Early notifications are serialized behind request settlement so the mutation response remains accepted-only while no evidence is lost. A known remote rejection leaves no accepted record. A possible-send failure remains incomplete and blocks unsafe duplicate dispatch until authoritative reconciliation or a later proven terminal state.
- Matching terminal `interrupted` or `failed`, archive, connection-generation loss, missing lifecycle evidence, duplicate/out-of-order identity, or contradictory item/turn outcomes remain explicit interrupted, failed, or incomplete states. Deprecated `thread/compacted`, elapsed time, terminal text, and slash injection never advance compact progress.
- Exact 0.144.0 can emit `thread/tokenUsage/updated` between context-compaction item start/completion with independent last-turn usage above the post-compaction total and with cumulative fields reset downward. Each breakdown remains internally bounded, but `last` is not a subset of `total`. The normalizer and usage observer permit at most one cumulative-baseline reset only on the same ordered turn after its `contextCompaction` item starts; all unrelated, pre-item, repeated, post-terminal, stale-generation, or ordinary-turn regressions still fail.
- Compact control state is isolated by exact session/thread, bounded by `control_compact_max_tracked_operations` (default 128, reviewed maximum 4,096), and serialized per session. The production service does not auto-interrupt on a timer; a bounded smoke/UI observation may invoke the separate exact-turn interrupt control once the compact turn is event-proven.
- `account/usage/read` is a read-only runtime/account request with no params. Its exact summary and nullable daily buckets require safe non-negative integers, strict unique calendar dates/order, internal summary consistency, a configured bucket cap, one capture time, and stable connection generation across the request. Thread token/context and runtime rate-limit notifications are separately normalized, bounded process-memory observations keyed to the same generation; reconnect clears them instead of presenting stale values. The usage control validates one current managed session/thread before and after the account read, exposes explicit not-observed thread/quota states, and never allocates account totals to a thread, invents monetary cost/unlimited quota, starts/steers a turn, scans storage history, or parses terminal text.
- Skills listing is one read for one exact current selected session cwd: `skills/list { cwds: [selectedCwd], forceReload: true }`. The control obtains cwd only from selected state, validates target/runtime/generation both before and after the await, and never accepts a caller path, invokes HostDeck filesystem discovery, retries, or mutates runtime settings.
- The adapter requires one exact matching cwd entry and strictly validates bounded skill/error/nested metadata, known `user`/`repo`/`system`/`admin` scope, generated `enabled` truth, duplicate names, and configured skills/error/dependency ceilings. Required keys are exact; generated optional short-description/interface/dependency fields follow the exact observed omitted-or-null-or-valid wire policy rather than coercion. The public frozen snapshot retains only target, runtime/generation/time, deterministic name ordering, name, bounded description, scope, enabled, state (`content`, `empty`, `partial`, or `error`), and error count.
- Raw cwd, skill/error/icon paths, default prompts, dependency command/URL/transport/value fields, and raw error messages are validation-only and are dropped before the adapter result escapes. Unsupported capability, target/generation drift, extra/missing cwd, malformed/oversize/nested drift, and runtime failure remain explicit; terminal text and slash injection are never fallback sources.

### Approval

1. Adapter receives a supported app-server server request and validates it.
2. Approval service registers one pending request with expiry/connection generation and projects it to the session.
3. Browser receives the committed approval projection.
4. Approve/deny passes the normal mutation gate and verifies request is still pending on the same connection generation.
5. Audit `accepted`, send exactly one app-server response, then wait for `serverRequest/resolved` and authoritative item completion before auditing terminal outcome.
6. Duplicate, expired, disconnected, or superseded responses reject without sending.
7. App-server supplies `startedAtMs` but no expiry; HostDeck owns bounded expiry. Reconnect expires prior connection-bound pending approvals unless app-server reissues them.

### Replay To Live SSE

1. Authenticate read and validate session/cursor.
2. Register paused subscriber; capture committed high-water cursor.
3. Query retained projection after requested cursor through high-water.
4. Emit boundary if requested history was pruned, then ordered replay.
5. Drain queued committed events above high-water and switch to live.
6. Send heartbeat comments within idle timeout.
7. Convert the validated async source to a Node Readable at the SSE adapter boundary; never hand an AsyncIterable directly to the pinned plugin.
8. On request abort, queue overflow, auth revocation, session archive, or shutdown, abort the source, unregister immediately, finalize the iterator, and close with bounded reason where possible.

### Runtime Reconnect

1. Mark compatibility/runtime disconnected and projections stale; reject new mutations.
2. Fail pending requests with `incomplete`/unknown outcome as appropriate and expire connection-bound approvals.
3. Retry connection with capped exponential backoff and jitter while host remains active.
4. Repeat handshake/version checks.
5. Reconcile managed threads and current statuses without starting turns.
6. Persist an explicit replay boundary when events during disconnect cannot be recovered.
7. Resume subscriptions and mutation readiness only after reconciliation.

### Tailscale Remote Enable/Profile Switch

1. `IFC-V1-070` proves the exact pinned Tailscale 1.98.8 CLI/status/profile/Serve contract, standard versus `X-Tailscale-*` identity-header behavior, external HTTPS origin, 65-second cellular SSE plus reconnect, non-root permissions, path-scoped cleanup, live logout observation, and saved-profile switching on the target laptop and phone. The frozen redacted contract is `artifacts/ifc-v1-070-tailscale-remote-ingress-spike.md`.
2. The local CLI requests remote enable through the loopback selected API while the human-selected dedicated HostDeck profile is active. One planned operation derives the canonical external origin and bounded profile comparison identity from spike-proven local observation; a conflicting prior selection requires verified explicit disable first. HostDeck records only stable comparison metadata and its own expected Serve descriptor, never a node key or reusable Tailscale credential.
3. The Serve manager serializes one explicit operation without a wait queue. A fresh configured observer preflight must prove exact supported version, running dedicated-profile match, expected external origin, empty Funnel, and action-compatible state. Enable accepts absent/already-exact; disable accepts exact/already-absent. Every other state returns without a command.
4. One attempted mutation uses only the frozen absolute-path argv, exact environment, no shell/stdin, bounded aggregate output/time, and the lifecycle signal. The runner retains only fixed consent/permission indicators; raw stdout/stderr, feature URL, account, profile, and DNS values are discarded.
5. A fresh configured observation after dispatch is authoritative over process exit. Desired state proves applied/removed even after a nonzero exit; unchanged pre-state maps to a bounded failure; profile/version/schema/observer/conflicting Serve state maps to incomplete/unknown. The manager performs no retry or compensation and never broad-resets, overwrites, or removes ambiguous state.
6. Read-back must prove the expected private HTTPS-to-loopback mapping and empty Funnel state before normalized remote state can be ready. Effective admission additionally requires a matching durable post-terminal enable proof and a live same-generation observation lease. Accepted enable/disable invalidates older proof atomically; restart, proof failure, response uncertainty, or lease expiry therefore stays closed.
7. When the active profile changes, Tailscale stops, or Serve state drifts, HostDeck advances the remote generation, marks remote access unavailable, and leaves local runtime, storage, and loopback access running. Read-only observation changes do not invent a mutation audit.
8. HostDeck never switches profiles automatically and never repairs or disables Serve state on an unrecognized/company profile. Returning to the dedicated profile triggers observation only: exact persisted state becomes ready only when the prior successful enable proof can be advanced to the fresh exact generation; missing, drifted, or unproven state requires explicit local enable.
9. Remote disable closes the live admission lease immediately. Its accepted audit atomically invalidates enable proof; the transition then advances generation and durably latches disabled-with-cleanup-incomplete before removing only the exactly matching HostDeck-owned Serve mapping. Verified removal clears the cleanup marker. Ambiguous, failed, or interrupted cleanup remains visible and cannot reopen admission or be reported as successful cleanup.
10. Remote status is a no-store selected API read for loopback local-admin or a current paired device. Enable and disable are confirmed, security-audited, loopback local-admin-only mutations. The CLI uses these routes once per command and never invokes Tailscale, switches profiles, or retries an uncertain mutation itself.

### Tailscale Serve Proxy Trust

1. `IFC-V1-073` adds a dedicated pure evaluator and thin Fastify pre-handler boundary; it does not loosen the existing loopback request-trust evaluator or enable generic `trustProxy`. The immutable policy owns one canonical loopback origin, default HTTP header/URL budgets, and a private current-admission reader.
2. A request is physically eligible only on the plaintext IPv4 loopback backend with an origin-form target. A request with no reserved proxy signal follows the existing direct local Host/Origin/method rules and never reads remote state. Any forwarding, standard identity, Funnel, `Forwarded`, `X-Real-IP`, `X-Original-*`, `Tailscale-*`, or `X-Tailscale-*` signal selects remote classification or rejection; it cannot fall back to local authority.
3. Admitted remote form requires one exact external `Host`, forwarded host, HTTPS proto, and single `100.64.0.0/10` forwarded source. Unsafe methods require the same exact external `Origin`; safe `GET`/`HEAD` may omit it; preflight always rejects. The standard 1.98.8 identity bundle is all absent or all present once with the exact headers-info marker. Partial/duplicate/malformed identity, Funnel, unknown reserved names, and surviving `X-Tailscale-*` lookalikes reject.
4. Remote evaluation reads admission before and after parsing. Both reads must be valid, open, and equal in generation and canonical external origin. Disable, profile/Serve generation change, provider failure, or malformed state therefore cannot produce stale provenance. The evaluator hashes a valid source with a domain-separated SHA-256 label and discards every raw source and identity value.
5. The only admitted output is frozen local or remote provenance with application authorization explicitly `not_evaluated`. Tailscale context cannot mint a paired device, permission, local-admin authority, cookie, or CSRF state. Exact loopback imitation by another process remains inside the explicit single-user host-local-process boundary but still gains no paired remote authority.
6. The Fastify boundary runs before handlers, exposes provenance through a private accessor, closes rejected connections with one generic bounded response, and records bounded reason counters without request values. It emits no CORS policy and retains no raw proxy, identity, source, profile, DNS, Host, or Origin data.
7. `IFC-V1-074` composes admitted provenance with application pairing/rate/authorization. `IFC-V1-077` may use the canonical external origin for links only after that composition. `IFC-V1-079` owns aggregate hostile and physical-phone proof; no earlier unit claim substitutes for it.

### Tailscale Serve Application Authorization

1. `IFC-V1-074` adds a normalized private authentication-ingress adapter and an explicit `remote` authentication mode. The selected Fastify factory installs proxy trust before that adapter and request authentication, accepts no historical LAN trust policy or backend TLS, and leaves lifecycle/SSE ownership to `IFC-V1-078`.
2. Local translation contains loopback HTTP origin/method context and no remote source or generation. Remote translation contains effective external HTTPS origin/method context, the admitted domain-separated source hash, and the admitted generation. Optional standard Tailscale identity is discarded before authentication and has no fallback or authorization role.
3. Request authentication stores ingress separately from its public device context. It revalidates remote generation around device storage, on every cached-authority use, before mutation dispatch, and before successful response publication. Pair claim also revalidates before its durable transition, response preparation, and cookie attachment. Each check requires two equal open reads matching the original origin/generation; local checks never invoke the remote reader.
4. Pairing uses one admitted source hash for both process-local concurrency and durable source-attempt limits, plus the existing independent global limits. Same-source reconnects share a bucket; source changes do not evade the global bucket; identity changes affect neither. No socket-address or identity fallback exists on the selected path.
5. The existing cookie/device/permission/CSRF/lock/revoke contracts remain the sole application authority. Remote unpaired state exposes only bounded access state, protected reads require a paired device, writes require current writer/CSRF/unlocked authority, and remote unlock/local-admin are impossible. Successful atomic work is never relabeled when delivery later becomes stale; response/cookie publication fails closed and inaccessible credentials are discarded.
6. The one canonical configured origin remains approved bounded metadata in the existing public authentication context and pair-claim audit actor. Public errors and diagnostics retain only generic invalid-origin/error codes and bounded counters. Source hashes, generations, raw forwarding/origin headers, optional Tailscale identity/profile fields, cookies, and raw tokens do not enter public authentication contexts, audit payloads, logs, or snapshots.

### Browser Pair/Reload/Revoke

1. Local CLI creates one one-time code with permission and expiry, persists only its hash, and renders a remote HTTPS QR/link with the raw code in the URL fragment.
2. The browser reads the fragment, immediately removes it with history replacement, and submits the code in a bounded claim body. Fragments never reach Serve, HostDeck request logs, or referrers.
3. HTTPS claim validates exact external origin/host, admitted proxy provenance, source/rate limits, and code; it atomically consumes the code, creates a hashed device token, sets a Secure HttpOnly cookie, and audits outcome.
4. Browser calls CSRF bootstrap; server rotates generation/hash and returns the raw token to memory.
5. Reload repeats bootstrap using the HttpOnly cookie.
6. Revoke invalidates device and CSRF state, audits outcome, and causes active SSE/mutations to fail on next authorization check.

### Graceful Shutdown

1. Set not-ready and reject new mutations.
2. Stop accepting HTTP connections.
3. Close SSE and fanout queues by deadline.
4. Stop reconnect loops and fail pending broker requests truthfully.
5. Flush projection/audit work and close SQLite.
6. Close adapter transport.
7. Terminate app-server only when foreground ownership says HostDeck owns it.
8. Release socket/runtime files and daemon lease.

### Selected Runtime Module Hardening

1. Run one frozen non-smoke adapter/server test inventory through a dedicated Vitest config and require exact JSON file/assertion truth with zero skips.
2. Harden the assembled structured vertical to require one canonical exact-version binary and emit one strict private report only after app-server, TUI, threads, database, sockets, and temp roots are cleaned.
3. Execute that vertical and the accepted reconnect/crash/supervisor/restart/coexistence lifecycle scenarios from one clean-commit outer harness. Every child has a distinct private root, detached owned process group, bounded output/deadline, and no retry.
4. Cross-validate exact runtime/commit, deterministic inventory, five model turns, one compact, structured control coverage, lifecycle ownership, event integrity, privacy declarations, and zero-resource cleanup before atomically publishing `INT-V1-091` evidence.
5. Keep binding regeneration and the static app-server-only production boundary as required adjacent gates. Passing this aggregate does not compose Fastify, SSE, service packaging, or remote-phone behavior.

## Failure And Concurrency Matrix

| Case | Required behavior | Test owner |
| --- | --- | --- |
| Invalid calendar timestamp or unsafe cursor | Contract rejection before persistence/dispatch. | `FND-V1-016` |
| Two starts with same alias | One reservation succeeds; the other gets duplicate conflict. | `DAT-V1-018`, `INT-V1-005` |
| Thread created, DB write fails | No automatic second thread; explicit recoverable/incomplete result. | `INT-V1-005` |
| App-server disconnect after accepted mutation | Audit becomes incomplete/unknown unless a terminal event proves outcome. | `DAT-V1-023`, `INT-V1-028`, `IFC-V1-050` |
| HostDeck restart while turn runs | Service-mode app-server continues; reconciliation restores projection or explicit boundary. | `INT-V1-030`, `IFC-V1-036`, `IFC-V1-037` |
| Approval double tap/two clients | Exactly one response wins; loser sees resolved conflict. | `INT-V1-025`, `IFC-V1-044`, `FE-V1-022` |
| CSRF reload/revoke race | Rotated/revoked generation invalidates stale header; no bearer token exposure. | `DAT-V1-021`, `DAT-V1-028`, `IFC-V1-027`, `IFC-V1-059`, `FE-V1-024`, `FE-V1-031` |
| Slow SSE subscriber | Subscriber closes at bounded queue without blocking projector/other clients. | `IFC-V1-035`, `IFC-V1-048` |
| Retention during replay | Transactional boundary and high-water handoff remain ordered. | `DAT-V1-022`, `IFC-V1-034` |
| Duplicate daemon | Second owner exits before opening DB/listener/runtime mutation. | `DAT-V1-019` |
| Wrong/unknown active Tailscale profile | Remote state is unavailable; no profile switch, Serve mutation, pairing claim, or local-runtime interruption. | `IFC-V1-070`, `IFC-V1-071`, `IFC-V1-072`, `IFC-V1-079` |
| Foreign or drifted Serve mapping | Reconciliation/disable fails with an ownership conflict and leaves foreign state untouched. | `IFC-V1-070`, `IFC-V1-072`, `IFC-V1-076`, `IFC-V1-079` |
| Unknown/contradictory proxy context or mismatched external Host/Origin | Request is rejected before cookie/data access. Exact host-local loopback imitation remains inside the documented single-user-host boundary and cannot manufacture paired remote authority from Tailscale identity; explicit local-admin request forms remain separate. | `IFC-V1-073`, `IFC-V1-074`, `IFC-V1-079` |
| Unsupported `/plan` semantic | Control disabled/incompatible; no literal slash fallback. | `INT-V1-003`, `INT-V1-021`, `IFC-V1-063`, `FE-V1-027` |
| TUI plus HostDeck clients | Both address the same thread without subscription corruption. | `INT-V1-031` |

## Required Capability Blocks

| Block | Scope after rebaseline | Completion gate |
| --- | --- | --- |
| `BLK-V1-01` | Normalized contracts, events, approvals, compatibility, remote-ingress/access state, fixtures, planning validation. | Remote rebaseline tests and `FND-V1-092`; earlier structured-runtime completion is insufficient. |
| `BLK-V1-02` | App-server mapping/projection migration, auth/CSRF, audit outcomes, remote-ingress configuration/audit, production retention, permissions/lease. | Integration/storage evidence and `DAT-V1-092`. |
| `BLK-V1-03` | Codex adapter, private runtime, real thread/turn/control/approval/event/restart/TUI path. | Real vertical plus `INT-V1-091`; no fake producer. |
| `BLK-V1-04` | Fastify API/SSE/static, loopback listener, Tailscale profile/Serve ingress, app authorization, CLI/build/service packaging, and resource controls. | Packaged remote path, cellular/profile-switch evidence, and `IFC-V1-091`. |
| `BLK-V1-05` | Remote-access state rebaseline, replacement visual options/selection, phone-first dashboard, approvals, controls, fidelity/device evidence. | `FE-V1-090`. |
| `BLK-V1-06` | Security/privacy, clean install/service/browser/remote phone, company-profile noninterference, aggregate validation, completion matrix, go/no-go. | Release-readiness artifact and human acceptance. |

## Delivery Order

| Order | Gate/slice | Exit evidence |
| --- | --- | --- |
| 1 | Audit and planning integrity | `REL-V1-011`, `FND-V1-014`; owner docs/backlog/checker agree. |
| 2 | Normalized contract rebaseline | `FND-V1-015`, `FND-V1-016`, generated fixtures and strict invariants. |
| 3 | Codex compatibility and IPC adapter | `INT-V1-003`, `INT-V1-004`; handshake/broker/fake tests. |
| 4 | Selected durable state | `DAT-V1-018` to `DAT-V1-030`; migration, paths/lease, append/retention, audit outcomes, CSRF/device/pairing/revoke storage and bounded startup reconciliation. |
| 5 | Real structured semantics and operation ports | `INT-V1-005`, `INT-V1-006`, `INT-V1-017` to `INT-V1-027`; thread, prompt, events, controls, approval, interrupt. |
| 6 | Runtime lifecycle, legacy disposition, and integration hardening | `INT-V1-007`, `INT-V1-028` to `INT-V1-032`, `INT-V1-008`, `INT-V1-091`; supervision, restart, TUI coexistence, one selected runtime. |
| 7 | Remote-ingress proof and reopened foundations | `REL-V1-012`, `IFC-V1-070`, `FND-V1-018`, `DAT-V1-031`, and `DAT-V1-032`; exact profile/Serve contract, normalized state, fixtures, migration, and audit catalog. |
| 8 | Production host and remote interface | Existing `IFC-V1-015` to `IFC-V1-069` evidence plus `IFC-V1-071` to `IFC-V1-078`; loopback Fastify/SSE/static lifecycle, profile-safe Serve ownership, proxy trust, QR pairing, routes/CLI, build, and service packaging. |
| 9 | Interface hardening and physical remote proof | `IFC-V1-079`, `FND-V1-092`, `DAT-V1-092`, and `IFC-V1-091`; hostile/failure matrices, cellular phone path, profile switching, and company-profile noninterference. |
| 10 | Mobile state and visual gate | `FE-V1-004`, reopened `FE-V1-002`, human `FE-V1-003`. This precedes React screen implementation. |
| 11 | Dashboard implementation | `FE-V1-010` to `FE-V1-040`; typed clients, screens/actions/trust states, responsive, accessibility, browser, fidelity, and copy evidence. |
| 12 | Module and release hardening | `FE-V1-090`, release/security/clean-install/aggregate tasks. |
| 13 | Human acceptance | `REL-V1-010`; explicit go/no-go. |

Tasks may overlap only when dependencies and shared contracts make the work independent. No UI screen implementation starts before order 9 is complete.

## Rollout And Rollback

- All app-server behavior is behind the new adapter and selected-runtime configuration during migration.
- Historical tmux implementation evidence remains in artifacts and Git history; current tmux use is limited to isolated exact-Codex TUI test harnesses.
- If the real structured vertical fails a required semantic, V1 returns to planning. It does not silently ship both runtimes or resume TUI scraping.
- If Tailscale ingress cannot meet the pinned remote/security/profile-isolation contract, V1 returns to planning. It does not fall back to a LAN listener, custom CA, public port forwarding, or silent company-profile mutation.
- Database migrations are forward-only and tested on a copy; destructive pre-release legacy reset requires explicit CLI confirmation and preserves bounded global audit history while removing only inert legacy session state.
- Dependency additions are committed separately from UI work and include license/version rationale in the owning task.
- A completed block is reopened whenever its production outcome changes, even if historical package tests still pass.

## Pre-Implementation Checks

- `pnpm check:planning` passes and detects unknown refs, duplicate tasks, dependency cycles, invalid ready states, and uncovered requirements.
- Current queue contains only active in-progress/ready tasks and intentional human/external blockers.
- Every new task has status, block/requirement refs, real `Blocked by` and `Blocks`, description, criteria, and evidence.
- `docs/status.md` reports the rebaseline and no-go state without historical completion inventory.
- No product implementation claim relies on the rejected visual boards or fake-Codex tmux smoke.
