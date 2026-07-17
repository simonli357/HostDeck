# IFC-V1-038 Projection, Health, Reconnect, And Shutdown Acceptance

Date: 2026-07-16
Status: criteria frozen; implementation in progress

## Objective

Accept the completed projection fanout, replay/live subscriber, mutable host-health, selected-runtime reconnect/reconciliation, and graceful application-shutdown leaves as one bounded lifecycle. The aggregate must preserve durable-before-publication truth, exact stream continuity or an explicit boundary, fail-closed mutation readiness, independent remote degradation, honest pending outcomes, and complete cleanup.

Requirement refs: `FR-005`, `FR-013`, `FR-014`, `FR-018`, `NFR-002`, `NFR-010`, `NFR-011`, `PR-007`, `SFR-017`.

## Ownership Audit

- Production projection append and continuity ports already commit SQLite state before publishing to the fanout. The replay/live handoff and subscriber service already enforce high-water continuity, retained-memory limits, slow-reader isolation, and terminal cleanup.
- The reconnect controller already closes request admission synchronously, runs once-per-generation durable reconciliation, repeats compatibility, resubscribes, and reopens only after the ready barrier. The reconciliation lifecycle already persists disconnected/restart boundaries and runtime-ready events.
- Host health already separates seven local components from remote availability and invalidates generation-bound mutation proofs on any accepted local transition. It does not own reconnect callbacks or observation scheduling.
- Application shutdown already composes write drain, subscribers, approvals, reconnect, barriers, runtime ownership, storage, and lease under deadlines. Its real test uses a generic finite SSE source and a no-op reconnect lifecycle, so it does not substitute for projection/recovery acceptance.
- No existing test composes host health, the actual reconnect controller and reconciliation lifecycle, production projection publication, replay/live subscribers, and shutdown truth. This leaf owns that aggregate evidence, not a new production orchestrator.

## Frozen Aggregate Scenarios

### Deterministic Recovery Scenario

Use a migrated SQLite database and the actual selected-state repository, production append/continuity ports, projection fanout, replay/live handoff, bounded subscriber service, host-health service, reconnect controller, and runtime reconciliation lifecycle.

1. Initialize storage, compatibility, projector, fanout, listener, and lease health as ready while runtime remains unknown; initialize remote health as ready.
2. Open healthy and intentionally stalled projection subscribers before initial runtime admission.
3. Start generation one. Durable reconciliation must commit a restart boundary and runtime-ready event before fanout publication. The healthy subscriber receives the exact ordered sequence and local mutation admission opens only after the runtime-ready barrier.
4. Degrade remote ingress. Local readiness, the admitted mutation proof, runtime requests, and projection delivery remain unchanged.
5. Crash generation one while holding generation-two reconciliation. Request admission closes synchronously; disconnected durable truth publishes; runtime health becomes non-ready; the prior mutation proof rejects; no mutation is replayed.
6. Release reconciliation. Generation two must re-run compatibility, persist one disconnect boundary, resubscribe, publish runtime-ready truth, and reopen local mutation admission. The healthy subscriber receives one contiguous cursor sequence containing explicit boundaries; the stalled subscriber alone may overflow and release all retained accounting.
7. Exercise paired-authority abort, independent request disconnect, and session archive against admitted replacement streams. Unrelated streams remain valid until their owning terminal condition.
8. Close the subscriber service, fanout, reconnect controller, SQLite database, and temporary root. All active buckets, retained counters, subscriptions, pending requests, listeners, timers, and owned resources reach zero.

### Bounded Real Shutdown Scenario

Run the real loopback Fastify lifecycle with migrated SQLite, daemon lease, selected write admission/audit, actual reconnect controller, active SSE response, and one sent mutation. Application close must refuse new work, settle SSE, close reconnect without replay, preserve one accepted-to-incomplete audit trail, finish all ten shutdown stages, close SQLite, release/reacquire the lease and listener port, and leave no process/socket/timer/temp residue.

## Hard Success Criteria

| Boundary | Required proof |
| --- | --- |
| Commit before publish | Every observed boundary/runtime event already exists in the selected repository with matching cursor, projection revision, and retained-window state when fanout delivery runs. Forced rollback publishes nothing. |
| Initial high-water | Subscribers opened before and after generation-one reconciliation converge on the same exact ordered durable sequence without a gap or duplicate. Replay counters release as events are consumed. |
| Runtime crash | Controller request admission closes before asynchronous cleanup. Disconnected projection and health truth become visible before generation-two admission; sent mutations remain unknown/incomplete and are never replayed. |
| Recovery boundary | Repeated compatibility, durable reconciliation, boundary replacement, resubscription, held-event drain, runtime-ready publication, and health recovery complete for the same generation before requests reopen. |
| Health independence | Remote ready-to-unavailable-to-ready changes never modify local generation/readiness or invalidate a current local proof. Runtime failure/recovery does invalidate the old proof and requires a new one. |
| Slow-reader isolation | Stalled queue overflow closes only that stream. Healthy same-session delivery remains exact, fanout remains healthy, released capacity is reusable, and retained counters return to zero. |
| Revoke/disconnect/archive | Shared paired-authority abort closes all streams using that signal, request abort closes only that request, and archive closes only that session. Every path releases source, queue, listener, bucket, and handoff ownership once. |
| Shutdown truth | New mutations reject after drain begins; active SSE closes within the selected bound; reconnect sends no retry; accepted-only audit truth becomes incomplete; all later stages run and lease/listener reuse succeeds. |
| Failure containment | Any aggregate assertion failure identifies only stage/code/count/cursor facts. No prompt/event body, token, cookie, device/session/thread id, profile key, path, PID, socket identity, or raw cause enters aggregate evidence. |
| Cleanup | Final snapshots and active-handle inspection show zero subscribers, retained events/bytes, fanout registrations, controller requests/timers, listeners, ADB daemon, test process, and test-created temporary root. |

## Validation Plan

- Add one deterministic aggregate acceptance test that wires the actual modules and controls the reconnect race with a bounded scripted transport and gate.
- Keep the real listener/shutdown scenario independently bounded and include it in the fixed focused aggregate command.
- Run adjacent fanout, handoff, subscriber, health, reconciliation, reconnect, and shutdown tests; all workspace suites; root/package typechecks; lint/exports; scaffold/planning/runtime-boundary; exact Codex 0.144.0 binding; frozen install; production audit/license inventory; and final diff/privacy/process/listener/temp inspection.
- Record exact scenario, assertion, suite, resource, cleanup, commit, and push evidence here before closure.

## Explicit Non-Goals

- No production bootstrap, route-family assembly, health/status route, static build, executable signal owner, package, service unit, or release claim is added.
- No Tailscale command, poller, profile switch, Serve mutation, physical-phone run, browser retry policy, or frontend behavior is added. `IFC-V1-078` and `IFC-V1-079` retain remote lifecycle and physical acceptance ownership.
- This aggregate does not duplicate every hostile leaf case. It proves that the accepted leaf contracts compose without weakening their ordering, bounds, failure truth, or cleanup.
