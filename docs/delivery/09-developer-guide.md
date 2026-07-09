# Developer Guide

Owns setup context, environment policy, services, and operational notes.

## Setup

- Runtime: Node.js `22.22.2` pinned in `.nvmrc`.
- Package manager: `pnpm 10.29.2` pinned in `package.json`.
- Install: `corepack enable`, then `pnpm install --frozen-lockfile`.
- Env file: none required for the scaffold.
- Local services: HostDeck can run a foreground local HTTP service through the CLI `serve` shell path; no external hosted service is required.
- Native dependency: `@hostdeck/storage` uses `better-sqlite3`; `pnpm-workspace.yaml` approves its build script through `onlyBuiltDependencies`.

## Development

| Purpose | Command | Notes |
| --- | --- | --- |
| Install | `pnpm install --frozen-lockfile` | Uses the committed `pnpm-lock.yaml`. |
| Scaffold check | `pnpm check:scaffold` | Verifies root files, package directories, and root script names. |
| Typecheck | `pnpm typecheck` | Runs a strict TypeScript no-emit check across package source files. |
| Lint | `pnpm lint` | Runs Biome plus package export convention checks. |
| Unit tests | `pnpm test` or `pnpm test:unit` | Runs Vitest unit tests. |
| Contract tests | `pnpm test:contract` | Runs Vitest contract tests for shared schemas. |
| Integration tests | `pnpm test:integration` | Runs Vitest integration tests for cross-module failure ordering. |
| Tmux smoke | `pnpm test:tmux` | Requires `tmux` and `codex` on `PATH`; runs the required real managed-session smoke. |
| Later tests | `pnpm test:web`, `pnpm test:e2e` | Placeholders; fail loudly until their owning tasks implement them. |
| Build/package | `pnpm build` | Placeholder; fails loudly until release/build tasks implement it. |
| Local smoke | `pnpm smoke:local` | Placeholder; fails loudly until release smoke exists. |

## Operations

- Secrets: CLI pairing creates short-lived one-time pairing codes; durable pairing/device/CSRF secrets are stored as hashes by the storage repositories.
- State: CLI local admin paths default to `${XDG_STATE_HOME}/hostdeck` when `XDG_STATE_HOME` is set, otherwise `~/.local/state/hostdeck`; the default SQLite file is `hostdeck.sqlite` inside that state directory.
- State overrides: CLI config accepts `--state-dir`, `--database` / `--database-path`, `HOSTDECK_STATE_DIR`, `HOSTDECK_DATABASE_PATH`, and JSON config keys `state_dir` / `stateDir` plus `database_path` / `databasePath`.
- Foreground service: `codexdeck serve` starts the host agent, runs startup checks, opens SQLite state, reconciles tmux, and exposes `GET /api/host/status` on the configured localhost port. A packaged binary and OS-level long-running service wrapper remain release tasks.
- Data/reset: remove `node_modules/` and rerun `pnpm install --frozen-lockfile`; if a pre-approval local install skipped the SQLite native build, use a clean reinstall so `better-sqlite3` rebuilds. Remove the local HostDeck state directory only when intentionally resetting HostDeck sessions, settings, pairing codes, and audit records.
- Logs/artifacts: task evidence lives under `artifacts/`.
- Common failures: placeholder scripts exiting nonzero are expected until the referenced owning task replaces them.
