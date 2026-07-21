# IFC-V1-050 End-to-End Deadline And Cancellation

Date: 2026-07-20

## Hardening Target

- Owning block: `BLK-V1-04`.
- Requirements: `NFR-006`, `NFR-010`, `NFR-011`, and `SFR-017`.
- Accepted inputs: the 84-field resource registry and monotonic `OperationDeadline` from `IFC-V1-020`; Fastify request ownership from `IFC-V1-022` and `IFC-V1-047`; selected write/audit/idempotency behavior from `IFC-V1-049` and `IFC-V1-066`; reconnect and unknown-outcome behavior from `INT-V1-028`; exact 22-registration/35-route composition from `IFC-V1-046`; selected-only interface closure from `IFC-V1-067`.
- Target state: every selected HTTP operation that can reach Codex carries one unchanged request deadline through route and service layers. Each protocol send receives the same signal and a timeout derived at send time as the lesser of the operation-specific protocol cap and the decreasing request remainder. Cancellation never invents success or remote cancellation.

## Baseline Audit

| Boundary | Current behavior | Required correction |
| --- | --- | --- |
| Fastify owner | The app creates one `OperationDeadline` view over the unchanged `request.signal`; the common write gate receives it. | Keep this as the only HTTP timer/signal owner and expose that exact object to every protocol-bearing route path. |
| Read/control routes | Model, goal, plan, usage, skills, prompt, compact, approval, and interrupt routes pass only `request.signal`; no route passes remaining duration. | Pass `hostDeckRequestDeadline(request)` through every request-facing service port. Read and write paths use the same contract. |
| Session lifecycle | Selected start and archive call `ManagedCodexThreadService` without any signal or deadline. | Carry the request deadline through validation, recovery checks, thread reads, start/archive dispatch, and post-dispatch persistence checks. |
| Application services | Request-facing services generally accept an optional `AbortSignal`; seven control services serialize work without rejecting an aborted waiter before its callback starts. | Require a request deadline for HTTP entry methods, check it before local state changes and each protocol boundary, and make queued/local terminal waits abortable without violating serialization. |
| Protocol clients | Thread operations have no signal; turn/model/goal/plan/usage/compact/skills use fixed per-client timeout values and optional signals. Paginated or nested calls reuse the fixed cap for every request. | Derive `{ signal, timeout_ms }` from the same deadline immediately before every broker request. Each later request must observe an equal or smaller remainder. |
| Broker | The broker owns bounded pending state, distinguishes `not_sent` from possible-send `unknown`, and clears its timer/listener on settlement. Child request timeouts below 50 ms are rejected as invalid. | Accept the final 1-49 ms of a valid parent deadline, preserve send-state truth, and prove timer/listener/pending cleanup plus late-response retirement. |
| Approval server response | User decisions and background expiry await `respondToServerRequest` with no signal or timeout. | Bound server-response writes; user decisions use the request deadline, while background expiry uses the reviewed protocol cap. A timed-out possible send remains unknown. |
| Public outcome | Several adapter `request_timeout`/`request_aborted` cases map to `runtime_unavailable`, `unknown_error`, or 503 while the selected route already reserves 504 `operation_timeout`. | Map elapsed protocol work to stable `operation_timeout`; retain `not_sent` versus `unknown` separately for audit and retry truth. |
| Aggregate evidence | Existing tests prove the Fastify deadline owner and many service-local abort paths, but no test traverses real selected HTTP, services, broker, and a controlled protocol transport under one clock/outcome matrix. | Add direct, aggregate, and structural evidence across every in-scope operation family and both loopback and admitted-remote request composition. |

There are currently eleven direct `request.signal` call sites across nine selected route modules, while session start/archive have no cancellation argument. The in-scope protocol client set is thread, turn, model, goal, plan, usage, compact, skills, and approval server-response handling.

## Frozen Operation Matrix

| Selected surface | Protocol work that must consume the request deadline |
| --- | --- |
| Session start | `thread/start`; any request-path materialization request that follows a proven remote start. |
| Session archive | Paginated `thread/list`, loaded/read verification, then `thread/archive`; expiry between reads and archive sends no archive request. |
| Prompt | Exact `turn/start` or `turn/steer`; pending model/Plan composition uses the same deadline and may not create a fresh child budget. |
| Model | `model/list`, `thread/resume`, and a later prompt's model-bearing `turn/start`; pagination and read-back only decrease the remainder. |
| Goal | `thread/goal/get`, `thread/goal/set`, and `thread/goal/clear`; read-before-write expiry prevents the write. |
| Plan | `collaborationMode/list` and a later prompt's collaboration-bearing `turn/start`; nested model catalog work shares the same deadline. |
| Usage | `account/usage/read`. |
| Compact | `thread/compact/start` plus local matching item/turn terminal wait. |
| Skills | `skills/list`. |
| Approval | Exact app-server server-response write plus local matching approval/item terminal wait. |
| Interrupt | `turn/interrupt` plus local matching turn-terminal wait. |

