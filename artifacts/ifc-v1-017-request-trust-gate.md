# IFC-V1-017 Request Trust Gate

Date: 2026-07-11

Status: complete.

## Scope

Implement the first non-optional Fastify request trust boundary for transport, request target, Host, Origin, forwarded-header, and CORS policy. The gate produces an internal immutable trust context before any route handler, authentication, storage read, or application dispatch. Cookie/device authentication remains `IFC-V1-026`; CSRF remains `IFC-V1-027`; pairing, revoke, lock, and LAN configuration remain their owning leaves.

## Current Gaps

- `createHostDeckFastifyApp` fixes `trustProxy: false`, but accepts no explicit request trust policy and installs no root Host/Origin gate.
- Route plugins can currently execute for missing, foreign, malformed, or DNS-rebinding Host/Origin inputs.
- Socket transport is not compared with an expected loopback/LAN policy, and spoofed forwarding headers are not rejected explicitly.
- No internal request trust context, rejection snapshot, CORS response guard, or raw-listener hostile-request evidence exists.
- The selected lifecycle still owns loopback HTTP only. `IFC-V1-031` owns LAN/TLS listener configuration; this leaf must provide the policy contract that composition will consume without pretending LAN is already runnable.

## Frozen Policy

One exact immutable policy contains:

- `mode`: `loopback` or `lan`;
- `transport`: `http` or `https`, with `lan` requiring `https`;
- one to eight canonical allowed origins, each bounded to 512 ASCII bytes and using the selected transport.

Each origin must be a canonical bare origin with no wildcard, credentials, path beyond `/`, query, fragment, opaque value, duplicate, or non-default serialization variant. Host authorities are derived only from these configured origins, never from request headers. The current lifecycle derives one loopback HTTP origin from its verified bind; the future LAN owner must provide HTTPS origins already validated against configured certificate identity.

## Hard Success Criteria

| Criterion | Required evidence |
| --- | --- |
| Non-optional composition | Direct app construction requires a valid frozen trust policy. Lifecycle composition derives and injects its current verified loopback origin. Missing, mutable, extra-field, oversized, duplicate, mixed-transport, wildcard, credentialed, path/query/fragment, or LAN-HTTP policy fails before route registration/readiness/listen. |
| Socket transport truth | Trust derives HTTP/HTTPS only from the raw socket, never `Forwarded` or `X-Forwarded-*`. Loopback mode requires a loopback peer; LAN mode rejects plaintext with stable `insecure_transport`/426. Spoofed proxy headers reject and cannot upgrade authority. `trustProxy` remains false. |
| Request-target form | Only bounded origin-form targets beginning with one `/` are admitted. Absolute-form, authority-form, asterisk-form, network-path `//`, control characters, and backslash ambiguity reject before routing. |
| Exact Host | Exactly one nonempty canonical Host header is required and must byte-canonically match an authority derived from the policy for the actual transport. Duplicate, comma-joined, userinfo, path, wildcard, alternate numeric IP, suffix/prefix, trailing-dot, wrong-port, foreign, and malformed values reject without reflection. |
| Origin policy | A present Origin must occur exactly once, be canonical, and exactly match the selected configured origin. Foreign, `null`, malformed, credentialed, path-bearing, trailing-slash, duplicate, and mixed-scheme values reject. Missing Origin is allowed for GET/HEAD; unsafe missing-Origin requests are allowed only from a loopback peer with no browser fetch metadata or CORS-preflight headers and are classified explicitly as local non-browser traffic. |
| CORS disabled | CORS preflight headers reject even with a same-origin value because V1 is same-origin. Successful and rejected requests emit no `Access-Control-Allow-*` or `Timing-Allow-Origin`. A route/plugin attempt to add one is removed and fails visibly through the internal-error path; wildcard credentialed CORS cannot be introduced silently. |
| Gate ordering | Structural request ceilings may run first, but the trust gate completes before route validation/handler, authentication, storage, audit, static send, or SSE source open. Every rejection proves the fixture handler and side-effect counters remain untouched. |
| Trust context | Accepted requests expose one frozen exact-key context containing only configured/canonical authority, actual transport, network mode, and `same_origin`, `safe_no_origin`, or `local_non_browser` origin classification. No raw untrusted header, cookie, token, path, or secret enters the context or durable output. Access before admission fails loudly. |
| Stable failure surface | Syntax/shape violations return bounded non-reflective `invalid_origin`/403; LAN plaintext returns `insecure_transport`/426. Error envelopes retain generated request ids and contain no attacker Host, Origin, target, forwarded value, stack, or route data. |
| Bounded diagnostics | A frozen app snapshot reports accepted requests and invalid-origin, insecure-transport, and forbidden-CORS counts only. It never retains raw headers, origins, addresses, paths, cookies, or response payloads. Counter behavior is exact for repeated rejection and route-level CORS violations. |
| Real HTTP behavior | Injection covers policy/context and the complete hostile matrix. A real loopback listener plus raw sockets prove exact Host, missing/duplicate Host, absolute/network-path targets, foreign Origin, forwarded spoof, route non-dispatch, bounded JSON failures where Node admits the request, and parser-level refusal where Node rejects before Fastify. |
| Ownership boundaries | This leaf does not authenticate a device, grant local-admin authority from a missing Origin, issue cookies/credentials, validate CSRF, configure/enable LAN, read certificate files, add a TLS listener, add a CORS dependency, or expose protected route data. |

