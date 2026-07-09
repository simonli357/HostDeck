# DAT-V1-015 Retention Cleanup And Replay Boundary Storage Metadata

Date: 2026-07-08

## Scope

- Added `createRetentionRepository` in `@hostdeck/storage`.
- Added storage-side output append/replay support backed by `output_events`.
- Added output cleanup by `output_event_limit` and UTF-8 `output_byte_limit`.
- Added global audit cleanup by `audit_event_limit` and `audit_retention_days`.
- Added durable `retention_boundaries` writes for output and audit cleanup.
- Exported the `RetentionPolicy` contract type from `@hostdeck/contracts`.

## Behavior Proven

- Output cursors remain monotonic per session and cannot be reused after pruning.
- Event-cap cleanup retains newest output records and records the highest removed cursor.
- Byte-cap cleanup uses UTF-8 payload bytes, including multibyte text.
- Replay reads return a boundary when the requested cursor is before the retained range.
- Latest output boundary lookup orders by numeric `truncated_before_cursor`, not lexicographic id.
- Audit cleanup enforces both count and age limits and records global audit boundaries.
- Invalid output payloads, missing sessions, invalid replay cursors, invalid limits, corrupt output rows, and corrupt boundary rows fail loudly.

## Validation

- `pnpm install --frozen-lockfile` passed.
- `pnpm --filter @hostdeck/storage typecheck` passed.
- `pnpm check:scaffold` passed.
- `pnpm typecheck` passed.
- `pnpm -r --if-present typecheck` passed.
- `pnpm lint` passed.
- `pnpm test` passed with 80 tests across 12 files.
- `pnpm test:unit -- packages/storage/src/retention-repository.test.ts packages/storage/src/audit-repository.test.ts packages/contracts/src/storage.contract.test.ts` passed with 80 tests across 12 files.
- `pnpm test:contract` passed with 37 tests across 4 files.
- `git diff --check` passed.

## Remaining Gaps

- Tmux output capture still waits on `INT-V1-001`; `INT-V1-014` can now consume storage retention primitives after that spike.
- API/UI boundary rendering remains planned in `IFC-V1-003`, `INT-V1-014`, and `FE-V1-015`.
