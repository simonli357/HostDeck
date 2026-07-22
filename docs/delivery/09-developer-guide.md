# Developer Guide

Owns setup context, environment policy, services, and operational notes.

## Supported Local Environment

| Item | Current truth |
| --- | --- |
| OS target | Ubuntu/Linux local development. V1 release smoke still needs a clean Ubuntu user install/run pass. |
| Node.js | `22.22.2`, pinned in `.nvmrc` and `package.json` engines. |
| Package manager | `pnpm 10.29.2`, pinned in `package.json`. |
| Native build | `@hostdeck/storage` uses `better-sqlite3` and exact `fs-ext` 2.1.1; `pnpm-workspace.yaml` allows both native build scripts through `onlyBuiltDependencies`. A normal Ubuntu C/C++/Python `node-gyp` toolchain may be required when cached binaries are unavailable. |
| Required Codex for selected adapter work | Exact `codex-cli 0.144.0` must be on `PATH`; `HOSTDECK_CODEX_BIN` may name another executable for binding/smoke commands. The reviewed V1 binding uses experimental API for `/plan`. |
| Linux command sandbox | Command-backed exact-Codex smokes require Bubblewrap to create an unprivileged user namespace. Ubuntu 24.04 hosts with `kernel.apparmor_restrict_unprivileged_userns=1` require the packaged `bwrap-userns-restrict` AppArmor profile to be installed and loaded. Do not replace this prerequisite with a sandbox or approval downgrade. |
| Tmux | Optional and test-only. Exact thread/TUI smokes use `tmux 3.4` as an isolated terminal emulator; no HostDeck production package, service, or command depends on it. |
| Browser validation | Playwright 1.61.1 with its Chromium 1228 bundle is required for the fragment/history pairing suite. |
| Hosted services | None. HostDeck is local-first and stores state locally. |