## Validation Plan

- Direct policy parser tests for exact fields, canonicalization, bounds, immutability, transport/mode constraints, and hostile origins.
- Pure/injection tests for socket transport, Host, Origin, safe missing-Origin, explicit local non-browser classification, forwarding denial, CORS denial, context shape, counters, redaction, and route non-dispatch.
- Adjacent app/SSE/static/lifecycle/resource regressions to prove every route surface remains gated and resource accounting settles.
- Real loopback HTTP/raw-socket matrix for parser-versus-hook boundaries and generated stable errors.
- Root typecheck/lint, unit/contract/integration/web, planning/scaffold/binding, frozen offline install, production audit, structural dependency review, and manual hook/order/privacy inspection.

## Outcome

- `createHostDeckRequestTrustPolicy` accepts only one exact plain configuration, copies and freezes one to eight canonical origins, binds them to one mode/transport, rejects LAN HTTP and unsafe host/origin forms, and brands the result so the app factory cannot accept a forged lookalike.
- The headless evaluator validates an exact bounded probe, derives transport only from `socket.encrypted`, rejects forwarding headers and non-origin request targets, requires one canonical configured Host, applies exact Origin/missing-Origin policy, and returns only one frozen configured trust context.
- `createHostDeckFastifyApp` now requires the parsed policy and installs one root gate across API, SSE, static, and not-found surfaces while preserving `trustProxy: false`. The selected lifecycle derives its current exact loopback HTTP origin from the verified bind before readiness/listen.
- Stable rejections use redacted `invalid_origin`/403 or `insecure_transport`/426 envelopes and generated request ids. Saturating snapshots retain only accepted, invalid-origin, insecure-transport, and forbidden-CORS counters.
- Same-origin CORS remains disabled without a dependency. Preflight rejects. Handler, child `onSend`, `reply.header(s)`, raw `setHeader`/`appendHeader`/`setHeaders`, and raw `writeHead` attempts cannot emit `Access-Control-*` or `Timing-Allow-Origin`; each becomes one observed bounded internal-error response with the would-be success body replaced. Throwing/rejecting observers cannot alter or leak that response.
- Real loopback raw sockets prove exact configured Host success, redacted foreign Origin/forwarding/absolute-form/network-path rejection, Node-level missing-Host refusal, hook-level duplicate-Host refusal, and no route dispatch. LAN HTTPS same-origin and plaintext refusal are proven headlessly because production LAN listener composition remains `IFC-V1-031`.

## Validation

- Direct request-trust policy/evaluator/hook/raw-listener matrix: 1 file, 12 passed.
- Full server: 35 files and 303 tests passed; 7 explicit external smoke files/tests skipped.
- Unit: 87 files passed and 16 expected external files skipped; 783 tests passed and 29 skipped.
- Contract: 14 files, 139 passed; integration: 2 files, 16 passed; web: 2 files, 14 passed.
- Root typecheck passed. Lint/exports passed for 273 files and 9 packages. Scaffold passed for 9 packages and 18 root scripts.
- Planning closure passed with 196 tasks, 84 requirements, 631 dependencies, and 6 queued entries after queue advancement.
- Exact isolated Codex 0.144.0 binding passed for 671 files at `e1a1a5cff3ab91862f9215dd06538eae1ea0b00bae48cbb7d87061faaee27e24`.
- Frozen offline install passed; production dependency audit reported no known vulnerabilities.
- Manual composition/privacy review passed: the root gate precedes route validation/handlers and body parsing, configured rather than raw authority enters context, response guards cover later child-hook/native mutation, no CORS package exists, no rejected input is reflected or retained, and `git diff --check` passes.

## Remaining Ownership

- `IFC-V1-026` adds explicit cookie/device/local-admin authentication after this context.
- `IFC-V1-027` adds bootstrap and exact current CSRF generation/header checks.
- `IFC-V1-031` validates persisted LAN/certificate state and supplies the HTTPS listener/policy inputs.
- `IFC-V1-033` runs aggregate browser and real-HTTPS security acceptance.
