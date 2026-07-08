# FND-V1-012 Storage, Config, Auth, Audit, And Retention Contract Schemas

Date: 2026-07-08

## Scope

- Added shared scalar contract validators in `packages/contracts/src/scalars.ts` for session ids, names, cwd paths, ISO timestamps, output cursors, bind mode, and bounded primitive values.
- Added storage-oriented Zod schemas in `packages/contracts/src/storage.ts` for:
  - schema migration records
  - settings/config records
  - session registry records
  - session metadata records
  - output event records
  - retention boundary records
  - auth device records
  - pairing code records
  - bounded audit event records
- Exported the storage contracts from `@hostdeck/contracts`.
- Kept this task to contracts only; SQLite driver selection, migrations, and repositories remain in the `DAT-V1-*` tasks.

## Contract Coverage

- Session registry records require stable ids, unique-name-compatible names, absolute cwd, tmux backend metadata, lifecycle state, timestamps, and coherent stale reasons.
- Session metadata records validate branch, status, attention, bounded summary, last activity, and last output cursor fields.
- Output event records validate cursor/order metadata, capture timestamps, bounded payloads, and replay-boundary cursor truth.
- Retention boundary records make output/audit cleanup explicit, with output boundaries requiring both session and cursor references.
- Auth and pairing records store hash fields only; strict schemas reject raw token/code fields.
- Settings records validate state directory, bind mode, host, port, LAN state, lock state, retention policy, and schema version.
- Audit events validate explicit command action types, bounded/sanitized payload summaries, actor identity, result state, and error-code consistency.

## Validation

Passed:

- `pnpm install --frozen-lockfile`
- `pnpm check:scaffold`
- `pnpm typecheck`
- `pnpm -r --if-present typecheck`
- `pnpm lint`
- `pnpm test`
- `pnpm test:unit`
- `pnpm test:contract`
- `git diff --check`

Observed results:

- Unit tests: 4 files, 31 tests passed.
- Contract tests: 2 files, 19 tests passed.
