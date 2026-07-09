# INT-V1-090 Tmux Lifecycle And Output Hardening

## Hardening Target

- Owning block: `BLK-V1-03`
- Modules inspected: `@hostdeck/tmux-adapter`, server output reader, server restart reconciler, SQLite-backed output retention handoff.
- Current maturity before this pass: real adapter/output/restart primitives and the required Ubuntu tmux smoke exist, but hardening evidence is incomplete.

## Harsh Success Criteria

- Missing `tmux`, missing Codex command, invalid cwd, duplicate target id/name, failed start, missing target, and stale target failures return typed errors without creating fake success.
- Repeated start/send/read/stop cycles leave no managed targets behind, reject later writes/attach/read, and keep exact session targeting.
- Output capture appends only genuinely new lines when the current tmux snapshot contains a retained-output suffix rather than the whole retained history.
- Output continuity gaps create explicit replay-boundary events instead of pretending full continuity.
- Invalid replay cursors and invalid replay limits fail loudly through server reader errors.
- Output reader capture and append failures are observable through reader state.
- Restart reconciliation marks missing targets stale, ignores stopped records, reports unmanaged HostDeck-looking targets without importing them, and makes output-reader start failures visible instead of silently succeeding.
- Manual real tmux smoke covers at least two sessions, attach metadata, send targeting, stop, output drain, restart reconciliation, and stale behavior on the supported Ubuntu/tmux/Codex environment.

## Audit Gaps Found Before Implementation

- Bounded tmux snapshots can contain only the suffix of previously retained output. The existing diff logic required all previous retained lines to be present, which could add false replay boundaries and duplicate recent output.
- Restart reconciliation had no regression for output-reader start failure visibility.
- Server output reader tests did not cover invalid replay limits/cursors through the reader API.
- Repeated lifecycle cleanup was covered by individual operations but not by repeated real start/stop cycles.

## Planned Fixes

- Teach adapter and server reader snapshot diffing to match the longest previous-output suffix present in the captured snapshot.
- Add focused tests for suffix-continuity output append, invalid replay input, output-reader start failure, and repeated real tmux start/stop cleanup.
- Run focused tmux/server tests, full repo validation, and `pnpm test:tmux`.

## Changes Made

- Updated server output-reader snapshot diffing to match the longest retained-output suffix inside a bounded captured snapshot before appending new output.
- Updated real tmux adapter `readOutput()` with the same suffix-continuity logic so bounded `capture-pane` windows do not duplicate recently retained output.
- Added typed `HostDeckRestartReconcilerError` failures for output-reader startup errors during restart reconciliation, including affected session ids.
- Kept restart reconciliation stale-marking behavior active even when a live target's output reader fails to start.

## Validation

- `command -v codex && codex --version && command -v tmux && tmux -V && lsb_release -ds && date -Iseconds` passed on Ubuntu 24.04.4 LTS with `codex-cli 0.143.0` and `tmux 3.4` at 2026-07-09T02:53:57-04:00.
- `pnpm install --frozen-lockfile` passed.
- `pnpm check:scaffold` passed.
- `pnpm --filter @hostdeck/tmux-adapter typecheck` passed.
- `pnpm --filter @hostdeck/server typecheck` passed.
- `pnpm test:unit -- packages/server/src/output-reader.test.ts packages/server/src/restart-reconciler.test.ts packages/tmux-adapter/src/index.test.ts` passed: 20 unit test files, 126 tests.
- `pnpm lint` passed.
- `pnpm -r --if-present typecheck` passed.
- `pnpm test` passed: 20 unit test files, 126 tests.
- `pnpm test:contract` passed: 4 contract test files, 37 tests.
- `pnpm test:tmux` passed: 1 smoke test file, 1 test.
- `git diff --check` passed.

## Coverage Added

- Server output reader appends only the new line when the current capture contains a suffix of retained output.
- Server output reader records observable `storage_append_failed` state when storage append fails.
- Server output reader rejects invalid replay cursors and invalid replay limits as `invalid_replay`.
- Restart reconciliation surfaces output-reader startup failure as `output_reader_start_failed` with affected session ids while still marking missing sessions stale.
- Real tmux adapter proves bounded `capture-pane` suffix continuity by printing more than the bounded window, sending one more line, and asserting only the new acknowledgment is emitted after the prior cursor.
- Real tmux adapter proves repeated start/stop cycles leave no managed targets behind and reject later send/attach attempts.

## Manual AI Inspection

- Reviewed the tmux adapter and server reader diff logic for hidden fallback behavior. Continuity is treated as proven only when a suffix of retained output is found in the current snapshot; otherwise the server reader still records an explicit replay boundary.
- Reviewed restart reconciliation ordering. Durable session truth is updated from tmux discovery, missing targets are marked stale, and reader-start failure is surfaced as a typed failure instead of returning a successful reconciliation result.
- Reviewed validation output against `INT-V1-090` criteria. The task now has automated coverage for missing/stale target errors, repeated lifecycle cleanup, reader crash/append failure, invalid replay input, restart reader failure, and real tmux smoke behavior.

## Remaining Gaps

- API/CLI startup, route exposure, write dispatch, stream fanout, and command behavior remain in `BLK-V1-04`.
- Dashboard UI, visual mockups, and UI-fidelity evidence remain in `BLK-V1-05`.
- Clean install/run/service release smoke remains in `BLK-V1-06`.
