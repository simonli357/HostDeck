# FND-V1-008 Conservative Status And Attention Classifier Tests

Date: 2026-07-08

## Scope

- Added `classifyCodexOutput` in `packages/core/src/classifier.ts`.
- Exported the classifier from `@hostdeck/core`.
- Added fixture-backed classifier tests in `packages/test-fixtures/src/classifier.test.ts`.

## Behavior

- Empty output classifies as `status: idle`, `attention: none`.
- Approval prompts classify as `status: waiting_for_approval`, `attention: needs_approval`.
- User questions classify as `status: waiting_for_user`, `attention: needs_input`.
- Running commands classify as `status: running`, `attention: watch`.
- Passing tests classify as `status: tests_passed`, `attention: none`.
- Failing tests classify as `status: tests_failed`, `attention: failed`.
- Compact/context warnings classify as `status: compacting`, `attention: watch`.
- Unrecognized output classifies as `status: unknown`, `attention: unknown`.

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

- Unit tests: 6 files, 41 tests passed.
- Contract tests: 3 files, 26 tests passed.
