# IFC-V1-035 Bounded Subscriber Queues

Date: 2026-07-16
Status: complete

## Outcome

- `createProjectionSubscriberStreamService` is the headless owner for sustained live queues, global/per-device/per-session admission, stream lifecycle, and aggregate count-only inspection around the completed replay-to-live handoff.
- Durable replay remains under the handoff's replay event/byte limits. Only committed events accepted after captured high-water enter the sustained queue, so replay and live memory retain separate budgets.
- `createHostDeckProjectionStreamRouteRegistration` registers the exact selected `GET /api/v1/sessions/:session_id/events/stream` manifest route through the existing Readable-only Fastify transport. It derives paired-device identity from authenticated request context; callers cannot supply a device bucket.
- A branded source-lifecycle signal lets queue overflow, archive, source failure, service close, and explicit unsubscribe destroy an active Readable/response without waiting for another iterator pull.
- Fanout delivery stays synchronous and wait-free. A callback validates and enqueues, satisfies one pending reader, or closes only that subscriber; it never awaits socket progress or returns a non-void result into the shared hub.
- The queue owns no timers. It owns only abort listeners, bounded queue storage, admission counters, one handoff token, and one source-lifecycle controller.

Criteria: `5ff42b7`. Implementation: `730bd73`. Failure-evidence hardening: `19df3aa`.

## Hard Success Criteria

| Boundary | Completion evidence |
| --- | --- |
| Exact construction | Descriptor-first exact parsers reject missing, extra, accessor, prototype-invalid, unbranded route-service, invalid signal, and copied resource-budget inputs before admission or source work. Returned-handoff validation rejects malformed state, and malformed or late-returned handoffs receive one best-effort close. |
| Selected route | The registration asserts the one frozen manifest row, uses the selected path/query/session schema, and preserves stable authentication, authorization, missing-session, archived, future-cursor, capacity, and storage HTTP envelopes instead of collapsing source-open failures to generic 500. |
| Identity ownership | Paired `device_id` is derived only from the frozen authenticated context. Loopback readers have no invented device identity and remain under global/session caps. No device id appears in subscriber failures or snapshots. |
| Admission | Unique id, closed service, global, per-device, and per-session limits reject synchronously. Reservation precedes handoff open, every failed/late open releases once, and released device/session/global capacity is reusable. |
| No-gap composition | A real fanout, selected-state repository, and replay/live handoff prove replay cursor 1 followed by live cursors 2 and 3 exactly once in order. The sink activates before the stream is returned. |
| Queue bounds | Live events use the shared exact framed UTF-8 SSE byte function. Eight events and an exact 65,536-byte aggregate boundary pass; cursor 9 or the first additional framed byte fails only that subscriber and clears all queued totals. |
| Backpressure isolation | A stalled subscriber overflows while a healthy peer receives cursors 1 through 10. Publication remains synchronous, the shared fanout stays healthy, and a real paused HTTP response closes after source-owned termination. |
| Iterator contract | One iterator and one unresolved `next` are allowed. Concurrent iterator/pull, `return`, `throw`, repeated close, natural replay/live reads, and pending-reader settlement have deterministic state and counter results. |
| Disconnect and revoke | Request abort, real client disconnect, and real paired-device authority invalidation release queue, listener, source controller, registry slot, and handoff once; unrelated authority remains independent. |
| Archive | Post-commit archive invalidates only that session's active/opening subscribers. A real opening race and a noncooperative late handoff both close, while later opens still revalidate durable archived state. Cleanup throw or malformed return produces a durable incomplete audit outcome without redispatch. |
| Source and service failure | Iterator throw, fanout close/fatal loss, malformed/open failure, handoff signal loss, aggregate service close, and cleanup-close failure remain bounded and clear owned state without private causes. |
| Active socket closure | Real listener tests hold the client response paused, trigger source-owned close and live queue overflow, then prove response close and zero in-flight Fastify requests without requiring client disconnect or a later source pull. |
| Inspection | Frozen snapshots expose counts, aggregate queue totals/peaks, rejection/closure counters, and service state only. Failure observations expose only code/cursor; event content, authorization, request/cookie/CSRF values, device ids, and private causes are absent. |

## Failure Policy

| Condition | Public/internal action |
| --- | --- |
| Admission exhausted | Reject source open as `503 service_overloaded`; no handoff or queue remains. |
| Missing session | Reject source open as `404 session_not_found`. |
| Archived/stale or future cursor | Reject source open as `409 stale_session`; future cursor identifies only the `after` field. |
| Authorization rejection | Preserve the existing bounded authentication/permission HTTP error. |
| Storage, fanout, or contradictory replay state | Reject source open as bounded internal/storage unavailability; retain no underlying cause in the response. |
| Live queue overflow | Close only that subscriber, actively terminate transport, and emit one bounded internal `queue_overflow` observation. Do not fabricate or silently discard a projection event. |
| Disconnect/revoke/explicit return | Close normally and idempotently; do not report overflow or source failure. |
| Archive/source failure/service close | Terminate affected streams with bounded internal reason and no automatic reconnect/retry. Client reconnect policy remains downstream. |

## Validation

- Focused subscriber/route/transport/fanout/handoff/archive/revoke matrix: 7 files, 75 tests passed.
- Unit: 175 files passed and 26 intentional external/device files skipped; 1,694 tests passed and 27 skipped.
- Contract: 33 files and 259 tests passed. Integration: 14 files and 18 tests passed. Web: 3 files and 33 tests passed.
- Root and all eight package typechecks passed. Biome/package exports checked 499 files and eight packages.
- Scaffold passed with eight packages and 20 root scripts. Runtime-boundary passed. Planning passed with 212 tasks, 84 requirements, 649 dependencies, and two queued leaves after closure.
- The default Codex 0.144.5 binary correctly rejected the pinned binding gate. An isolated unchanged Codex 0.144.0 verified all 671 generated files at SHA-256 `e1a1a5cff3ab91862f9215dd06538eae1ea0b00bae48cbb7d87061faaee27e24`.
- Frozen offline install passed. Production audit found no known vulnerabilities. The 155-entry production license inventory contains only permissive MIT/BSD/ISC/Apache/BlueOak/0BSD or permissive-choice licenses; no dependency or lockfile changed.
- Manual inspection found no queue timer, direct plugin AsyncIterable send, retained private observation, test process, HostDeck listener, Codex process, tmux process, or test-started ADB daemon. Staged privacy and diff checks passed.

## Remaining Ownership

- `IFC-V1-036` owns mutable local and remote health after startup.
- `IFC-V1-037` owns deadline-bounded whole-application shutdown ordering across HTTP, SSE, runtime, storage, and lease.
- `IFC-V1-038` owns aggregate projection/recovery/shutdown acceptance.
- `IFC-V1-048` owns reconnect-storm and aggregate SSE resource stress enforcement.
- `IFC-V1-046` owns full selected production route assembly.
- Frontend reconnect/offline UX and physical-phone acceptance remain downstream UI/remote tasks.
