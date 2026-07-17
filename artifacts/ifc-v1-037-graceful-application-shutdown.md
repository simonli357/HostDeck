# IFC-V1-037 Graceful Application Shutdown

Date: 2026-07-16
Status: criteria frozen; implementation in progress

## Objective

Implement one headless, deadline-bounded shutdown owner that composes the existing Fastify lifecycle, selected-write admission, subscriber service, approval service, reconnect controller, audit and projection barriers, runtime supervisor, storage, and daemon lease without inventing completion truth or skipping cleanup after failure.

Requirement refs: `FR-018`, `NFR-002`, `NFR-010`, `SFR-016`, `SFR-017`.

## Ownership Audit

- `startHostDeckFastifyLifecycle` already owns listener refusal, bounded SSE settlement, active-socket grace/force, Fastify close, idempotent full close, and aggregate cleanup errors. It does not have a pre-listener mutation-drain callback or a runtime-close phase before active-request settlement.
- `createHostDeckSelectedWriteAdmissionPolicy` owns every selected write owner/replay and active-owner count, but it cannot close admission or await zero active owners.
- Closing the reconnect controller revokes runtime admission, cancels reconnect work, closes the protocol connection, and rejects sent mutations as unknown. Existing selected-write services and the audit executor preserve those outcomes as `incomplete`; they do not retry.
- The Codex event pipeline has a stable barrier; the projection subscriber service synchronously terminates and releases every subscriber; the approval service synchronously supersedes pending approvals; and the runtime supervisor already distinguishes foreground-child ownership from service-owned sibling non-ownership.
- SQLite writes are immediate and synchronous, but durable accepted-only audit truth still needs an explicit zero-pending barrier before database close. Startup orphan reconciliation remains the append-only mechanism for any accepted operation that cannot be proven terminal.
- HostDeck observes but does not own `tailscaled`. Shutdown must not switch profiles, remove unrelated Serve state, sign out, or stop the daemon. Remote-operation draining is supplied through the aggregate write port by later production composition.

## Frozen Close Order

1. Synchronously enter `draining`, close all mutation admission, and publish listener-draining health before listener refusal begins.
2. Begin listener refusal so no new TCP connection or keep-alive request is accepted.
3. Close all projection subscribers under the SSE shutdown bound.
4. Supersede pending approval waiters, cancel reconnect/backoff, and close the Codex protocol connection under the protocol-close bound. Sent mutations become unknown, never replayed.
5. Await the aggregate write barrier. Success requires zero active operation owners; accepted operations must have a terminal `succeeded`, `failed`, or `incomplete` result.
6. Run the durable audit barrier. It may append only `incomplete` for accepted-only truth; success requires zero pending accepted operations.
7. Run the projection barrier after runtime ingress is closed; success requires zero pending notifications and one stable last sequence.
8. Close the runtime supervisor by ownership: terminate and clean a foreground child, but leave a service-owned sibling app-server alive.
9. Settle active HTTP requests, force only still-owned sockets at the outer deadline, and close Fastify.
10. Close storage, then release the daemon lease last.

The Fastify lifecycle owns steps 1 to 3 and 9 around the injected application shutdown owner. The application owner owns steps 4 to 8 and 10. `IFC-V1-046` and `IFC-V1-078` later provide the production composition; they may adapt concrete services to these ports but may not reorder or weaken them.

## Hard Success Criteria

