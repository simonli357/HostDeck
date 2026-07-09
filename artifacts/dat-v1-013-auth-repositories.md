# DAT-V1-013 Auth Devices And Pairing-Code Repositories

Date: 2026-07-08

## Scope

- Added `@hostdeck/storage` auth device and pairing-code repositories in `packages/storage/src/auth-repository.ts`.
- Added `csrf_token_hash` to the auth-device storage contract and SQLite schema through migration `202607080003_auth_device_csrf_hash`.
- Pairing codes are stored as hashes, are time-bounded, and can be claimed exactly once.
- Device tokens and CSRF tokens are stored as hashes only.
- Auth devices persist client label, permission mode, created time, last-used time, expiry, and revocation time.
- Browser write authorization requires a valid device-token cookie value, write permission, unexpired/unrevoked device state, and a matching CSRF token.

## Failure Behavior Covered

- Expired pairing codes reject with `pairing_code_expired`.
- Used pairing codes reject with `pairing_code_used`.
- Missing device tokens reject with `device_not_found`.
- Expired and revoked device tokens reject with `device_expired` and `device_revoked`.
- Read-only devices authenticate as trusted read-only clients but reject browser writes with `read_only`.
- Wrong CSRF tokens reject browser writes with `csrf_mismatch`.
- Invalid persisted auth rows fail on repository read instead of being accepted as trusted state.

## Local State Inspection

- `auth-repository.test.ts` reads `pairing_codes` and `auth_devices` rows directly after creation/claim.
- The direct row assertions verify that raw pairing codes, raw device tokens, and raw CSRF tokens do not appear in persisted SQLite records.
- Auth rows contain `token_hash` and `csrf_token_hash`; pairing rows contain `code_hash`.

## Validation

- `pnpm --filter @hostdeck/storage typecheck` passed.
- `pnpm --filter @hostdeck/contracts typecheck` passed.
- `pnpm install --frozen-lockfile` passed.
- `pnpm check:scaffold` passed.
- `pnpm typecheck` passed.
- `pnpm -r --if-present typecheck` passed.
- `pnpm lint` passed.
- `pnpm test` passed with 68 tests across 10 files.
- `pnpm test:unit -- packages/storage/src/auth-repository.test.ts packages/storage/src/migration-runner.test.ts packages/contracts/src/storage.contract.test.ts` passed with 68 tests across 10 files.
- `pnpm test:contract` passed with 37 tests across 4 files.
- `git diff --check` passed.

## Remaining Follow-Up

- `DAT-V1-016` still waits on the audit repository before cross-repository restart-persistence coverage can close.
- `IFC-V1-005` can now build pairing/token claim and security/network state API routes on the storage repository.
- Audit events for pair/revoke/write attempts remain owned by `DAT-V1-014` and the API write pipeline.
