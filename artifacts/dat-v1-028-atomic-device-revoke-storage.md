# DAT-V1-028 Atomic Device Revoke Storage

Date: 2026-07-11

Status: hard success criteria frozen before implementation.

## Scope

Harden the durable device-authority revocation transition. This leaf owns strict auth-device chronology, one selected SQLite revocation transaction, a minimal non-secret result, ordering against bearer authentication/browser-write authorization/CSRF bootstrap, and direct storage evidence. It does not own who may revoke, self/last-writer policy, confirmation UI, HTTP/CSRF/cookie handling, active SSE or in-flight request cancellation, security-audit orchestration, device listing, or session deletion.

## Current Gaps

- `AuthDeviceRepository.revoke` performs read, unconditional update, and read as separate operations instead of one immediate transaction.
- Revocation time is not constrained against creation, latest use, or CSRF rotation. An impossible or regressing timestamp can become durable and concurrent revokes can overwrite the first winner.
- The method returns the complete auth-device record, including token and CSRF hashes, although downstream revoke behavior needs only non-secret transition facts.
- The historical and selected revoke surfaces are not distinct; no strict plain-data input or fixed cause-free selected error boundary exists.
- The auth-device contract does not reject expiry before creation or revocation before creation/latest use/latest CSRF rotation.
- Update-count/commit rollback, read-only/closed/corrupt storage, restart, indexed lookup, raw main/WAL/SHM inspection, and real revoke/auth/bootstrap/revoke ordering are not directly proven for the selected transition.

## Frozen Selected Contract

### API And Result

`createDeviceRevocationRepository(db)` exposes one `revoke({ deviceId, now })` operation.

- Input is one exact plain data object. `deviceId` is a bounded nonempty storage identifier containing only ASCII letters, digits, `_`, `.`, `:`, or `-`; `now` is one valid `Date` normalized to canonical UTC milliseconds.
- Unknown/missing fields, arrays, inherited/accessor/proxy input, invalid ids, invalid dates, and secret-shaped exception causes fail before SQLite mutation with fixed bounded errors that do not echo input.
- Success returns one exact frozen result: `deviceId`, durable `revokedAt`, `previouslyRevoked`, and literal `authorityInvalidated: true`.
- The result exposes no token/CSRF hash, generation, label, permission, expiry, last-use value, raw credential, SQLite detail, or mutable stored object.
- The existing auth-device revoke method is renamed `revokeLegacy` and deprecated. Historical tests/callers may retain it temporarily, but it cannot satisfy selected route ownership or evidence.

### Record Chronology

The strict auth-device record contract additionally requires:

- non-null expiry is at or after creation; equality represents an immediately expired device;
- CSRF rotation is at or after creation and at or before expiry when expiry exists;
- existing last-use remains at or after creation and strictly before expiry;
- non-null revocation is at or after creation, CSRF rotation, and last use when present;
- revocation may occur at or after expiry because administrative invalidation of an expired device remains valid.

Malformed or contradictory persisted state is corruption. Selected revoke returns no trusted result and performs no repair or fallback.

### Atomic Transition

1. Strict input and canonical time validate before transaction entry.
2. One `BEGIN IMMEDIATE` transaction reads the exact device by primary key and validates the complete stored contract.
3. Requested time must be at or after creation, current CSRF rotation, current last use, and an existing revocation. Regression rejects without mutation.
4. An already-revoked valid row is an idempotent success with `previouslyRevoked: true`, the original durable timestamp, and no write. A later repeat never overwrites first-winner truth.
5. An unrevoked row is updated through a full-current-state compare-and-set. Exactly one changed row is required.
6. The transaction rereads and validates the committed candidate before returning `previouslyRevoked: false`. The public frozen result is released only after commit.
7. Statement, update-count, validation, storage, or deferred-commit failure rolls back the transition and returns no success result. There is no retry that could hide uncertain commit state.

### Authority Semantics

