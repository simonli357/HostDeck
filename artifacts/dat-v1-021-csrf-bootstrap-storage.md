# DAT-V1-021 CSRF Bootstrap Storage

Date: 2026-07-11

Status: complete.

## Scope

Extend the existing auth-device contract and SQLite repository with durable CSRF generation/rotation state and one atomic bootstrap rotation operation. This leaf owns storage and internal repository behavior only. HTTP cookie/origin/header handling remains `IFC-V1-026`/`IFC-V1-027`; pairing, last-used, revoke, device listing, and rate metadata remain their separate data leaves.

## Current Gaps

- `auth_devices` stores only `csrf_token_hash`; it has no generation or rotation timestamp.
- Device creation accepts an initial raw CSRF token, but no repository operation can rotate it for browser reload.
- Existing write authorization rejects an old raw token after hash replacement, but there is no durable generation for later strict header checks.
- No immediate-transaction, concurrent-connection, rollback, exhaustion, duplicate-generated-secret, or database-file raw-secret evidence exists.
- Existing migration tests stop at migration 008 and do not prove a row-preserving CSRF-state backfill.

## Hard Success Criteria

| Criterion | Required evidence |
| --- | --- |
| Forward-only schema | Migration 009 preserves every existing auth-device field, backfills generation 1 and rotation time from `created_at`, adds bounded positive-safe-integer and non-null timestamp constraints, and adds a CSRF-hash lookup index without changing prior migration bytes. |
| Strict record contract | Every auth-device record requires `csrf_generation` and `csrf_rotated_at`; zero, overflow, malformed timestamp, missing, and extra fields reject. Rotation time cannot precede device creation. |
| Initial state | Fresh device creation and pairing claim persist generation 1, use `created_at` as the first rotation time, and store only hashes. |
| Atomic bootstrap | One repository call validates the device bearer token and usable device state, generates one bounded CSPRNG CSRF token, hashes it, increments generation exactly once, updates rotation time, and returns the raw token only in the ephemeral result. Read and validation occur in one immediate transaction. |
| Invalid device state | Missing, revoked, and expiry-at-or-before-now devices reject before entropy generation or mutation. Read and write permission devices may bootstrap; permission changes are outside this leaf. |
| Time and generation safety | Invalid/regressing time, malformed generated token, generator failure, duplicate generated hash, and `Number.MAX_SAFE_INTEGER` exhaustion fail explicitly with the prior row byte-for-byte unchanged. Equal timestamps may rotate because concurrent requests can share one clock tick. |
| Current-token truth | After each successful rotation, the prior raw token rejects and only the newest raw token authorizes against the stored hash. Later selected HTTP work must require the returned generation as a header; this leaf does not retrofit historical routes. |
| Real concurrency | A worker-held immediate transaction and a second repository connection serialize without a lost increment. The final row has one monotonic newest generation/hash; the superseded contender token rejects. |
| Rollback | Forced update/commit failure returns no raw token, advances no generation/timestamp/hash, and leaves the device usable with its prior token. |
| Restart | Reopen preserves the latest hash, generation, and rotation time; a new rotation continues at exactly +1. |
| Secret absence | Raw bearer and every raw CSRF token are absent from table rows, SQLite file bytes, migration history, errors, logs, and public durable contracts. Repository get/list/require never return a raw token. |
| Ownership boundaries | Rotation does not update `last_used_at`, revoke a device, consume pairing state, emit an HTTP response, or add fallback acceptance. Those outcomes remain owned by downstream leaves. |

## Validation Plan

- Contract tests for exact fields, timestamp relation, safe generation bounds, and strict rejection.
- Migration tests for fresh schema, preserved checksums, row-preserving 008-to-009 upgrade, constraints, and index presence.
- Focused auth repository tests for initial state, repeated rotation, old/current token behavior, read-only support, invalid states, entropy failures, duplicate/exhausted/regressing inputs, forced rollback, real two-connection serialization, reopen, and raw file inspection.
- Adjacent restart/storage/server regression, root typecheck/lint, unit/contract/integration/web, planning/scaffold/binding, frozen install, audit, and manual SQL/API/privacy inspection.

## Outcome

- Migration 009 rebuilds `auth_devices` without changing prior migration bytes, preserves prior rows including historical duplicate CSRF hashes, backfills generation 1 and `created_at` rotation time, enforces integer safe-range storage, and adds the non-unique CSRF-hash lookup index.
- The strict auth-device contract requires bounded generation and canonical non-regressing rotation time. Fresh create and pairing claim initialize the same generation-1 state.
- `rotateCsrfBootstrap` authenticates a usable bearer inside one immediate transaction, generates 32 CSPRNG bytes by default, rejects duplicate/malformed/exhausted/regressing state, and atomically stores only the new hash/generation/time before returning one frozen ephemeral result.
- Missing, revoked, expired, corrupt, and invalid-time states reject before entropy. Update failure rolls back, real writer contention serializes to one monotonic newest token, and restart continues at exactly the next generation.
- Rotation does not touch `last_used_at`, pairing, revoke, HTTP, audit, or UI state. Exact generation-header enforcement remains owned by `IFC-V1-027`.

## Validation

- Focused migration/auth/rotation: 3 files, 26 passed; focused storage contract: 1 file, 9 passed.
- Affected storage plus historical write route: 19 files, 166 passed.
- Unit: 86 files passed and 16 expected external files skipped; 771 tests passed and 29 skipped.
- Contract: 14 files, 139 passed; integration: 2 files, 16 passed; web: 2 files, 14 passed.
- Root typecheck passed. Lint/exports passed for 271 files and 9 packages. Scaffold passed for 9 packages and 18 root scripts.
- Exact isolated Codex 0.144.0 binding passed for 671 files at `e1a1a5cff3ab91862f9215dd06538eae1ea0b00bae48cbb7d87061faaee27e24`.
- Frozen offline install passed; production dependency audit reported no known vulnerabilities.
- Manual schema/API/privacy review passed: SQLite reports the integer/range/nonnull constraints, the CSRF query uses `auth_devices_csrf_token_hash_idx`, the index remains non-unique for historical placeholder hashes, repository durable reads contain no raw secret, and transaction/error paths return no raw token before commit.
- `git diff --check` passed. Planning closure passed with 196 tasks, 84 requirements, 631 dependencies, and 7 queued entries after dependency advancement.

## Remaining Ownership

- `DAT-V1-025` to `DAT-V1-029` add listing, pairing/rate, security-action audit, atomic revoke, and monotonic last-used behavior.
- `IFC-V1-026` authenticates the HttpOnly device cookie.
- `IFC-V1-027` returns bootstrap output with no-store policy and requires the exact current generation/token on mutations.
- `FE-V1-024`/`FE-V1-031` keep the raw token only in page memory and handle stale/revoked reload states.