Health, projected session/event reads, SSE delivery, resume metadata, pairing/access/device/lock, and remote-ingress routes do not issue Codex protocol requests. They retain the Fastify request owner and their existing task-specific cancellation/resource contracts; this task does not add fake protocol work to them.

## Frozen Outcome Model

| Boundary reached when deadline/abort wins | Required truth |
| --- | --- |
| Before a protocol send is invoked | No frame is submitted. Mutation outcome is `not_sent`; selected audit terminates as failed `operation_timeout`; no unknown latch or automatic retry is created. |
| After protocol send is invoked but before a validated response | Delivery is possible. Mutation outcome is `unknown`; selected audit terminates as incomplete `operation_timeout`; idempotency and service reconciliation state prevent unsafe redispatch. |
| Read request after possible send | The HTTP operation fails as 504 `operation_timeout`; the read remains retry-safe internally but HostDeck performs no automatic retry. A late response is retired and cannot complete the old HTTP request. |
| Client disconnect | The same request signal stops local queue/terminal waiting and protocol response waiting. No second response is attempted. Mutation send-state truth remains `not_sent` or `unknown`; disconnect never means Codex cancellation succeeded. |
| Matching late event after an incomplete mutation | Projection/control reconciliation may advance from authoritative event evidence. The old response and immutable accepted/incomplete audit history are not rewritten into client success. |
| Protocol rejection before either deadline | Existing stable rejection/conflict/protocol mappings remain unchanged; deadline handling must not collapse unrelated failures into timeout. |

## Harsh Success Criteria

### DLC-01 One Request Owner

- `createHostDeckFastifyApp` remains the only owner of the selected HTTP route timer and abort signal.
- Every request-facing route/service operation in the frozen matrix receives the exact `OperationDeadline` returned by `hostDeckRequestDeadline(request)`. Selected write callbacks use `context.deadline`; no route reconstructs a deadline from wall-clock time.
- Route, service, and protocol-client code creates no `AbortSignal.timeout`, replacement `AbortController`, or larger child deadline. Process lifecycle/reconnect owners remain separate and explicitly out of this request path.
- Invalid, disposed, expired, or contradictory deadline objects fail before protocol dispatch.

### DLC-02 Decreasing Protocol Budget

- One shared adapter helper derives the broker request signal and timeout at the final call boundary. `timeout_ms` is `min(deadline.remaining, operation_cap)`, is a positive safe integer, and never increases across sequential or paginated work.
- Thread, turn, model, goal, plan, usage, compact, and skills clients use the helper for every frozen protocol method. No request-path call falls back to a configured full timeout after time has elapsed.
- The broker accepts a valid 1 ms child remainder while production policy minima still constrain configured protocol caps. Zero/expired work rejects before allocating an id, pending entry, timer, listener, or transport send.
- Clock rollback, deadline disposal, and cap/contract mismatch fail loudly and do not become `runtime_unavailable`.

### DLC-03 Session And Multi-Step Ordering

- Start checks the deadline before and after local CWD/recovery/storage stages and before `thread/start`. A proven possible-send timeout keeps recoverable unknown state; a proven no-send timeout cannot claim a thread exists.
- Archive, goal mutation, model/Plan reads, and all paginated reads check the same deadline between stages. Expiry after an earlier read prevents every later mutation.
- Prompt with pending model/Plan settings passes one deadline through the nested service and exact `turn/start`; no nested control can reset time or dispatch a second turn.
- Exact-boundary success and one-millisecond-before-send expiry are both deterministic under a fake monotonic clock.

### DLC-04 Mutation Send Truth

- Broker and transport boundaries preserve `not_sent`, `remote_rejected`, and possible-send `unknown` without inference from elapsed time alone.
- Prompt/start/archive/model/goal/plan/compact/approval/interrupt route mappings produce failed `operation_timeout` only when no protocol mutation was submitted, and incomplete `operation_timeout` after possible send.
- Timeout, client abort, transport close, response loss, and simultaneous late response/event races cause no automatic retry, duplicate protocol request, duplicate terminal audit, or contradictory success body.
- Idempotency/admission ownership releases on proven no-send and retains the documented result/unknown guard after possible send.

### DLC-05 Read And Public Error Truth

