# IFC-V1-047 Real HTTP Resource Limits

Date: 2026-07-11

## Outcome

- The selected Fastify lifecycle now applies and verifies the full Node HTTP limit set before listen: header bytes/count, timeout-check cadence, header/receive/idle/keep-alive timing, connection cap, and requests per socket.
- Header byte/count budgets are inclusive HostDeck limits. Node receives one-unit parser sentinels because its byte threshold is exclusive and its count threshold otherwise truncates before application inspection. The live snapshot exposes accepted and parser values separately.
- Request receive timeout must be strictly shorter than the route handler deadline. This prevents a slow body from receiving both Fastify 504 and Node 408 terminal responses.
- App-reached breaches keep stable HostDeck envelopes and request ids. Parser/socket breaches remain bounded native Node outcomes; HostDeck does not invent an envelope after parsing or connection admission failed.
- Shutdown refuses new accepts, closes SSE and newly idle sockets during a bounded grace period, then force-closes tracked HTTP sockets if necessary. Close waits for their `close` events before later app/startup owners complete and before same-port restart is accepted.

Implementation: `53699d6`. Exact inclusive header-byte correction: `4967044`.

## Applied Default Limits

| Boundary | Accepted policy | Applied runtime value |
| --- | --- | --- |
| Body / URL / route parameter | 65,536 / 2,048 / 128 bytes | Fastify body/router plus HostDeck byte checks |
| Header bytes | 16,384 bytes inclusive | Node parser sentinel 16,385 bytes |
| Header count | 64 inclusive | Node parser sentinel 65; HostDeck rejects count 65 |
| Header / receive / handler | 10,000 / 15,000 / 30,000 ms | Node/Fastify with strict receive-before-handler invariant |
| Timeout check cadence | At most 1,000 ms | `connectionsCheckingInterval=1000` by default |
| Keep-alive / idle | 5,000 / 60,000 ms | Hidden keep-alive buffer forced to 0 |
| Connections / in-flight | 64 / 64 | Node admission plus HostDeck request ownership |
| Requests per socket | 1,000 | Node `maxRequestsPerSocket` |

## Wire Outcomes

| Layer | Case | Proven outcome |
| --- | --- | --- |
| Node parser | Header bytes exactly 4,096 in reduced test budget | One 200 response and one handler call |
| Node parser | Header bytes 4,097 | One bounded native 431; no additional handler call |
| HostDeck hook | Header count exactly 16 / count 17 | 200 / stable 431 `malformed_request` with generated request id and `Connection: close` |
| Node parser | Incomplete headers or partial body at 1,000 ms | Exactly one native 408 in 900-3,200 ms; no handler side effect; slot/socket released |
| Node connection | Third connection at cap 2 | TCP connection dropped; active count remains 2; drop counter increments once |
| Node socket | Third pipelined request at cap 2 | Statuses 200, 200, 503; exactly two handler calls; drop-request counter increments once |
| Node socket | Keep-alive 1,000 ms / idle 5,000 ms | Close in 900-1,800 ms / 4,800-6,500 ms with no hidden 1,000 ms extension |
| HostDeck app | Body exactly 65,536 / 65,537 bytes | 200 / stable 413 `request_too_large` |
| HostDeck app | Media, URL, parameter, in-flight, handler deadline | Stable 415 / 414 / 414 / 503 / 504 families under existing exact app tests |
| HostDeck lifecycle | Partial upload during close | One tracked socket force-closed after 200 ms grace; close under 900 ms; zero active slots/sockets; later owners once; immediate same-port restart |

Client-aborted partial upload increments the abort counter once and releases both request and socket ownership. A timed-out noncooperative handler retains its in-flight slot until the original handler settles, so timeout never creates false capacity.

## Validation

- Real-listener header/timeout/socket/deadline/shutdown matrix: 5 tests passed.
- Focused resource/lifecycle matrix after the inclusive-byte correction: 3 files and 12 tests passed.
- Unit: 84 files passed, 16 skipped; 756 tests passed, 29 explicit external tests skipped.
- Contract: 14 files and 138 tests passed. Integration: 2 files and 16 tests passed. Web: 2 files and 14 tests passed.
- Typecheck, lint/package exports, scaffold, planning graph, exact Codex 0.144.0 binding, offline frozen install, production audit, and diff checks passed.
- Planning check before closure: 196 tasks, 84 requirements, 631 dependencies, 3 queued.
- Manual production-hardening review covered parser sentinel behavior, request-terminal ordering, once-only accounting, listener refusal, force-close deadline reserve, socket-close waiting, idempotent close, and restart truth.

Primary implementation references: [Node HTTP](https://nodejs.org/download/release/v22.22.0/docs/api/http.html), [Node net](https://nodejs.org/api/net.html), and [Fastify server](https://fastify.dev/docs/latest/Reference/Server/).

## Remaining Ownership

- `IFC-V1-048` owns sustained SSE subscriber/queue overload limits.
- `IFC-V1-049` owns operation idempotency and application concurrency limits.
- `IFC-V1-050` owns end-to-end HTTP-to-protocol deadline/cancellation propagation.
- `IFC-V1-051` owns CLI client timeout, response-size, and error bounds.
- `IFC-V1-052` owns the aggregate resource/overload/deadline/idempotency stress proof after those leaves complete.
