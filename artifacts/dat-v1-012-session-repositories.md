# DAT-V1-012 Session Registry And Metadata Repositories

Date: 2026-07-08

## Scope

- Added `@hostdeck/storage` session registry and metadata repositories in `packages/storage/src/session-repository.ts`.
- Repositories use `@hostdeck/contracts` storage schemas for runtime validation.
- Session repository persists stable ids, unique names, absolute cwd, tmux backend target metadata, lifecycle state, timestamps, and stale reasons.
- Metadata repository persists branch, last activity, status, attention, summary, last output cursor, and update time.
- Added a second SQLite migration, `202607080002_session_metadata_failed_status`, so storage accepts every valid core session status, including `failed`.

## Failure Behavior Covered

- Duplicate session names return `HostDeckSessionRepositoryError` with `duplicate_session_name`.
- Duplicate session ids return `session_exists`.
- Invalid session records, including relative cwd and stale sessions without a reason, return `invalid_session`.
- Metadata for a missing session returns `session_not_found`.
- Invalid persisted session rows fail on repository reload instead of being treated as valid state.

## Validation

- `pnpm install --frozen-lockfile` passed.
- `pnpm --filter @hostdeck/storage typecheck` passed.
- `pnpm check:scaffold` passed.
- `pnpm typecheck` passed.
- `pnpm -r --if-present typecheck` passed.
- `pnpm lint` passed.
- `pnpm test` passed with 62 tests across 9 files.
- `pnpm test:unit -- packages/storage/src/session-repository.test.ts packages/storage/src/migration-runner.test.ts` passed with 62 tests across 9 files.
- `pnpm test:contract` passed with 37 tests across 4 files.
- `git diff --check` passed.

## Remaining Follow-Up

- `DAT-V1-017` is now ready for optional git branch capture against session metadata.
- `DAT-V1-016` still waits on auth and audit repositories before the cross-repository restart-persistence test can close.
- Real tmux start/reconcile tasks still wait on `INT-V1-010` and environment tmux access.
