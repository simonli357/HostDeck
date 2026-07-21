# IFC-V1-052 Production Resource Stress Aggregate

Date: 2026-07-20

## Hardening Target

- Owning block: `BLK-V1-04`.
- Requirements: `NFR-010`, `NFR-011`, `SFR-005`, `SFR-013`, and `SFR-017`.
- Accepted inputs: the exact 84-field resource/deadline contract from `IFC-V1-020`; selected HTTP/lifecycle enforcement from `IFC-V1-047`; selected SSE accounting/backpressure from `IFC-V1-048`; selected write idempotency/concurrency from `IFC-V1-049`; end-to-end protocol deadlines from `IFC-V1-050`; bounded source CLI transport from `IFC-V1-051`; exact 22-registration/35-route selected composition and selected-only closure from `IFC-V1-046` and `IFC-V1-067`.
- Target state: one deterministic, real-loopback aggregate shares one coherent reduced resource budget across the selected Fastify lifecycle, complete selected route composition, projection subscriber service, write admission, controlled Codex connection/broker, SQLite audit, and source CLI transport. Concurrent slow, oversized, duplicate, conflicting, timed-out, aborted, response-loss, and shutdown cases remain within every owner limit and preserve one truthful response/audit/projection outcome.

## Baseline Audit

| Boundary | Proven independently | Aggregate gap |
| --- | --- | --- |
| Policy | `IFC-V1-020` rejects invalid values and contradictory fields and maps all selected owners. | No test proves that one resolved reduced budget is the only policy consumed by all HTTP/SSE/admission/protocol/CLI owners in one assembled run. |
| HTTP/lifecycle | `IFC-V1-047` proves real parser, socket, request, deadline, shutdown, and same-port behavior through dedicated probe routes. | It does not use the exact selected 22-registration composition, source CLI, selected audit, protocol broker, or simultaneous SSE/mutation pressure. |
| SSE | `IFC-V1-048` proves replay/live accounting, admission, burst isolation, heartbeat backpressure, revoke, and shutdown. | Its stress matrix is not concurrent with selected mutation, protocol, HTTP, and CLI saturation through the selected composition. |
| Write admission | `IFC-V1-049` proves shared cross-route idempotency, actor/target/global capacity, response loss, and durable audit. | Its real listener has two routes and does not contend with SSE, protocol deadlines, HTTP capacity, or CLI capacity. |
| Deadline/protocol | `IFC-V1-050` proves all protocol-bearing paths structurally and selected Fastify/broker/audit timeout outcomes. | Its aggregate uses focused registrations and injection; it does not prove real socket/CLI pressure, subscriber contention, or lifecycle shutdown at the same time. |
| CLI | `IFC-V1-051` proves strict direct-loopback transport, process-global capacity, bytes, parsing, failure truth, and cleanup against hostile real HTTP servers. | It does not call an assembled selected Fastify lifecycle while server, SSE, write-admission, and protocol limits are already occupied. |
| Observability | Each owner exposes bounded count-only snapshots or direct pending counts; individual tests inspect active resources. | No aggregate captures synchronized owner snapshots, exact peaks/rejections, audit rows, protocol frames, durations, and final process resources without adding a second resource owner. |

The accepted leaves contain no known production-behavior defect at criteria freeze. The missing evidence is cross-owner composition and contention. Any defect exposed by that aggregate must be fixed at its owning boundary rather than hidden in the test harness.

## Frozen Aggregate Topology

