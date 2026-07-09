# INT-V1-015 Restart Reconciliation

## Scope

- Added a server-side restart reconciler that compares durable session records with live tmux target discovery.
- Added server dependency on `@hostdeck/tmux-adapter` so startup services can consume typed real tmux discovery results.
- Added an output-reader restart hook for live targets.

## Behavior

- Non-stopped durable sessions are converted to expected tmux targets and reconciled through `RealTmuxTargetDiscovery`.
- Live targets update durable session records to `running`, refresh tmux session/window/pane metadata, clear stale reasons, and invoke the output-reader start hook.
- Missing expected targets are marked `stale` with the reconciler-provided reason.
- Stopped durable sessions are ignored and remain stopped.
- Unmanaged HostDeck-looking live targets are returned in the result but are not imported into storage.

## Validation

- `command -v codex && codex --version && command -v tmux && tmux -V` passed with `codex-cli 0.143.0` and `tmux 3.4`.
- `pnpm install` updated the lockfile for the new internal workspace dependency.
- `pnpm install --frozen-lockfile` passed after the lockfile update.
- `pnpm check:scaffold` passed.
- `pnpm --filter @hostdeck/server typecheck` passed.
- `pnpm test:unit -- packages/server/src/restart-reconciler.test.ts` passed.
- `pnpm lint` passed.
- `pnpm -r --if-present typecheck` passed.
- `pnpm test` passed: 19 unit test files, 119 tests.
- `pnpm test:contract` passed: 4 contract test files, 37 tests.
- `git diff --check` passed.

## Test Coverage

- Live durable session is updated to `running` with refreshed tmux pane metadata.
- Missing durable session is marked `stale`.
- Stopped durable session remains stopped and is not reconciled.
- Unmanaged HostDeck-looking target is reported without being imported.
- Output-reader start hook runs for live targets.

## Remaining Gaps

- Full real Ubuntu smoke with start, attach, send, stop, output, restart, and stale behavior remains in `INT-V1-016`.
- Tmux/output module hardening remains in `INT-V1-090`.
- API/CLI startup wiring and route exposure remain in `BLK-V1-04` tasks.
