# IFC-V1-029 Bounded Paired-Device List Route

Date: 2026-07-12

Status: complete. Implementation: `892a17b`.

## Scope

Implement the one selected `device_list` manifest row as a production Fastify API registration over the completed request-authentication policy and bounded device-list repository. This leaf owns the HTTP query/cursor and response contracts, exact route binding, read authorization, route-level result validation, stable failure mapping, cache policy, and headless HTTP evidence.

It does not own pairing, CSRF rotation, device revoke, active-request invalidation after revoke, access/lock state, rate limiting for mutation endpoints, SSE reauthorization, production route aggregation, dashboard presentation, Android behavior, or release acceptance.

## Pre-Implementation Gaps

- The selected manifest names `device_list_query_v1` and `device_list_response_v1`, but neither is bound to an executable Zod contract.
- No selected Fastify registration currently owns `GET /api/v1/access/devices`; historical handlers are not production registrations.
- Storage accepts an internal device id keyset, while an HTTP client needs one canonical bounded limit and an opaque versioned continuation cursor.
- The route must distinguish public query failure, credential failure, storage corruption/unavailability, and an impossible route-to-repository contract mismatch without returning native causes or partial rows.
- The route must prove that read-only and write-paired clients are admitted by the frozen manifest while safe loopback requests without a device credential and missing, invalid, expired, or revoked credentials cannot reach listing storage.
- The selected storage projection is non-secret, but the HTTP mapping, error path, headers, raw listener, and malformed injected-port output have no privacy evidence.

## Implementation Result

- Added shared executable query, cursor, response-item, and response contracts. The dependency-free ASCII codec emits one `v1.` unpadded-base64url cursor and rejects bad version/alphabet/padding/length/trailing bits, invalid decoded ids, and noncanonical round trips.
- Added one fixed frozen `selected-device-list` API registration. It asserts the complete manifest row, disables implicit HEAD, authenticates a device cookie before query validation/list access, applies no-store before route-local failures, and calls one snapshotted detached synchronous list port.
- Added descriptor-first proof for the frozen returned page, array, and every item before Zod parsing. Full page/request coherence validates row count, nonterminal fullness, strict post-cursor order, continuation, and response preparation before any body is released.
- Added fixed cause-free storage failures plus observed sanitized internal contract failures. Unknown/malformed/async/mutable/accessor/proxy/over-limit/incoherent port outcomes cannot select a response, invoke an accessor, leak a native cause, retry, fall back to `listLegacy`, or return a partial prefix.
- Corrected the selected manifest from the unreachable `local_admin_or_device_cookie` union to `device_cookie` under `DEC-024`. Paired read and write devices remain admitted; safe no-Origin GETs remain unpaired as required by the completed authentication contract.
- Added real migrated-SQLite traversal, authentication last-used, revoke-before-auth, corrupt-lookahead, query-only, reopen, and raw loopback listener evidence without adding a dependency or claiming downstream CLI/UI behavior.

## Frozen Route Contract

### Manifest Binding

- Register exactly `GET /api/v1/access/devices` on the `api` surface under one fixed registration id. Disable Fastify's implicit `HEAD` exposure for this route.
- Resolve and assert the frozen `device_list` manifest row before registration. Method, path, transport, request/response ids, auth, authority, CSRF, lock, target, operation, audit, credential effect, handler, and owner must all remain exact; drift fails registration instead of silently creating a different route.
- Bind `device_list_query_v1` and `device_list_response_v1` to local Zod validation and serialization. Trailing-slash, case-variant, alternate-method, request-body contract, offset/page, sort, total-count, and bulk variants are absent.

### Query And Cursor

The public query has exactly two optional fields:

- `limit`: canonical unsigned decimal text from `1` through `100`; omitted means `100`.
- `cursor`: a canonical `v1.` cursor or absent for the first page.

`limit` rejects zero, signs, whitespace, fractions, exponents, leading zeroes, unsafe/over-limit values, duplicate arrays, non-strings, and unknown fields.

The cursor is `v1.` followed by the unpadded base64url encoding of one selected device id. The payload is 2 through 160 characters and the complete cursor is at most 163 characters. Decode must:

