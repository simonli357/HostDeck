# FE-V1-023 Bounded Browser SSE Client

Date: 2026-07-22

## Scope

Implement one headless browser client for the selected per-session event stream. This leaf owns the exact stream route, same-origin fetch transport, bounded SSE parsing, one in-memory session cursor, visible continuity state, heartbeat/idle detection, capped read reconnect, cancellation, and fake plus real-server evidence.

The client does not own initial session/page reads, durable browser storage, React rendering, host/access diagnosis, pairing, CSRF, mutation retry, Tailscale control, or production entry wiring. `FE-V1-012` consumes its typed events, `FE-V1-025` coordinates its state with HTTP/host/access truth, and `FE-V1-015` later closes the cross-screen continuity matrix.

## Pre-Change Findings

- The selected manifest has exactly one SSE route: `GET /api/v1/sessions/:session_id/events/stream`, with optional canonical `after`, `text/event-stream`, browser-managed cookie authority, no CSRF, and `selectedProjectionEventSchema` payloads.
- The production server frames every event as one cursor `id`, exact projection `event` type, and JSON `data`. It emits `: heartbeat` comments every 15 seconds by default and can return strict JSON error envelopes before committing the stream.
- Native browser `EventSource` hides comment heartbeats, owns an implementation-defined automatic reconnect loop, cannot expose HTTP error status/body, and cannot be given the selected bounded state machine. It cannot satisfy heartbeat/idle, exact API-error, or reconnect-cap criteria without weakening them.
- Native `fetch` exposes the response status/media/body stream, supports same-origin cookies and cancellation, and permits HostDeck to own all retry and idle state. A maintained parser remains preferable to a handwritten SSE grammar.
- Exact `eventsource-parser` 3.1.0 is MIT licensed, has no runtime dependencies, publishes TypeScript declarations, exposes comment/retry/error callbacks, and has a hard `maxBufferSize`. It is the selected parser; HostDeck still validates its narrower wire contract and owns all network/state behavior.
- The shared resource registry has server SSE limits but no browser SSE owner. Browser JSON limits do not bound a long-lived stream, parser buffer, reconnect loop, or concurrent subscriptions.

## Frozen Design

### Public State And Ownership

- `createBrowserSseClient` snapshots one canonical current-document origin, one fetch port, one clock/timer set, and one frozen browser SSE limit set. It exposes `connect` and `close`; each connection exposes immutable `snapshot` and idempotent `close`.
- A connection is permanently bound to one validated session id and one caller-supplied cursor. Its phases are `connecting`, `connected`, `reconnecting`, `failed`, and `closed`.
- Snapshots retain only session id, transport, phase, cursor, `unproven`/`contiguous`/`boundary` continuity, bounded boundary metadata, retry count/time, last heartbeat/event times, stable failure, and explicit close reason.
- Cursor and continuity live only in that connection. They are reused across its read reconnects and are never put in `localStorage`, `sessionStorage`, URL fragments, logs, or another session.
- One client rejects a second active connection for the same session and enforces its concurrent-stream ceiling. Terminal or closed connections release their slot exactly once.

### Fetch And Parser Boundary

- The only path is `/api/v1/sessions/<encoded-session-id>/events/stream`, with canonical `?after=<cursor>` only when a cursor exists. Callers cannot supply a URL, origin, method, header, cookie, authorization value, or retry directive.
- Fetch uses `GET`, `Accept: text/event-stream`, `Cache-Control: no-store`, `credentials: "same-origin"`, `mode: "same-origin"`, `redirect: "error"`, and `referrerPolicy: "no-referrer"`.
- A connect timer covers fetch through accepted response headers. A separate idle timer begins only after a valid 200 SSE response and resets only on an exact heartbeat comment or a fully validated selected event, not arbitrary bytes.
- Non-200 responses are read once under the error-response byte cap and must match the selected JSON media type, fatal UTF-8, JSON syntax, and exact HostDeck error envelope. Redirects, unexpected status, malformed headers/body, missing body, or wrong media fail explicitly.
- The parser's character buffer is capped by the browser event limit. Decoding is fatal UTF-8. Parser errors, `retry:` fields, unknown comments, incomplete terminal input, oversized data, and malformed fields fail closed; the server cannot override the client retry budget.
- Every event requires canonical decimal `id`, an exact selected event name, one JSON payload, strict `selectedProjectionEventSchema`, matching id/cursor, event name/type, and session id. Parsed output is deeply frozen before delivery.

### Cursor And Boundary Contract

- A normal event must be exactly the prior cursor plus one. Equal cursors are `duplicate_event`, lower cursors are `out_of_order_event`, and a forward gap without a first-event replay boundary is `cursor_gap`; all are terminal contract failures.
- A replay boundary is accepted only as the first event on a physical connection. It may jump beyond the prior cursor, advances the cursor to `next_cursor`, and changes continuity to `boundary` with bounded `after`, cursor, and reason metadata.
- Once observed, a boundary remains visible for the life of the connection. Later healthy reconnects cannot silently restore `contiguous` or erase the prior discontinuity.
- The event observer must return synchronously. It runs before cursor commit so a throwing/thenable consumer cannot lose an event behind an advanced cursor; consumer failure is terminal and never retried.

