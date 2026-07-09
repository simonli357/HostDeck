# INT-V1-010 Tmux Adapter Interface And Fake Adapter

Date: 2026-07-08

## Scope

- Replaced the empty `@hostdeck/tmux-adapter` package export with a typed async `TmuxAdapter` interface.
- Added deterministic `createFakeTmuxAdapter` support for start, list, get, send, stop, attach metadata, output reads, fake output append, stale marking, and sent-input inspection.
- Added typed `HostDeckTmuxAdapterError` codes for duplicate sessions/names, invalid cwd/start command/output cursor, missing target, stale target, and non-running target writes.
- Added the package dependency on `@hostdeck/core` so adapter inputs use shared session id, session name, cwd, timestamp, lifecycle, and cursor types.
- Added focused fake-adapter tests in `packages/tmux-adapter/src/index.test.ts`.

## Behavior Proven

- Fake starts produce deterministic tmux session names, pane ids, running lifecycle state, and attach commands without invoking real `tmux` or Codex.
- Fake list/get expose the selected target; duplicate session ids and names fail explicitly.
- Send records the exact selected-session input and pane; empty sends fail.
- Fake output appends monotonically increasing cursors and supports `after`/`limit` reads.
- Stop returns explicit stopped metadata, removes the live target, and rejects later send/attach attempts.
- Stale targets carry a reason and reject send/attach attempts.
- Missing targets and invalid output limits fail through typed adapter errors.

## Validation

- `pnpm install` passed and updated workspace links/lockfile.
- `pnpm --filter @hostdeck/tmux-adapter typecheck` passed.
- `pnpm test:unit -- packages/tmux-adapter/src/index.test.ts` passed with 97 tests across 16 files.
- `pnpm lint` passed.
- `pnpm typecheck` passed.
- `pnpm install --frozen-lockfile` passed.
- `pnpm check:scaffold` passed.
- `pnpm -r --if-present typecheck` passed.
- `pnpm test` passed with 97 tests across 16 files.
- `pnpm test:contract` passed with 37 tests across 4 files.
- `git diff --check` passed.

## Remaining Gaps

- `INT-V1-001` tmux output capture spike remains blocked because `tmux` is unavailable in this environment.
- `INT-V1-011` real tmux target naming/list/reconcile primitives require an environment with `tmux`.
- Real Codex launch, send/stop/attach, output reader, restart reconciliation, and Ubuntu smoke remain in later `BLK-V1-03` tasks.
