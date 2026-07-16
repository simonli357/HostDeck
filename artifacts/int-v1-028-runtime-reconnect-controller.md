# INT-V1-028 Runtime Reconnect Controller

Date: 2026-07-16

Status: complete.

## Hardening Audit Amendment

The first executable pass exposed additional criteria before closure fixes:

- Public phase `ready` must mean the admitted generation is already final. The final lifecycle callback runs while the controller remains non-ready; no snapshot may report `ready` with a null admitted generation.
- The lifecycle runtime port is a revocable cycle lease. It rejects use after cycle completion/failure and dispatches only an explicit reconciliation-read method set; the resubscribe step additionally permits only the reviewed idempotent `thread/resume` request. A caller-supplied `kind: "read"` cannot disguise a mutation method.
- Generation-aware approval clients must be composable before initial start, while every actual parse/response remains generation-positive and compatibility-gated. During synchronous held-callback delivery only, the controller exposes the completed handshake compatibility needed to register inbound truth while its request/response admission remains closed. The scope ends when the callback returns.
- Fatal protocol issues, stale-generation frames, and callback contract failures are terminal, not reconnectable transport failures. Closing that generation still runs the once-per-generation disconnected cleanup before terminal publication.
- Injected random, clock, transport-property, and sleep contracts fail with bounded controller errors. Backoff cancellation does not depend on an injected sleep implementation cooperating, and terminal reporting cannot strand initial readiness if owned shutdown reports an error.

## Scope

Implement one headless selected-runtime reconnect controller around the existing Unix transport and compatibility connection. It owns immediate write closure after transport loss, connection-generation cleanup, capped cancellable backoff, repeated compatibility handshake, a read-only reconciliation gate, bounded inbound holdback, resubscription ordering, and admission only after the full cycle succeeds. Durable mapping/thread/turn reconciliation, replay-boundary persistence, app-server restart evidence, HostDeck-only restart, TUI coexistence, host startup composition, and release acceptance remain downstream.

## Pre-Change Findings

- `CodexAppServerConnection.reconnect()` is an explicit one-shot transport recycle. No production component owns a continuing reconnect loop, backoff, cancellation, or lifecycle state.
- The request broker already settles sent reads as retry-safe unknown and sent mutations as non-retryable unknown on disconnect. The connection never stores or retries request inputs, but there is no outer admission gate preventing new writes between handshake success and application reconciliation.
- The connection publishes `ready` immediately after compatibility. Notification and server-request callbacks can therefore reach application consumers before durable state is reconciled or subscriptions are re-established.
- `CodexApprovalControlService.disconnect(generation)` can supersede connection-bound approvals, and selected projections support disconnected/stale truth, but no selected-runtime owner invokes those capabilities as one ordered disconnect transition.
- Broker generation validation is complete for correlated responses only. A stale-generation notification or server request injected by a broken transport contract can still reach decoding/consumers.
- The resource registry has connect/handshake/request bounds but no reviewed reconnect-delay bounds. The historical tmux restart reconciler is not a selected-runtime input.

## Frozen Architecture

- Add a `CodexRuntimeReconnectController` in `@hostdeck/codex-adapter`. It exclusively owns one existing `CodexTextTransport` and its internally constructed `CodexAppServerConnection`; the raw connection never escapes.
- The controller exposes compatibility, generation, request, server-response, start, close, and privacy-safe snapshot surfaces needed by existing adapter clients. All application requests and server responses pass through this outer port.
- Exact phases are `idle`, `connecting`, `reconciling`, `resubscribing`, `ready`, `disconnected`, `backing_off`, `incompatible`, `failed`, `closing`, and `closed`. Only `ready` admits requests or approval responses, its admitted generation must equal the current transport generation, and `ready` is never published before that admission is final.
- Add an injected lifecycle port with four ordered operations: `disconnected`, `reconcile`, `resubscribe`, and `ready`. Each receives a caller-owned operation deadline. `reconcile` receives only a same-generation read-only request port; it cannot dispatch a mutation through the controller contract.
- `disconnected` is called once for every lost positive generation before another connection attempt. The production composition will use it to publish runtime/projection unavailability and invoke approval generation cleanup. Failure to establish that truth is terminal and cannot be hidden by reconnecting.
- `reconcile` and `resubscribe` must both complete for the same current generation before `ready` runs. Their runtime lease is method-restricted, generation-stable, deadline-bound, and revoked on every terminal path. Any disconnect, deadline, generation change, malformed callback result, or lifecycle failure prevents admission. Lifecycle-step automatic retry is forbidden because downstream storage/subscription side effects require explicit idempotency ownership.
- Concrete durable thread reconciliation and disconnect-boundary persistence remain `INT-V1-029`; this leaf proves that their port is ordered, read-only at the adapter boundary, generation-stable, deadline-bound, and mandatory before admission.

