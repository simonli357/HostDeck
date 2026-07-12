# DAT-V1-029 Monotonic Authentication Last Used

Date: 2026-07-11

Status: complete.

## Scope

Make auth-device bearer authentication and historical browser-write authorization validate current authority and advance `last_used_at` atomically and monotonically. This leaf owns the auth-device contract/repository transaction only. Cookie parsing/trust context remains `IFC-V1-026`; atomic revoke semantics remain `DAT-V1-028`; device listing remains `DAT-V1-025`; rate limits and audit remain their owning leaves.

## Current Gaps

- `authenticateDeviceToken` reads and validates a device, then calls an unconditional `UPDATE` outside a transaction.
- `authorizeBrowserWrite` separately validates permission/CSRF, then uses the same unconditional touch.
- An older observation can overwrite a newer `last_used_at` value.
- A revoke can commit between validation and touch, after which the current method returns `trusted: true` with a revoked row.
- Invalid, equal, regressing, concurrent, forced-failure, restart, and raw-file last-used evidence is missing.
- The auth-device contract accepts `last_used_at` before creation or at/after a configured expiry even though no valid authentication can produce those states.

## Frozen Behavior

- `authenticateDeviceToken` admits both read and write devices and returns the existing read-only distinction.
- `authorizeBrowserWrite` additionally requires write permission and the current CSRF hash.
- Both operations use one immediate SQLite transaction from bearer lookup through committed result.
- A valid observation strictly newer than the current value advances `last_used_at`; an equal observation succeeds without writing; an older observation rejects as `authentication_conflict` without mutation.
- Observation before device creation is invalid. Expiry at or before the observation rejects. Revocation always rejects regardless of observation time.

## Hard Success Criteria

| Criterion | Required evidence |
| --- | --- |
| Strict record chronology | Non-null `last_used_at` must be canonical, at/after `created_at`, and strictly before `expires_at` when expiry exists. Missing/malformed/pre-creation/at-expiry/post-expiry records reject through the contract/repository. Existing nullable behavior remains. |
| Atomic bearer authentication | One immediate transaction validates time, bounded raw bearer, stored row contract, current nonrevoked/nonexpired authority, and monotonic observation before any write. A successful read or write device returns only after commit with the exact persisted record. |
| Atomic browser-write authorization | Permission and current CSRF hash validate inside the same immediate transaction before last-used mutation. Read-only or wrong/old CSRF rejects without touching metadata. Generation-header enforcement remains `IFC-V1-027`. |
| Monotonic time | First valid authentication sets the canonical observation time. Later greater time advances exactly once. Equal time succeeds as a no-op. Time before creation is `invalid_time`; time below current last-used is explicit `authentication_conflict`. No path moves time backward. |
| Invalid authority | Missing, malformed-token, corrupt-row, expired-at-now, expired-before-now, and revoked devices reject without changing any auth-device field. Read-only is valid for bearer reads and invalid only for write authorization. |
| Ordered revoke race | A committed revoke observed before authentication causes rejection and no touch. Authentication serialized first may commit once, after which revoke wins and all future authentication rejects. No ordering returns trusted authority after observing committed revocation. Full atomic revoke ownership remains `DAT-V1-028`. |
| Real observation race | Two real connections serialize. Older-first then newer produces the newer final time; newer-first then older makes the older request conflict. No lost update or stale successful result occurs. Equal concurrent observations are idempotent. |
| Failure and rollback | Forced update/commit/SQLite failure returns generic `authentication_failed`, exposes no SQL/secret detail, changes no row, and returns no trusted result. A no-op equal observation performs no update and is unaffected by an update trigger. |
| Ownership boundaries | Authentication changes only `last_used_at`; it does not rotate CSRF, change generation/permission/expiry/revocation/label, consume pairing state, audit, rate-limit, parse cookies, or issue HTTP trust. CSRF bootstrap itself still does not touch last-used. |
| Restart and privacy | Reopen preserves the greatest committed timestamp and continues monotonically. Raw bearer/CSRF values remain absent from rows, SQLite bytes, errors, logs, and durable/public outputs. Token-hash lookup uses the existing unique index. |

## Validation Plan

- Contract tests for nullable, canonical, creation, and expiry chronology.
- Direct repository tests for read/write devices, first/greater/equal/regressing observations, time/authority/permission/CSRF/corruption failures, exact unchanged rows, and bounded generic errors.
- Real worker-held two-connection matrices for both old/new ordering and revoke-before-auth serialization.
- Forced trigger rollback, equal-time no-write proof, reopen continuation, raw row/file inspection, and query-plan inspection.
- Adjacent auth/CSRF/migration/restart/server regressions plus root typecheck/lint, unit/contract/integration/web, planning/scaffold/binding, frozen offline install, production audit, and manual transaction/privacy review.

## Outcome

- The strict auth-device contract now rejects non-null last-used values before creation or at/after expiry while preserving nullable historical state.
- Bearer authentication and browser-write authorization each run token lookup, stored-row validation, usable-authority checks, monotonic comparison, guarded update, and committed-row read through one immediate transaction. Browser writes additionally validate write permission and the current CSRF hash inside that transaction.
- Greater observations update only `last_used_at`; equal observations return the persisted row without issuing an update; older observations fail as `authentication_conflict`. Unknown begin/update/commit failures become generic cause-free `authentication_failed` errors.
- Real two-connection tests prove older/newer ordering in both directions, equal-time idempotence, revoke-before-auth rejection, and auth-before-revoke final authority. Deferred commit failure rolls back both the touch and trigger side effect.
- Reopen preserves the greatest timestamp, token lookup uses the existing unique index, and raw bearer/CSRF values remain absent from rows, database bytes, errors, and failure responses. HTTP adapters classify conflicts as `operation_conflict` and internal failures as `storage_error` without dispatch or state mutation.

## Validation

- Direct monotonic repository matrix: 1 file, 11 passed. Full storage package: 19 files, 167 passed.
- Affected security/write route matrix: 2 files, 17 passed. Full server package: 35 files and 305 tests passed; 7 declared external smoke files/tests skipped.
- Unit: 88 files passed and 16 declared external files skipped; 796 tests passed and 29 skipped.
- Contract: 14 files, 139 passed; integration: 2 files, 16 passed; web: 2 files, 14 passed.
- Root typecheck passed. Lint/exports passed for 274 files and 9 packages. Scaffold passed for 9 packages and 18 root scripts.
- Planning passed at 196 tasks, 84 requirements, 631 dependencies, and 6 queued entries before owner-doc closure.
- Exact isolated Codex 0.144.0 binding passed for 671 files at `e1a1a5cff3ab91862f9215dd06538eae1ea0b00bae48cbb7d87061faaee27e24`.
- Frozen offline install passed. Production audit reported zero known vulnerabilities across 140 production dependencies.
- Manual transaction/privacy review and `git diff --check` passed: every success returns the row read under the committing write lock, authority failures precede touch, equal time performs no update, guarded updates change only last-used, unknown failures expose no native cause, and no raw secret enters durable/public output.

## Remaining Ownership

- `IFC-V1-026` parses the HttpOnly cookie and attaches the request trust/auth context through this repository operation.
- `DAT-V1-028` makes revoke and CSRF invalidation one fully specified transaction.
- `DAT-V1-025` returns bounded non-secret last-used metadata in device listings.
- `IFC-V1-027` enforces current CSRF token plus generation on browser mutations.
