# IFC-V1-012 Service-Mode Smoke

Task: `IFC-V1-012` foreground and long-running service-mode smoke behavior.

Date: 2026-07-09

## Implementation

- Added `startHostHttpService` in `@hostdeck/server`.
- The service reuses `startHostAgent`, opens the same SQLite state, runs startup checks, reconciles tmux state, then binds a local HTTP listener.
- The listener currently exposes `GET /api/host/status` with the existing `HostStatusResponse` contract and typed JSON route errors for unsupported methods/routes.
- The service has a clean `close()` path that closes the HTTP listener and host-agent storage handle.
- Added CLI `serve` parsing/shell behavior.
- `codexdeck serve` now starts the host HTTP service through the CLI shell, emits readiness immediately, waits for shutdown, and closes the service.
- Added `@hostdeck/server` as a CLI workspace dependency because `serve` owns the daemon entrypoint.

## Smoke Coverage

- `packages/server/src/host-service.test.ts` starts a real local HTTP listener, fetches host status, keeps the service reachable briefly, stops it, verifies the listener is unavailable, then restarts from the same state directory/database.
- `tests/service-mode-smoke.test.ts` starts the real service and calls `runCli status` against it, verifies daemon-unavailable behavior after stop, then restarts and verifies CLI status works again.
- `packages/cli/src/cli.contract.test.ts` covers `serve` command wiring, state/database/port inputs, immediate readiness output, shutdown waiting, and close ordering through an injected service starter.

## Validation

Commands:

```text
pnpm --filter @hostdeck/server typecheck
pnpm --filter @hostdeck/cli typecheck
pnpm test:unit -- packages/server/src/host-service.test.ts packages/cli/src/cli.contract.test.ts tests/service-mode-smoke.test.ts
pnpm install --frozen-lockfile
git diff --check
pnpm lint
pnpm typecheck
pnpm -r --if-present typecheck
pnpm test:unit
pnpm test:contract
pnpm check:scaffold
pnpm test
pnpm test:tmux
HOSTDECK_REQUIRE_TMUX_SMOKE=1 pnpm exec vitest run tests/cli-tmux-smoke.test.ts
```

Results:

- `pnpm --filter @hostdeck/server typecheck`: passed.
- `pnpm --filter @hostdeck/cli typecheck`: passed.
- Focused service/CLI smoke command: passed; Vitest reported 31 passed files and 1 skipped file, with 174 passed tests and 1 skipped test.
- `pnpm install --frozen-lockfile`: passed.
- `git diff --check`: passed.
- `pnpm lint`: passed; Biome checked 106 files and package exports passed.
- `pnpm typecheck`: passed.
- `pnpm -r --if-present typecheck`: passed for all 8 workspace packages with typecheck scripts.
- `pnpm test:unit`: passed; 31 files / 174 tests, with 1 skipped file/test.
- `pnpm test:contract`: passed; 6 files and 62 tests.
- `pnpm check:scaffold`: passed; 8 packages and 12 root scripts.
- `pnpm test`: passed; same unit suite result.
- `pnpm test:tmux`: passed; 1 real server/tmux smoke test.
- `HOSTDECK_REQUIRE_TMUX_SMOKE=1 pnpm exec vitest run tests/cli-tmux-smoke.test.ts`: passed; 1 CLI real-tmux smoke test.

## Remaining Gaps

- The HTTP listener currently wires `GET /api/host/status`; the other route families still exist as headless route handlers and need HTTP registration in later interface tasks.
- This does not add a packaged runnable `codexdeck` binary.
- This does not add an OS-level long-running service wrapper; V1 still needs documented wrapper/release smoke in `REL-V1-002` and `REL-V1-006`.
- Dashboard serving remains in `IFC-V1-009`.
