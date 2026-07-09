# INT-V1-011 Real Tmux Target Primitives

## Scope

- Added deterministic HostDeck tmux target naming in `@hostdeck/tmux-adapter` with names shaped as `hostdeck_${sessionId}`.
- Added HostDeck-only tmux session parsing so regular user sessions and malformed HostDeck-looking sessions are ignored.
- Added real tmux target discovery with optional isolated socket support for tests and future daemon isolation.
- Added target reconciliation from expected durable registry records into live, stale, and unmanaged HostDeck-looking targets.
- Added explicit `tmux_unavailable` adapter errors for missing tmux binaries.

## Behavior

- `tmuxSessionNameForSession(sessionId)` returns a stable tmux session name for the HostDeck session id.
- `parseSessionIdFromTmuxSessionName(tmuxSession)` returns a valid `SessionId` only for names with the HostDeck prefix and a valid core session id.
- `createRealTmuxTargetDiscovery().listTargets()` shells out to `tmux list-panes -a` and returns only valid HostDeck-managed targets with session, window, pane, cwd, created, and activity metadata.
- Missing tmux server state is treated as an empty live-target list so startup reconciliation can mark expected durable sessions stale.
- `reconcileTargets(expectedTargets)`:
  - returns live targets when deterministic session naming and optional stored window/pane metadata match;
  - marks expected targets stale when the tmux target is missing or stored window/pane metadata mismatches;
  - returns unmanaged HostDeck-looking live targets separately and does not import them automatically.

## Validation

- `command -v tmux && tmux -V` passed with `/home/simonli/.local/bin/tmux` and `tmux 3.4`.
- `pnpm install --frozen-lockfile` passed.
- `pnpm check:scaffold` passed.
- `pnpm lint` passed.
- `pnpm -r --if-present typecheck` passed.
- `pnpm test` passed: 17 unit test files, 106 tests.
- `pnpm test:contract` passed: 4 contract test files, 37 tests.
- `git diff --check` passed.

## Remaining Gaps

- Managed Codex session start, cwd validation, and partial-failure cleanup remain in `INT-V1-012`.
- Real send/stop/attach metadata operations remain in `INT-V1-013`.
- Output reader, cursor assignment, and replay-boundary handoff remain in `INT-V1-014`.
- Durable restart reconciliation service remains in `INT-V1-015`.
- Full real Ubuntu tmux smoke and hardening remain in `INT-V1-016` and `INT-V1-090`.
