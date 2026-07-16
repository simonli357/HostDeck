# IFC-V1-049 Operation Idempotency And Concurrency

Date: 2026-07-16

Status: complete.

## Scope

Implement one explicit process-level admission and idempotency policy shared by every selected write gate. The policy consumes the existing resource budget, bounds mutation requests by authenticated actor, exact target, and process, and makes a repeated operation id either replay the same retained result or fail without a second audit/dispatch. Durable selected audit remains the authoritative accepted-to-terminal history and crash boundary. Aggregate route registration, propagated child deadlines, application shutdown, packaging, UI behavior, and release acceptance remain downstream.

## Pre-Change Findings

- The resource registry already defines `mutation_window_ms`, `mutation_max_requests_per_device`, per-device/per-target/global in-flight caps, `admission_max_tracked_keys`, and `admission_state_ttl_ms`; no selected mutation consumes them.
- The exact selected write gate enforces parse, authority/CSRF, lock, target, accepted audit, at-most-once dispatch, response preparation, and terminal proof, but each gate instance has no shared admission state.
- The selected audit repository serializes one operation id durably. A duplicate therefore prevents a second dispatch, but every duplicate is only a conflict; same-payload replay, an in-flight join, cross-route intent comparison, and prior response return do not exist.
- Accepted audit summaries intentionally omit prompt/objective text and other sensitive request data. Durable audit cannot safely prove that a repeated operation id carries the same full payload, and it does not retain full HTTP responses.
- Route-local control services serialize some operations per session, but those guards neither enforce the selected HTTP resource policy nor coordinate different mutation families, devices, or exact targets.
- Pair-claim concurrency has a separate route-local limiter. It is not reusable mutation idempotency and remains outside this leaf.

## Frozen Architecture

- Add one branded `HostDeckSelectedWriteAdmissionPolicy` under `@hostdeck/server`, created from one strict resolved `ResourceBudget` and an injected monotonic clock.
- Every selected write gate requires that policy explicitly. Concrete selected route registrations require an admission policy from composition; they cannot create a private default or silently omit enforcement.
- One policy instance is shared across route families in a process. Different policy instances are isolated and cannot accidentally share operation, actor, target, response, or rate state.
- The gate performs parse -> write authority/CSRF -> open request deadline -> admission begin. A same-intent replay returns or awaits retained truth before lock/target/audit/dispatch. A new owner then performs lock -> target resolution -> exact-target bind -> accepted audit -> one dispatch -> response preparation -> terminal audit -> retained result.
- Admission is headless and storage-independent. It never writes audit, reads selected state, dispatches Codex work, creates a replacement timeout, retries a callback, or decides operation success.

## Identity And Replay Contract

- The operation key is the strict client operation id. Intent equality is a SHA-256 digest over a canonical, accessor-free, cycle-free representation of the authenticated audit actor, selected route id, action, accepted summary, and complete parsed target-or-selector plus value.
- Canonical encoding sorts object keys, distinguishes JSON primitive/array/object forms, rejects non-finite numbers, unsupported prototypes, accessors, symbols, cycles, excessive depth/fields/items/bytes, and retains only the digest of raw intent. Admission state retains the bounded immutable public gate result required for exact replay until TTL; request-only private fields that are absent from that public result are not retained. Snapshots and diagnostics expose no prompt, objective, path, model value, request body, actor field, target id, digest, replay result, or error.
- The same operation id, same authenticated actor, and same canonical intent joins the existing operation. It consumes the actor's request-rate budget but no second in-flight slot, target bind, accepted audit, response preparation, or dispatch.
- An in-flight replay waits for the owner's retained result under only the replay request's existing AbortSignal. Replay abort removes its listener and never cancels or relabels the owner.
- A retained terminal replay returns the exact immutable succeeded, failed, or incomplete gate result, or rethrows the same bounded post-admission error, without touching lock, target, audit, or dispatch.
- Reuse by another actor, route, action, target/selector, confirmation, decision, revision, model/goal/plan value, prompt text, or any other parsed value is `operation_conflict` before lock, target, audit, or dispatch.
- Terminal replay entries are eligible for lazy eviction at the configured TTL and are pruned before admission/capacity decisions. Running entries are never evicted. After eviction or process restart, durable audit uniqueness can still prevent dispatch, but payload equality cannot be proven; the request fails as a durable operation conflict rather than guessing, replaying fabricated state, or redispatching.