1. Resolve one strict `ResourceBudget` once. Pass that exact frozen object to the Fastify lifecycle, selected route composition dependencies, projection subscriber service, selected write admission policy, protocol option mapping, and one source-CLI transport. No aggregate component may construct a private default or larger budget.
2. Start `startHostDeckFastifyLifecycle` on `127.0.0.1` and an ephemeral unprivileged port. Register the exact output of `createHostDeckSelectedApiRouteComposition`; assert 22 registrations and the canonical 35 method/path rows before traffic.
3. Back selected write routes with a real migrated temporary SQLite database and selected audit repository/executor. Use selected session/runtime contracts and the production write gate; no fake success audit or in-memory replacement is accepted.
4. Back at least one selected protocol read and one selected mutation with `createCodexAppServerConnection` plus a bounded controlled `ScriptedCodexTransport`. Handshake is real through the connection/broker; target responses may be delayed, rejected, lost, or delivered late deterministically. No live model call is required.
5. Back the selected event-stream route with `createProjectionSubscriberStreamService` and the production replay/live handoff contract. Test control may publish only valid bounded selected projection events through the accepted source port.
6. Call the listener through actual selected source clients using one shared `createBoundedLoopbackFetch`. Raw Node sockets are allowed only for parser-level slow/partial/stalled cases the JSON client cannot represent.
7. Teardown uses the lifecycle's real close path. It begins write drain, closes subscriber ownership, closes the controlled protocol connection, closes SQLite after application/listener ownership, and verifies immediate same-port restart. Every test-owned socket/server/controller/database/temp root still has an explicit independent fallback cleanup.

## Frozen Stress Budget

The aggregate uses reviewed minima or small coherent values so exact saturation is deterministic without changing production defaults.

| Boundary | Aggregate values |
| --- | --- |
| HTTP | 4 KiB body and headers, 16 headers, 256-byte URL, 64-byte parameter; 1 s header/receive, 2.5 s handler, 5 s idle, 1 s keep-alive; 6 connections, 4 in-flight requests, 8 requests/socket. |
| SSE | 1 s heartbeat; 2 global, 1/device, 1/session subscribers; 8 events/64 KiB live queue; 1 KiB event; 8 events/64 KiB replay; 100 ms disconnect and 200 ms shutdown cleanup. |
| Mutation admission | 1 s fixed window, 100 attempts/actor, 2/actor, 1/target, and 2 global in flight; 64 tracked keys and 60 s terminal retention. |
| Protocol | 1 s read/mutation/start and handshake, 500 ms connect, 100 ms close, 2 in-flight broker requests; frame/buffer limits remain valid and bounded by the resolved policy. |
| Lifecycle | 1 s shutdown and 100 ms cleanup step. |
| CLI | 500 ms connect, 3 s whole request, 4 KiB request, 64 KiB response, 5 s response idle, and 2 process-global requests. |

The test must assert the resolved profile before startup. If a future policy invariant makes these values invalid, criteria and evidence must be reviewed; the test may not silently fall back to defaults.

## Harsh Success Criteria

### RAG-01 Exact Selected Graph And One Budget

- A structural assertion proves the aggregate lifecycle registers exactly 22 selected registration owners and all 35 canonical manifest method/path rows, with no probe, legacy, LAN, TLS, raw, tmux, or test-only route.
- The same resolved budget identity is observed at lifecycle startup and explicitly supplied to app, subscribers, admission, protocol mapping, and CLI transport. Source inspection rejects a second `resolveResourceBudget`, `defaultResourceBudget`, or owner-local higher fallback inside the aggregate path.
- Selected production code remains the owner of parsing, authentication, write ordering, SSE streaming, deadlines, errors, and cleanup. The harness supplies ports and controlled external outcomes only; it does not duplicate those policies.
- Full graph construction, invalid graph/budget setup, listener bind, and ready failure leave no listener, policy owner, broker connection, database handle, or temp resource.

### RAG-02 Concurrent Admission And Precedence

- One synchronized phase holds an admitted SSE stream, a selected protocol read, and a selected mutation while using the exact four-request HTTP budget. The next HTTP request receives one stable 503 before its route/service/protocol/audit side effect; the in-flight count never exceeds four.
- With two shared CLI requests active, a third source-client operation fails locally as `service_overloaded` before socket allocation. Releasing one request makes capacity immediately reusable; no automatic retry occurs.
- Mutation per-actor, exact-target, and global caps are exercised while unrelated read and stream work remain healthy. A target/global loser receives stable 503 before accepted audit or protocol dispatch and can succeed only through a later explicit operation after capacity releases.
- When CLI and HTTP capacity could both reject, the boundary reached first owns the result. Tests assert request, handler, protocol-frame, dispatch, audit, and rejection counters so a lower-layer rejection cannot be mislabeled as an upper-layer one.

