# IFC-V1-020 Resource Budget And Deadline Contract

Date: 2026-07-09

## Scope

Define one strict V1 resource registry for the selected HTTP, SSE, admission, Codex protocol, lifecycle, and CLI boundaries, plus one process-local monotonic deadline/AbortSignal owner. This task freezes contracts and evidence before the Fastify app, SSE adapter, trust hooks, listener lifecycle, and CLI consume them.

## Harsh Success Criteria

- Every selected V1 body, header, URL, request, idle connection, subscriber, event queue, replay, admission, protocol, lifecycle, and CLI bound has an explicit unit, minimum, default, maximum, config owner, stable public breach code/action, and observation key.
- The policy is exact-key, integer-only, nonzero, finite, and bounded. Missing values resolve to reviewed defaults; unknown, zero, fractional, non-finite, or above-maximum values fail parsing.
- Cross-field invariants prevent configurations that defeat their own limits: heartbeats fit idle windows, child protocol work fits the request/startup deadline, buffers contain frames/events, local caps fit global caps, cleanup fits shutdown, and client timeout does not expire before the server budget.
- Public errors distinguish oversized input (`request_too_large`), admission throttling (`rate_limited`), temporary capacity exhaustion (`service_overloaded`), and elapsed work (`operation_timeout`).
- One request owner creates an absolute deadline from a monotonic clock and one AbortSignal. Every in-process layer receives the same object/signal and can only use the remaining time or a smaller local cap; clock rollback, invalid duration, or use after expiry fails loudly.
- Parent/client disconnect abort propagates once with its original reason. Expiry aborts once with an `operation_timeout` reason. Owner disposal removes timer/listener state without inventing cancellation.
- Fake-clock tests prove exact expiry, decreasing remaining time, no extension, parent abort, disposal, clock rollback rejection, and timer cleanup without wall-clock sleeps.
- Existing Codex adapter defaults are inventoried and represented without silently increasing their current maxima; future consumers and remaining integration ownership are explicit.

## Pre-Change Findings

- Codex transport, broker, connection, and thread client already validate local timeout, frame, queue, in-flight, and pagination defaults, but no server-level policy names their public breach behavior or composes them with HTTP/CLI deadlines.
- The legacy custom HTTP path has no selected global body/header/connection/deadline owner. Fastify defaults cannot become production policy implicitly.
- SSE subscriber, per-session subscriber, queue bytes/events, event bytes, replay, disconnect, and shutdown bounds are planned but not yet represented by one typed config.
- Pair-claim and mutation rate/concurrency requirements have task owners but no shared windows, cardinality caps, or bounded limiter-state policy.
- Core already exposes `operation_timeout` and `rate_limited`; oversized-input and temporary-capacity errors need stable first-class codes before the selected app factory maps status codes.

## Selected Policy

The executable source of truth is `packages/contracts/src/resource-policy.ts`. It now exports an immutable 78-entry definition registry, exact-key Zod schema, reviewed default object, and key lookup. `IFC-V1-020` introduced the original 59 entries; downstream owning leaves added bounded control, projection, approval, usage, skills, and pairing fields without creating a second policy owner. Every observation name is derived as `hostdeck.resource.<key>`; owner/action/code metadata is part of the public contract rather than comments.

| Area | Entries | Reviewed default posture |
| --- | ---: | --- |
| HTTP | 13 | 64 KiB body; 16 KiB/64 headers; 2 KiB URL; 128-byte route parameter; 10 s headers, 15 s receive, 30 s route, 60 s idle, 5 s keep-alive; 64 connections/in-flight; 1,000 requests/socket. |
| SSE | 11 | 15 s heartbeat; 32 global, 8/device, 4/session subscribers; 256-event/1 MiB queue; 64 KiB event; 2,000-event/8 MiB replay; 2 s disconnect and shutdown cleanup. |
| Admission | 13 | 60 s pair/mutation windows; 5 min pairing-code lifetime; 10 pair attempts/source and 100 global; 1/source and 4 global pair claims; 60 mutations/device, 2/device, 1/target and 16 global in flight; 1,024 tracked keys retained 10 minutes. |
| Codex protocol/control | 32 | Transport, broker, event, pagination, model, collaboration, turn-control, approval, usage, compact, and skills bounds remain explicit and owner-mapped. |
| Lifecycle | 3 | 60 s startup, 10 s shutdown, 2 s cleanup step. |
| CLI | 6 | 5 s connect, 35 s request, 64 KiB request, 1 MiB response, 45 s stream idle, 4 in flight. |

Production minima prevent zero/unbounded and pathological sub-second protocol/heartbeat configuration. Low-level Codex transport tests may still inject a 50 ms timing floor; production composition must use `codexResourceOptionsFromBudget`, whose input is the stricter policy schema.

### Cross-Field Invariants

- Header receive, request receive, and route handling are separate and ordered; keep-alive is below idle timeout.
- SSE heartbeat fits both server connection-idle and CLI stream-idle windows; device/session caps fit global subscribers, and global subscribers reserve normal HTTP capacity.
- One event fits queue, replay, and protocol-frame bytes; replay covers at least one full queued event/byte window.
- Pair per-source, mutation per-device/target, and protocol concurrency fit their global/HTTP caps; limiter state outlives both rate windows.
- Protocol frame fits its buffer; read/mutation/start fit the route deadline; connect plus handshake fit startup; close and cleanup fit shutdown.
- CLI connect fits its request timeout, its request body fits the server body limit, and its outer request timeout cannot expire before the server route budget.

