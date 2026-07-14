# IFC-V1-077 Fragment-Safe Pairing Evidence

## Outcome

- Automated implementation is complete in `1a22576`; the task remains `in_progress` until a real Android phone scans and claims a generated link.
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
- Workspace: typecheck passed; lint/exports passed for 388 files and 9 packages; unit 1,243 passed with 35 explicit external/device skips; contract 249 passed; integration 16 passed; web 33 passed.
- Structure and planning: scaffold passed for 9 packages and 18 scripts; planning passed for 212 tasks, 84 requirements, 649 dependencies, and 17 queued tasks before this status update.
- Supply chain: frozen offline install passed; production and full audits report no known vulnerabilities. Exact `qrcode` 1.5.4 is MIT; exact `@playwright/test` 1.61.1 is Apache-2.0; exact Vite 8.1.4 is MIT.
- Diff whitespace, terminal-output size, link/QR payload identity, request/response byte limits, route-manifest ownership, history/referrer ordering, audit privacy, and SQLite privacy checks pass.

## Remaining Physical Gate

- `adb devices -l` returns no attached device, and the phone does not appear in the laptop USB inventory. This is below Android authorization, so unlocking cannot resolve it.
- No real-phone scan, claim, screenshot, reload, or browser-memory inspection is claimed. Restore USB data enumeration, then run the generated QR through the target phone and record only redacted evidence.
- `IFC-V1-079` still owns the broader different-network Android matrix: read, bounded write, SSE reconnect, revoke, profile-away/recovery, noninterference, and cleanup.