### RAG-03 HTTP Bytes, Slow Input, And Isolation

- Exact HTTP/CLI request and response byte limits pass. One byte over at the CLI rejects before a socket; one byte over at the selected Fastify body boundary returns 413 without service/audit/protocol work; an over-limit selected response is destroyed and never rendered.
- A partial raw upload reaches the selected listener, occupies at most one HTTP connection/request owner, and releases on client abort or receive timeout. Other admitted CLI read and SSE work remains responsive within its own deadline.
- Parser-level header/slow-input outcomes stay bounded native responses where the route was never reached; app-level body/in-flight outcomes retain stable HostDeck envelopes. No aggregate assertion invents a HostDeck request id or audit row for a parser rejection.
- Request, socket, handler, and CLI counters return to the expected concurrent baseline after each individual failure rather than only after final process teardown.

### RAG-04 SSE Contention And Failure Isolation

- Global/device/session subscriber caps remain exact while HTTP and mutation work is active. Rejected stream attempts perform no replay-source open and retain no subscriber/device/session/authority/abort ownership.
- One stalled subscriber can retain no more than its exact replay-plus-live event/byte ceiling. Queue overflow closes only that subscriber once; a healthy subscriber on another session or authority receives an exact contiguous sequence and unrelated selected requests continue.
- Heartbeat backpressure remains one blocked write/listener maximum. No heartbeat tick, replay reconnect, or overflow creates unbounded timers/listeners or consumes a write-admission/protocol slot.
- Abort, archive, authority loss, source failure, and lifecycle close each return current replay/live/retained totals and active subscriber/device/session buckets to zero while preserving truthful monotonic peaks/rejection counters.

### RAG-05 Idempotency, Protocol, Response Loss, And Audit Truth

- Two same-intent requests for one selected mutation join/replay one owner, accepted audit, protocol frame, and terminal outcome. A conflicting payload or cross-route reuse rejects before dispatch; a same-target contender respects the exact target cap.
- A protocol timeout proven before submission records failed `operation_timeout`; a possible-send timeout or response loss records incomplete `operation_timeout`. Neither path retries, emits a success response, duplicates terminal audit, or releases an unknown mutation for redispatch.
- Destroying the client socket after accepted audit cannot cancel proven remote work or erase retained idempotency truth. A same-intent retry within retention returns the retained result/failure without another protocol frame or accepted audit.
- A late protocol response is retired. Only matching authoritative projection events may reconcile service/projection state; the original HTTP/CLI result and immutable accepted/incomplete audit remain unchanged.
- SQLite rows, public errors, source-client failures, owner snapshots, protocol issue summaries, and test diagnostics contain no prompt, goal, token, cookie, CSRF value, device/session/thread/operation identity, path, protocol frame, raw cause, or response body beyond explicitly asserted bounded fixture fields.

### RAG-06 Deadlines, Abort, And Noncooperation

- The exact Fastify request deadline reaches selected services and final broker calls unchanged. Child timeout values never increase while requests wait behind HTTP, admission, serialization, or protocol pressure.
- Client abort removes the CLI/socket listener and server request owner, aborts local queue/wait work, and preserves protocol send-state truth. It creates no second response, late callback, or automatic request.
- A noncooperative route/service that outlives its 504 retains its HTTP/admission capacity until actual settlement. The aggregate proves no false free slot and then exact release when the controlled owner settles.
- Whole-request, response-idle, handler, receive, protocol, subscriber-cleanup, and shutdown deadlines remain distinct; resetting activity at one boundary cannot extend another owner.

### RAG-07 Drain, Shutdown, And Restart

- Lifecycle close synchronously starts write drain before listener refusal, rejects new mutation owners, and settles/aborts replay waiters without releasing possibly running owners early.
- Active SSE, partial upload, idle connection, pending read, and possible-send mutation are each present across the shutdown matrix. Listener refusal, subscriber close, protocol cleanup, app close, database close, and final owner cleanup occur in the accepted order under one outer deadline; later cleanup still runs after an injected stage failure.
- A shutdown-interrupted possible-send mutation remains incomplete and non-retryable by inference; a no-send queued mutation fails without accepted audit. Shutdown never rewrites either outcome to success.
- Final lifecycle, Fastify, subscriber, admission, broker, authority, and audit snapshots have zero current owners. The listener is closed, the same port restarts immediately with the same budget, and one bounded selected read succeeds after restart.

