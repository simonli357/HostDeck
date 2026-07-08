# FND-V1-007 Deterministic Fake Codex, Session, And Host Fixtures

Date: 2026-07-08

## Scope

- Added deterministic Codex-like output fixtures in `packages/test-fixtures/src/codex-output.ts`.
- Added fake API session, host status, Mission Control, and Session Detail fixtures in `packages/test-fixtures/src/session-states.ts`.
- Exported fixtures through `@hostdeck/test-fixtures`.
- Added fixture inventory and contract-compatibility tests in `packages/test-fixtures/src/fixtures.test.ts`.
- Added workspace dependencies from `@hostdeck/test-fixtures` to `@hostdeck/core` and `@hostdeck/contracts`.

## Required SFR-011 Categories

Covered:

- question waiting
- approval waiting
- command running
- tests passed
- tests failed
- compact/context warning
- idle/no-output
- unknown output

## Validation

Passed:

- `pnpm install`
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

- Unit tests: 5 files, 38 tests passed.
- Contract tests: 3 files, 26 tests passed.

## Notes

- The first frozen install failed as expected before refreshing `pnpm-lock.yaml` because the fixture package gained workspace dependencies.
- Unknown output is explicitly expected to classify as `status: unknown` and `attention: unknown`; it is not treated as idle, passed, or healthy.