## Rate, Capacity, And Concurrency Contract

- Every authorized selected mutation attempt, including replay and conflicting operation-id reuse, enters one fixed monotonic per-actor request window. Paired devices use their exact device actor; local-admin CLI calls share one explicit local actor bucket.
- The exact configured request count is admitted in a window. The next attempt returns `rate_limited` with no lock, target, operation entry, audit, or dispatch. At `window_start + mutation_window_ms`, the bucket resets exactly.
- A new operation owner acquires one per-actor and one global slot atomically before lock/target work. After exact target resolution it binds one canonical hashed target slot before accepted audit.
- Per-actor, per-target, and global limits are checked deterministically. Exhaustion returns `service_overloaded`; no operation entry survives and no accepted audit or dispatch occurs.
- Target counts include every selected action addressing the same exact typed target. Different route families therefore cannot bypass one another by using separate gate instances.
- Tracked rate buckets plus operation entries never exceed `admission_max_tracked_keys`. Expired terminal operations and inactive expired rate buckets are pruned first. If safe pruning is insufficient, a new key is rejected as `service_overloaded`; active or unexpired truth is never silently evicted.
- Owner slots release exactly once on every settlement path. Underflow, duplicate bind/settle, foreign claim use, target drift, clock rollback, or impossible counters fail loudly and cannot open capacity.

## Failure And Audit Truth

- Parse and authentication/CSRF failures occur before admission and retain no policy state. Rate/capacity/conflicting-reuse failures occur before lock/target/audit and create no operation trail.
- Lock, deadline, target-resolution, or target-admission failure is proven not started: the provisional owner entry and actor/global/target slots release, existing replay waiters receive the same bounded failure, and an explicit later attempt may acquire again.
- Accepted-audit unavailability proven to have created no durable accepted row releases the provisional entry. A durable operation conflict is retained as a bounded conflict and never dispatches.
- Once accepted audit or dispatch may have begun, succeeded, failed, incomplete, timeout/disconnect, malformed transition, response-preparation failure, terminal-audit failure, and unknown exceptions retain one terminal replay outcome. No same-operation attempt can redispatch.
- A response delivery/serialization failure outside the gate does not erase the already retained gate result. A same-intent retry may retrieve that result inside the retention window without a second accepted audit or dispatch.
- Admission never converts failure/incomplete into success, invents retry safety, overwrites durable audit, retries unknown outcomes, or releases an owner merely because its deadline elapsed while callback settlement remains unknown.
- Stable public mappings are 429 `rate_limited`, 503 `service_overloaded`, 409 `operation_conflict`, and 504 `operation_timeout` for an aborted replay wait. Messages and diagnostics contain no operation id, actor/device/source, target, route payload, digest, limit key, or private cause.

## Observability And Lifecycle

- A frozen count-only snapshot reports attempts, owners, in-flight/terminal replays, conflicts, rate/device/target/global/capacity rejections, owner settlements/abandons, replay aborts, active owners/targets/waiters, tracked operations/rate buckets, peaks, and contract/clock failures.
- Counters saturate at `Number.MAX_SAFE_INTEGER`. Snapshot reads expose no map, key, timestamp, fingerprint, value, result, error, or callback.
- Replay listeners are one-shot and removed on owner settlement or replay abort. The policy creates no polling loop, retry timer, wall-clock timeout, or unbounded promise/listener collection.
- Lazy TTL cleanup is deterministic under the injected monotonic clock and occurs before each admission. Application-wide drain/close behavior remains `IFC-V1-037`; this leaf cannot release possibly running mutations during shutdown.

## Hard Success Criteria

