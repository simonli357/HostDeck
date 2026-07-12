# IFC-V1-027 CSRF Bootstrap And Browser-Write Boundary

Date: 2026-07-12

Status: hard-success criteria frozen; execution pending.

## Purpose

Implement the selected `POST /api/v1/access/csrf` bootstrap route and one reusable browser-write CSRF verifier over the completed request-authentication context, auth-device rotation state, route manifest, and security-mutation audit executor. A browser reload must recover writable posture from its HttpOnly device cookie without exposing the bearer token, while stale, foreign, revoked, expired, malformed, or read-only authority must not pass a selected mutation gate.

## Architecture Resolution

`IFC-V1-026` intentionally clears the raw device bearer from private request state as soon as cookie authentication resolves. The completed storage rotation and historical browser-write methods accept the raw bearer. This task must not weaken the earlier privacy boundary by retaining, copying, decorating, returning, or re-exposing that bearer.

Add a narrowly scoped authenticated-device CSRF repository capability instead:

- input comes only from a validated paired request context and contains selected device id, exact expected CSRF generation, operation time, and raw CSRF token only for write verification;
- each immediate transaction re-reads the device by id and revalidates complete row shape, expiry, revocation, permission, expected generation, and token hash before mutation or trusted return;
- bootstrap rotation generates a fresh selected 32-byte token, persists only its hash plus generation/time, and returns raw token only after commit;
- browser-write verification advances `last_used_at` monotonically only after every authority and CSRF check passes;
- the older bearer-based repository methods remain for their existing contracts and tests, but selected Fastify code uses only the authenticated-device capability after cookie authentication.

This is an application-boundary capability, not a general id-as-authentication API. No browser-controlled device id is accepted; the device id and generation come exclusively from the private validated request context.

## Frozen HTTP Contract

| Field | Contract |
| --- | --- |
| Manifest | Exact existing `csrf_bootstrap` entry: `POST /api/v1/access/csrf`, JSON, `device_cookie`, `csrf_rotate`, `rotate`, no lock gate, authenticated-device target, `csrf_bootstrap` security audit, `rotate_csrf`, owner `IFC-V1-027`. |
| Request body | Exact JSON object `{ operation_id }`; `operation_id` uses the selected client-operation id contract. No token, device id, generation, confirmation, or unknown key is accepted. |
| Success | HTTP 200 exact body `{ csrf_token, csrf_generation, rotated_at }`; token is exactly 43 unpadded base64url characters, generation is positive-safe, and time is canonical ISO. |
| Cache/privacy headers | Every bootstrap response path sets `Cache-Control: no-store` and `Pragma: no-cache`. Success sets no cookie, redirect, URL token, bearer value, or JavaScript-readable durable credential. |
| Authentication | Exact paired device cookie is required. Read and write devices may bootstrap. Local admin, unpaired, invalid, expired, and revoked contexts cannot rotate. Host lock is intentionally not applicable. |
| CSRF input | Bootstrap requires no prior CSRF token or generation. Same-origin request trust plus paired-cookie authentication protects the recovery endpoint. |
| Route shape | Exact path/method/case/trailing-slash behavior; no implicit HEAD or alternate endpoint. Authentication and no-store headers precede body validation/handler work. |

## Frozen Browser-Write Header Contract

- Raw header names are case-insensitive HTTP names `X-HostDeck-CSRF` and `X-HostDeck-CSRF-Generation`.
- A paired-device mutation requires exactly one raw occurrence of each header. The token is exact selected 43-character base64url; generation is canonical unsigned decimal for a positive safe integer, with no sign, whitespace, leading zero, exponent, fraction, comma list, alternate encoding, or normalization.
- Duplicate raw fields, combined values, missing values, empty/quoted/percent-encoded/Unicode values, wrong token length/alphabet, and malformed/overflow generations reject before the CSRF repository and before lock, target, audit, or dispatch.
- The generation header must equal the authenticated request context generation before storage. The immediate storage transaction then proves that generation is still current and that the token hash belongs to that same device.
- Local-admin requests have no ambient cookie and bypass device CSRF only where a manifest route explicitly permits local admin. Paired read-only devices never bypass CSRF or write permission. Device-cookie-only routes never gain local-admin fallback.
- Successful verification returns only a frozen non-secret authorization receipt. Raw headers/tokens, hashes, labels, rows, and native causes never enter request decorations, logs, diagnostics, audit summaries, errors, or receipts.

