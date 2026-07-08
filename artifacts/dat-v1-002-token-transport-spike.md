# DAT-V1-002 Dashboard Token Transport Spike

Date: 2026-07-08

## Decision

- Use an opaque device token stored in a host-only `HttpOnly` cookie for the browser dashboard.
- Store only a hash of the device token in local storage.
- Use a server-issued CSRF token in same-origin write headers for trusted writable browser state.
- Reject bearer tokens in `localStorage`, `sessionStorage`, or durable JavaScript-managed browser storage for V1.
- Keep unlock CLI-only; dashboard state can lock writes but cannot remotely unlock.

## Cookie And Header Contract

- Pair claim flow:
  1. CLI or local admin path creates a short-lived one-time pairing code.
  2. Dashboard posts the code to the same-origin pair-claim endpoint.
  3. Server stores only the hashed device token, sets the raw opaque token in an `HttpOnly` host-only cookie, and returns trust state plus a non-secret CSRF token for write headers.
- Cookie attributes:
  - Host-only cookie: no `Domain` attribute.
  - `Path=/`.
  - `HttpOnly`.
  - `SameSite=Strict`.
  - `Max-Age` bounded by the stored device expiry.
  - `Secure` when served over HTTPS or localhost where the browser accepts it; explicit LAN-over-HTTP mode cannot claim transport confidentiality.
- Write request requirements:
  - Same-origin dashboard/API request.
  - Valid HttpOnly cookie device token.
  - `Origin` must match the dashboard origin when present.
  - `X-HostDeck-CSRF` header must match the server-side token bound to the authenticated device.
  - No wildcard credentialed CORS. Cross-origin credentialed browser requests are not part of V1.

## Contract Updates

- `trustStateSchema` now includes:
  - `auth_transport`: `"none"` or `"http_only_cookie"`.
  - `csrf_token`: nullable bounded token string.
- Trusted writable browser state must use `auth_transport: "http_only_cookie"` and include a CSRF token.
- Untrusted state must use `auth_transport: "none"` and no CSRF token.
- Read-only, locked, or otherwise write-disabled browser state must not expose a CSRF write token.

## Options Rejected

| Option | Reason |
| --- | --- |
| Bearer token in `localStorage` | Durable JavaScript-readable token raises XSS blast radius and creates harder revocation/cleanup behavior for the V1 browser dashboard. |
| Bearer token in `sessionStorage` | Better lifetime than `localStorage`, but still JavaScript-readable and not needed when same-origin cookie transport works. |
| Bearer token held only in memory | Reduces durable leakage but loses trust on refresh and complicates phone UX without materially improving V1 local threat posture. |
| Cookie alone without CSRF token/header | Ambient cookies can be sent automatically by the browser; V1 writes need an explicit same-origin header/token gate. |
| Remote dashboard unlock | Violates the V1 safety boundary; unlock remains CLI-only local admin behavior. |

## Security Notes

- SameSite is a partial CSRF defense, not the only defense.
- CORS must not expose credentialed API responses to wildcard or unapproved origins.
- CSRF tokens are not sent in URLs and are not durable browser credentials.
- LAN mode is explicit and visible, but HTTP LAN cannot be treated as confidential transport. Release security review must call this out unless HTTPS is added later.
- Pairing codes are short-lived and one-time; device tokens are revocable without deleting sessions or audit history.

## Sources

- OWASP CSRF Prevention Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html
- MDN Set-Cookie reference: https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie
- MDN secure cookie configuration: https://developer.mozilla.org/en-US/docs/Web/Security/Practical_implementation_guides/Cookies
- MDN CORS guide: https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS
- MDN Access-Control-Allow-Credentials: https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Access-Control-Allow-Credentials

## Validation

- `pnpm install --frozen-lockfile`
- `pnpm check:scaffold`
- `pnpm typecheck`
- `pnpm -r --if-present typecheck`
- `pnpm lint`
- `pnpm test`: 6 files, 43 tests passed.
- `pnpm test:unit`: 6 files, 43 tests passed.
- `pnpm test:contract`: 4 files, 37 tests passed.
- `git diff --check`

## Follow-On Task Updates

- `DAT-V1-013` auth repository work can start after `DAT-V1-010` because token transport is now resolved.
- `IFC-V1-005` must implement cookie setting/clearing, same-origin CSRF header validation, origin checks, and remote unlock rejection.
- `FE-V1-013` must render trust/read-only/locked/expired/revoked states from the trust contract and use the CSRF token only for same-origin writes.
