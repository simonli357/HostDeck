# IFC-V1-011 Localhost/LAN Network Smoke

Task: `IFC-V1-011` Localhost/LAN config and network smoke coverage.

Date: 2026-07-09

## Implementation

- Added startup network bind preflight in `packages/server/src/startup.ts`.
- Startup now validates the configured bind host/port after settings load and before tmux/reconciliation checks.
- Startup records a `network_bind` startup check when the bind is available.
- Startup fails loudly with typed `network_bind_failed` startup error, API error code `invalid_config`, and field `bind` when the configured host/port cannot be bound.
- Added injectable `checkNetworkBind` for deterministic startup tests that are not about networking.
- Added real Node TCP listener smoke coverage in `packages/server/src/network-smoke.test.ts`.
- Existing startup readiness tests now include the `network_bind` startup check.

## Coverage

- Default startup remains localhost-only: `127.0.0.1` with `lan_enabled: false`.
- Startup proves the default localhost bind port is available before returning ready.
- LAN enablement persists and is visible as `mode: "lan"`, `host: "0.0.0.0"`, and `lan_enabled: true` on restart.
- LAN disablement is reversible and returns to `mode: "localhost"`, `host: "127.0.0.1"`, and `lan_enabled: false`.
- Invalid bind port `0` fails before startup can claim ready.
- Duplicate localhost bind port fails before tmux discovery and before startup can claim ready.
- Security/network route coverage still exposes localhost and LAN state from persisted settings.

## Validation

Environment:

```text
codex-cli 0.143.0
tmux 3.4
Ubuntu 24.04.4 LTS
2026-07-09T04:24:08-04:00
```

Commands:

```text
pnpm install --frozen-lockfile
pnpm --filter @hostdeck/server typecheck
pnpm --filter @hostdeck/contracts typecheck
pnpm test:unit -- packages/server/src/network-smoke.test.ts packages/server/src/startup.test.ts packages/server/src/security-routes.test.ts
pnpm test:contract
pnpm lint
pnpm check:scaffold
pnpm -r --if-present typecheck
pnpm test
pnpm test:tmux
git diff --check
```

Results:

- `pnpm install --frozen-lockfile`: passed; lockfile was current.
- `pnpm --filter @hostdeck/server typecheck`: passed.
- `pnpm --filter @hostdeck/contracts typecheck`: passed.
- `pnpm test:unit -- packages/server/src/network-smoke.test.ts packages/server/src/startup.test.ts packages/server/src/security-routes.test.ts`: passed; root Vitest invocation reported 27 files and 160 tests.
- `pnpm test:contract`: passed; 6 files and 49 tests.
- `pnpm lint`: passed; Biome checked 98 files and package exports passed.
- `pnpm check:scaffold`: passed; 8 packages and 12 root scripts.
- `pnpm -r --if-present typecheck`: passed for all 8 workspace packages with typecheck scripts.
- `pnpm test`: passed; 27 files and 160 tests.
- `pnpm test:tmux`: passed; 1 real tmux smoke test.
- `git diff --check`: passed.

## Remaining Gaps

- This task proves bind configuration and listener availability, not a mounted Fastify HTTP server.
- Foreground and long-running service-mode smoke remains in `IFC-V1-012`.
- Dashboard serving remains in `IFC-V1-009`.
- Clean release install/run/service smoke remains in `REL-V1-006`.
