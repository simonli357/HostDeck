# IFC-V1-077 Fragment-Safe Pairing Evidence

## Outcome

- Implementation and physical Android acceptance are complete. The selected path was exercised through a real in-memory QR, private Tailscale Serve HTTPS, Android Chrome, Fastify, and SQLite without a custom CA or LAN fallback.
- The shared contract accepts one canonical private Tailscale HTTPS root URL with an exact 128-bit pairing code solely in `#pair=...`. Query, path, encoded, duplicate, noncanonical, userinfo, explicit-port, and non-private origins reject.
- `codexdeck pair` now uses only the bounded loopback API. It requires remote state to remain ready at the same generation and origin around exactly one audited pairing-code issue, then renders a bounded terminal QR plus text fallback. It has no JSON or caller-selected TTL mode.
- Browser bootstrap reads the fragment once, synchronously replaces browser history with `/` before operation-id creation or fetch, validates the selected origin and route, submits one bounded no-referrer claim, clears mutable request references after fetch acceptance, and performs one in-memory CSRF bootstrap after successful claim.

## Security And Failure Inspection

- Readiness loss, generation/origin drift, malformed issue response, typed API failure, loopback violation, QR failure, and post-issue status failure reveal no link and never retry.
- Missing or malformed fragments, wrong origin/path/query, history failure, operation-id failure, unavailable fetch, hostile response accessors, malformed or oversized responses, synchronous/asynchronous network failure, claim rejection, CSRF failure, reload/back/forward, and two-tab races have bounded typed outcomes.
- Claim transport ambiguity never retries. CSRF failure after a committed claim reports paired-without-CSRF and never submits the one-time code again.
- The real selected Fastify composition proves audited issue, claim, and CSRF terminal success; one SQLite device; one consumed pairing record; hardened device-cookie publication; and raw pairing, bearer, and CSRF secret absence from audit rows and SQLite bytes.
- Manual source inspection found no pairing-path console logging, local/session storage, IndexedDB, JavaScript cookie access, or logger call. Browser requests use same-origin credentials, no-store cache, redirect rejection, and `no-referrer`.

## Automated Evidence

- Focused CLI/browser/server matrix: 37 tests passed after response-accessor and request-bound hardening; the selected real Fastify/SQLite composition contributes 8 of those tests.
- Chromium boundary: `pnpm test:browser:pairing` passes 3 cases for URL scrubbing plus reload/back/forward, two-tab one-device race, and one-attempt network failure.
- Workspace: typecheck passed; lint/exports passed for 390 files and 9 packages; unit 1,243 passed with 36 explicit external/device skips; contract 249 passed; integration 16 passed; web 33 passed; Chromium 3 passed.
- Structure and planning: scaffold passed for 9 packages and 18 scripts; planning passed for 212 tasks, 84 requirements, 649 dependencies, and 16 queued tasks.
- Supply chain: frozen offline install passed; production and full audits report no known vulnerabilities. Exact `qrcode` 1.5.4 is MIT; exact `@playwright/test` 1.61.1 is Apache-2.0; exact Vite 8.1.4 is MIT.
- Diff whitespace, terminal-output size, link/QR payload identity, request/response byte limits, route-manifest ownership, history/referrer ordering, audit privacy, and SQLite privacy checks pass.

## Physical Android Evidence

- `pnpm smoke:pairing-android` passed one opt-in 80.16-second physical case on the authorized Android 16 target. The user scanned and opened the QR; no raw link, code, bearer, CSRF token, private DNS value, or device identity entered ADB/CDP arguments, files, logs, screenshots, artifacts, or test output.
- The run proved one consumed code and one device, history scrub before the claim request, no fragment in the claimed URL/visible DOM/referrer/resource entries, no browser storage or JavaScript-visible cookie, one no-referrer claim and CSRF bootstrap, final Secure/HttpOnly/host-only/SameSite-Strict cookie publication, and a protected read.
- Reload retained only HttpOnly device authority and returned the explicit no-fragment state. Targeted site-data clearing removed authority and changed the protected read to 401. The raw SQLite main/WAL/SHM scan found no issued code, device token, or CSRF token.
- The acceptance harness resolves the target camera and Chrome activities, closes only stale same-origin HostDeck tabs while Serve is absent, keeps the intentionally short observation lease current with real status reads, and fails on proxy, Chrome, secret-retention, audit, cleanup, or adapter drift. That acceptance-only lease keeper does not substitute for production lifecycle ownership in `IFC-V1-078`.
- Final cleanup proved no Tailscale Serve mapping and no ADB forward. Temporary browser/database/QR state and inspection screenshots were removed.

## Remaining Aggregate Gate

- `IFC-V1-079` still owns the broader different-network Android matrix: one bounded write, SSE disconnect/reconnect, revoke, profile-away/recovery, company-profile noninterference, listener/process/storage inspection, and aggregate cleanup. This task-local scan does not substitute for that release gate.