1. accept only the exact `v1` version and base64url alphabet without padding;
2. decode to 1 through 120 ASCII bytes matching the selected device-id grammar;
3. re-encode to the byte-identical cursor payload to reject permissive/noncanonical decoder inputs.

The cursor is opaque and stateless, not encrypted or signed. Device ids are already authorized response data; cursor tampering can only select a different bounded `id > decodedId` page and cannot broaden fields or authority. A cursor remains valid if its named device was deleted or revoked.

The validated query maps to exactly `{ limit, afterDeviceId }` for one detached synchronous `list` port call. No caller value enters SQL structure.

### Authorization And Request Order

- The route consumes manifest auth `device_cookie` in route `onRequest`, after the mandatory root trust and cookie-intake hooks and before query validation or list-repository access.
- Paired read devices and paired write devices are admitted. Read permission is sufficient because this is the frozen user-accessible read route.
- Safe no-Origin GETs are deliberately `unpaired`, not local admin, under the completed authentication contract. Advertising `local_admin_or_device_cookie` here would create an unreachable local-admin arm, so this leaf corrects the selected manifest to `device_cookie`. The future local CLI list path remains `IFC-V1-054` ownership and must not elevate a safe GET.
- Missing, malformed, duplicate, unknown, expired, or revoked credentials reject with the existing stable authentication policy. Any cookie header prevents ambient local-admin fallback.
- The route adds no CSRF, write-permission, lock, audit, rate-limit, or target gate. Rejected trust/auth requests and invalid credentials make zero list-port calls.
- A revoke committed before authentication is observed by authentication. A revoke after the request's accepted authentication snapshot may race with this bounded read; active invalidation and aggregate revoke ordering remain `IFC-V1-059`/`IFC-V1-033` ownership.

### Response

Success is one exact snake_case object:

```text
{
  devices: [{
    device_id,
    client_label,
    permission,
    created_at,
    last_used_at,
    expires_at,
    revoked_at
  }],
  next_cursor,
  has_more
}
```

- `devices` contains at most the requested limit and at most 100 items, in strict ascending `device_id` order. Every item uses the selected id/label/permission/canonical timestamp bounds.
- Every returned id is strictly greater than the decoded request cursor. A nonterminal page is nonempty, contains exactly the requested limit, sets `has_more: true`, and encodes its final id as `next_cursor`.
- Empty and terminal pages set `has_more: false` and `next_cursor: null`. The response contract independently verifies cursor canonicality, order, and continuation/final-item agreement.
- The complete page is validated and mapped before reply serialization. No partial prefix can be sent for a corrupt lookahead row, malformed port result, cursor-encoding failure, or response-contract failure.
- Success and every route-local failure carry `Cache-Control: no-store`.
- The response omits bearer and CSRF values/hashes, CSRF generation/rotation metadata, total counts, audit/pairing/session state, SQLite details, raw internal objects, and an invented current-device flag.

### Port And Failure Boundary

- Construction accepts one exact plain-data input containing one exact one-method device-list port. Snapshot the `list` function without invoking accessors and call it detached exactly once per admitted valid request.
- Validate returned page/array/item descriptors before reading values, then parse the complete selected storage page and request/result relationships. Accessor, proxy, promise, extra-key, mutable-shape, over-limit, out-of-order, before-cursor, incoherent-continuation, and otherwise malformed results fail closed.
- Public query failures use the global `400 validation_error` envelope with field `query`. Trust/authentication retains its existing stable `400`/`401`/`403`/`409`/`500` policy.
- Repository `invalid_auth_device` and `device_list_failed`, plus untyped storage throws, become fixed cause-free `500 storage_error` responses.
- Repository `invalid_device_list`, an unexpected auth-repository error code, malformed returned state, or impossible response preparation is an observable sanitized `500 internal_error`, because the route has already produced the exact internal input. The response and observer receive no candidate value, native cause, query, cursor, credential, hash, or row content.
- No failure is retried and no fallback list, legacy hash-bearing list, partial result, or empty-success substitute is allowed.

## Hard Success Criteria

