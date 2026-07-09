# DAT-V1-090 Storage Hardening

Date: 2026-07-08

## Target

- Module: `@hostdeck/storage`
- Block: `BLK-V1-02`
- Scope: SQLite migrations, settings/config, session registry/metadata, auth/pairing, audit events, output/audit retention, optional branch metadata, and restart persistence.

## Strict Criteria

- Migration drift fails loudly for corrupt databases, unknown versions, checksum mismatch, and sequence gaps.
- Invalid persisted settings, sessions, metadata, auth rows, audit rows, output events, and retention boundaries fail through typed repository errors.
- Raw pairing codes, device tokens, and CSRF tokens are validated before hashing; obvious weak or malformed raw secrets never create durable rows or authenticate.
- Durable auth rows store only hashes; revoked, expired, read-only, CSRF-mismatched, or malformed credentials cannot authorize browser writes.
- Settings keep safe localhost defaults, reject invalid bind/port/LAN combinations, and persist lock/LAN state across reopen.
- Retention keeps storage bounded, records visible output/audit boundaries, rejects invalid replay requests, and does not silently drop the newest retained output event under an extreme byte cap.
- Restart persistence reloads durable settings, sessions, metadata, auth/pairing, audit, output retention, and migration state while leaving stream/output-reader state ephemeral.
- Local state inspection verifies raw tokens/codes/CSRF values are absent from SQLite rows and audit payload summaries are bounded.
- Gaps owned by later blocks stay explicit: API audit preflight/write ordering belongs to `IFC-V1-004`; live tmux reconciliation belongs to `INT-V1-015`; release privacy/setup docs belong to release-readiness tasks.

## Initial Audit

- Existing coverage already proves base migrations, corrupt DB rejection, settings defaults, invalid settings reload, session stale invariants, auth hash-only storage, auth revocation/expiry/read-only/CSRF rejection, audit payload bounds, retention boundaries, optional branch metadata, and cross-repository restart persistence.
- Hardening gaps selected for this pass:
  - Raw auth secret inputs need explicit rejection before hashing.
  - Retention should retain the newest event even when a misconfigured byte cap is below one event payload.
  - Audit retention boundaries should be contractually global and cursorless.
  - Migration checksum mismatch and sequence-gap coverage should assert specific failure codes.
  - Audit storage unavailability should produce a distinct repository error for later write-preflight services.

## Implemented Hardening

- Added `packages/storage/src/storage-hardening.test.ts` as the storage module hardening suite.
- Added migration `202607080004_retention_boundary_scope_checks` to make audit retention boundaries global and cursorless at schema level.
- Tightened `retentionBoundaryRecordSchema` so invalid audit boundary shape fails contract parsing.
- Added raw secret validation before pairing-code, device-token, and CSRF hashing or lookup.
- Added distinct `audit_unavailable` audit repository errors for closed, missing, or read-only audit storage.
- Adjusted output retention cleanup to keep the newest output event visible even when a byte cap is smaller than one payload.
- Added local SQLite inspection coverage proving raw pairing/device/CSRF values and unbounded prompt text are absent from persisted rows.

## Validation

- `pnpm install --frozen-lockfile` passed.
- `pnpm --filter @hostdeck/storage typecheck` passed.
- `pnpm test:unit -- packages/storage/src/storage-hardening.test.ts packages/storage/src/audit-repository.test.ts packages/storage/src/auth-repository.test.ts packages/storage/src/retention-repository.test.ts packages/storage/src/migration-runner.test.ts packages/contracts/src/storage.contract.test.ts` passed with 92 tests across 15 files.
- `pnpm lint` passed.
- `pnpm typecheck` passed.
- `pnpm check:scaffold` passed.
- `pnpm -r --if-present typecheck` passed.
- `pnpm test` passed with 92 tests across 15 files.
- `pnpm test:contract` passed with 37 tests across 4 files.
- `git diff --check` passed.

## Remaining Gaps

- API write-preflight ordering and remote write rejection on audit failure remain in `IFC-V1-004`.
- Live tmux restart reconciliation remains in `INT-V1-015`.
- Release privacy/setup documentation and clean-run evidence remain in release-readiness tasks.
