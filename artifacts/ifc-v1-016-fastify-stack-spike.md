# IFC-V1-016 Fastify Production Stack Spike

Date: 2026-07-09

## Scope

Select and pin the production HTTP, validation, SSE, and static-delivery dependencies for Node 22 before any production route migration. Freeze the integration constraints that downstream app-factory, stream, asset, and lifecycle tasks must implement.

## Harsh Success Criteria

- Exact maintained versions install on Node 22.22.2 and typecheck under the repository's strict TypeScript configuration.
- One Zod schema can infer a parsed request type, reject unknown/invalid input, validate output, and produce bounded stable client errors without exposing a stack or schema internals.
- Fastify enforces configured body limits, supports injection, returns stable not-found errors, and closes idempotently.
- SSE-only negotiation, `Last-Event-ID`, replay callback input, heartbeat, real socket backpressure, request abort, event-source finalization, and handler settlement are executable.
- Static delivery separates assets, explicit browser routes, and API misses; traversal and dotfiles reject; cache, MIME, GET, and HEAD behavior are explicit.
- License, compatibility, maintenance, audit, dependency-tree, and rejected-alternative evidence is recorded.

## Selection

| Package | Exact version | License | Decision |
| --- | --- | --- | --- |
| `fastify` | `5.10.0` | MIT | Selected as the sole production HTTP app/listener owner. |
| `zod` | `4.4.3` | MIT | Selected for request, response, config, and shared HostDeck contract validation. This matches `@hostdeck/contracts`. |
| `@fastify/sse` | `0.5.0` | MIT | Selected with the mandatory Readable-backed transport restriction below. |
| `@fastify/static` | `9.3.0` | MIT | Selected with explicit asset-root, dotfile, path, cache, and browser-route policy. |

Registry metadata on 2026-07-09 reported publication updates on 2026-07-05, 2026-05-04, 2026-07-01, and 2026-07-08 respectively. `@fastify/sse` declares Node `>=20.20.2` and Fastify `^5.x`; `@fastify/static` 9.x is the Fastify 5 line. Fastify 5 requires Node 20 or newer, so the pinned Node 22.22.2 runtime satisfies the selected stack.