| Area | Required evidence |
| --- | --- |
| Construction | Exact branded policy, strict resource-budget/clock input, no defaults, copies, accessors, invalid clocks, or policy identity substitution. |
| Canonical intent | Deterministic key-order-independent digest, actor/route/action/target-or-selector/value coverage, hostile object rejection, no raw intent or key exposed, and bounded public replay results isolated from diagnostics. |
| Idempotency | Same completed/in-flight intent replays one result; conflicting actor/route/payload rejects; post-TTL/restart durable conflict never redispatches. |
| Rate/capacity | Exact fixed-window boundary, actor isolation, local-admin bucket, tracked-key pruning/cap, and stable pre-side-effect 429/503 outcomes. |
| Concurrency | Deterministic per-actor/per-target/global winners across independent gate/route families; same-operation join uses no second slot; exact release and peak accounting. |
| Failure truth | Pre-start abandon versus post-accepted retention, known failure/incomplete, unknown outcome, audit unavailability/conflict, response preparation/delivery failure, terminal audit failure, owner/replay abort. |
| Integration | Every selected gate-backed route requires the shared policy; a real Fastify/SQLite cross-route vertical proves one policy, one winner, one trail/dispatch, replay, conflict, target isolation, and no leaked raw intent. |
| Ownership | No pair-claim rewrite, aggregate selected registration, child-deadline propagation, reconnect reconciliation, shutdown release, installed CLI, UI, phone, package, or release claim. No dependency change. |

## Validation Plan

- Direct policy tests use a fake monotonic clock and controlled deferred owners for exact window/TTL edges, all cap dimensions, same/distinct actor/target/route/intent, in-flight joins, aborted waiters, capacity exhaustion, release, clock rollback, counter saturation, and privacy.
- Selected write-gate tests prove order, replay before lock/target, exact-target binding before audit, not-started cleanup, post-audit retention, immutable response replay, and unchanged existing authority/deadline/audit behavior.
- Route input tests reject missing/copied admission policies. Existing selected route suites and verticals must consume explicit policies without private defaults.
- A real SQLite cross-route integration uses at least two selected mutation families and two exact targets. It proves same-operation one-dispatch replay, conflicting reuse, per-target/global contention, terminal/accepted trail consistency, response-loss retry, and raw storage/snapshot privacy.
- Run focused policy/gate/route tests, full unit/contract/integration/web suites, root and all-package typechecks, lint/exports, scaffold, planning, frozen offline install, exact reviewed Codex binding, production dependency/license checks, and diff/manual privacy/order inspection. No physical phone or model call is required for this headless leaf.

## Implementation And Evidence

- `HostDeckSelectedWriteAdmissionPolicy` now owns strict canonical intent hashing, fixed-window actor rate limits, operation replay/conflict state, per-actor/per-target/global admission, TTL/capacity pruning, count-only snapshots, and fail-loud contract checks. The selected write gate requires the branded policy and applies it before lock, target, audit, and dispatch work.
- All ten selected mutation route families require an explicit shared policy. Direct route suites reject omitted or copied policy identities; no route creates a private fallback.
- The real Fastify/SQLite integration composes prompt and archive routes with one policy and proves cross-route replay/conflict, response loss, one audit/dispatch, target contention and isolation, pre-audit retry, TTL eviction followed by durable conflict, and storage/snapshot privacy.
- Focused evidence: 49 policy/gate/start tests, 14 direct policy tests, 104 selected route tests, one cross-route integration, and 10 affected vertical integrations passed.
- Workspace evidence: unit 1,610 passed with 36 skipped; contract 276, integration 26, and web 33 passed. Root and all-package typechecks, lint/exports, scaffold, planning, frozen offline install, production license inventory, `git diff --check`, and manual order/privacy/default review passed.
- The exact binding check remains externally blocked because the installed Codex is 0.144.3 while the reviewed binding is exact 0.144.0; the repository already records the isolated cached 0.144.0 reproduction path. Production audit remains unavailable because npm's retired audit endpoint returns HTTP 410. Neither gap was introduced by this leaf, and no dependency or lockfile changed.
- Criteria commit: `5477a50`. Implementation commit: `fc5f182`.

## Downstream Ownership

- `IFC-V1-046` owns one aggregate selected route composition that injects the same policy into every production mutation registration.
- `IFC-V1-050` owns decreasing child deadlines and cancellation propagation through every selected layer.
- `IFC-V1-052` owns aggregate HTTP/SSE/mutation/CLI stress evidence.
- `IFC-V1-037` owns application drain and shutdown interaction with active mutations.
- `DAT-V1-030`, `INT-V1-028`, and `INT-V1-029` own restart/reconnect reconciliation of durable pending or unknown operations.
- UI leaves own duplicate-submit disabling and presentation of replayed, rate-limited, overloaded, conflict, and incomplete states.