### Reconnect And Failure Contract

- Only transport rejection, connect timeout, idle timeout, unexpected clean EOF, and a validated retryable read error can schedule reconnect. Invalid response/stream/event/order, nonretryable API error, consumer failure, and explicit cancellation are terminal.
- Reconnect uses deterministic capped exponential delay from 500 ms to 10 seconds with at most eight consecutive retries. A valid heartbeat or delivered event proves liveness and resets the consecutive retry count; merely receiving 200 headers does not.
- Reconnect always sends the last committed cursor in canonical `after`. No mutation is invoked or retried. No server `retry:` field, raw exception, online flag, or hidden alternate transport changes the schedule.
- Exhaustion produces a stable `reconnect_exhausted` failure carrying only the last bounded failure category. Manual recovery creates a new connection explicitly.
- Caller abort, route change, unmount, per-connection close, and client close cancel active fetch/read plus connect/idle/backoff timers, release the reader and capacity, and finish as distinct closed reasons without another fetch.

### Resource Contract

Add eight browser-SSE-owned integer limits to the shared registry and a narrow browser-safe package export:

| Limit | Default | Range |
| --- | --- | --- |
| Connect timeout | 35 seconds | 1 to 180 seconds |
| Idle timeout | 45 seconds | 5 to 300 seconds |
| Error response | 64 KiB | 1 KiB to 1 MiB |
| Event/parser buffer | 64 KiB | 1 KiB to 256 KiB |
| Initial reconnect delay | 500 ms | 50 ms to 5 seconds |
| Maximum reconnect delay | 10 seconds | 100 ms to 60 seconds |
| Consecutive reconnect attempts | 8 | 1 to 32 |
| Concurrent streams per client | 2 | 1 to 32 |

Cross-field validation requires connect timeout to cover the server route deadline, idle timeout to exceed the server heartbeat interval, browser event capacity to cover the server event cap, error response capacity to fit browser JSON response capacity, and initial reconnect delay not to exceed its maximum. The registry grows from 91 to 99 definitions.

## Stable Failure Model

Public failures contain only reason, session id, transport, optional status, optional validated API envelope, and for exhaustion one prior bounded reason. They never retain origin/path, raw response bytes, raw exception, cookie, device identity, pairing/CSRF data, event payload, or callback value.

| Reason | Meaning |
| --- | --- |
| `connect_timeout` | Accepted response headers did not arrive within the selected limit. |
| `idle_timeout` | No exact heartbeat or valid event arrived within the selected idle limit. |
| `transport_unavailable` | Fetch/read ended without a trusted HostDeck response; no offline/Tailscale/profile diagnosis is invented. |
| `invalid_response` | Status, headers, media type, body, UTF-8, JSON, or selected error schema was invalid. |
| `response_too_large` | A non-stream error response exceeded its selected cap. |
| `malformed_stream` | UTF-8, SSE grammar, comment/retry field, EOF, or parser bounds violated the selected stream contract. |
| `invalid_event` | Event id/name/JSON/schema/session/type/cursor binding was invalid. |
| `duplicate_event` | The stream repeated the committed cursor. |
| `out_of_order_event` | The stream moved behind the committed cursor. |
| `cursor_gap` | The stream skipped a cursor without a first replay-boundary event. |
| `consumer_error` | A synchronous event/state consumer violated its port contract. |
| `api_error` | A non-200 response carried the exact selected HostDeck error envelope. |
| `reconnect_exhausted` | Consecutive retryable read failures exceeded the selected cap. |

## Acceptance Matrix