## Bootstrap Audit Sequence

1. Request trust and paired-cookie authentication resolve a frozen read/write device context.
2. Exact body validation yields the client operation id.
3. The security executor records accepted `csrf_bootstrap` with actor device/permission/origin, same-device target, and `{ schema_version: 1, csrf_generation_before }`.
4. The authenticated-device repository rotates only if the context generation is still current and authority remains usable.
5. The transition validates exact returned device/generation/time/token coherence and supplies `{ schema_version: 1, csrf_generation_after, rotated: true }`.
6. The executor records terminal succeeded before the route returns the prepared response.
7. Known failed rotation records failed; an outcome that cannot be proven records incomplete. Audit preflight failure invokes no entropy/storage rotation. Terminal-audit or response-preparation failure never invents a delivered token or retries rotation.

Authentication or malformed-body rejection before a trusted actor and valid operation id exists has no fabricated audit trail. Once accepted is durable, every path must end terminal or remain explicit pending for startup reconciliation.

## Hard Success Criteria

| Criterion | Required evidence |
| --- | --- |
| Exact selected contracts | Public request/response/header schemas are strict, bounded, dependency-free, and exported. Operation id, token, generation, and timestamp canonicality pass exact/near-boundary/hostile tests. No historical `trustStateSchema` shape becomes the selected response. |
| Manifest lock | Route construction asserts every frozen manifest field, including audit and credential effect, before registration. Missing/duplicate/mutated/contradictory manifest truth fails startup. |
| Constructor/port safety | Route/policy inputs and ports use exact own data descriptors, fixed keys, detached invocation, sync-only storage results, and frozen bounded outputs. Accessors, proxies, inherited keys, Promise/thenable results, mutable/partial/extra objects, and incoherent values fail before response. |
| Authenticated-device storage | Contextual rotate/write transactions validate selected device id, expected generation, canonical time, complete durable row, current expiry/revocation, permission, token hash, and monotonic state. Wrong device/token/generation, read-only write, exhausted generation, corrupt row, invalid entropy/time, closed/read-only storage, forced update/commit failure, and unavailable storage leave no trusted result or partial mutation. |
| Rotation races | Two contexts at one generation serialize to one generation transition winner; a later request may rotate the resulting generation again, but only the greatest committed generation/token is current. Response generation lets clients discard out-of-order stale responses. Revoke-first and rotate-first orderings preserve one legal durable authority state. |
| Write races | Rotation/revoke committed before write verification rejects stale authority. Verification committed first is one valid linearization point and does not claim to cancel an already admitted request retroactively. Concurrent newer/older last-used observations remain monotonic with no retry. Long-lived/SSE rechecks remain downstream. |
| Header parser | Zero/one/duplicate raw headers, mixed case, unrelated headers, odd raw arrays, comma joins, whitespace, alternate encodings, exact/over lengths, canonical generation, and hostile arrays have deterministic outcomes without reading storage on rejection. Header values are never reflected. |
| Authorization order | Request/resource/trust and cookie authentication precede CSRF. Paired write permission and header syntax precede contextual storage authorization; storage success precedes lock/target/audit/dispatch in consuming route fixtures. Local-admin bypass occurs only from exact prior context plus manifest policy. |
| Bootstrap route | Exact POST/path/body/response/no-store/no-cache/no-Set-Cookie behavior passes injection and real raw-listener tests. Read/write devices rotate; local admin/unpaired/invalid/expired/revoked fail. Wrong method, HEAD, trailing slash, case, content type, malformed JSON, and unknown body fields never rotate. |
| Truthful audit | Accepted precedes entropy/rotation. Succeeded/failed/incomplete summaries match durable mutation truth and exact actor/target/generation continuity. Duplicate operation, accepted-audit failure, rotation failure/uncertainty, response preparation failure, terminal-audit failure, and restart pending truth never produce contradictory success or a second rotation. |
| Response coherence | Returned generation is exactly prior generation plus one, device identity matches the authenticated target internally, rotation time is non-regressing/canonical, and raw token hashes to the committed row. Malformed or hostile port/executor output produces no partial response. |
| Failure mapping | Missing/invalid/revoked/expired/read-only/CSRF-invalid, operation conflict, audit unavailable, storage failure, timeout/internal contract failure, and unknown mutation outcome map to fixed bounded HTTP truth. Retry safety follows audit/mutation state; no native or secret-bearing cause escapes. |
| Privacy | Raw bearer is destroyed by the existing auth boundary and never supplied to selected CSRF ports. Raw CSRF exists only in the request stack or committed bootstrap response. Bearer/CSRF sentinels are absent from contexts, receipts, audit, diagnostics, observer/log captures, errors, SQLite main/WAL/SHM bytes except approved hashes, and artifacts. |
| Bounded diagnostics | Frozen saturating counters retain only bootstrap success/failure, header rejection, write authorization, authority rejection, conflict, and storage/audit failure counts. They retain no token/header/device/origin/path/message. |
| Existing behavior | Request-authentication, pairing, device list/revoke, audit executor, Fastify resource/trust/error policies, historical compatibility surfaces, and all selected manifests remain green. No hidden cookie clearing/issuance or fallback is introduced. |
| Honest boundary | This task supplies bootstrap plus reusable write-CSRF verification. It does not implement pair claim/cookie issuance, lock/target/write-gate orchestration, concrete non-CSRF mutations, active SSE revocation, per-device admission/idempotency, UI memory ordering, LAN composition, or release/browser acceptance. |

