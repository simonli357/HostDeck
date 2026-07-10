# IFC-V1-023 Fastify SSE Transport

Date: 2026-07-10

## Scope

Implement one explicit `sse` route registration over `@fastify/sse` 0.5.0 and a required injected selected-event source. This leaf owns negotiation, cursor input, framing, heartbeat, Readable backpressure, source validation/observation, abort propagation, bounded iterator cleanup, and handler settlement. Replay/live handoff, subscriber admission/queues, durable retention, auth, and listener shutdown remain separate owners.

## Harsh Success Criteria

- Registration is exact-key and side-effect-free until Fastify composition. Missing source/observer, invalid id/path, non-Zod params, or parameterized routes without a params schema fail before route registration; no empty/fake source exists.
- `@fastify/sse` remains the negotiation/framing/heartbeat owner with `sse: "only"`. Missing, wildcard, weighted, explicitly refused, and non-SSE `Accept` cases follow the pinned parser; 406 responses normalize to the stable `not_acceptable` envelope.
- Query `after` and `Last-Event-ID` accept only canonical nonnegative safe-integer text. Either may supply the cursor; identical dual inputs are accepted and conflicting dual inputs reject before source open.
- The source receives parsed params, resolved cursor, exact Fastify `request.signal`, and request context. Real client disconnect aborts that same signal; no replacement cancellation signal or timer is created.
- Every source value passes `selectedProjectionEventSchema`, route-session identity, strictly increasing cursor order, deterministic JSON serialization, and full SSE wire-byte measurement before emission. Event id is the decimal cursor and event name is the selected event type.
- The plugin receives only `Readable.from(managedSseMessages(...), { objectMode: true, highWaterMark: 1 })`. The direct AsyncIterable send path is structurally absent.
- Source open/iteration/validation/order/size/send/cleanup failures are observed once per actual failure with request correlation and generic transport messages. Committed SSE responses never contain source errors, schema details, another session id, or thrown secrets.
- Iterator `return()` is called on validation failure, send cancellation, timeout, and disconnect. Cleanup is bounded by `sse_disconnect_cleanup_timeout_ms`; a noncooperative return is observed and cannot hold the Fastify handler/in-flight slot indefinitely.
- Finite, empty, heartbeat-idle, source-failure, cooperative backpressure, and noncooperative cleanup cases settle with no active app request count.

## Pre-Change Findings

- Fastify 5.10.0 `request.signal` does abort on a real client disconnect. The source can receive the exact app-factory signal; a replacement `AbortController` is unnecessary and would violate the deadline contract.
- The pinned SSE plugin's `only` negotiation correctly applies RFC media-range specificity and q=0 refusal, but its native 406 body is not a HostDeck error envelope. A registration-scoped `onSend` normalizer preserves the plugin decision while stabilizing the body.
- The plugin's Readable branch commits SSE headers before `pipeline()`. On a source/transform error it catches internally, marks the context disconnected, logs, and returns without rejecting `send()` or ending the raw response. Without adapter ownership, injection and real clients can hang indefinitely.
- The plugin direct AsyncIterable branch has the backpressured-disconnect settlement defect recorded by `IFC-V1-016`; only the Readable branch is admissible.
- `Readable.from`/generator cancellation can reach iterator `return()`, but an uncooperative source can keep `return()` pending forever. HostDeck needs an independent bounded wait and explicit incomplete-cleanup observation.

## Implemented Contract

### Registration And Cursor

`createHostDeckSseTransportRegistration` returns a frozen `HostDeckRoutePluginRegistration` with surface `sse`. Its path and optional parameter schema are copied before asynchronous registration. The fixed query schema parses only canonical decimal `after` values; header and query conflict is a 400 `validation_error`. Cursor resolution occurs before source open.

The route registers the pinned plugin with the reviewed heartbeat and one deterministic JSON serializer. The source factory receives one frozen input containing the resolved `OutputCursor | null`, parsed params, request, and exact signal. A session-scoped route additionally rejects selected events whose `session_id` differs from parsed `params.session_id`.

### Readable Lifecycle

`fastify-sse-source.ts` owns the iterator and creates a one-object-high-water Readable. Each iteration races `next()` against the unchanged request signal, validates the selected event, enforces cursor advance, computes the exact wire frame bytes, and yields one `SSEMessage` containing cursor id/type/data.

On early termination, the generator calls source `return()` and waits at most the configured disconnect-cleanup timeout. Cleanup failure/timeout is observed but does not replace the primary source failure or extend handler settlement. Natural completion does not issue a redundant return.

### Pinned Plugin Error Adaptation

The adapter listens to the Readable's error event because the plugin does not propagate pipeline errors from `send(readable)`. After the plugin returns, HostDeck records the generic bounded failure and explicitly ends an already-committed raw response if the client is still connected. Expected request abort/disconnect does not create a false source-error observation. The handler always removes its signal listener and destroys the Readable idempotently.

## Failure Codes

Internal observations use: `source_open_failed`, `source_iteration_failed`, `invalid_event`, `invalid_cursor_order`, `event_too_large`, `source_cleanup_failed`, `source_cleanup_timeout`, and `transport_send_failed`. They are operational evidence, not public API error codes. Public pre-commit failures remain bounded HostDeck envelopes; committed stream failures close the stream without serializing internal details.

## Validation

| Command / inspection | Result |
| --- | --- |
| Focused SSE matrix | Pass; 7 tests cover strict composition, empty/finite sources, query/header cursor reconciliation, Accept specificity and 406 normalization, cursor ids/types/data, heartbeat, invalid/cross-session/duplicate/oversized/source failures, and structural Readable-only use. |
| Real paused-client backpressure | Pass; exact request signal aborts, source `finally` runs, production remains below the 10,000-event sentinel, and app in-flight count returns to zero. |
| Noncooperative real disconnect | Pass; source `return()` is invoked once, 50 ms cleanup timeout is observed, and handler/app capacity settles within the 1 s test bound. |
| Pinned plugin source-error regression | Pass; invalid/oversized/throwing source responses terminate instead of hanging and leak no raw source detail. |
| `pnpm check:scaffold` / `pnpm check:planning` / `pnpm check:codex-bindings` | Pass; 9 packages/18 scripts, 196 tasks/84 requirements/622 dependencies/5 queued, and exact 0.144.0 identity across 671 files. |
| `pnpm typecheck` and `pnpm -r typecheck` | Pass for root and all 9 packages. |
| `pnpm test:unit` | Pass; 404 tests, 18 explicit external/real-process tests skipped. |
| `pnpm test:contract` | Pass; 111 tests. |
| `pnpm test:integration` / `pnpm test:web` | Pass; 16 integration and 14 web tests. |
| `pnpm lint` | Pass; 181 files and all 9 package exports. |
| `pnpm audit --prod --json` | Pass; 0 vulnerabilities across 121 production dependencies. |
| `git diff --check` | Pass. |

## Remaining Ownership

- `IFC-V1-018` supplies commit-only replay/live event sources and the no-gap high-water handoff.
- `IFC-V1-034` owns replay windows, stale/future/pruned cursor semantics, and retention-boundary events.
- `IFC-V1-035` enforces global/device/session subscriber admission and bounded per-subscriber queues.
- `IFC-V1-025`, `IFC-V1-036`, and `IFC-V1-037` own real listener lifecycle, health, drain, and aggregate SSE shutdown.
- `IFC-V1-047`, `IFC-V1-048`, and `IFC-V1-052` own HTTP/SSE stress, heap/counter/leak, and aggregate production evidence. This task proves transport mechanics, not those capabilities.