| ID | Criterion |
| --- | --- |
| `SSE-01` | Exactly the selected session stream path, params, query, response schema, auth/CSRF policy, and current loopback-HTTP/private-Tailscale-HTTPS origins are represented without a production server import. |
| `SSE-02` | Exact `eventsource-parser` 3.1.0 is pinned and lockfile/audit/license evidence confirms its zero-dependency MIT boundary; no handwritten general SSE parser or native auto-reconnect owner exists. |
| `SSE-03` | The shared registry has exactly 99 definitions including eight browser SSE limits with exact metadata/default/range/cross-field rejection, plus one narrow browser-safe limits export. |
| `SSE-04` | Invalid constructor/connect ports, session ids, cursors, signals, limits, observers, duplicate sessions, and capacity exhaustion perform zero fetches and expose no hostile accessor/cause data. |
| `SSE-05` | Every attempt uses one fixed encoded root-relative path, canonical cursor query, exact same-origin credential/cache/referrer/redirect policy, and no caller-controlled header, URL, or alternate transport. |
| `SSE-06` | Connect timeout, caller abort, transport rejection, invalid status/media/body, exact/over error bytes, malformed error envelope, and valid retryable/nonretryable API errors preserve bounded distinct state. |
| `SSE-07` | Exact heartbeat comments and selected message/turn/activity/approval/control/runtime/boundary/unknown-optional events parse under fatal UTF-8 and parser/event caps; invalid fields, `retry:`, unknown comments, malformed EOF, and oversized input fail closed. |
| `SSE-08` | Event id/cursor, event name/type, session, schema, and deep immutability are exact; malformed JSON/schema, mismatches, duplicate, out-of-order, and unmarked gaps do not advance cursor or invoke later delivery. |
| `SSE-09` | A first-event replay boundary may jump, advances the cursor, records bounded metadata, and leaves continuity visibly `boundary` through later events/reconnects; misplaced/multiple boundaries fail. |
| `SSE-10` | Heartbeat/event liveness resets idle and consecutive failures; arbitrary chunks/headers do not. Idle expiry aborts the reader and enters bounded reconnect without inventing a network diagnosis. |
| `SSE-11` | Retryable EOF/transport/connect/idle/API cases use the committed cursor and exact capped exponential schedule; healthy activity resets it; terminal cases never retry; exhaustion stops exactly at the configured count. |
| `SSE-12` | Caller abort, route change, unmount, connection close, and client close cancel fetch/read/backoff exactly once, release readers/timers/listeners/capacity, and never start a late attempt. |
| `SSE-13` | Throwing/thenable event consumers and throwing state observers cannot advance hidden state, create an unbounded queue, leak values, or trigger retry; public snapshots/failures remain immutable and bounded. |
| `SSE-14` | No public result, error, snapshot, serialized diagnostic, or retained closure contains origin, cookie/token/CSRF/pairing data, device/Tailscale identity, raw response, event payload, or raw cause. |
| `SSE-15` | Real selected Fastify SSE passes through native loopback HTTP and production admitted-Serve trust/auth contexts, including replay, heartbeat, paired read, unpaired denial, cursor reconnect, and cleanup without live Tailscale/profile/Serve/phone mutation. |
| `SSE-16` | Focused tests, web/workspace gates, Vite/runtime/package boundaries, frozen install, audit, manual source/privacy/no-retry review, and zero listener/timer/process residue pass. |

## Planned Validation

```bash
pnpm --filter @hostdeck/web test
pnpm --filter @hostdeck/web typecheck
pnpm --filter @hostdeck/web build
pnpm test:web
pnpm test:unit
pnpm test:contract
pnpm test:integration
pnpm typecheck
pnpm lint
pnpm check:scaffold
pnpm check:runtime-boundary
pnpm check:planning
pnpm test:package
pnpm install --offline --frozen-lockfile
pnpm audit --prod
git diff --check
```

## Evidence

All `SSE-01` to `SSE-16` criteria pass on the committed tree.

### Implementation

- `packages/web/src/sse-client.ts` owns the bounded fetch-stream state machine; `sse-route-contract.ts` owns the sole browser SSE route; `browser-origin.ts` shares the exact loopback/private-Tailscale origin policy with the JSON client.
- `packages/contracts/src/browser-sse-resource-policy.ts` exposes the narrow browser limit contract. The shared registry contains exactly 99 definitions and rejects invalid browser/server and reconnect relationships.
- Exact `eventsource-parser` 3.1.0 is pinned. Its package metadata and bundled license identify MIT, it has no runtime dependencies, frozen offline install passes, and `pnpm audit --prod` reports no known vulnerabilities.
- Implementation: `c8dc4d3`. Direct acceptance hardening: `91e8c87`.

### Automated Validation

- Direct SSE client: 28 tests. Web package: 66 tests. Aggregate web: 69 tests.
- Route contract: 1 test. Full contract: 244 tests. Real integration: 30 tests.
- Full unit: 1,912 passed with 28 intentional skips across 196 passing and 27 skipped files.
- Root and web typechecks, lint/exports, scaffold, runtime-boundary, planning, Vite build, frozen offline install, production audit, and diff checks pass.
- Deterministic package acceptance passes at 612 source modules, 1,231 outputs, and 6,433 entries, including relocated read-only runtime and mutation rejection. Vite emits 331.61 kB JavaScript and 6.49 kB CSS.

### Runtime And Manual Inspection

- The real integration uses the production selected Fastify projection stream, bounded replay/live handoff, native loopback streaming, and production admitted-Serve trust/authentication. It proves unpaired denial, paired replay, exact heartbeat, live delivery, `after=2` reconnect, and cleanup without changing live Tailscale, profile, Serve, or phone state.
- Source inspection confirms one fixed same-origin fetch transport, no native hidden reconnect, no mutation retry, sticky replay-boundary truth, cursor commit only after synchronous consumption, bounded immutable public state, privacy-safe failures, late-response cancellation, and reader/timer/listener/capacity cleanup.
- The first full integration invocation encountered an unrelated compact-fixture `EADDRINUSE` race. That fixture passed alone and the unchanged complete integration suite then passed 30/30.

No `FE-V1-023` gap remains. CSRF lifecycle, coordinated host/access state, UI consumption, cross-screen continuity, browser/device matrices, and release acceptance remain owned by downstream leaves.
