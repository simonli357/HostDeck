# INT-V1-016 Real Ubuntu Tmux Smoke

## Scope

- Replaced the `pnpm test:tmux` placeholder with a required real tmux smoke test.
- Added a server smoke test that starts HostDeck-managed tmux sessions through the real adapter, uses isolated tmux sockets, and avoids real model calls with a deterministic fake `codex` executable.
- Verified that the real `codex` CLI and `tmux` binaries are available before the required smoke can pass.

## Environment

- OS: Ubuntu 24.04.4 LTS
- `codex`: `/home/simonli/.local/bin/codex`, `codex-cli 0.143.0`
- `tmux`: `/home/simonli/.local/bin/tmux`, `tmux 3.4`
- Evidence timestamp: 2026-07-08T22:53:13-04:00

## Smoke Path

- Starts two managed sessions with `createRealTmuxAdapter()` on an isolated tmux socket.
- Confirms attach metadata includes the socket-aware command: `tmux -L <socket> attach-session -t <hostdeck-session>`.
- Sends literal input to one pane and verifies the other pane does not receive it.
- Reads live output through the real adapter and drains it into SQLite-backed output retention.
- Stops one session explicitly and verifies restart reconciliation leaves it stopped.
- Simulates daemon restart reconciliation by reopening durable session state through `createRestartReconciler()` and starting the output-reader hook for the live target.
- Kills the remaining tmux target and verifies the next reconciliation marks the durable record `stale` with `tmux target missing`.

## Validation

- `command -v codex && codex --version && command -v tmux && tmux -V && lsb_release -ds && date -Iseconds` passed with the environment above.
- `pnpm install --frozen-lockfile` passed.
- `pnpm check:scaffold` passed.
- `pnpm --filter @hostdeck/server typecheck` passed.
- `pnpm lint` passed.
- `pnpm -r --if-present typecheck` passed.
- `pnpm test` passed: 20 unit test files, 121 tests.
- `pnpm test:contract` passed: 4 contract test files, 37 tests.
- `pnpm test:tmux` passed: 1 smoke test file, 1 test.
- `git diff --check` passed.

## Test Coverage

- Required smoke fails loudly when `HOSTDECK_REQUIRE_TMUX_SMOKE=1` and either `tmux` or `codex` is missing from `PATH`.
- Normal `pnpm test` includes the smoke when tools are present and skips it when required host tools are unavailable.
- The smoke covers start, attach metadata, send targeting, stop, output read, storage drain, restart reconciliation, output-reader restart hook, and stale target behavior in one path.
- Adapter regression coverage treats tmux's `server exited unexpectedly` response after the last managed session is killed as an allowed missing-server empty list, not as an invalid target.

## Remaining Gaps

- This is module-level smoke, not a clean install or service-mode release smoke.
- Real API/CLI startup wiring, dashboard observation, and service lifecycle evidence remain in `BLK-V1-04`, `BLK-V1-05`, and `BLK-V1-06`.
- Tmux/output negative-case hardening remains in `INT-V1-090`.
