# IFC-V1-059 Paired-Device Revoke

Date: 2026-07-13

Status: complete. Implementation: `276303d`.

## Scope

Implement and harden the exact selected paired-device revoke route, including durable revoke, live process-authority invalidation, concurrent HTTP/CSRF/SSE behavior, self-revoke cookie deletion, accepted-to-terminal audit truth, and secret-free failure handling. The aggregate physical Android security matrix remains `IFC-V1-033`.

## Result

- Added exact strict params, request, response, and durable-result contracts for `POST /api/v1/access/devices/:device_id/revoke`.
- Added one branded active-device-authority policy with per-request leases, synchronous per-device invalidation, late-acquisition denial, isolated device scope, abort signals, and saturating count-only diagnostics.
- Integrated active authority into lazy request authentication. Successful protected responses recheck the same live authority before publication, request cleanup releases leases, and only an exact self-revoke response can use the narrow invalidated-authority bypass.
- Added a request-stable authority signal and composed it with the request signal for SSE source opening and delivery. Revocation closes streams that are already active and sources that are still opening.
- Added the exact route through the selected write gate and security audit executor. Accepted audit precedes one durable revoke; live authority invalidation follows durable truth; terminal proof precedes response and cookie publication.
- Added one exact Secure, HttpOnly, host-only, SameSite=Strict deletion cookie for audited self-revoke success. Other-device, conflict, failed, incomplete, serialization, and terminal-audit failure paths emit no cookie.
- Kept session state untouched and responses, audits, counters, errors, raw storage, and test evidence free of bearer, CSRF, cookie, label, session, and private-cause values.

## Policy And Ordering

| Boundary | Proven behavior |
| --- | --- |
| Admission | Exact manifest route, bounded device id, `{ operation_id, confirmed: true }`, admitted trust, local admin or paired writer, and current paired CSRF only. |
| Self/final device | A paired writer or local admin may revoke any selected device, including itself and the final paired device; loopback local admin remains recovery authority. |
| Existing state | Already revoked or missing targets return visible `409 operation_conflict`; storage corruption/unavailability never becomes success. |
| Audit | One accepted record precedes durable mutation; matching succeeded, failed, or incomplete terminal truth follows without redispatch. |
| Live authority | Fresh durable revoke synchronously closes all target leases and rejects later target lease acquisition while leaving other devices and local admin unaffected. |
| Concurrent HTTP | A target request invalidated before publication cannot return protected success. The selected write gate rechecks authority immediately before dispatch. |
| CSRF | A bootstrap whose durable rotation loses to revoke cannot publish the rotated raw token. |
| SSE | Revocation aborts the same composite signal used while opening and while streaming, then closes the Readable/source for only the target device. |
| Self response | Only the audited self-revoke response can finish after its own lease invalidates, and only that 2xx response receives the exact deletion cookie. |
| Privacy | Success contains only operation id, target id, durable revoke time, invalidation truth, and self-revoke truth. No session row is deleted. |

## Failure And Concurrency Evidence

- Real HTTPS, SQLite, CSRF, authentication, audit, and route composition proves other-device and final-device self revoke.
- Same-target concurrent operation ids produce exactly one `200` and one `409`, one durable first revoke, and matching terminal audit outcomes.
- A slow protected response authenticated before revoke is replaced with stable `401 permission_denied`; protected body data is not published.
- An active SSE stream closes its iterator after revoke without closing an actor device request.
- An SSE source authenticated while still opening observes authority abort and publishes no event.
- A CSRF bootstrap rotated before injected durable revoke publishes neither the token nor a cookie and returns stable denial.
- Terminal-audit failure after durable revoke returns `503 audit_unavailable`, leaves the audit trail pending, retains invalidated authority, and publishes no success/cookie.
- Malformed, unpaired, read-only, stale-CSRF, missing, repeated, and contradictory inputs stop at their owning boundary.
- Raw SQLite/WAL/SHM and HTTP evidence excludes test bearer and CSRF values; the preserved session row is byte-for-byte unchanged across revoke.

## Validation

- Direct revoke route: 9 tests passed.
- Authority lifecycle, authentication, SSE, selected write gate, revoke route, CSRF, and revoke storage: 70 tests passed.
- Unit: 995 passed, 29 explicitly skipped external tests.
- Contract: 177 passed.
- Integration: 16 passed.
- Web: 14 passed.
- All nine package typechecks passed.
- `pnpm lint`, package exports, scaffold, and planning checks passed.
- The reviewed Codex 0.144.0 binding passed against an isolated cached 0.144.0 binary: 671 files and the committed SHA-256 identity matched. The user's default 0.144.3 binary was not modified.
- `pnpm install --frozen-lockfile --offline` passed.
- `pnpm audit --prod` reported no known vulnerabilities.
- Biome, staged scope, whitespace, secret-pattern, hook ordering, cookie construction/publication, authority ownership, failure mapping, and raw privacy inspection passed.

## Remaining Ownership

- `IFC-V1-033` owns the aggregate injection plus physical Android browser security matrix and listener/cookie/database/log inspection.
- `IFC-V1-035` owns bounded subscriber queues and aggregate disconnect/revoke/archive cleanup beyond the exact stream-authority closure proved here.
- `IFC-V1-049` owns cross-route idempotent prior-response behavior and global/per-device/target concurrency ceilings beyond the accepted-audit and same-target race evidence here.
