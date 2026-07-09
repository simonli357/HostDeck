# IFC-V1-001 Startup Readiness

Task: `IFC-V1-001` `codexdeck serve` startup sequence and host readiness checks.

Date: 2026-07-09

## Implementation

- Added `startHostAgent` and `HostDeckStartupError` in `packages/server/src/startup.ts`.
- Startup now validates state directory access, SQLite migrations, settings/bind policy, tmux discovery, registry reconciliation, and output-reader startup for live sessions before returning a ready `HostStatusResponse`.
- Failure startup paths throw typed errors with a non-ready host status and bounded API error envelope details.
- Restart reconciliation remains durable-state driven: live sessions are updated, missing durable sessions become stale, stopped sessions stay stopped, and unmanaged HostDeck-looking targets are reported but not imported.

## Coverage

- Ready path with persisted settings, one live session, one missing durable session, and one unmanaged tmux target.
- Missing tmux binary.
- Invalid state directory.
- Invalid bind port/settings.
- Migration failure.
- Output-reader startup failure for a live reconciled session.

## Validation

Environment:

```text
codex-cli 0.143.0
tmux 3.4
Ubuntu 24.04.4 LTS
2026-07-09T03:11:24-04:00
```

Commands:

```text
pnpm install --frozen-lockfile
pnpm --filter @hostdeck/server typecheck
pnpm test:unit -- packages/server/src/startup.test.ts
pnpm lint
pnpm check:scaffold
pnpm -r --if-present typecheck
pnpm test
pnpm test:contract
pnpm test:tmux
git diff --check
```

Results:

- `pnpm install --frozen-lockfile`: passed; lockfile was current.
- `pnpm --filter @hostdeck/server typecheck`: passed.
- `pnpm test:unit -- packages/server/src/startup.test.ts`: passed; Vitest reported 21 files and 132 tests because the root unit runner includes the full suite with this filter invocation.
- `pnpm lint`: passed; Biome and package export checks passed.
- `pnpm check:scaffold`: passed; 8 packages and 12 root scripts.
- `pnpm -r --if-present typecheck`: passed for all 8 workspace packages with typecheck scripts.
- `pnpm test`: passed; 21 files, 132 tests.
- `pnpm test:contract`: passed; 4 files, 37 tests.
- `pnpm test:tmux`: passed; 1 real tmux smoke test.
- `git diff --check`: passed.

## Remaining Gaps

- This task adds the headless startup/readiness service, not the actual Fastify route registration or CLI command parser.
- `IFC-V1-002` owns host status/session/output routes.
- `IFC-V1-006` owns the CLI shell and daemon-unavailable behavior.
- `IFC-V1-011` owns localhost/LAN network smoke and duplicate/invalid port coverage beyond the headless invalid-port startup test.
