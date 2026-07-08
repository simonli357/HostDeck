# FND-V1-013 UI Fixture And View-Model Contract Schemas

Date: 2026-07-08

## Scope

- Added UI view-model Zod schemas in `packages/contracts/src/ui.ts` for:
  - write control state
  - output boundary visibility
  - session cards
  - trust state
  - host safety state
  - Mission Control
  - Session Detail
- Exported the UI contracts from `@hostdeck/contracts`.
- Kept this task to headless UI contracts only. No UI implementation, visual direction, generated mockups, or screen assets were created.

## Contract Coverage

- Session cards use shared session id/name/cwd/timestamp/cursor validation plus core lifecycle/status/attention enums.
- Session Detail view models consume shared API session and output contracts and enforce exactly one target session.
- Host safety models consume shared host status, security state, and network state contracts.
- Trust models keep disabled write controls visible before writes when untrusted, read-only, or locked.
- Output boundaries must be visible and carry user-facing copy when replay/truncation occurs.
- Remote unlock and dashboard LAN mutation controls are rejected in V1 view models.
- Raw input remains disabled while the advanced raw fallback is hidden.

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
- Contract tests: 3 files, 26 tests passed.
