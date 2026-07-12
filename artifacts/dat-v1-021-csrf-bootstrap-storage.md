# DAT-V1-021 CSRF Bootstrap Storage

Date: 2026-07-11

Status: hard success criteria frozen before implementation.

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

## Remaining Ownership

- `DAT-V1-025`, `DAT-V1-026`, `DAT-V1-028`, and `DAT-V1-029` add listing, pairing/rate, atomic revoke, and monotonic last-used behavior.
- `IFC-V1-026` authenticates the HttpOnly device cookie.
- `IFC-V1-027` returns bootstrap output with no-store policy and requires the exact current generation/token on mutations.
- `FE-V1-024`/`FE-V1-031` keep the raw token only in page memory and handle stale/revoked reload states.