| Boundary | Required proof |
| --- | --- |
| Drain atomicity | Lifecycle phase changes to `draining` and the injected synchronous drain callback runs before listener refusal. A request racing after that point cannot claim a new mutation owner, including a duplicate replay request. Existing owners may only settle or be reported by the bounded drain failure. |
| Admission owner | The selected-write policy has exact `open`, `draining`, and `closed` phases. `beginDrain` is idempotent; `drain` resolves only at zero active owners; concurrent waiters settle once; aborted waiters detach without reopening admission or abandoning an owner. |
| Runtime cancellation | Approval close precedes reconnect close. Reconnect/backoff and pending protocol requests are canceled once. A sent mutation rejected during close produces durable incomplete truth; no automatic request, mutation, approval response, or reconnect is issued. |
| Barrier truth | Write, audit, and projection callbacks return exact frozen acknowledgements. Nonzero active writes, nonzero accepted-only audits, nonzero pending projection events, malformed/accessor/extra-key results, or callback throw are stage failures, never successful flushes. |
| Runtime ownership | Foreground supervisor close may terminate only its verified child and socket. Service mode releases process-local ownership but does not stop the sibling app-server. HostDeck never stops or mutates Tailscale during shutdown. |
| Deadline hierarchy | One outer lifecycle deadline bounds the full close. SSE and protocol close use their dedicated caps; every other component uses the cleanup-step cap and parent signal. Timeout or abort is attributed to its exact stage, and a noncooperative promise cannot hold the lifecycle open. |
| Failure continuation | Drain, subscriber, approval, reconnect, write, audit, projection, supervisor, listener/app, storage, and lease failures are retained as bounded stage errors. Every later stage is still attempted in order; lease release is attempted even when storage close fails. |
| Idempotence | Repeated and concurrent full lifecycle close returns the same promise. Each application stage invokes its owned callback at most once and reuses its settled promise/result; there is no retry after throw, timeout, malformed acknowledgement, or late settlement. |
| Inspection | Frozen snapshots expose phase, exact stage state, completion/failure counts, and aggregate active/pending counts only. No operation id, session/thread/turn/request id, audit target, profile, path, PID, socket, raw error, credential, or payload is retained. |
| Real resources | A real listener with an active selected mutation and SSE client closes within budget, records honest incomplete outcome when protocol delivery is unknown, drains subscribers/requests, closes SQLite, releases and reacquires the lease, and leaves no listener, socket, timer, process, or temporary root. Service-owned runtime evidence leaves the sibling alive. |

## Failure Policy

- First close invocation fixes ownership and ordering. Later invocations observe the same operation; they cannot supply replacement ports, deadlines, or retries.
- A stage timeout records failure and proceeds. The controller observes any late fulfillment/rejection only to prevent an unhandled rejection; late completion cannot change the already-published stage result or authorize an earlier resource to reopen.
- If reconnect close fails, write, audit, projection, supervisor, storage, and lease cleanup still run. If write drain fails, the audit barrier still attempts append-only incompletion and projection still flushes.
- An audit barrier can claim success only when its final authoritative scan reports zero accepted-only operations. Partial/batch-limited/unknown reconciliation is a shutdown failure and storage still closes.
- Projection failure cannot be hidden by closing fanout or storage. Storage or lease failure leaves the overall lifecycle failed even if all earlier work passed.
- Public HTTP behavior remains bounded existing error envelopes. Aggregate causes are internal only and snapshots/artifacts retain stage names, not private causes.

## Validation Plan

- Admission-policy matrix: exact input, open/draining/closed transitions, new-owner/replay rejection, zero-owner immediate close, owner completion/failure/abandon, concurrent drains, waiter abort/detach, clock/contract failure, counters, and no listener/storage side effect.
- Controller matrix: exact ports and acknowledgements, frozen snapshots, complete order, every single-stage throw/timeout/malformed result, multiple failures, late settlement, parent abort, repeated/concurrent calls, counter saturation, and privacy inspection.
- Fastify matrix: drain callback before listener refusal, active finite/noncooperative request, active SSE, runtime close before app close, storage/lease after app, startup-failure cleanup, same-port/lease restart, and aggregate errors with all later callbacks observed.
- Real integration: SQLite selected audit accepted-to-incomplete, projection barrier, reconnect pending request cancellation, foreground and service-owned supervisor behavior, active real HTTP/SSE, storage close, lease reacquisition, and residue inspection.
- Focused and adjacent tests, all workspace suites, root/package typechecks, lint/exports, scaffold/planning/runtime-boundary, exact Codex 0.144.0 binding, frozen install, production audit/license inventory, diff/privacy/process/temp inspection, commit, and push.

## Explicit Non-Goals

- No production route assembly, health/status route, static build, package/service unit, Tailscale polling or mutation, frontend behavior, or phone acceptance is added here.
- No process-wide signal handler or executable entrypoint is selected here; installed service and CLI lifecycle ownership remain downstream.
- No accepted operation is retried, rolled back, relabeled successful, or inferred failed solely because shutdown began.
- No foreground child is preserved, and no service-owned sibling or `tailscaled` process is terminated.
