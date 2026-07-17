# IFC-V1-035 Bounded Subscriber Queues

Date: 2026-07-16
Status: hard criteria frozen; implementation not yet complete

## Selected Boundary

- Add one headless subscriber-stream service around the completed replay-to-live handoff. It owns sustained live queues, global/per-device/per-session admission, stream lifecycle, and aggregate subscriber inspection.
- Keep immutable durable replay under the existing replay event/byte limits. Only committed events accepted after the captured high-water count against the sustained queue event/byte limits; replay and live memory are never silently charged to the wrong budget.
- Register the exact selected `GET /api/v1/sessions/:session_id/events/stream` manifest route through the existing Readable-only Fastify SSE transport. The route derives paired-device identity from the authenticated request context; callers cannot supply a device bucket.
- Add one branded source-lifecycle signal to the SSE transport. Queue overflow, archive, source failure, service close, or explicit unsubscribe can therefore destroy an already-backpressured Readable/socket instead of waiting indefinitely for another iterator pull.
- Keep publisher delivery synchronous and wait-free. A fanout callback may only validate and enqueue, satisfy one pending reader, or close that subscriber; it never awaits socket progress and never throws or returns a thenable/non-void value into the shared fanout hub.
- Add no queue-owned timers. Fastify owns heartbeat timing and bounded iterator cleanup; this service owns only abort listeners, queue storage, admission counters, the handoff token, and its source-lifecycle controller.

## Hard Success Criteria

| Boundary | Required proof |
| --- | --- |
| Exact construction | Service, route, open input, source lifecycle, and observer inputs reject missing/extra/accessor/prototype-invalid fields before admission, authorization, fanout, or storage work. The selected resource budget is the only limit source. |
| Selected route | The registration matches the one frozen manifest row exactly: method, versioned path, SSE transport, session params, cursor query, read authority, no CSRF/lock/audit, handler, and owner task. Authentication failures retain their stable HTTP status instead of becoming generic source-open 500 responses. |
| Identity ownership | Only the route derives a paired `device_id` from the frozen authenticated context. Local loopback readers have no invented device identity and remain bounded by global and session caps. Device identifiers never enter errors, observations, snapshots, or artifacts. |
| Admission | Reserve one unique subscriber atomically before handoff open. Reject duplicate id, closed service, global cap, per-device cap, and per-session cap with bounded codes. Every failed open releases exactly the reservation it acquired; unrelated subscribers remain active. |
| No-gap composition | Open the existing register-before-high-water handoff, expose its immutable replay first, then activate its synchronous sink before returning the stream. Events before/during/after activation appear once in increasing cursor order with no replay/live gap or duplicate. |
| Queue bounds | Every live event is schema-valid and charged by the shared exact SSE framed UTF-8 byte function. Exact event and byte boundaries pass; the first event over either cap fails that subscriber, clears retained events/bytes, and records a bounded `queue_overflow` reason without dropping and continuing. |
| Backpressure isolation | A stalled iterator/socket can fill only its own bounded queue. Overflow actively terminates that source and handoff without awaiting the reader. The publisher and a healthy peer complete synchronously and receive later events. |
| Iterator contract | One stream supports one sequential consumer, at most one unresolved `next`, idempotent `return`, and explicit `throw`. Concurrent iteration fails closed. Natural replay/live reads do not alter admission counts; terminal paths settle a pending reader exactly once. |
| Disconnect and revoke | The unchanged request-plus-device-authority signal closes opening or active streams. Queue storage, abort listener, source controller, registry slot, and handoff token release once even when transport later calls iterator cleanup. Another device remains active. |
| Archive | One explicit post-commit session-archive invalidation closes all active/opening subscribers for only that session with bounded `session_archived` diagnostics. A later open still revalidates durable archived state and cannot rely on an unbounded archive cache. |
| Source and service failure | Iterator `throw`, handoff/open failure, source-owned termination, and aggregate service close clear every owned resource without exposing private causes. Repeated or concurrent terminal calls are deterministic and do not underflow counters. |
| Active socket closure | A real paused HTTP client proves source-owned overflow/termination closes the Readable/response and settles the Fastify handler without requiring client disconnect or a later iterator pull. Direct `AsyncIterable` plugin sends remain absent. |
| Inspection | Frozen snapshots expose only bounded counts, queue totals/high-water marks, rejection/closure counters, and service state. No event content, authorization object, request/cookie/CSRF value, device id, private error, or foreign session id is retained in observations. |

## Failure Policy

| Condition | Public/internal action |
| --- | --- |
| Admission exhausted | Reject source open as `503 service_overloaded`; no handoff or queue remains. |
| Missing session | Reject source open as `404 session_not_found`. |
| Archived/stale or future cursor | Reject source open as `409 stale_session`; future cursor identifies only the `after` field. |
| Authorization rejection | Preserve the existing bounded authentication/permission HTTP error. |
| Storage, fanout, or contradictory replay state | Reject source open as bounded internal/storage unavailability; retain no underlying cause in the response. |
| Live queue overflow | Close only that subscriber, actively terminate transport, and emit one bounded internal `queue_overflow` observation where possible. Do not enqueue a fabricated projection event or silently discard committed data. |
| Disconnect/revoke/explicit return | Close normally and idempotently; do not report overflow or source failure. |
| Archive/source failure/service close | Terminate affected streams with bounded internal reason and no automatic reconnect/retry. Client reconnect policy remains downstream. |

## Validation Plan

- Direct deterministic service tests for exact input, admission boundaries, replay/live ordering, event/byte limits, pending-reader settlement, repeated cleanup, archive isolation, source failure, shutdown, diagnostics, and privacy.
- Multi-client tests with one stalled subscriber and one healthy peer, publisher duration/call-count assertions, per-device and per-session boundaries, revoke/disconnect signals, and zero residual handoff/queue/registry counts.
- Fastify injection tests for the exact selected route, stable auth/session/cursor/admission failures, framing, and finite cleanup.
- Real listener paused-client tests proving source-owned termination closes active backpressure and leaves zero in-flight request/subscriber state.
- Focused adjacent handoff/fanout/SSE/revoke tests, full workspace suites, root/package typechecks, lint, scaffold/planning/binding/install/audit/license/diff/privacy review, and a completion artifact update before closure.

## Explicit Non-Goals

- `IFC-V1-037` owns deadline-bounded whole-application shutdown ordering across HTTP, SSE, runtime, storage, and lease.
- `IFC-V1-038` owns the aggregate projection/recovery/shutdown acceptance matrix.
- `IFC-V1-048` owns reconnect-storm and aggregate resource stress enforcement over this bounded implementation.
- `IFC-V1-046` owns full selected production route assembly; this leaf owns and directly proves only its exact stream registration and source composition.
- Frontend reconnect/offline UX and physical-phone acceptance remain downstream UI/remote tasks.
