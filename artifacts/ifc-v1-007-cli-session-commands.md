# IFC-V1-007 CLI Session Commands

Task: `IFC-V1-007` CLI session commands: `start`, `list`, `send`, `attach`, `stop`, and status display.

Date: 2026-07-09

## Implementation

- Added typed `StartSessionRequest` / `StartSessionResponse` contracts and `POST /api/sessions` route-manifest coverage.
- Added a headless session-control route that starts HostDeck-managed tmux sessions, stores durable session and metadata records, starts output capture when provided, and fails with typed errors for invalid cwd, duplicate name, missing Codex binary, tmux start failure, storage failure, and output-reader startup failure.
- Extended write routes with explicit local-admin CLI write support while preserving browser cookie+CSRF write authorization for dashboard callers.
- Extended the CLI parser, API client, shell, and renderers for:
  - `codexdeck start --name NAME --cwd PATH`
  - `codexdeck list`
  - `codexdeck send SESSION TEXT...`
  - `codexdeck attach SESSION`
  - `codexdeck stop SESSION`
- Session-targeting commands resolve exactly one managed session by id or unique name and fail before write/attach when the target is missing, ambiguous, stale, or non-running.
- `attach` prints explicit tmux attach metadata instead of claiming an attach occurred.
- Added CLI/API/server route tests plus a skipped-by-default CLI real-tmux smoke under `tests/cli-tmux-smoke.test.ts`.

## Coverage

- `start` validates name/cwd request shape before tmux side effects.
- Duplicate session names fail before a second tmux target is created.
- Missing Codex executable maps to `missing_binary` with field `command`.
- Output-reader startup failure returns `internal_error` and attempts to stop the launched tmux target.
- `list` renders lifecycle, status, attention, branch, cwd, and stale state honestly.
- `send` posts prompt text only after resolving one running managed session.
- `attach` refuses stale/non-running sessions and prints the tmux attach command for running sessions.
- `stop` posts an explicit confirmed stop after resolving one running managed session.
- Write rejections returned as `{ accepted: false, error }` are converted into typed CLI API failures.
- Real tmux CLI smoke covers `start`, `list`, `attach`, `send`, and `stop` through a real tmux adapter-backed client.

## Validation

Environment:

```text
codex-cli 0.143.0
tmux 3.4
Ubuntu 24.04.4 LTS
2026-07-09T04:44:49-04:00
```

Commands:

```text
pnpm install --frozen-lockfile
pnpm --filter @hostdeck/contracts typecheck
pnpm --filter @hostdeck/server typecheck
pnpm --filter @hostdeck/cli typecheck
pnpm typecheck
pnpm -r --if-present typecheck
pnpm test:contract
pnpm test:unit
pnpm test
pnpm lint
pnpm check:scaffold
pnpm test:tmux
HOSTDECK_REQUIRE_TMUX_SMOKE=1 pnpm exec vitest run tests/cli-tmux-smoke.test.ts
git diff --check
```

Results:

- `pnpm install --frozen-lockfile`: passed; lockfile was current.
- Package-focused typechecks for contracts, server, and CLI: passed.
- `pnpm typecheck`: passed for the root tsconfig, including root smoke tests.
- `pnpm -r --if-present typecheck`: passed for all 8 workspace packages with typecheck scripts.
- `pnpm test:contract`: passed; 6 files and 58 tests.
- `pnpm test:unit`: passed; 28 files / 168 tests, with the CLI real-tmux smoke skipped by default.
- `pnpm test`: passed; same unit suite result.
- `pnpm lint`: passed; Biome checked 101 files and package exports passed.
- `pnpm check:scaffold`: passed; 8 packages and 12 root scripts.
- `pnpm test:tmux`: passed; 1 real server/tmux smoke test.
- `HOSTDECK_REQUIRE_TMUX_SMOKE=1 pnpm exec vitest run tests/cli-tmux-smoke.test.ts`: passed; 1 CLI real-tmux smoke test.
- `git diff --check`: passed.

## Remaining Gaps

- This still does not add a packaged runnable `codexdeck` binary.
- The real CLI tmux smoke uses an injected tmux-backed API client because the mounted HTTP daemon/router is not implemented yet.
- Pairing, lock/unlock, and LAN commands remain in `IFC-V1-008`.
- Full CLI command matrix coverage remains in `IFC-V1-013` after `IFC-V1-008`.
- Command-reference updates remain in `REL-V1-003` after CLI commands are runnable through the final service path.
