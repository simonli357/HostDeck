# INT-V1-012 Real Tmux Managed Start

## Scope

- Added `createRealTmuxAdapter()` with real `startSession`, `listTargets`, and `getTarget` behavior.
- Kept real `sendInput`, `stopSession`, `attachMetadata`, and `readOutput` as loud `unsupported_operation` failures until their owning tasks.
- Aligned fake adapter tmux session naming with the real deterministic `hostdeck_${sessionId}` naming helper.

## Behavior

- Real starts validate the session id, session name, absolute cwd, existing cwd directory, and non-empty command parts before launching tmux.
- Command binaries must be absolute executable files or resolvable on `PATH`; missing binaries return `command_unavailable`.
- Starts use `tmux new-session -d -s hostdeck_${sessionId} -c <cwd> -n <command-name> <command>`.
- The adapter verifies that the deterministic HostDeck tmux target exists after launch before returning success.
- Duplicate live session ids return `duplicate_session`; in-process duplicate live session names return `duplicate_session_name`.
- Missing tmux returns `tmux_unavailable`.
- Commands that exit before verification return `start_failed`; partial tmux targets are killed when present.
- `listTargets()` and `getTarget()` return live targets known to this adapter instance through real tmux discovery/reconciliation.

## Validation

- `command -v codex && codex --version && command -v tmux && tmux -V` passed with `codex-cli 0.143.0` and `tmux 3.4`.
- `pnpm install --frozen-lockfile` passed.
- `pnpm check:scaffold` passed.
- `pnpm --filter @hostdeck/tmux-adapter typecheck` passed.
- `pnpm test:unit -- packages/tmux-adapter/src/index.test.ts` passed.
- `pnpm lint` passed.
- `pnpm -r --if-present typecheck` passed.
- `pnpm test` passed: 17 unit test files, 111 tests.
- `pnpm test:contract` passed: 4 contract test files, 37 tests.
- `git diff --check` passed.

## Remaining Gaps

- Real send, stop, and attach metadata operations remain in `INT-V1-013`.
- Output reader, cursor assignment, and replay-boundary handoff remain in `INT-V1-014`.
- Durable restart reconciliation service remains in `INT-V1-015`.
- API/CLI session creation and durable registry transaction handling remain in later `BLK-V1-04` tasks.
- Full real Ubuntu tmux smoke and hardening remain in `INT-V1-016` and `INT-V1-090`.
