# FE-V1-024 In-Memory Browser CSRF Lifecycle

Date: 2026-07-22

## Scope

Implement one headless page-memory authority client over the completed bounded browser HTTP client and selected CSRF bootstrap route. This leaf owns explicit bootstrap and pairing-response adoption, one current CSRF token/generation, protected-mutation credential injection, generation arbitration, authority invalidation, cancellation, stable public state, and fake plus real-server evidence.

The client does not own the HttpOnly device cookie, pairing fragment/claim flow, access or remote-health diagnosis, React rendering, durable browser storage, mutation retry, operation-specific recovery, Tailscale control, or production entry wiring. `FE-V1-025` coordinates CSRF state with host/access/profile truth and `FE-V1-031` renders reload and stale-authority recovery.

## Pre-Change Findings

- `POST /api/v1/access/csrf` already rotates the authenticated device's durable generation/hash from its HttpOnly cookie and returns exact `{ csrf_token, csrf_generation, rotated_at }` JSON under no-store/no-cache policy. It accepts read and write devices and needs no prior CSRF header.
- The bounded browser HTTP catalog already contains that rotate route plus exactly 11 `required_for_device` routes. It validates all request/response schemas and can attach exact token/generation headers, but callers currently provide those raw values for each mutation.
- The server invalidates the previous token at rotation commit. A timed-out, aborted, malformed, or lost bootstrap response can therefore hide a committed rotation; restoring the prior browser credential after any attempted rotation would be unsafe.
- The existing pairing helper returns a valid bootstrap credential in page memory, but no owner can consume it without leaving mutation components responsible for token storage and ordering.
- Server bootstrap/storage evidence explicitly leaves page-memory handling, greatest-generation response selection, reload/revoke behavior, and browser proof to `FE-V1-024` and `FE-V1-031`.
- No dependency is needed. The selected Zod contracts and bounded HTTP client already own parsing, transport, byte, deadline, and API-envelope behavior.

## Frozen Design

### Public Port And State

- `createBrowserCsrfClient` requires one branded `BrowserHttpClient` and one operation-id factory. It exposes `snapshot`, `bootstrap`, `adoptBootstrap`, `request`, `invalidate`, and idempotent `close`.
- `request` accepts only the 11 catalog routes whose policy is `required_for_device`; safe reads, local-admin routes, pair routes, bootstrap itself, and caller-supplied token/header options reject before the HTTP port.
- Public immutable snapshots use only `idle`, `bootstrapping`, `ready`, `failed`, and `closed`. They may expose the non-secret current generation and rotation time only while ready, plus one bounded failure or invalidation reason.
- No public result, snapshot, error, observer, serialization, or callback argument contains the raw token. No state port accepts a device cookie, device bearer, origin, profile identity, or Tailscale identity.
- The raw token exists only in the client closure, a transient validated bootstrap response, and the exact HTTP request options handed to the bounded client. Clearing replaces the closure reference immediately; JavaScript string erasure is not claimed.

### Bootstrap And Adoption

- `bootstrap` creates exactly one selected operation id and calls only `csrf_bootstrap`. It sends no CSRF headers, caller URL, device id, generation, or alternate credential.
- Starting a bootstrap first disables and clears the current credential and aborts protected requests from the prior authority epoch. It never restores that credential after failure because the server may have committed rotation without delivering the response.
- At most one bootstrap is owned by a client at a time. Concurrent callers join the same result and do not create another operation id, rotation, fetch, retry, or promise queue.
- `adoptBootstrap` consumes the exact selected response shape produced by pairing/bootstrap without a fetch. Invalid input fails closed. It never returns the raw token.
- A higher positive-safe generation with non-regressing canonical `rotated_at` replaces the current credential. A lower generation is discarded as stale. An exact duplicate is idempotent; equal generation with different token/time is contradictory and clears authority.
- Generation gaps are valid because another page may have rotated in between. A response from an invalidated/closed/older authority epoch is discarded even if its generation is numerically higher.

### Protected Mutations

- A mutation starts only from `ready`, snapshots the current authority epoch, and calls the bounded HTTP client once with the internally owned token plus canonical decimal generation. No caller can override either value.
- Client/bootstrap/adoption/invalidation never invents or retries a product mutation. A transport timeout, response loss, retryable envelope, or uncertain operation outcome is returned once and preserves the credential unless authority itself became invalid.
- `permission_denied`, `read_only`, or `operation_conflict` from a protected mutation conservatively clears authority because the current API envelope cannot distinguish CSRF/device invalidation from later route conflict. Recovery is an explicit bootstrap; no error path starts it automatically.
- Other validation, target, lock, runtime, audit, storage, transport, deadline, capacity, or response failures do not silently rotate, retry, or claim authority loss.
- Invalidation/adoption/bootstrap/close aborts active mutation fetches. A late response cannot publish success after its authority epoch changed; server-side completion is not undone or relabeled as proven failure.