| Criterion | Required evidence |
| --- | --- |
| Exact registration | Fixed API registration asserts the complete selected manifest row, exposes only exact GET/path semantics, disables implicit HEAD, and binds both named Zod contracts. |
| Canonical query | Omitted/default, 1, 100, malformed numeric text, duplicates, unknown fields, cursor version/alphabet/padding/length/round-trip, and deleted-cursor cases pass or reject exactly. |
| Authorization | Paired read/write succeed; safe loopback no-cookie, same-origin unpaired, unrelated-cookie, malformed, invalid, expired, revoked, conflict, and auth-storage failure states reject before listing with stable errors. |
| Bounded traversal | Empty, one, exact-limit, plus-one, terminal, after-end, deleted cursor, default page, and at least 250-row HTTP traversal are ordered, duplicate-free, complete, and at most 100 rows per call. |
| Result coherence | Returned pages must be exact synchronous plain data, fully validated before mapping, bounded by the request, strictly after its cursor, and continuation-consistent. Hostile/malformed port results produce one observed internal failure and no partial body. |
| Stable failures | Query, auth, storage corruption/unavailability, internal input mismatch, and serialization/preparation failures map to fixed status/code/field/retryability without native or candidate detail. No rejected request retries or calls the legacy list. |
| Privacy and cache | Injection and a real raw loopback listener show no token, cookie value, hash, CSRF, generation/rotation, error sentinel, SQLite detail, or session data in success/error bodies, headers, or observations; every outcome reached after route admission is no-store. |
| Storage composition | Real migrated SQLite proves authentication-last-used composition, selected non-secret list mapping, corruption/no-partial behavior, reopen continuity, read-only listing, and revoke-before-auth denial without route-owned writes. |
| Ownership boundaries | No pair/revoke/CSRF/lock/audit/SSE/aggregate composition, browser UI, Android, presentation ordering, or release claim is introduced. |

## Validation

- Direct route matrix: 8 tests passed for exact hostile construction, manifest/path/method binding, query mapping, paired read/write plus every rejected credential state, storage/internal failures, accessor-free hostile results, 250-device traversal, deleted/after-end/exact-terminal cursors, query-only/reopen, authentication/revoke/corruption composition, and real raw-listener privacy/non-elevation.
- Selected list and manifest contracts: 14 tests passed, including all cursor lengths from 1 through 120 decoded id bytes, malformed/noncanonical forms, exact query defaults/bounds, strict non-secret response shape, and corrected device-cookie manifest policy.
- Focused route/auth/list/revoke regressions passed 49 tests. Storage passed 217 tests. Server passed 336 tests with seven explicit external smokes skipped.
- Aggregate unit passed 877 tests with 29 explicit external skips; contract 162, integration 16, and web 14 passed.
- Root and package typechecks, Biome/package exports over 299 files and 9 packages, scaffold (9 packages/18 scripts), planning (196 tasks/84 requirements/633 dependencies/9 queued), and exact Codex 0.144.0 binding (671 files at `e1a1a5cff3ab91862f9215dd06538eae1ea0b00bae48cbb7d87061faaee27e24`) passed.
- Frozen offline install passed. Production audit reported no known vulnerabilities. Production license inventory remained MIT 101, ISC 9, BSD-3-Clause 5, BlueOak-1.0.0 5, Apache-2.0 3, 0BSD 1, `(BSD-2-Clause OR MIT OR Apache-2.0)` 1, and `(MIT OR WTFPL)` 1.
- Manual contract/query/manifest/failure/privacy review confirmed one bounded list call, no native/candidate error reflection, no secret/CSRF/session/total-count fields, no implicit HEAD, and no route-owned write/audit/revoke/UI behavior. Diff and staged-patch checks pass.

## Remaining Gaps

None within this leaf. CSRF, pair/claim, revoke/active invalidation, access/lock state, aggregate security composition, local CLI device listing, dashboard presentation, Android/browser acceptance, and release evidence remain with their named downstream owners.

## Reuse Assessment

Keep Fastify, the local Zod compiler/error policy, selected manifest, request-authentication context, `Buffer` base64url support, selected device-list contracts/repository, and current storage error type. A cursor/pagination package, signing key, encryption layer, ORM, response-cache plugin, or new dependency would add cost without improving this bounded immutable-id keyset.
