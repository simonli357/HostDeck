# DAT-V1-025 Bounded Device List Storage

Date: 2026-07-11

Status: hard success criteria frozen before implementation.

## Scope

Implement one bounded read-only storage projection for paired-device management. This leaf owns the non-secret item/page contracts, explicit keyset pagination, one-statement SQLite snapshot, corruption handling, and direct storage evidence. It does not own HTTP query/cursor encoding, request authentication/device-admin policy, UI ordering/presentation, revoke actions, audit, SSE authorization, or pairing.

## Current Gaps

- `AuthDeviceRepository.list()` is unbounded and returns complete auth-device rows, including bearer and CSRF hashes plus CSRF generation/rotation state.
- No selected list item/page/input contract, maximum page size, cursor rule, or frozen result exists.
- Created-time ordering would need a new composite index and has raw-offset/canonical-cursor ambiguity; the current task has no migration or resource-policy dependency.
- Large datasets, exact/over limits, invalid cursors, empty/end pages, duplicate-free traversal, read-only/closed storage, corrupt rows, restart, and query-plan behavior are not proven.
- Concurrent revoke has no explicit page-snapshot evidence, and current parse failures can retain native Zod/SQLite causes.
- The historical hash-bearing `list` name is not explicit enough to prevent selected-route misuse.

## Frozen Selected Contract

### Input And Bound

`createDeviceListingRepository(db)` exposes `list({ limit, afterDeviceId })`.

- Input is one exact plain data object with both fields required. `limit` is an integer from 1 through exported `selectedDeviceListMaxPageSize = 100`; `afterDeviceId` is either `null` for the first page or one bounded selected device id.
- No default, offset, page number, total-count request, alternate sort, caller-selected SQL field, or unbounded mode exists at the storage boundary.
- Unknown/missing/inherited/accessor/proxy fields, invalid ids, zero/negative/fractional/unsafe/over-100 limits, arrays, and native exception causes fail before SQLite with fixed cause-free errors.

### Stable Keyset And Snapshot

- Ordering is ascending immutable `auth_devices.id`, using the existing primary-key index. The cursor is the last returned device id; it need not still exist and is interpreted exclusively as `id > afterDeviceId`.
- One read-only SQLite statement selects at most `limit + 1` rows using `WHERE id > ? ORDER BY id LIMIT ?` (or the first-page equivalent). There is no separate count query.
- The extra row determines `hasMore`. A nonterminal page returns `nextAfterDeviceId` equal to its final returned item id; empty and terminal pages return `null`.
- All fetched rows, including the lookahead row, are validated before any result is released. One corrupt row fails the whole page without a partial prefix or invented continuation.
- Each call is one bounded SQLite statement snapshot. Concurrent revoke cannot change immutable order or duplicate/omit a row inside that statement. A later page/call may truthfully observe newer revocation metadata; cross-call historical snapshots are not claimed.

ID keyset order is deliberately selected over created-time order: device ids are immutable, already indexed, offset-safe, and sufficient for stable pagination. `IFC-V1-029` owns any opaque HTTP cursor encoding, and UI work owns presentation grouping without changing storage traversal truth.

### Non-Secret Projection

Each exact frozen item contains only:

- `deviceId`
- nullable `clientLabel`
- `permission` (`read` or `write`)
- canonical `createdAt`
- nullable canonical `lastUsedAt`
- nullable canonical `expiresAt`
- nullable canonical `revokedAt`

The page contains a frozen item array, `nextAfterDeviceId`, and `hasMore`. It omits bearer/CSRF hashes, CSRF generation/rotation time, raw credentials, internal row objects, total count, audit/session/pairing state, and SQLite details.

The existing full-record method becomes `listLegacy` with an explicit deprecation marker. It may remain for historical internal callers but cannot satisfy selected route ownership or evidence.

## Hard Success Criteria

| Criterion | Required evidence |
| --- | --- |
| Exact contracts | Input, item, and page schemas reject unknown/missing/wrong fields and enforce the 1..100 page bound, selected id syntax, nullable lifecycle metadata, permission enum, canonical timestamps, and no secret/CSRF fields. |
| Bounded indexed read | Every call executes one primary-key keyset statement with at most 101 fetched rows and no count/offset/full-table result. Query plan uses the auth-device primary index. |
| Stable traversal | Empty, one-row, exact-limit, limit-plus-one, multi-page, after-end, deleted-cursor, non-chronological ids, and at least 250-row traversal are sorted, duplicate-free, complete, and bounded. |
| Truthful snapshot | Every fetched row validates before return. Concurrent revoke-before-read is visible; an uncommitted revoke during the statement yields the prior valid page snapshot and a later call sees the committed revocation without order drift. |
| Non-secret immutable output | Outer page, array, every item, and continuation state are frozen. JSON/object keys contain no token/CSRF hash, generation/rotation, raw credential, mutable row, or unrelated data. |
| Invalid/corrupt/unavailable state | Invalid input, malformed hash/generation/timestamp/chronology/permission/id rows, corrupt lookahead, closed storage, and native SQLite failure are fixed, cause-free, and return no partial page. Read-only storage succeeds. |
| Restart and privacy | Traversal and cursor behavior survive reopen. Raw bearer/CSRF values and error sentinels remain absent from result, errors, rows beyond existing hashes, and main/WAL/SHM bytes. Listing writes nothing. |
| Ownership boundaries | No HTTP cursor/query encoding, auth/admin policy, revoke, audit, SSE recheck, pairing, total-count UI, presentation sort, or device-management UI behavior is implemented or claimed. |

## Validation Plan

- Contract tests for exact input/item/page schemas, page-size boundaries, timestamps, permissions, strict absence, and frozen repository outputs.
- Direct repository tests for all pagination boundaries, 250+ rows, deleted cursor, non-created-time id order, corrupt returned/lookahead rows, no partial output, closed/read-only storage, restart, and raw-file privacy.
- Worker-backed real SQLite revoke-before, uncommitted-during, and committed-after snapshot cases with duplicate-free continuation.
- Query-plan inspection for primary-key `id > ?` traversal; statement instrumentation or structural inspection proving one bounded select and no count/offset query.
- Full storage/server/unit/contract/integration/web, typecheck/lint, scaffold/planning/exact-binding, frozen offline install, production audit, manual pagination/privacy/ownership review, and diff checks.

## Reuse Assessment

Keep `better-sqlite3`, the strict auth-device record schema, selected device-id contract, and Zod. Primary-key keyset pagination is simpler and safer than adding an offset/cursor library or a migration solely for created-time display order.

## Remaining Ownership

- `IFC-V1-029` owns authenticated device-admin access, HTTP query/default/opaque-cursor contracts, response mapping, and route-level concurrency/failure behavior.
- `FE-V1-013` and `FE-V1-032` own mobile device-management presentation and interaction.
- `DAT-V1-028`/`IFC-V1-059` own revocation state and route behavior.
- `DAT-V1-091` owns aggregate selected storage/auth hardening.
