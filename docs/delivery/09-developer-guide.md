# Developer Guide

Owns setup context, environment policy, services, and operational notes.

## Supported Local Environment

| Item | Current truth |
| --- | --- |
| OS target | Ubuntu/Linux local development. V1 release smoke still needs a clean Ubuntu user install/run pass. |
| Node.js | `22.22.2`, pinned in `.nvmrc` and `package.json` engines. |
| Package manager | `pnpm 10.29.2`, pinned in `package.json`. |
| Native build | `@hostdeck/storage` uses `better-sqlite3`; `pnpm-workspace.yaml` allows its build script through `onlyBuiltDependencies`. |
| Required local tools for tmux/service work | `tmux` and the external Codex CLI must be on `PATH`. Current local validation used `tmux 3.4` and `codex-cli 0.143.0`. |
| Hosted services | None. HostDeck is local-first and stores state locally. |

## Setup

```bash
corepack enable
pnpm install --frozen-lockfile
```

The frozen install was validated for the current workspace on 2026-07-09. If a previous install skipped the approved native SQLite build, remove `node_modules/` and rerun the frozen install.

## Development Commands

| Purpose | Command | Notes |
| --- | --- | --- |
| Install | `pnpm install --frozen-lockfile` | Uses the committed `pnpm-lock.yaml`. |
| Scaffold check | `pnpm check:scaffold` | Verifies root files, package directories, and root script names. |
| Typecheck | `pnpm typecheck` | Strict TypeScript no-emit check across workspace source. |
| Lint | `pnpm lint` | Biome plus package export convention checks. |
| Unit tests | `pnpm test` or `pnpm test:unit` | Runs Vitest unit tests. |
| Contract tests | `pnpm test:contract` | Runs shared schema/API/CLI/storage/UI contract tests. |
| Integration tests | `pnpm test:integration` | Runs cross-module failure-ordering tests. |
| Service smoke | `pnpm exec vitest run tests/service-mode-smoke.test.ts` | Proves foreground HTTP service status/restart and CLI start/list/send/stop through the service with fake tmux. |
| Tmux smoke | `pnpm test:tmux` | Requires `tmux` and `codex` on `PATH`; runs required real managed-session smoke. |
| Later web tests | `pnpm test:web` | Placeholder; fails loudly until `FE-V1-001` implements it. |
| Later E2E tests | `pnpm test:e2e` | Placeholder; fails loudly until `REL-V1-007` implements it. |
| Later build/package | `pnpm build` | Placeholder; fails loudly until `REL-V1-007` implements it. |
| Later release smoke | `pnpm smoke:local` | Placeholder; fails loudly until `REL-V1-006` implements it. |

## CLI And Service State

The CLI shell and service entrypoints are implemented in `packages/cli/src/` and `packages/server/src/`, but a packaged runnable `codexdeck` binary is not installed yet. `REL-V1-003` verified this gap and keeps `codexdeck ...` examples out of the copy-paste command reference until build/package or clean install smoke provides a runnable executable path.

Default local configuration:

| Setting | Default / source |
| --- | --- |
| API host | `127.0.0.1` |
| API port | `3777` |
| State directory | `${XDG_STATE_HOME}/hostdeck` when `XDG_STATE_HOME` is set, otherwise `~/.local/state/hostdeck` |
| SQLite database | `hostdeck.sqlite` inside the state directory |
| Config file | Optional JSON file passed with `--config` |

Supported config inputs:

| Fact | Flags | Env | JSON config keys |
| --- | --- | --- | --- |
| API base URL | `--api-url` | `HOSTDECK_API_BASE_URL` | `api_url` or `apiUrl` |
| API host | `--host` | `HOSTDECK_HOST` | `host` |
| API port | `--port` | `HOSTDECK_PORT` | `port` |
| State directory | `--state-dir` | `HOSTDECK_STATE_DIR` | `state_dir` or `stateDir` |
| Database path | `--database` or `--database-path` | `HOSTDECK_DATABASE_PATH` | `database_path` or `databasePath` |

## Foreground Service Behavior

`codexdeck serve` is the intended foreground daemon command once the runnable binary path exists. The service code currently:

- opens the configured local SQLite database and runs migrations;
- validates state directory usability, settings, network bind, tmux discovery, and restart reconciliation before reporting ready;
- binds localhost by default on port `3777`;
- exposes registered HTTP route families for host status, sessions, output replay/stream, writes, pairing, security, and network state;
- keeps local-admin CLI writes limited to loopback non-browser requests;
- requires browser writes to use the paired device cookie plus `X-HostDeck-CSRF`;
- rejects dashboard unlock and LAN mutation paths in V1;
- closes the HTTP listener and storage handle on service shutdown.

Long-running service wrapping is not implemented yet. Use foreground mode during development and keep OS service wrapper instructions out of release docs until `REL-V1-006` validates them.

## LAN And Safety Notes

- Default bind is localhost-only.
- `codexdeck lan enable --bind-host 0.0.0.0` changes stored LAN/bind settings through the local-admin path, but daemon listener changes require restart or future controlled rebind.
- `codexdeck lan disable` restores localhost settings.
- `codexdeck unlock` is CLI-only in V1; dashboard unlock remains rejected.
- Pairing codes, device tokens, and CSRF tokens are stored only as hashes in local SQLite.

## Common Failures

| Symptom | Likely cause | Current behavior |
| --- | --- | --- |
| `daemon_unavailable` from normal CLI commands | Foreground service is not running or the configured URL is wrong. | CLI exits nonzero and tells the user to start `codexdeck serve`. |
| `tmux_unavailable` / missing binary | `tmux` is not on `PATH` or cannot be queried. | Startup fails before ready status. |
| `missing_binary` during session start | External Codex CLI is not on `PATH`. | Session start fails before durable success is recorded. |
| Invalid state directory or database path | Path is missing, unreadable, or migration fails. | Startup or local-admin command fails loudly with typed config/storage errors. |
| Duplicate bind port | Another process already owns the configured port. | Startup fails before reporting ready. |
| Placeholder scripts fail | Web, E2E, build, or release smoke is not implemented yet. | Script exits nonzero with the owning future task ID. |

## Evidence

- Service/API hardening: `artifacts/ifc-v1-090-api-cli-hardening.md`.
- Foreground service smoke: `artifacts/ifc-v1-012-service-mode-smoke.md`.
- Network bind smoke: `artifacts/ifc-v1-011-network-smoke.md`.
- Real tmux smoke: `artifacts/int-v1-016-real-tmux-smoke.md`.
- Release validation wiring: `artifacts/rel-v1-001-validation-wiring.md`.
