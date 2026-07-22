# FE-V1-019 Bounded Browser HTTP Client

Date: 2026-07-22

## Scope

Implement one headless browser HTTP foundation for the selected HostDeck JSON API. This leaf owns a typed route catalog, exact request construction, current-document origin enforcement, bounded fetch/body handling, stable public failures, and fake plus real-server evidence.

The selected manifest contains 35 routes. This leaf owns all 34 `json` routes. `session_event_stream` remains exclusively owned by `FE-V1-023`; pairing-fragment orchestration and in-memory CSRF generation remain with `FE-V1-024`; coordinated host/access/session diagnosis remains with `FE-V1-025`. No React screen, retry policy, storage, Tailscale control, or production entry wiring is added here.

## Pre-Change Findings

- `packages/web/src/pairing-bootstrap.ts` has a route-specific bounded JSON reader, but it has no composed deadline, in-flight ceiling, typed route catalog, or bounded transport-cause model. It is not called by the production entry.
- The selected server manifest identifies request and response schemas but intentionally lives in `@hostdeck/server`; production browser code must not import the server package.
- The resource registry has no browser-client owner. Selected JSON response enforcement currently reuses `cli_response_max_bytes`, which gives a server response concern the wrong owner before a browser consumer exists.
- Native browser fetch can report offline, certificate, DNS, Tailscale/profile transition, proxy loss, and connection refusal through the same rejected promise. The client cannot truthfully distinguish those causes before a HostDeck response loads.
- Readiness is a typed response at both HTTP 200 and 503. Treating every non-2xx response as an error envelope would corrupt selected API semantics.

## Frozen Design

### Typed Route Catalog

- `@hostdeck/web` owns one browser-safe catalog for every selected JSON route. Each entry binds exact route id, method, path template, request schema ids and Zod schemas, response schema id and Zod schema, CSRF policy, and accepted success statuses.
- A contract test compares the catalog to the production `selectedApiRouteManifest`; missing, extra, method/path/schema/CSRF drift, or accidental SSE admission fails.
- The generic request API infers exact params/query/body/options and response data from the selected route id. Request containers and nested schemas reject unknown or malformed data before fetch.
- Paths come only from catalog templates. Parameters are validated and encoded once; query keys are allowlisted and canonically encoded. Callers cannot supply a URL, origin, method, cookie, authorization value, or arbitrary header.
- The readiness route accepts its selected 200/503 typed body. Every other success status is exact; unexpected success or redirect output is invalid.

### Origin And Credential Boundary

- The client snapshots one canonical current-document origin at construction. Selected HTTP means an IPv4 loopback origin with an explicit port; selected HTTPS means one canonical private Tailscale `*.ts.net` origin.
- Requests use only root-relative selected paths with `mode: "same-origin"`, `credentials: "same-origin"`, `redirect: "error"`, `cache: "no-store"`, and `referrerPolicy: "no-referrer"`.
- Device cookies remain browser-managed and inaccessible. CSRF-required route types accept one validated raw CSRF value and place it only in the selected header for that request; no result or error retains it.
- Local-admin-only manifest routes remain typed because they are selected API routes, but the client never fabricates a local-admin header or treats Tailscale identity as HostDeck authority.

### Resource Contract

- Add generic `http_response_max_bytes` ownership for selected JSON server output and migrate server-side response enforcement away from the CLI key.
- Add browser-client request timeout, request-body bytes, response bytes, and in-flight request limits to the shared resource registry. Reviewed defaults are 35 seconds, 64 KiB, 1 MiB, and 8 requests.
- Cross-field checks require browser timeout to cover the server request deadline, browser request bytes to fit the server body limit, browser and CLI response limits to cover the selected HTTP response limit, and browser concurrency to fit the server HTTP ceiling.
- A caller signal may shorten work but never extend the selected deadline. Timer and signal listeners are removed after every terminal path. Capacity is released exactly once.
- JSON is streamed under the byte cap, decoded as fatal UTF-8, and parsed once. Declared oversize is rejected before reading; chunked or underdeclared overflow is cancelled while reading.

### Stable Failure Model

The public client error contains only route id, current transport (`http` or `https`), bounded reason, optional HTTP status, and an optional validated HostDeck error envelope. It never retains a raw exception, URL/origin, request body, request headers, cookie, CSRF token, Tailscale identity, or response bytes.

| Reason | Meaning |
| --- | --- |
| `request_contract` | Params, query, body, options, or required CSRF data failed before dispatch. |
| `request_too_large` | Encoded JSON exceeded the selected browser request limit. |
| `capacity_exhausted` | The per-client in-flight ceiling rejected the request before fetch. |
| `caller_aborted` | The caller signal ended the operation. |
| `deadline_exceeded` | The client-owned outer deadline elapsed. |
| `transport_unavailable` | Fetch failed without a trusted HostDeck response; no offline/profile/Tailscale diagnosis is invented. |
| `invalid_response` | Status, headers, media type, UTF-8, JSON, success schema, or error schema was invalid. |
| `response_too_large` | Declared or streamed response bytes exceeded the selected cap. |
| `api_error` | A non-success response carried the exact selected HostDeck error envelope. |

## Acceptance Matrix

| ID | Criterion |
| --- | --- |
| `HTTP-01` | Exactly 34 selected JSON route contracts are present and match the server manifest; the one SSE route is absent and remains downstream. |
| `HTTP-02` | Route-id inference gives every route exact params/query/body/CSRF input and typed response output; malformed or extra request data performs zero fetches. |
| `HTTP-03` | Fixed route templates safely encode params and allowlisted query values without double encoding, path traversal, duplicate keys, fragments, or caller-controlled origins. |
| `HTTP-04` | Only canonical current-document loopback HTTP and private Tailscale HTTPS origins construct; every request is root-relative, same-origin, credentialed only by the browser, no-store, no-referrer, and redirect-denying. |
| `HTTP-05` | The shared registry owns generic HTTP response plus browser timeout/body/response/concurrency limits with exact metadata, defaults, ranges, and cross-field invariants. |
| `HTTP-06` | Caller abort before fetch, during fetch, and during body read; deadline during fetch/read; repeated abort; and normal completion all settle once and release timer/listener/capacity ownership. |
| `HTTP-07` | Exact and over request bytes, declared response bytes, fixed/chunked streamed bytes, zero/invalid chunks, missing body, and cancellation failure remain bounded. |
| `HTTP-08` | Exact JSON media type, fatal UTF-8, JSON syntax, strict success schema, exact status, readiness 503, and strict error envelope are enforced without fallback parsing. |
| `HTTP-09` | Offline, connection refusal, DNS/certificate-like rejection, and simulated profile/Serve transition map only to `transport_unavailable`; HTTP and HTTPS remain distinguishable without exposing origin or raw cause. |
| `HTTP-10` | A valid error envelope maps to `api_error`; malformed/oversized non-success bodies never become fabricated API errors. |
| `HTTP-11` | GET and POST dispatch once. Retryable envelopes, network failures, timeout, abort, and uncertain mutations never trigger automatic retry or duplicate fetch. |
| `HTTP-12` | Errors/results/object graphs and serialized diagnostics contain no cookie, raw CSRF, pairing code, request body, Tailscale identity, origin, private server response bytes, or raw exception. |
| `HTTP-13` | A real selected Fastify API passes through native loopback HTTP and an exact admitted-Serve proxy context, including paired HTTPS read and denial, without changing live Tailscale/profile/Serve state. |
| `HTTP-14` | Focused tests, web/workspace gates, production build/boundary, package validation, audit, manual source/privacy review, and zero test listener/timer residue pass. |

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

Implementation and final evidence are pending.