## Disconnect And Retry Contract

- A transport close synchronously clears the admitted generation and blocks new calls before background cleanup. The broker independently settles every in-flight request; the controller never captures, clones, queues, or replays a request input.
- Queued pre-admission notifications/server requests for the lost generation are discarded. Connection-bound application cleanup runs once with generic reason classification and no raw close text.
- Initial connection is immediate. Each retryable transport/handshake failure after cleanup sleeps with deterministic equal jitter over a doubling base. The base starts at `protocol_reconnect_initial_delay_ms`, saturates at `protocol_reconnect_max_delay_ms`, and never overflows a safe integer.
- Add both reconnect delay keys to the selected resource registry and Codex resource mapping. The initial delay must not exceed the maximum. One connect/handshake/reconcile/resubscribe cycle consumes the existing caller-owned lifecycle startup bound; delay does not reset or extend an active cycle.
- Retry continues only while the controller is active. Close or initial-start cancellation aborts sleep, connect, handshake, reconciliation, resubscription, and queued callbacks without retaining timers/listeners.
- Only a retry-safe adapter failure schedules another attempt. Incompatible version/capability, protocol/schema failure, lifecycle failure, invalid random/clock/port output, or impossible state becomes terminal and observable. There is no tmux, stdio, TCP, alternate socket, process restart, or compatibility downgrade fallback.

## Inbound And Generation Contract

- During connect, handshake, reconcile, and resubscribe, normalized connection callbacks are held in one FIFO with separate configured notification and server-request ceilings. They are released only for the admitted generation after resubscription and before final ready admission.
- Held inbound registration receives a synchronous compatibility-only window after handshake and resubscription. This permits precomposed consumers to record the inbound event for the current generation; ordinary application requests and server responses remain blocked until final admission, and the window cannot escape the callback stack.
- Overflow fails the generation closed. A disconnect clears the FIFO; no callback from an unadmitted or stale generation reaches application code.
- The broker rejects every message event whose generation differs from the transport's current generation before decoding, correlation, notification delivery, or server-request registration. This impossible transport-contract violation terminates the current connection with a bounded protocol issue.
- Reconciliation reads carry the cycle deadline and exact generation. Mutation-kind input, generation drift before/after await, or a response arriving after disconnect fails without retrying the request.
- Late responses retain the existing bounded degraded behavior only when they belong to the current generation. Unknown required semantics continue to block mutation and are not relabeled as reconnect success.

## Failure Truth And Observability

- The frozen snapshot exposes phase, raw connection state, current/admitted generation, connect attempts, consecutive retryable failures, completed reconnects, disconnect cleanups, next delay, held callback counts, and a fixed stage/code failure summary.
- Counters saturate at `Number.MAX_SAFE_INTEGER`. The snapshot and public controller errors contain no socket path, close reason, request method/params/id, thread/session/turn/item id, approval content, executable, pid, raw frame, raw error, or callback object.
- A required background-error observer receives terminal post-start failures. Start rejects terminal pre-ready failure. Repeated/concurrent start and close have one explicit result; close is idempotent and awaits the background loop plus connection shutdown.
- Successful initial readiness is distinct from later reconnect readiness. Compatibility may be internally handshake-ready while the public controller remains mutation-blocked in `reconciling` or `resubscribing`.

## Hard Success Criteria

| Area | Required evidence |
| --- | --- |
| Construction | Strict plain-data options, exact transport/lifecycle/callback/clock/random contracts, complete resolved resource budget, and rejection of accessors, extra keys, malformed signals, invalid callbacks, and contradictory limits. |
| Admission | Initial connect, compatibility, reconciliation, resubscription, held-callback drain, and ready publication occur in exact order; calls reject before final same-generation admission. |
| Disconnect | Admission closes synchronously; sent read/mutation outcomes retain broker truth; lifecycle cleanup runs once per generation; approvals/projection owner hooks are demonstrably ordered before retry. |
| Backoff | Equal-jitter exponential schedule, cap, safe saturation, retry classification, cancellation at every phase, and reset only after complete readiness pass under a fake monotonic clock/random source. |
| Compatibility | Every connection attempt repeats initialize/capability checks; incompatible or malformed semantics stop rather than loop or downgrade. |
| Reconciliation | Same-generation, deadline-bound, read-only request port; no mutation dispatch; lifecycle failure/timeout/drift prevents ready; resubscribe and ready cannot reorder. |
| Inbound | Bounded FIFO across handshake/reconcile, exact notification/server-request ordering, overflow closure, disconnect discard, callback failure closure, and no stale-generation delivery. |
| Lifecycle | Initial/repeated/concurrent start, disconnect during every await, repeated close, close during sleep/connect/reconcile/resubscribe/ready, terminal background failure, and no timer/listener/request retention. |
| Privacy | Snapshot/error/object-graph review proves only bounded stage/code/count/state facts and no path, close reason, raw request/message, target id, approval content, or secret. |
| Ownership | No durable thread reconciliation, boundary persistence, process restart, host lifecycle composition, TUI evidence, UI, phone, package, or release claim. No dependency change. |

