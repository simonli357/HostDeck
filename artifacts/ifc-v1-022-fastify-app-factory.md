# IFC-V1-022 Typed Fastify App Factory

Date: 2026-07-09

## Scope

Implement the selected side-effect-free Fastify 5.10.0 app factory over the frozen resource/deadline contract. This leaf owns global composition policy and adversarial injection evidence. It does not migrate production routes, open storage or listeners, implement SSE replay/backpressure, or select the static dashboard boundary.

## Harsh Success Criteria

- Construction accepts only an exact factory input, one complete frozen `ResourceBudget`, a synchronous internal-error observer, and at most 64 uniquely named explicit route registrations. No listener, storage, process, legacy route, or filesystem source is opened implicitly.
- Route registrations declare `api`, `sse`, or `static`. API routes cannot register without at least one Zod response schema; every declared request/response schema is the pinned local Zod instance. Route-local compiler replacement is forbidden, and API/SSE routes cannot install route-local error handling or `attachValidation`; SSE/static response-schema exemptions are explicit and narrow.
- Global body, URL, route-parameter, receive, handler, idle, keep-alive, request-per-socket, and in-flight values come from the reviewed resource policy. A route may lower body/deadline limits but cannot disable or raise them.
- Every admitted request receives one generated server request id, response header, unchanged Fastify `request.signal`, and deadline view using the effective route deadline. An incoming request-id header is never trusted.
- In-flight ownership spans both underlying handler settlement and response completion/abort. A handler that ignores timeout/abort retains its slot; parser/pre-handler failures release after response; every normal path releases exactly once.
- Native framework errors, including failures before `onRequest`, become bounded HostDeck envelopes. Validation, malformed JSON/URL, oversized body/parameter/target, unsupported media, overload, timeout, not-found, method, typed route, response-schema, and unknown internal errors have tested status/code behavior.
- Generic handler/serializer failures reach the required internal observer while client responses contain no raw URL, stack, Zod detail, or thrown secret. Typed route errors are immutable and reserve error-detail capacity for correlation.
- Handler wrapping preserves Fastify's original synchronous, `FastifyReply`, and Promise behavior. The pinned SSE and static plugins can register through their declared surfaces without changing their response lifecycle.

## Pre-Change Findings

- The stack spike proved local compilers and basic error handling, but there was no reusable app factory or explicit plugin composition contract.
- Fastify's root `setErrorHandler` does not normalize router-level `FST_ERR_MAX_PARAM_LENGTH` errors for routes inside encapsulated plugins. Without a factory-level `frameworkErrors` owner, the native response leaks the full request URL.
- Fastify `handlerTimeout` sends its native 503 and aborts `request.signal`, but JavaScript cannot forcibly stop a handler that ignores cancellation. Releasing capacity on response alone would permit an unbounded set of timed-out background handlers.
- Converting every registered handler to an `async` wrapper changes Fastify semantics. `@fastify/static` starts a stream pump from a synchronous handler and returns `undefined`; an async wrapper causes Fastify to complete an empty response before the pump reads the file.
- A general Zod compiler is insufficient to prove all API responses are validated because static files and SSE streams need deliberate non-JSON exceptions.

## Implemented Contract

### Factory And Registration

`createHostDeckFastifyApp` validates all configuration before constructing Fastify. `resolveResourceBudget` is the canonical configuration-to-frozen-policy path; `assertResolvedResourceBudget` rejects partial, mutable, non-plain, unknown, or contradictory inputs. The factory returns an unbound instance and registers only the supplied route groups.

| Surface | Schema rule | Intended owner |
| --- | --- | --- |
| `api` | Every declared schema is Zod and at least one Zod response schema is required. | JSON API route groups. |
| `sse` | Declared request schemas remain Zod; streaming response framing is exempt from JSON response serialization. | `IFC-V1-023`. |
| `static` | JSON response-schema enforcement is exempt; the only non-Zod route-schema metadata accepted globally is boolean `schema.hide`. | `IFC-V1-024`. |

Registration ids are lowercase bounded identifiers and unique. Registration objects, surface contexts, the policy, public deadlines, typed HTTP errors, and resource snapshots are frozen or copied before asynchronous plugin composition.

### Global Request Policy