- `revoked_at` is the single durable invalidation bit. Existing immediate bearer-authentication, browser-write, and CSRF-bootstrap transactions all reject a row with non-null revocation before returning authority or generating a new CSRF value.
- Revoke does not rotate, blank, or rewrite token/CSRF hashes, generation, rotation time, permission, label, expiry, or last-use state. Hash-only storage remains unchanged; authority becomes unusable because the row is revoked.
- If authentication or bootstrap owns the writer transaction first, it may commit once and revoke then observes that newest chronology before invalidating authority. If revoke owns it first, the waiting authority operation rejects as revoked and performs no touch/rotation/entropy generation.
- Storage revocation cannot retract authority already returned to an in-flight caller. `IFC-V1-059` and `IFC-V1-035` own request/SSE reauthorization and post-revoke behavior.

## Hard Success Criteria

| Criterion | Required evidence |
| --- | --- |
| Strict chronology | Contract tests cover creation/expiry/rotation/use/revocation equality and ordering, canonical offsets, missing/extra fields, unsafe generation, and every contradiction above. |
| Explicit selected boundary | New selected repository has exact input, fixed cause-free errors, minimal frozen non-secret result, and no dependency on the legacy revoke method. Legacy revoke is named/deprecated explicitly. |
| One-way atomic transition | One immediate read/validate/CAS/reread transaction changes only `revoked_at`; missing/corrupt/stale/update-count/statement/commit failures produce no partial or trusted result. |
| Stable idempotency | The first committed revocation timestamp is permanent. Equal/later repeats report `previouslyRevoked: true` without writing; earlier/regressing observations conflict. Concurrent revokes have one durable winner. |
| Complete authority invalidation | After commit, bearer authentication, browser-write authorization, and CSRF bootstrap all reject. CSRF entropy is not called, stale/current headers cannot authorize, and hashes/generation/rotation remain unchanged. |
| Ordered real races | Worker-backed real SQLite evidence covers auth-first/revoke-second, bootstrap-first/revoke-second, revoke-first/auth, revoke-first/bootstrap, and two-revoke ordering without lost chronology or post-revoke authority. |
| Failure and rollback | Invalid input/time, missing device, entropy-independent revoke, forced update ignore/abort, deferred commit failure, read-only/closed storage, and native SQLite failure are bounded, cause-free, and leave the full row unchanged. |
| Corruption and restart | Invalid hash/generation/timestamp/expiry/use/revocation rows fail loudly. Valid revocation and idempotent truth survive reopen; primary-key lookup uses the expected index. |
| Secret and data absence | Raw bearer/CSRF values and secret-bearing sentinels remain absent from result, errors, rows, main/WAL/SHM bytes, logs, and artifacts. Revoke changes no pairing/session/projection/audit/settings row and deletes nothing. |
| Ownership boundaries | No route authority, confirmation, self/last-device rule, cookie/header behavior, audit write, active request/SSE invalidation, list response, or UI behavior is implemented or claimed. |

## Validation Plan

- Contract tests for strict auth-device chronology and selected result shape.
- Direct repository tests for first revoke, exact/equal/later/earlier repeat, expired devices, read/write devices, missing/invalid/corrupt inputs, changed-column isolation, update/commit rollback, closed/read-only storage, and restart.
- Worker-backed two-connection tests for authentication, CSRF bootstrap, and revoke ordering in both directions plus concurrent revokes.
- Existing authentication/browser-write/bootstrap tests prove the durable `revoked_at` authority gate remains shared and no current credential works after commit.
- Raw table plus main/WAL/SHM scans for synthetic bearer, CSRF, id/error sentinels; query-plan and foreign-table count/diff inspection.
- Full storage/server/unit/contract/integration/web, typecheck/lint, scaffold/planning/exact-binding, frozen offline install, production audit, manual transaction/privacy/ownership review, and diff checks.

## Reuse Assessment

Keep `better-sqlite3`, the existing auth-device Zod contract, `HostDeckAuthRepositoryError`, and current immediate authentication/bootstrap transactions. No dependency or generalized state-machine abstraction is needed for one SQLite one-way transition.

## Remaining Ownership

- `IFC-V1-059` owns selected revoke authorization, self/last-device and confirmation policy, CSRF/cookie handling, response mapping, and security audit orchestration.
- `IFC-V1-035` owns active SSE authorization/recheck behavior after revocation.
- `DAT-V1-025`/`IFC-V1-029` own bounded non-secret device listing.
- `IFC-V1-032` owns reusable security mutation accepted-to-terminal audit execution.
- `DAT-V1-091` owns aggregate selected storage/auth hardening.