The matrix mutates every definition below minimum, above maximum, to zero/fraction/non-finite, and exercises 35 contradictory but individually valid policy combinations. A coherent lower policy must lower linked values explicitly; it cannot inherit a larger CLI/protocol fallback that violates the new cap.

## Deadline Ownership

`packages/core/src/deadline.ts` provides two forms with the same `OperationDeadline` interface:

- `createOperationDeadline` owns one monotonic timer and AbortController for startup, shutdown, and future CLI-local work that has no framework cancellation owner.
- `createOperationDeadlineView` returns the exact external AbortSignal unchanged and owns no timer. The Fastify app uses this over `request.signal`, because Fastify 5.10 `handlerTimeout` already owns route-lifecycle expiry and cooperative cancellation.

Both forms expose a frozen public facade with immutable process-local start/expiry values, decreasing `remainingMs()`, and `timeoutMs(cap)` that can only shorten work. Mutable timer/listener state remains inaccessible behind that facade. Invalid durations/clocks/signals, monotonic rollback, expiry, or use after disposal fail loudly. Parent abort preserves its original reason; deadline expiry uses `OperationDeadlineExceededError` with `operation_timeout`; disposal clears timer/listener ownership without reporting a false abort.

A monotonic timestamp is never serialized across CLI/server process boundaries. The CLI owns its outer network timeout; the server owns a fresh route deadline, and client disconnect reaches the server through Fastify's request signal.

## Integration Changes

- Added `request_too_large` and `service_overloaded` to the stable core error family; the existing server status mapper now emits 413 and 503 respectively.
- `fastifyResourceOptionsFromBudget` maps body, receive, handler, idle, keep-alive, requests/socket, router guard, header bytes/count, connection, URL/parameter-byte, and in-flight values without constructing a listener.
- `codexResourceOptionsFromBudget` accounts for all 15 protocol keys and returns frozen transport, connection, and thread option groups.
- Codex transport/broker/connection/thread defaults and maxima now read the shared registry. Thread read, mutation, and start timeouts are configurable and forwarded exactly; the former duplicated operation timeout table is removed.
- No production Fastify route, SSE hub, trust limiter, listener, or CLI client is implemented by this task. Their enforcement and real stress evidence remain the leaf owners listed below.

## Source Review

- [Fastify server reference](https://fastify.dev/docs/latest/Reference/Server/) distinguishes socket `connectionTimeout`, full-request receive `requestTimeout`, route-lifecycle `handlerTimeout`, body limits, request-per-socket bounds, and router parameter guards. The selected mapping preserves those meanings.
- [Node 22 HTTP reference](https://nodejs.org/download/release/v22.15.0/docs/api/http.html) owns `headersTimeout`, `maxHeadersCount`, `maxHeaderSize`, `maxConnections`, socket idle, keep-alive, and request-per-socket semantics.
- [Node 22 global AbortController reference](https://nodejs.org/download/release/v22.15.0/docs/api/globals.html) confirms one-shot abort reasons and recommends one-shot listener cleanup. HostDeck preserves the original reason and removes listeners on abort/disposal.

## Validation

| Command / inspection | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | Pass; all 10 workspace projects already match the lockfile. |
| `pnpm check:scaffold` | Pass; 9 packages and 18 required root scripts. |
| `pnpm check:planning` | Pass; 196 tasks, 84 requirements, 622 dependencies, 5 queued. |
| `pnpm check:codex-bindings` | Pass; exact 0.144.0 identity across 671 files. |
| `pnpm typecheck` and `pnpm -r typecheck` | Pass for root and all 9 packages. |
| `pnpm lint` | Pass; 174 files and all 9 package exports. |
| Focused resource/deadline/error/mapping/adapter matrix | Pass; policy metadata/invariants, fake clock, same-signal view, Fastify semantics, complete Codex mapping, and configured thread timeout forwarding. |
| `pnpm test:unit` | Pass; 391 tests, 18 explicit external/real-process tests skipped. |
| `pnpm test:contract` | Pass; 110 tests including the 59-field policy matrix. |
| `pnpm test:integration` | Pass; 16 tests. |
| `pnpm test:web` | Pass; 14 tests. |
| `pnpm audit --prod --json` | Pass; 0 vulnerabilities across 121 production dependencies. |
| Manual ownership review | Every `IFC-V1-047` to `IFC-V1-051` enforcement dimension maps to a registry key and later evidence owner; no production enforcement is claimed here. |
| `git diff --check` | Pass. |

## Remaining Ownership

- `IFC-V1-022` consumes HTTP limits and stable errors in the typed Fastify app factory.
- `IFC-V1-023`, `IFC-V1-034`, and `IFC-V1-035` consume SSE transport/replay/subscriber bounds.
- `IFC-V1-025`, `IFC-V1-036`, and `IFC-V1-037` consume startup, readiness, drain, and shutdown deadlines.
- `IFC-V1-026`, `IFC-V1-030`, and `IFC-V1-031` consume pair/mutation admission policy.
- `IFC-V1-047` to `IFC-V1-052` prove each stress/failure layer and aggregate behavior.
- Runtime supervision tasks consume Codex protocol values; CLI implementation consumes outer request/response bounds. This task does not claim those adapters are wired to the registry yet.
