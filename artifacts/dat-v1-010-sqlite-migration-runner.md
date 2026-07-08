# DAT-V1-010 SQLite Migration Runner And Base Schema

Date: 2026-07-08

## Implementation

- Added `better-sqlite3@12.11.1` to `@hostdeck/storage`.
- Added `@types/better-sqlite3@7.6.13` for TypeScript.
- Added `better-sqlite3` to `pnpm-workspace.yaml` `onlyBuiltDependencies` so clean installs can build the native binding.
- Added `openMigratedDatabase` and `runMigrations`.
- Added the first migration: `202607080001_base_schema`.
- Exported migration runner and migration definitions from `@hostdeck/storage`.

## Base Schema

The base schema creates:

- `schema_migrations`
- `sessions`
- `session_metadata`
- `output_events`
- `retention_boundaries`
- `auth_devices`
- `pairing_codes`
- `settings`
- `audit_events`

Indexes:

- `output_events_session_order_idx`
- `retention_boundaries_scope_applied_idx`
- `audit_events_at_idx`
- `audit_events_session_idx`

## Failure Behavior

- Unknown applied migration versions fail before applying pending migrations.
- Applied migration checksum drift fails before applying pending migrations.
- Duplicate migration versions fail before migration execution.
- Non-migration tables without migration history fail as untracked schema.
- Failed pending migrations roll back product schema changes and do not insert migration rows.
- Corrupt database files fail before startup can claim storage readiness.
- Foreign keys are enabled after open.

## Native Dependency Check

- Initial `pnpm add` skipped the `better-sqlite3` build script under pnpm build approval.
- After adding `onlyBuiltDependencies`, `pnpm install --frozen-lockfile --force` rebuilt the dependency and the load check passed.
- Load check:

```sh
pnpm --filter @hostdeck/storage exec node -e "import Database from 'better-sqlite3'; const db = new Database(':memory:'); db.exec('select 1'); db.close(); console.log('better-sqlite3 load ok')"
```

Result: `better-sqlite3 load ok`.

## Validation

- `pnpm install --frozen-lockfile`
- `pnpm install --frozen-lockfile --force` after adding `onlyBuiltDependencies` to prove a clean native rebuild path.
- `pnpm --filter @hostdeck/storage exec node -e "import Database from 'better-sqlite3'; const db = new Database(':memory:'); db.exec('select 1'); db.close(); console.log('better-sqlite3 load ok')"`: passed.
- `pnpm --filter @hostdeck/storage typecheck`
- `pnpm check:scaffold`
- `pnpm typecheck`
- `pnpm -r --if-present typecheck`
- `pnpm lint`
- `pnpm test`: 7 files, 49 tests passed.
- `pnpm test:unit -- packages/storage/src/migration-runner.test.ts`: 7 files, 49 tests passed.
- `pnpm test:unit`: 7 files, 49 tests passed.
- `pnpm test:contract`: 4 files, 37 tests passed.
- `git diff --check`