## Validation Plan

- Direct fake-clock controller tests cover every phase, ordering edge, backoff boundary, retry classification, cancellation point, generation race, lifecycle failure, queue limit, callback failure, repeated call, counter, and privacy rule.
- Connection/broker regression tests add stale-generation notification/server-request rejection and preserve current response, unknown-outcome, late-response, compatibility, and explicit reconnect behavior.
- A headless integration composes the real controller with scripted transport, actual request broker/connection, approval disconnect service, and selected projection-like lifecycle recorder to prove sent mutation uncertainty, immediate write closure, approval supersession, held callbacks, compatibility recheck, read-only reconcile, resubscription, and same-generation readiness without a model call.
- Run affected package tests, full unit/contract/integration/web suites, root and all-package typechecks, lint/exports, scaffold, planning, frozen offline install, exact 0.144.0 binding, production dependency/license checks, `git diff --check`, active-handle inspection, and manual state/order/privacy/no-retry review.

## Implementation And Hardening Evidence

- `CodexRuntimeReconnectController` now owns the selected connection lifecycle, exact public phases, same-generation admission, once-per-generation disconnect cleanup, bounded equal-jitter retry, repeated compatibility checks, read-only reconciliation, restricted resubscription, held inbound delivery, and final ready publication.
- Every ordinary request and approval response remains closed until final admission. The controller never stores or replays a mutation, and the existing broker retains distinct read-retry-safe versus mutation-unknown disconnect outcomes.
- Lifecycle runtime ports use method allowlists and revocable generation leases. Reconciliation permits only reviewed reads; resubscription additionally permits only `thread/resume`; the ready hook receives no request surface.
- Fatal protocol issues, malformed compatibility, stale-generation frames, invalid injected contracts, lifecycle failures, and impossible state terminate with bounded privacy-safe errors. Caller cancellation and close remain effective even when connect, sleep, or lifecycle collaborators do not cooperate.
- A real precomposed approval service is exercised during held callback delivery and reconnect. Connection-bound approvals are superseded before retry, while same-generation registration remains possible only inside the synchronous compatibility window.
- Resource policy now owns reviewed initial/max reconnect delays and rejects an initial delay greater than the maximum. No dependency, fallback transport, process-restart behavior, durable reconciliation, or UI surface was added.

## Validation Results

| Evidence | Result |
| --- | --- |
| Focused adapter/controller matrix | 57 passed. |
| Headless controller integration | 1 passed with the real broker/connection and approval composition. |
| Focused resource contracts | 6 passed. |
| Unit suite | 1,663 passed, 37 skipped across 173 passed and 23 skipped files. Android-gated cases reported no connected device, which is outside this headless leaf. |
| Contract / integration / web | 276 / 32 / 33 passed. |
| Static and repository gates | Root and all 9 package typechecks, lint over 486 files, package exports, scaffold, planning, offline frozen install, license inventory, and diff checks passed. |
| Exact runtime | Reviewed 0.144.0 binding (671 generated files), no-model compatibility smoke, and Unix IPC smoke passed using the isolated pinned binary. The user's default 0.144.3 remains intentionally ineligible as exact evidence. |
| Dependency/security check | Production licenses are permissive. npm audit returned no advisory result because the retired registry endpoint responded HTTP 410; no dependency or lockfile changed. |
| Manual inspection | Phase/admission order, no replay, callback/lease revocation, timer/listener cleanup, bounded snapshots/errors, and absence of retained runtime test processes/sockets passed. |

Criteria commits: `3861c37`, `daf6607`. Implementation commit: `6a142dd`.

## Downstream Ownership

- `INT-V1-029` implements durable mapping/thread/status reconciliation, model/mode rehydration, honest interrupted/incomplete outcomes, and one explicit disconnect boundary.
- `INT-V1-030` proves HostDeck-only restart against a service-owned app-server.
- `INT-V1-031` proves exact HostDeck plus laptop TUI coexistence.
- `INT-V1-032` owns aggregate selected-runtime lifecycle acceptance.
- `IFC-V1-036` to `IFC-V1-038` own mutable host health, startup composition, and graceful application drain around this controller.