- Fastify receives exact factory values from `fastifyResourceOptionsFromBudget`; proxy trust and incoming request-id trust are disabled, JSON prototype/constructor poisoning fails, and strict router slash/case behavior is explicit.
- Only `application/json` with an optional UTF-8 charset is accepted as a request content type. The default text parser is removed.
- Raw request-target bytes and decoded parameter bytes are bounded. Router-level max-parameter and bad-URL failures use the same global classifier through `frameworkErrors`.
- Route-local `bodyLimit` and `handlerTimeout` are validated during registration and may only be positive, non-extending reductions.
- Route-local validator/serializer compilers are rejected. API/SSE registrations cannot bypass global validation/error handling; the static surface alone permits the pinned plugin's stream-close error handler, which delegates all other failures.
- The request deadline view uses the exact `request.signal` and effective route-local/global handler timeout.
- The app exposes a frozen snapshot of active, maximum, and rejected-overload counts. Admission is synchronous and one request owns one state record.

### Completion State Machine

An admitted request records `handlerStarted`, `handlerSettled`, `responseFinished`, and `finalized`. A slot is released only when:

1. no route handler started and response/abort processing finished; or
2. a handler started, its original sync/Promise lifecycle settled, and response/abort processing finished.

Fastify timeout can finish the response before a noncooperative Promise settles. That request remains counted until the Promise settles. Synchronous handlers retain their original return value and are never converted to async; actual Promises receive a `finally` observer.

### Stable Errors

| Condition | Status | Code |
| --- | ---: | --- |
| Zod request validation | 400 | `validation_error` |
| Malformed JSON/content length/URL | 400 | `malformed_request` |
| Unknown route | 404 | `route_not_found` |
| Wrong method on a known concrete route | 405 | `method_not_allowed` plus `Allow` |
| Body too large | 413 | `request_too_large` |
| Request target or route parameter too large | 414 | `malformed_request` or `validation_error` |
| Unsupported content type | 415 | `unsupported_media_type` |
| In-flight capacity exhausted | 503 | `service_overloaded` |
| Fastify handler deadline | 504 | `operation_timeout` |
| Unknown handler/serializer failure | 500 | `internal_error` plus internal observation |

Every error uses the API error schema and a serializer independent of route response schemas. The generated request id is carried in the header and error details when detail capacity allows. `route_not_found`, `method_not_allowed`, and `unsupported_media_type` are now stable core error codes.

## Validation

| Command / inspection | Result |
| --- | --- |
| Focused app-factory matrix | Pass; 6 tests cover strict config/surfaces, Zod request/response, content type, body/URL/parameter limits, malformed router input, request ids, 404/405, typed/internal errors, no secret leak, in-flight response gating, real handler timeout, and pinned SSE/static registration. |
| Real handler timeout probe | Pass; native timeout becomes `operation_timeout`/504, the exact signal aborts, and the slot remains occupied until cooperative handler settlement. |
| Real static stream regression probe | Pass; sync handler semantics are preserved and the complete fixture body is read before cleanup. |
| `pnpm check:scaffold` / `pnpm check:planning` / `pnpm check:codex-bindings` | Pass; 9 packages/18 scripts, 196 tasks/84 requirements/622 dependencies/6 queued, and exact 0.144.0 identity across 671 files. |
| `pnpm typecheck` and `pnpm -r typecheck` | Pass for root and all 9 packages. |
| `pnpm test:unit` | Pass; 397 tests, 18 explicit external/real-process tests skipped. |
| `pnpm test:contract` | Pass; 111 tests including resolved-policy immutability. |
| `pnpm test:integration` / `pnpm test:web` | Pass; 16 integration and 14 web tests. |
| `pnpm lint` | Pass; 178 files and all 9 package exports. |
| `pnpm audit --prod --json` | Pass; 0 vulnerabilities across 121 production dependencies. |
| `git diff --check` | Pass. |

## Remaining Ownership

- `IFC-V1-023` implements the required Readable-backed SSE transport, negotiation, cursor input, abort/source cleanup, and handler settlement.
- `IFC-V1-024` implements canonical static roots, dot/traversal denial, explicit browser routes, cache/MIME/HEAD policy, and API fallback separation.
- `IFC-V1-025` composes readiness, real listener binding, rollback, drain, and reverse-order close, including Node header/connection options.
- `IFC-V1-017`, `IFC-V1-026`, `IFC-V1-030`, and `IFC-V1-031` add Host/Origin/CORS, trust, CSRF, rate, and mutation admission hooks.
- `IFC-V1-047` and `IFC-V1-050` provide raw-socket resource stress and full HTTP-to-protocol cancellation evidence. This task proves the app-level owner, not those downstream integrations.