### Invalidation And Lifetime

- Exact explicit invalidation reasons cover access loss, remote/profile authority change, device revoke, pairing replacement, and caller reset. The client diagnoses none of them itself; the downstream coordinator supplies the proven reason.
- Pairing replacement opens a new authority epoch and permits a new device generation to start at one. Other invalidations preserve no raw credential and do not imply a new device.
- Page reload naturally creates a fresh `idle` client with no credential. The module does not read or write `localStorage`, `sessionStorage`, IndexedDB, cookies, Cache Storage, history, URL, service workers, globals, logs, or DOM data attributes.
- `close` aborts bootstrap and mutation work, releases listeners/controllers/references once, clears the token, transitions permanently to `closed`, and permits no later fetch or adoption.

## Stable Failure Model

Public failures retain only operation kind, optional protected route id, reason, transport, optional status, and optional validated API envelope. They never retain input bodies, operation ids, token/generation headers, raw responses, raw causes, origins, device identity, or profile/network identity.

| Reason | Meaning |
| --- | --- |
| `client_contract` | Constructor, operation-id, adoption, route, input, options, or impossible lifecycle state violated the client contract. |
| `not_ready` | A protected mutation was requested without current ready authority. |
| `caller_aborted` | The mutation caller cancelled before a result. |
| `authority_changed` | Invalidation, adoption, bootstrap, or close superseded in-flight work. |
| `bootstrap_unavailable` | Bootstrap transport, deadline, capacity, or service failure produced no usable credential. |
| `invalid_response` | The bounded HTTP client rejected bootstrap response framing or schema. |
| `authority_rejected` | Paired-cookie/device authority was denied or became read-only/revoked/expired. |
| `stale_generation` | Bootstrap or mutation conflicted with newer authority. |
| `api_error` | A validated non-authority API failure occurred with no automatic recovery. |
| `closed` | Work was attempted after permanent client close. |

## Acceptance Matrix

| ID | Criterion |
| --- | --- |
| `BCS-01` | The browser catalog exposes exactly one rotate route and 11 protected mutation route ids, and the lifecycle matches those policies without a production server import. |
| `BCS-02` | Constructor, ports, operation ids, adoption values, routes, inputs, options, signals, getters, and impossible states fail before fetch without retaining hostile values. |
| `BCS-03` | Initial/page-reload state contains no authority; exact bootstrap uses one operation id, one fixed HTTP-client route, no prior CSRF, and one immutable ready snapshot. |
| `BCS-04` | Concurrent bootstrap calls are single-flight; only one operation id/rotation/request occurs and all callers settle consistently without an unbounded waiter structure. |
| `BCS-05` | Starting any rotation clears old authority first; abort, timeout, transport loss, malformed/oversized response, retryable/nonretryable API failure, and response loss never restore or expose it. |
| `BCS-06` | Pairing/bootstrap adoption validates exact token/generation/time and implements higher/lower/equal/gap ordering, timestamp monotonicity, contradiction rejection, and immutable token-free results. |
| `BCS-07` | Old-epoch responses after reset, profile/access change, re-pair, revoke, newer adoption, or close cannot overwrite current state or publish a stale credential. |
| `BCS-08` | Every one of the 11 protected routes receives the exact current token and canonical generation once; every non-protected route and caller credential override rejects before HTTP dispatch. |
| `BCS-09` | Mutation request contract, caller abort, deadline, transport, response, API, retryable, and uncertain-outcome failures never retry the write or automatically bootstrap. |
| `BCS-10` | Permission/read-only/conflict failures clear authority conservatively; unrelated failures preserve it; all recovery remains explicit and observable. |
| `BCS-11` | Invalidation and close abort bootstrap plus all active mutations, reject late success by epoch, release listeners/controllers/references, and remain idempotent under repeated/racing calls. |
| `BCS-12` | Public snapshots/errors/results are deeply immutable, bounded, and free of token, cookie, bearer, operation id, origin, device/profile/Tailscale identity, raw body, and raw cause data. |
| `BCS-13` | Static/runtime inspection proves no browser durable storage, cookie API, history/URL credential, global credential, logging, service worker, alternate transport, hidden retry, or UI ownership. |
| `BCS-14` | Real selected Fastify bootstrap and a selected protected mutation pass over native loopback and production admitted-Serve trust/auth contexts, including reload rotation, stale old page, revoke/authority denial, and cleanup. |
| `BCS-15` | Profile/access invalidation evidence uses an injected proven reason and stale-generation boundary without mutating live Tailscale/profile/Serve/phone state or inventing diagnosis. |
| `BCS-16` | Focused tests, web/workspace gates, Vite/runtime/package boundaries, frozen install, audit, manual privacy/no-retry review, and zero listener/timer/process residue pass. |

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

Criteria frozen before implementation. Implementation and terminal evidence remain pending.
