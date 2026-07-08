# DAT-V1-011 Settings Repository

Date: 2026-07-08

## Scope

- Added `@hostdeck/storage` settings repository exports in `packages/storage/src/settings-repository.ts`.
- Stores and loads the singleton `settings` row from the SQLite base schema.
- Uses `@hostdeck/contracts` `settingsRecordSchema` and `defaultRetentionPolicy` as the runtime contract source.
- Creates safe defaults: `127.0.0.1`, LAN disabled, port `3777`, unlocked, configured absolute state directory, and `DEC-016` retention defaults.
- Persists lock and LAN state changes across database reopen.
- Rejects invalid settings before write and when persisted invalid settings are loaded at startup.

## Failure Behavior Covered

- Missing settings throw `HostDeckSettingsError` with `settings_missing`.
- Invalid contract shape, invalid port, invalid state dir, invalid bind host, localhost-mode non-loopback bind, and LAN-mode loopback bind throw `HostDeckSettingsError` with `invalid_settings`.
- LAN enable defaults to `0.0.0.0`; LAN disable returns to `127.0.0.1`.

## Validation

- `pnpm install --frozen-lockfile` passed.
- `pnpm --filter @hostdeck/storage typecheck` passed.
- `pnpm check:scaffold` passed.
- `pnpm typecheck` passed.
- `pnpm -r --if-present typecheck` passed.
- `pnpm lint` passed.
- `pnpm test` passed.
- `pnpm test:unit -- packages/storage/src/settings-repository.test.ts` passed with 55 tests across 8 files.
- `pnpm test:unit` passed with 55 tests across 8 files.
- `pnpm test:contract` passed with 37 tests across 4 files.
- `git diff --check` passed.

## Remaining Follow-Up

- `DAT-V1-016` will add broader restart-persistence coverage across settings, session registry, auth, and audit repositories after the remaining repositories exist.
- `IFC-V1-011` will prove the actual server startup bind behavior and network smoke path.