### RAG-08 Repeatability, Counters, And Resource Residue

- Run the complete contention cycle repeatedly and at least one concurrent batch. Current counters return to baseline after every cycle; peak/rejection/timeout/abort/overflow/replay counters are monotonic, exact, safe integers, and frozen.
- The artifact records scenario counts, maximum observed owner counts, durations, rejection families, protocol frames, audit phase counts, SQLite row counts, and cleanup results without recording private payloads or identities.
- Before/after process resource inspection shows no task-owned `TCPSocketWrap`, HTTP parser/request, `Timeout`, signal/process listener, database, test server, or temporary-root growth after explicit settle and garbage-independent cleanup. Runner-owned resources are identified by type and compared, not closed by the task.
- Tests use bounded polling and explicit deadlines. They contain no unbounded promise, wall-clock sleep as correctness proof, retry-on-failure loop, skipped stress row, or environment-dependent port/profile/phone requirement.

### RAG-09 Failure Injection And Privacy

- Inject source open failure, protocol malformed/late response, audit terminal failure, observer failure, client disconnect, and cleanup throw at least once across direct or aggregate rows. Every later owner still receives cleanup and the first truthful public outcome is not overwritten.
- Impossible counter underflow, duplicate settle/close, budget drift, route inventory drift, or malformed snapshot fails loudly. The aggregate cannot clamp, ignore, or replace a broken owner with a test fallback.
- Internal observers and lifecycle failures are bounded and redacted. No private sentinel may appear in stdout/stderr, error envelopes, snapshots, raw audit JSON, test names, artifact text, or committed fixture data.
- The task creates no dependency, route, API schema, Tailscale mutation, remote profile change, credential, listener mode, retry policy, or UI behavior.

### RAG-10 Validation And Scope Truth

- Focused aggregate plus directly affected HTTP/SSE/admission/deadline/CLI tests pass, followed by full unit, contract, integration, web, root/all-package typecheck, lint/exports, scaffold, planning, runtime-boundary, exact isolated Codex 0.144.0 binding, frozen offline install, production audit/license, privacy, diff, and residue gates.
- Manual inspection covers selected graph/budget identity, request and cleanup order, exact counter arithmetic, response/audit/projection consistency, failure precedence, no retry/fallback, and source/package dependency boundaries.
- Evidence records exact commands, counts, durations, changed files, dependency/lockfile truth, residual risks, commits, and push state. Owner docs change only where validation strategy, task state, block maturity, queue, or handoff truth changes.
- This leaf does not claim compiled output, runnable packaged `codexdeck`, built dashboard assets, user services, clean install, physical phone workflow, module completion, or release readiness. Those remain `IFC-V1-021`, `IFC-V1-053` to `IFC-V1-058`, `IFC-V1-091`, frontend, and release owners.

## Required Evidence

- Exact full selected graph plus one-budget structural assertion.
- Real-loopback selected lifecycle/source-CLI stress with synchronized HTTP/SSE/admission/protocol pressure and exact boundary precedence.
- Real SQLite idempotency/response-loss/audit proof plus late response/event reconciliation.
- Active-work shutdown, same-port restart, repeated-cycle counters, privacy inspection, and zero task-owned residue.
- Full repository/static/install/supply-chain validation and clean commit/push state.

## Explicit Non-Goals

- No live model call, physical phone, Tailscale profile/Serve mutation, browser UI, public/LAN/TLS/custom-CA listener, source-package startup binary, service install, or release claim.
- No new resource registry, aggregate production diagnostics endpoint, retry loop, fairness scheduler, alternate transport, fake-success fallback, or private-data logging.
- No duplication of leaf-level exhaustive matrices. The aggregate selects representative failures that prove cross-owner composition while the accepted leaves retain exhaustive boundary ownership.