Primary sources: [Fastify v5 migration](https://fastify.dev/docs/latest/Guides/Migration-Guide-V5/), [Fastify](https://github.com/fastify/fastify), [Zod](https://github.com/colinhacks/zod), [Fastify SSE](https://github.com/fastify/sse), and [Fastify static](https://github.com/fastify/fastify-static).

## Frozen Integration Contract

### Validation And Errors

- `@hostdeck/server` owns a small local Fastify type provider plus validator and serializer compilers over the existing Zod schemas. Request inference uses parsed Zod output; response serialization validates before writing.
- Invalid request data is converted at the compiler boundary to a HostDeck-owned error code. The global error handler maps that code to a bounded stable 4xx response; response-schema or internal failures remain redacted 5xx responses.
- The app factory owns body/header/request limits, content-type policy, request ids, not-found/method behavior, logging, and close. Route plugins cannot replace these global policies silently.

### SSE

- Routes use `sse: "only"`; the plugin owns Accept negotiation, SSE headers, heartbeat timing, connection state, and `Last-Event-ID` extraction. HostDeck owns cursor validation, durable replay/live handoff, queue limits, authorization, event validation, and health/audit effects.
- Direct `reply.sse.send(asyncIterable)` is forbidden. In `@fastify/sse` 0.5.0, a backpressured write waits for `drain` or `error`, while socket `close` only flips connection state. A real paused client proved that this can leave the send promise and source suspended.
- The adapter must convert the validated event source with `Readable.from(source, { objectMode: true })` and pass that Readable to `reply.sse.send`. The plugin then uses Node `pipeline`; the real paused-client probe proved abort notification, source finalization, and handler settlement before timeout.
- The adapter owns one disconnect `AbortController` and passes its signal to the event source. It must observe source/serialization failure before the plugin's stream path logs and closes it. Missing production source is a composition error, never an empty stream fallback.
- Because `@fastify/sse` is pre-1.0 and the selected path avoids one public input form, any version change must rerun the complete probe before lockfile acceptance.

### Static Assets

- `@fastify/static` serves only a validated asset directory under `/assets/`; `index` is disabled there.
- `dotfiles: "deny"` and `allowedPath` rejecting every dot-prefixed path segment are both required. `serveDotFiles: false` alone did not reject a root-level `.secret` file in the executable probe.
- Only explicit browser routes send the validated `index.html`. HTML is `no-store`; content-hashed assets are immutable for one year. API misses remain stable JSON and never receive the browser shell.

## Rejected Alternatives And Paths

| Candidate/path | Finding | Decision |
| --- | --- | --- |
| `fastify-type-provider-zod@7.0.0` | Compatible with Fastify 5/Zod 4, but declares mandatory `@fastify/swagger` and `openapi-types` peers. pnpm installed those production peers although V1 has no OpenAPI owner. | Rejected. A narrow local provider/compiler avoids unrelated runtime dependencies and keeps error ownership in HostDeck. |
| `fastify-sse-v2@4.2.2` | Maintained and MIT, but lacks the selected plugin's Accept negotiation, replay helper, heartbeat, and connection-state API and adds a second stream utility stack. | Rejected after package/source/API review; temporarily installed dependency was removed. |
| `@fastify/sse` direct async-iterable send | Real slow-client close ran the close callback but did not finalize the source within one second because the pending drain wait did not observe close. | Rejected input path; Readable-backed send is mandatory. |
| `serveDotFiles: false` by itself | A root-level dotfile was served with status 200. The option documents hidden-directory behavior and is not a complete asset policy. | Rejected configuration; explicit send-level denial and allowed-path filtering are mandatory. |
| Ad hoc raw HTTP/SSE/static implementation | Would duplicate negotiation, framing, MIME/range/cache, and lifecycle behavior already available in maintained Fastify packages. | Rejected while the constrained official stack passes the required boundaries. |

Rejected-candidate sources: [fastify-type-provider-zod](https://github.com/turkerdev/fastify-type-provider-zod) and [fastify-sse-v2](https://github.com/mpetrunic/fastify-sse-v2).

## Probe Findings

The executable probe is `packages/server/src/fastify-stack.probe.test.ts`.

1. The first typecheck caught the SSE package's named ESM export and the repository's `unknown` error-handler boundary; the probe now uses the public `fastifySSE` export and explicit Fastify-error narrowing.
2. The first runtime pass failed three assumptions: raw Zod errors became 500 responses, direct SSE async-iterable cleanup timed out under backpressure, and the root-level dotfile was served. None of these assertions was relaxed.
3. Request-validation errors now cross an explicit HostDeck code boundary; SSE uses the proven Readable/AbortController path; static assets use `dotfiles: "deny"`, dot-segment filtering, and `index: false`.
4. The final focused matrix passes six tests covering validation/errors/limits, repeated close, SSE negotiation/replay, heartbeat, real disconnect/backpressure/abort, and static assets/fallbacks.
5. Aggregate validation exposed `BUG-002`: default unit tests opportunistically ran real tmux processes and failed in two different load-sensitive locations. Real tmux suites now require the existing explicit smoke flag; deterministic unit and dedicated real-process commands both pass.

## Dependency Review

- `pnpm audit --prod --json` reports zero info, low, moderate, high, or critical vulnerabilities across 121 production dependencies.
- `pnpm licenses list --prod --json` reports only permissive categories in the current production graph: MIT (86), ISC (9), Apache-2.0 (2), BSD-3-Clause (4), BlueOak-1.0.0 (5), and two permissive multi-license expressions.
- `pnpm why fastify-type-provider-zod` and `pnpm why @fastify/swagger` return no dependency path after cleanup.
- The server has four new exact direct dependencies. No setup/environment command changes; build/package output remains owned by `IFC-V1-021` and later packaging tasks.

## Validation

| Command / inspection | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | Pass; all 10 workspace projects match the lockfile. |
| `pnpm check:scaffold` | Pass; 9 packages and 18 required root scripts. |
| `pnpm check:planning` | Pass; 196 tasks, 84 requirements, 622 dependencies, 5 queued. |
| `pnpm check:codex-bindings` | Pass; exact 0.144.0 identity across 671 files. |
| `pnpm typecheck` and `pnpm -r typecheck` | Pass for root and all 9 packages. |
| `pnpm lint` | Pass; Biome and all 9 package exports. |
| Focused stack probe | Pass; 6 validation/lifecycle/SSE/static tests. |
| `pnpm test:unit` | Pass; 378 tests, 18 explicit external/real-process tests skipped. |
| `pnpm test:tmux` | Pass; 21 adapter/server real-process tests. |
| `pnpm test:contract` | Pass; 105 tests. |
| `pnpm test:integration` | Pass; 16 tests. |
| `pnpm test:web` | Pass; 14 tests. |
| `pnpm audit --prod --json` | Pass; 0 vulnerabilities across 121 production dependencies. |
| `pnpm licenses list --prod --json` | Pass; only the permissive categories summarized above. |
| Dependency-tree inspection | Exact four-package selection present; rejected provider/Swagger dependencies absent. |
| `git diff --check` | Pass. |

## Remaining Ownership

- `IFC-V1-020`: exact units, defaults, maxima, deadline, cancellation, and resource-budget contract.
- `IFC-V1-022`: side-effect-free typed app factory and production local Zod compilers/error policy.
- `IFC-V1-023`: Readable-backed SSE adapter, explicit source observation, bounds, and disconnect tests.
- `IFC-V1-024`: validated static-root and explicit browser/asset route boundary.
- `IFC-V1-025`: listener readiness, failure rollback, active-stream shutdown, and restart.
- This task selects and probes the stack; it does not complete production API, `BLK-V1-04`, or V1 release readiness.
