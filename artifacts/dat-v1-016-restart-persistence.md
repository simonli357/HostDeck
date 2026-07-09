# DAT-V1-016 Storage Restart Persistence

Date: 2026-07-08

## Scope

- Added `packages/storage/src/restart-persistence.test.ts`.
- Wrote representative durable state, closed SQLite, reopened through `openMigratedDatabase`, and verified no pending migrations were reapplied.
- Covered settings, session registry, session metadata, pairing/auth, audit, output retention, replay boundary, and retained output events in one cross-repository restart path.
- Asserted runtime-only stream/output-reader state is not represented as durable storage tables.

## Behavior Proven

- Settings persist state dir, LAN bind, LAN enabled, and locked state after reopen.
- Session and metadata records persist cwd, lifecycle, branch, status, attention, and last output cursor after reopen.
- Claimed pairing codes remain used, and the resulting auth device can authorize a browser write after reopen.
- Session-scoped audit records remain readable after reopen.
- Output retention boundary and retained output replay remain readable after reopen.
- `schema_migrations` is current on reopen; no migrations are reapplied.
- No `stream_subscriptions` or `output_readers` tables exist, keeping live reader/subscription state out of durable storage.

## Validation

- `pnpm install --frozen-lockfile` passed.
- `pnpm --filter @hostdeck/storage typecheck` passed.
- `pnpm check:scaffold` passed.
- `pnpm typecheck` passed.
- `pnpm -r --if-present typecheck` passed.
- `pnpm lint` passed.
- `pnpm test` passed with 86 tests across 14 files.
- `pnpm test:unit -- packages/storage/src/restart-persistence.test.ts packages/storage/src/session-repository.test.ts packages/storage/src/auth-repository.test.ts packages/storage/src/audit-repository.test.ts packages/storage/src/retention-repository.test.ts packages/storage/src/settings-repository.test.ts` passed with 86 tests across 14 files.
- `pnpm test:unit -- packages/storage/src/restart-persistence.test.ts` passed with 86 tests across 14 files.
- `pnpm test:contract` passed with 37 tests across 4 files.
- `git diff --check` passed.

## Remaining Gaps

- Live tmux target reconciliation remains in `INT-V1-015`.
- Server startup readiness remains in `IFC-V1-001`.
- Storage module hardening remains in `DAT-V1-090`.