## Failure Matrix

| Boundary | Public truth | Side-effect truth |
| --- | --- | --- |
| Cookie/context rejection | 401/403 fixed permission state | No body operation, audit, entropy, rotation, or write authorization. |
| Body/header syntax | 400 validation for body; fixed CSRF denial for device-write headers | No contextual repository call, audit, lock, target, or dispatch. |
| Stale/wrong CSRF | 403 `permission_denied` | No `last_used_at` change and no downstream work. |
| Concurrent newer authority | 409 `operation_conflict` or fixed revoked/CSRF denial by winner | Greatest committed generation/revoke/last-used state remains. |
| Audit preflight | Typed audit/storage error with executor retry truth | No rotation. |
| Known rotation failure | Typed failed result after terminal audit | No success response; no partial generation/hash update. |
| Unknown rotation outcome | Typed incomplete result after terminal audit | No retry or success claim; browser has no new token. |
| Terminal audit failure | Typed error exposing mutation/audit state only | Rotation may be committed; no contradictory client success or auto-rotation. |
| Response preparation/serialization | Typed internal failure after terminal success where proven | Durable rotation/audit remain; no token delivery claim or retry. |

## Evidence Plan

- Add selected CSRF request/response/header contracts and direct contract tests.
- Add authenticated-device contextual CSRF repository methods with direct rollback, race, restart, query-plan, and raw-file tests.
- Add one branded CSRF policy/header verifier and the fixed Fastify bootstrap registration with hostile constructor/port/executor/auth/header/audit/response matrices.
- Run real SQLite plus real raw HTTP evidence for cache headers, duplicates, cookie/header privacy, rotation ordering, write verification, and revoke races.
- Re-run affected auth/audit/device/manifest/server/storage suites and every workspace validation/supply-chain gate before closure.

## Reuse And Dependency Decision

Reuse Zod, Fastify, the selected request-authentication context, `AuthDeviceRepository` primitives, existing hash/entropy policy, `SecurityMutationAuditExecutor`, `HostDeckHttpError`, and the route-manifest pattern. No dependency is needed. Do not reuse the historical custom-listener trust response or retain the bearer to call bearer-based storage methods.

## Remaining Ownership

- `IFC-V1-030`, `IFC-V1-031`, `IFC-V1-041`/`042`/`044`/`045`, `IFC-V1-059`, and `IFC-V1-061` to `064` consume the verifier through their owning lock/target/audit/dispatch routes.
- `IFC-V1-066` composes the common selected write gate and exact ordering across mutation families.
- `IFC-V1-028` owns Secure/HttpOnly/host-only/SameSite cookie issuance; `IFC-V1-059` owns revocation route and active authority invalidation.
- `IFC-V1-049` owns global/per-device idempotency and admission limits; `IFC-V1-035` owns long-lived SSE authority rechecks.
- `FE-V1-024` and `FE-V1-031` own page-memory token handling, greatest-generation response selection, reload/revoke UX, and browser evidence.