- Model, goal, Plan, usage, skills, session lifecycle verification, and any other in-scope protocol read map broker timeout to HTTP 504 with the stable bounded `operation_timeout` envelope.
- A client-aborted socket receives no invented body; internal errors and observations retain only bounded method/stage/code data, never request bodies, prompts, goals, paths, cookies, headers, protocol frames, or raw errors.
- Runtime unavailable, overload, malformed protocol, stale target, incompatible capability, and storage failure keep their existing distinct status/code behavior when they win before timeout.

### DLC-06 Abortable Local Waits

- Per-target serialized request work rejects promptly when its deadline aborts before callback execution, never runs that callback later, and preserves ordering for already-running and subsequent work.
- Compact, approval, and interrupt terminal waiters remove their exact abort listener and waiter entry on terminal event, abort, timeout, service close, generation loss, and synchronous setup failure.
- Request abort does not cancel durable Codex work or claim a remote interrupt. Background projection/event observation remains independent and can reconcile later proof.
- Every timer, listener, pending broker request, server-response claim, waiter, and serialization reservation has one terminal cleanup path and idempotent repeated cleanup.

### DLC-07 Approval Server Responses

- User approval responses use the same HTTP deadline for the protocol server-response send and subsequent terminal wait.
- Background expiry denial remains bounded by the configured protocol mutation cap without borrowing an HTTP deadline or becoming unbounded.
- Abort before send restores pending approval only when `not_sent` is proven. Abort/timeout after possible send latches unknown, does not issue another decision, and can settle only from matching generation/item evidence.

### DLC-08 Late Response And Reconciliation

- The broker retires timed-out/aborted request ids, reports one bounded `late_response` issue, and never resolves an old promise or terminates the connection merely because a retired response arrives.
- Matching late normalized events may reconcile service/projection state according to existing operation contracts. Wrong target, generation, turn/item, duplicate, or contradictory events remain rejected or ignored by their owning contract.
- A late result cannot send a second HTTP response, replace an incomplete audit row with success, clear an unrelated unknown latch, or authorize retry.

### DLC-09 Structural And Aggregate Coverage

- A structural inventory binds every frozen route/service/protocol method to deadline-aware signatures and fails if selected code reintroduces signal-only/no-cancellation protocol calls or request-local timeout owners.
- Direct fake-clock/broker tests cover exact expiry, 1-49 ms remainder, pre-aborted signal, send failure, possible-send timeout, simultaneous response/abort, late response, close, and listener/timer/pending cleanup.
- Service tests cover each operation family, every multi-step expiry boundary, queued abort, terminal waiter cleanup, and error/outcome mapping.
- One real Fastify plus selected composition aggregate traverses loopback and admitted-remote requests into controlled services/broker transport and proves 504/read, failed no-send mutation, incomplete possible-send mutation, late event reconciliation, immutable audit, no duplicate dispatch, and zero retained owners.

### DLC-10 Validation And Residue

- Focused tests plus full unit, contract, integration, web, root/all-package typecheck, lint/exports, scaffold, planning, runtime-boundary, exact binding, frozen install, production audit/license, and diff checks pass.
- Manual inspection covers route/service/client signatures, request/protocol timing observations, bounded diagnostics, audit rows, dependency tree, listener/process/temp state, and selected-only production closure.
- No HostDeck listener, Codex test process/socket, timer-backed test worker, Tailscale Serve mutation, ADB process, or task temporary directory remains.
- The artifact records exact files, commands, counts, residual risks, commits, and push state. It makes no CLI-bound, aggregate-resource, packaging, UI, phone, or release-ready claim; those remain `IFC-V1-051`, `IFC-V1-052`, `IFC-V1-021`, frontend, and release work.

## Failure Conditions

- Any selected protocol-bearing route can omit the request deadline or pass only a signal.
- A later page, read-back, nested control, terminal wait, or protocol mutation receives a fresh/full timeout after earlier work consumed time.
- A no-send timeout creates unknown mutation state, or a possible-send timeout is reported as safely retryable failure/success.
- Protocol timeout appears as 503/runtime unavailable, generic unknown, or successful audit.
- Client abort leaves a queue callback, waiter, broker timer/listener, pending request, or second response alive.
- Tests prove only mocked service-local behavior and do not traverse the selected Fastify/broker boundary.

## Required Evidence

- Exact route/service/client/method inventory and structural enforcement.
- Fake-clock deadline derivation, broker send-state, queue/waiter cleanup, and late-response tests.
- Per-operation service matrices plus a real selected Fastify/broker/audit aggregate.
- Full workspace, clean install/supply chain, privacy/manual inspection, and zero-residue validation.
- Owning task, blueprint, test plan, block maturity, queue/status, and final artifact synchronized only where their facts change.
