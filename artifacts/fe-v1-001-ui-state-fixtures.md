# FE-V1-001 UI State Fixtures And View-Model Helpers

Date: 2026-07-09

## Scope

- Added headless dashboard view-model helpers in `packages/web/src/view-models.ts`.
- Added FE-V1-001 dashboard state fixture inventory in `packages/test-fixtures/src/dashboard-states.ts`.
- Replaced the `pnpm test:web` placeholder with a real web state test command.

## State Coverage

The fixture inventory covers:

- Mission Control: empty, loading, all idle, mixed attention, disconnected, permission denied, agent error, LAN disabled, locked.
- Session Detail: running, waiting for user, waiting for approval, failed, unknown, stale, stopped, output boundary, stream reconnecting.

The helpers keep write controls disabled before writes for untrusted, read-only, locked, unknown, stale, stopped, raw-confirmation, and stream-reconnecting states. Mission Control cards are attention-sorted and Session Detail exposes all V1 slash commands: `/model`, `/goal`, `/plan`, `/usage`, `/compact`, and `/skills`.

## Validation

Passed:

- `pnpm install`
- `pnpm install --frozen-lockfile`
- `pnpm check:scaffold`
- `pnpm test:web`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm test:unit`
- `pnpm test:contract`
- `git diff --check`

Observed results:

- Web state tests: 2 files, 14 tests passed.
- Unit tests: 32 files passed, 1 skipped; 184 tests passed, 1 skipped.
- Contract tests: 6 files and 68 tests passed.
