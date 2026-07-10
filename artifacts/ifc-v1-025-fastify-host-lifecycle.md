# IFC-V1-025 Fastify Host Lifecycle

Date: 2026-07-10

## Scope

Implement the selected Fastify startup/listener lifecycle over the completed resource policy, typed app factory, SSE transport, static boundary, and secure startup owner. This leaf owns upfront runtime cleanup authority, app readiness before bind, Node HTTP option application, exact loopback binding, lifecycle phase snapshots, bounded listener/SSE/app/startup cleanup, real secure-lease restart, and active finite-SSE shutdown. It does not compose unfinished Codex/projector/trust/routes, select HTTPS, replace the legacy custom listener, or complete aggregate graceful shutdown.

## Harsh Success Criteria

- Input is exact-key and side-effect-free until one complete runtime controller is validated. The controller exposes `start`, `closeSse`, and `closeStartup` before startup begins, so cleanup authority exists for runtime timeout/failure as well as every later failure.
- One frozen resolved resource budget owns startup/shutdown/step deadlines, Fastify limits, Node constructor/mutable limits, and SSE close bounds. An unresolved budget fails before runtime start.
- Runtime startup receives the exact budget plus one timer-owning startup deadline. Its result contains only context and one canonical listener bind. Before HTTPS selection, only explicit `127.0.0.1`/`::1` HTTP and ports 1 through 65535 are accepted; plaintext wildcard/LAN and unselected HTTPS fail before app creation.
- Explicit route registrations compose into `createHostDeckFastifyApp`; `app.ready()` completes while the server remains unbound. Node limits apply exactly before listen, including constructor-only `maxHeaderSize`; the actual bound address/port must equal the validated runtime result before readiness is returned.
- The returned lifecycle and nested snapshot values are frozen. `ready`, `draining`, `closed`, and `failed` are truthful; close returns one stable promise and cannot report closed when any cleanup step failed or timed out.
- Close initiates listener refusal first, then bounds SSE close, reaps only connections that become idle while listener close is pending, bounds Fastify close, and always attempts startup/storage/lease close last. One step failure or noncooperation cannot skip later owners; errors remain aggregated and observable.
- Route composition, plugin readiness, listener bind, runtime timeout, and close-failure matrices prove cleanup. Real secure local paths/database/lease restart after readiness and listen failures proves ownership rather than mock counters alone.
- A real active finite SSE response completes, releases request capacity, permits listener close, and allows immediate same-port restart. No force-close or enlarged timeout substitutes for source/response settlement.

## Pre-Change Findings

- `startHostHttpService` is the historical custom Node listener with tmux/raw route behavior. Extending it would preserve the rejected runtime direction, so the selected lifecycle is a new module and imports no legacy route handler.
- Fastify 5 accepts Node `createServer` options under its `http` factory option; `maxHeaderSize` is not a top-level Fastify option and cannot be assigned after construction. Other Node limits remain mutable server properties and are asserted before bind.
- Fastify `ready()` and `listen()` return thenable instances, not native `Promise` objects. The lifecycle wraps them explicitly before deadline racing and never treats registration as readiness.
- The runtime controller must exist before `start()`. A callback that returns cleanup functions only after startup cannot release a lease/storage owner when startup times out midway.
- `@fastify/sse` injection had masked a real-listener defect: a finite Readable source finalized, but the pinned plugin left `send(readable)` and the raw response open. The adapter now ends the raw response from the Readable `end` event; a direct real HTTP regression closes `BUG-005`.
- Node listener close can begin while a response is active and miss the same socket when it becomes idle later. During the bounded listener step, HostDeck polls `closeIdleConnections()` only; active requests are not force-closed by this leaf.

## Implemented Contract

### Runtime And Startup

`startHostDeckFastifyLifecycle` requires an exact plain input containing one frozen resolved `ResourceBudget`, internal-error observer, context-to-registration factory, and exact runtime controller. The controller owns partial-start coordination and exposes idempotent SSE/startup cleanup before its `start` method runs. Startup receives one frozen `{ deadline, resourceBudget }`; runtime result shape, bind transport/address/port, app creation, plugin readiness, listen, and actual address verification each have a distinct stable internal failure stage/code.

The lifecycle currently admits only loopback HTTP. This is intentional fail-closed behavior: `IFC-V1-015`, `IFC-V1-017`, and `IFC-V1-031` must supply selected certificate/HTTPS/trust inputs before non-loopback binding can enter the contract.

### App And Listener