## Setup

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
```

The frozen offline install and native lease rebuild were validated for the current workspace on 2026-07-09. If a previous install skipped an approved native build, remove `node_modules/` and rerun the frozen install.

On Ubuntu 24.04, prepare the command sandbox before running command-backed Codex acceptance:

```bash
sudo apt-get install apparmor-profiles apparmor-utils bubblewrap
sudo install -m 0644 /usr/share/apparmor/extra-profiles/bwrap-userns-restrict /etc/apparmor.d/bwrap-userns-restrict
sudo apparmor_parser -r /etc/apparmor.d/bwrap-userns-restrict
```

This host has Bubblewrap 0.9.0, `apparmor-profiles`, and `apparmor-utils`. The packaged and loaded `/etc/apparmor.d/bwrap-userns-restrict` copy matches the packaged source SHA-256 `11d39094f044f0cda0febb3ad517b830301da6b2ce929664af09ee9e4dd264f9`; strict `INT-V1-027` command-backed acceptance passes while the global user-namespace restriction remains enabled.

## Development Commands

| Purpose | Command | Notes |
| --- | --- | --- |
| Install | `pnpm install --frozen-lockfile` | Uses the committed `pnpm-lock.yaml`. |
| Scaffold check | `pnpm check:scaffold` | Verifies root files, package directories, and root script names. |
| Selected runtime boundary | `pnpm check:runtime-boundary` | Runs mutation tests plus an exact removed-file/root-export/import/dependency/config/script and transitive production-closure audit. Only exact historical migration/audit decoders and bounded legacy-session reset are allowed. |
| Codex binding check | `pnpm check:codex-bindings` | Regenerates 0.144.0 experimental bindings in a temporary directory and rejects drift. |
| Codex binding update | `pnpm generate:codex-bindings` | Replaces committed generated files and identity; use only during an explicit compatibility review. |
| Codex compatibility smoke | `pnpm smoke:codex-compatibility` | Starts installed app-server over stdio, initializes experimental API, and verifies Plan/Default without a model call. |
| Codex Unix IPC smoke | `pnpm smoke:codex-ipc` | Starts installed app-server on a temporary private Unix socket and proves the production transport, broker, and compatibility handshake without a model call. |
| Codex thread/TUI smoke | `pnpm smoke:codex-threads` | Requires authenticated Codex, Git, and tmux. Copies `auth.json` without parsing or logging it into a mode-`0600` private temporary home, proves loaded recovery/materialization/list/read/exact TUI resume/archive without a model turn, then removes the temporary tree. |
| Codex structured vertical smoke | `HOSTDECK_CODEX_BIN=/absolute/path/to/codex-0.144.0 pnpm smoke:codex-vertical` | Requires authenticated turns, Git, tmux, and a working strict Linux command sandbox. It fails on any model, callback, projection, approval, command, interrupt, compact, TUI, disclosure, or cleanup gap. |
| Selected runtime hardening | `HOSTDECK_CODEX_BIN="$(readlink -f /absolute/path/to/codex-0.144.0)" pnpm test:codex` | Requires Linux, a clean Git commit, authenticated exact 0.144.0 Codex, and tmux. Runs the fixed no-retry deterministic/structured/lifecycle aggregate and atomically publishes private commit-bound evidence only after complete cleanup. |
| Typecheck | `pnpm typecheck` | Strict TypeScript no-emit check across workspace source. |
| Lint | `pnpm lint` | Biome plus package export convention checks. |
| Unit tests | `pnpm test` or `pnpm test:unit` | Runs Vitest unit tests. |
| Contract tests | `pnpm test:contract` | Runs selected schema/API/CLI/storage contract tests. |
| Integration tests | `pnpm test:integration` | Runs cross-module failure-ordering tests. |
| Web state tests | `pnpm test:web` | Runs selected mobile fixture and headless pairing-bootstrap checks. |
| Production package build | `pnpm build` | Offline frozen-lock build of `dist/hostdeck` from the exact 609-source server/CLI closure. Emits six compiled packages, production dependencies, one `codexdeck` executable, one non-executable `dist/service-host.js`, schema-3 identity manifest, and dependency-free verifier; real web assets remain separate. |
| Production package acceptance | `pnpm test:package` | Builds twice, proves rollback/deterministic identity, relocates read-only, imports all roots and the inert service host, exercises SQLite/flock/Fastify and five command layouts, mutates command/service-host/verifier identity, and runs config/static/native/runtime/integrity/link failures. |
| Production executable smoke | `HOSTDECK_CODEX_BIN=/absolute/path/to/codex-0.144.0 pnpm smoke:executable-serve` | Runs the direct read-only packaged command twice with test-owned assets, exact no-model Codex, loopback HTTP/static checks, signal shutdown, same-port reuse, and residue inspection. |
| Production service-host smoke | `HOSTDECK_CODEX_BIN=/absolute/path/to/codex-0.144.0 pnpm smoke:service-host` | Runs external exact no-model app-server ownership plus the read-only packaged service host with Tailscale absent; replaces app-server once and HostDeck twice while proving sibling PID/socket survival, readiness recovery, private modes, and cleanup. |
| Production package verify | `node dist/hostdeck/verify.mjs dist/hostdeck` | Checks manifest/runtime/native/content identity, exact command/bin/shebang/mode and service-host identity, runtime manifests, and contained relative links without workspace dependencies. |
| Pairing browser tests | `pnpm test:browser:pairing` | Runs the real Chromium history/referrer/reload/two-tab/failure boundary; requires the Playwright Chromium bundle. |
| Remote Android acceptance | `HOSTDECK_REMOTE_CONTROL_DEDICATED_PROFILE_ID=DEDICATED_ID HOSTDECK_REMOTE_CONTROL_AWAY_PROFILE_ID=AWAY_ID pnpm smoke:remote-android` | Strict no-retry `IFC-V1-079` run from a clean commit. Requires exact Tailscale 1.98.8, two distinct authorized saved profiles, and one unlocked authorized Android device with Tailscale, Chrome, USB debugging, and working cellular data. |
| Later E2E tests | `pnpm test:e2e` | Placeholder; fails loudly until `REL-V1-007` implements it. |
| Later release smoke | `pnpm smoke:local` | Placeholder; fails loudly until `REL-V1-006` implements it. |

## CLI And Service State

The required grammar is complete in `packages/cli/src/`. Host `status` and paginated session `list` use least-authority loopback GET routes; confirmed `revoke` uses the audited local-admin device-revoke route with exact operation/device correlation. Paginated `devices` uses a separate non-creating, guarded, read-only current-schema SQLite path and does not call or weaken the paired-cookie-only HTTP route under `DEC-024`. Human status output omits the private remote origin, and human session-list output omits cwd, thread identity, objective, and summary; JSON preserves selected public contracts. Existing pair, lock, unlock, remote, and session/control commands use selected HTTP routes; only `devices` and bounded `legacy status/reset` enter local SQLite administration. `pnpm build` emits exactly one compiled `codexdeck` bin with direct foreground `serve` dispatch plus one private non-executable service-host module; reserved service actions remain explicit non-success until `IFC-V1-056`.

Local `legacy status [--json]` reports only the `legacy_unmigrated` disposition and a bounded row count. `legacy reset --confirm [--json]` opens the local SQLite database, runs one immediate transaction, removes only inert legacy session state through declared foreign keys, preserves selected sessions/projections/security/global audit state, and performs no process or tmux action.

Default local configuration:

| Setting | Default / source |
| --- | --- |
| API host | `127.0.0.1` |
| API port | `3777` |
| State directory | `${XDG_STATE_HOME}/hostdeck` when `XDG_STATE_HOME` is set, otherwise `~/.local/state/hostdeck` |
| SQLite database | `hostdeck.sqlite` inside the state directory |
| Runtime directory | `$XDG_RUNTIME_DIR/hostdeck`; foreground mode creates and owns its private Codex socket. Service mode requires the external Codex service to create the canonical current-user `0700` directory and `0600` socket first and never repairs or removes either. |
| Config directory | `${XDG_CONFIG_HOME}/hostdeck` when set, otherwise `~/.config/hostdeck` |
| Daemon lease | `hostdeck.lock` inside the state directory; one nonblocking Linux owner per state directory |
| Config file | Optional JSON file passed with `--config` |

Supported config inputs:

| Fact | Flags | Env | JSON config keys |
| --- | --- | --- | --- |
| API base URL | `--api-url` | `HOSTDECK_API_BASE_URL` | `api_url` or `apiUrl` |
| API host | `--host` | `HOSTDECK_HOST` | `host` |
| API port | `--port` | `HOSTDECK_PORT` | `port` |
| State directory | `--state-dir` | `HOSTDECK_STATE_DIR` | `state_dir` or `stateDir` |
| Database path | `--database` or `--database-path` | `HOSTDECK_DATABASE_PATH` | `database_path` or `databasePath` |

## Packaged Executable Boundary

`IFC-V1-054` connects the one compiled command to the accepted 22-registration/35-route application and foreground listener. It derives assets from the package root, resolves exact Codex from `HOSTDECK_CODEX_BIN` or bounded absolute `PATH` entries, publishes one loopback readiness line, waits for terminal truth, and has no old custom-listener, tmux, direct-LAN TLS, cwd, or historical-route fallback.

`IFC-V1-086` adds `dist/service-host.js` for the independent two-process service topology. It requires explicit `HOSTDECK_CODEX_BIN` for compatibility identity, observes only an already-owned private app-server socket, and keeps HostDeck alive across app-server replacement. HostDeck signal or restart closes its listener, storage, and lease only; it does not signal the sibling or unlink its socket.

The ordinary package still lacks the real Vite `web/` tree, generated systemd user units, installation lifecycle, and clean-machine parity. Do not publish foreground or service-wrapper user instructions until `IFC-V1-053` and `IFC-V1-055` to `IFC-V1-058` close those paths.

## Remote And Safety Notes

- The selected production listener boundary is localhost-only; Tailscale Serve will proxy private HTTPS to that loopback listener.
- The selected source CLI rejects `codexdeck lan`; direct-LAN/custom-CA commands are historical and unsupported for remote V1.
- `remote status`, `remote enable`, and `remote disable` are present in the packaged command, but require a successfully running local HostDeck process; no installed user workflow is claimed yet.
- `codexdeck unlock` is CLI-only in V1; dashboard unlock remains rejected.
- Pairing codes, device tokens, and CSRF tokens are stored only as hashes in local SQLite.
- The opt-in `smoke:remote-android` runner requires the dedicated HostDeck profile to be selected with its Serve root absent before startup. The away profile must be a distinct saved profile; the runner compares its Serve JSON byte-for-byte without publishing it, never asks HostDeck to switch profiles, and restores the dedicated selection before exit.
- The physical runner disables and later restores Android Wi-Fi, requires active cellular plus Tailscale VPN transport, and rejects any pre-existing ADB forward or reverse. Its temporary DevTools forward inspects Chrome only; HostDeck requests continue through private Serve HTTPS and never through USB, LAN, a custom CA, Funnel, or a certificate bypass.
- Keep the phone unlocked when starting the runner. It opens the default camera and waits up to five minutes for the in-memory QR to be scanned and opened. A failed row is terminal for that run; clean up fully and start a new evidence run rather than retrying an operation in place.

## Common Failures

| Symptom | Likely cause | Current behavior |
| --- | --- | --- |
| `daemon_unavailable` from source client tests or future packaged commands | No selected server is listening or the configured loopback URL is wrong. | Request fails nonzero; there is no legacy source `serve` fallback. |
| Exact thread/TUI smoke cannot start | Optional test dependency `tmux` is absent or unusable. | Only the opt-in TUI smoke fails; production code and ordinary validation do not require tmux. |
| `missing_binary` during session start | External Codex CLI is not on `PATH`. | Session start fails before durable success is recorded. |
| Thread/TUI smoke stops at authentication | Installed Codex has no private regular `auth.json` or its login is stale. | Smoke fails before claiming exact TUI evidence and removes its temporary state. |
| Command-backed Codex turn fails before approval | Bubblewrap cannot create a user namespace, commonly because the Ubuntu AppArmor profile is absent. | Aggregate acceptance remains failed. Install/load the packaged profile; do not disable sandbox or lower approval policy. |
| Invalid state directory or database path | Path is missing, unreadable, or migration fails. | Startup or bounded legacy-admin command fails loudly with typed config/storage errors. |
| `XDG_RUNTIME_DIR is required` | A runtime-owning source contract is exercised without a secure per-user runtime directory. | Config/path validation fails before runtime side effects. |
| Another owner holds the state directory lease | A HostDeck process/test already holds `hostdeck.lock`. | Packaged foreground startup fails before protected mutation; later user-service ownership must obey the same lease. |
| Duplicate loopback bind port | Another process already owns the configured port. | Fastify lifecycle startup fails before reporting ready; no alternate host, HTTPS, or LAN bind fallback exists. |
| Placeholder scripts fail | E2E or release smoke is not implemented yet. | Script exits nonzero with the owning future task ID. |

## Evidence

- Packaged command, foreground dispatch, invocation matrix, and verifier identity: `artifacts/ifc-v1-054-executable-production-audit.md`.
- Service/API hardening: `artifacts/ifc-v1-090-api-cli-hardening.md`.
- Historical foreground service smoke, superseded and no longer runnable: `artifacts/ifc-v1-012-service-mode-smoke.md`.
- Historical network bind smoke, superseded by the selected Fastify/Tailscale boundary: `artifacts/ifc-v1-011-network-smoke.md`.
- Owner-only paths and daemon lease: `artifacts/dat-v1-019-secure-paths-daemon-lease.md`.
- Historical tmux runtime smoke: `artifacts/int-v1-016-real-tmux-smoke.md`.
- Legacy runtime removal and retained-data administration: `artifacts/int-v1-008-legacy-tmux-disposition.md`.
- Release validation wiring: `artifacts/rel-v1-001-validation-wiring.md`.
