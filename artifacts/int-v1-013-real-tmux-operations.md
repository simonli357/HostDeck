# INT-V1-013 Real Tmux Send Stop Attach

## Scope

- Implemented real `sendInput`, `stopSession`, and `attachMetadata` operations in `createRealTmuxAdapter()`.
- Kept `readOutput` as a loud `unsupported_operation` until `INT-V1-014`.

## Behavior

- `sendInput()` requires a known live HostDeck target and sends literal text to the exact stored pane id with `tmux send-keys -t <pane> -l -- <text>`.
- `sendInput()` sends `Enter` by default and records the accepted text, pane id, enter flag, and timestamp.
- Empty or NUL-containing input is rejected before tmux dispatch.
- `stopSession()` requires a known live target, kills the deterministic tmux session, removes it from the adapter's known target set, and returns a stopped target snapshot.
- `attachMetadata()` requires a known live target and returns a concrete `tmux attach-session` command, including `-L <socket>` when the adapter is configured with an isolated socket.
- Unknown session ids fail as `missing_target`; known targets that disappeared from tmux fail as `stale_target`.

## Validation

- `command -v codex && codex --version && command -v tmux && tmux -V` passed with `codex-cli 0.143.0` and `tmux 3.4`.
- `pnpm install --frozen-lockfile` passed.
- `pnpm check:scaffold` passed.
- `pnpm --filter @hostdeck/tmux-adapter typecheck` passed.
- `pnpm test:unit -- packages/tmux-adapter/src/index.test.ts` passed.
- `pnpm lint` passed.
- `pnpm -r --if-present typecheck` passed.
- `pnpm test` passed: 17 unit test files, 113 tests.
- `pnpm test:contract` passed: 4 contract test files, 37 tests.
- `git diff --check` passed.

## Test Coverage

- Real send targets exactly one pane by running two fake Codex tmux sessions and proving only the selected session's file receives input.
- Real attach metadata includes the isolated tmux socket and deterministic session target.
- Real stop removes the selected target and rejects later sends to it.
- Missing session refs fail as `missing_target`; killed tmux targets fail as `stale_target`.

## Remaining Gaps

- Output reader, cursor assignment, and replay-boundary handoff remain in `INT-V1-014`.
- Durable restart reconciliation service remains in `INT-V1-015`.
- Full real Ubuntu tmux smoke and hardening remain in `INT-V1-016` and `INT-V1-090`.
- API/CLI write dispatch, audit ordering, and user-facing session commands remain in later `BLK-V1-04` tasks.