The completed app factory now passes `http.maxHeaderSize` during Fastify construction. The lifecycle applies `headersTimeout`, `maxConnections`, and `maxHeadersCount`, then asserts those plus connection idle, keep-alive, request receive, and requests-per-socket settings before `app.ready()`. Readiness hooks observe `server.listening === false`; only the lifecycle calls `listen`, and returned readiness requires exact address equality.

The service exposes the Fastify app, runtime context, base URL, idempotent close function, and a frozen snapshot containing phase, configured/bound address, listening state, and Node limit inventory. It does not add a fake health route or empty production source; tests supply explicit probe registrations only.

### Shutdown

Closing moves phase to `draining` synchronously and caches one promise. Listener close is initiated first so new connections refuse. SSE close receives a child deadline capped by both `sse_shutdown_timeout_ms` and `lifecycle_cleanup_step_timeout_ms`. Listener completion, Fastify close, and startup close each receive bounded child deadlines under the overall lifecycle shutdown deadline.

Connections that become idle after listener close starts are reaped every 10 ms only while the bounded listener wait is active. Failure/timeout is labeled by cleanup step, but every later step is still invoked. Clean completion sets `closed`; any collected error sets `failed` and rejects with one `shutdown_failed` aggregate. `IFC-V1-037` still owns mutation drain, pending outcomes, projector/audit flush, reconnect cancellation, subscriber-hub shutdown, and process termination policy.

## Validation

| Command / inspection | Result |
| --- | --- |
| Focused lifecycle matrix | Pass; 5 tests cover strict/unresolved input, unsupported bind/transport, runtime timeout cleanup, no-listen-before-ready, real API/static composition, exact Node inventory/raw header 431, stable snapshots/close promise, route/ready/listen/close/noncooperative failures, real secure lease release/restart, active finite SSE, and same-port restart. |
| Focused SSE transport matrix | Pass; 8 tests now include a direct real HTTP finite-source response-end regression in addition to negotiation/framing/failure/backpressure/disconnect coverage. |
| Real secure startup integration | Pass; actual owner-only paths, SQLite migration/open, Linux daemon lease, plugin failure cleanup, listener bind failure cleanup, clean close, and repeated same-state/same-port restart succeed without importing legacy service routes. |
| Manual implementation/diff review | Pass; runtime cleanup authority precedes side effects, loopback-only transport is fail-closed, all later cleanup is attempted, idle reaping cannot terminate active requests, and no production route/source fallback was introduced. |
| `pnpm check:scaffold` / `pnpm check:planning` | Pass; 9 packages/18 scripts and 196 tasks/84 requirements/622 dependencies/5 queued before task transition. |
| Binding check | Default installed Codex 0.144.1 correctly refuses the reviewed 0.144.0 manifest. `HOSTDECK_CODEX_BIN` pointed at isolated exact `@openai/codex@0.144.0`; 671 files and reviewed tree identity `e1a1a5...e27e24` pass. No binding change was accepted. |
| `pnpm typecheck` and `pnpm -r typecheck` | Pass for root and all 9 packages. |
| `pnpm test:unit` | Pass; 414 tests, 18 explicit external/real-process tests skipped. |
| `pnpm test:contract` | Pass; 111 tests. |
| `pnpm test:integration` / `pnpm test:web` | Pass; 16 integration and 14 web tests. |
| `pnpm lint` | Pass; 185 files and all 9 package exports. |
| `pnpm audit --prod --json` | Pass; 0 vulnerabilities across 121 production dependencies. |
| `git diff --check` | Pass. |

## Remaining Ownership

- `INT-V1-006` and subsequent runtime leaves supply the real Codex operation/event/control runtime behind this controller. Default Codex 0.144.1 is unreviewed; semantic work must invoke exact 0.144.0 or perform an explicit compatibility upgrade task.
- `IFC-V1-015`, `IFC-V1-017`, and `IFC-V1-031` own HTTPS creation, Host/Origin policy, and LAN bind admission. Plaintext LAN remains impossible here.
- `IFC-V1-018`, `IFC-V1-034`, and `IFC-V1-035` own the real fanout/handoff/subscriber source and its aggregate close implementation.
- `IFC-V1-036` and `IFC-V1-037` own mutable health plus complete application drain/flush/reconnect/process shutdown. This leaf proves lifecycle mechanics, not those application outcomes.
- `IFC-V1-047` owns full raw-socket slow/large/idle/connection limit enforcement; this leaf proves option inventory and one constructor-level oversized-header refusal.
- `IFC-V1-046` and `IFC-V1-067` compose selected routes and remove/isolate the historical custom listener from production entrypoints.
