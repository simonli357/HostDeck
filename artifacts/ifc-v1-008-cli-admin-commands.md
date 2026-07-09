# IFC-V1-008 CLI Admin Commands

Task: `IFC-V1-008` CLI pairing, lock, unlock, and LAN enable/disable commands.

Date: 2026-07-09

## Implementation

- Added CLI config support for local admin state:
  - `--state-dir PATH`
  - `--database PATH` / `--database-path PATH`
  - `HOSTDECK_STATE_DIR`
  - `HOSTDECK_DATABASE_PATH`
  - config file keys `state_dir` / `stateDir` and `database_path` / `databasePath`
- Default local state is XDG state home when available, otherwise `~/.local/state/hostdeck`; the default SQLite path is `hostdeck.sqlite` inside that state directory.
- Added storage-backed local admin command handling for:
  - `codexdeck pair [--label LABEL] [--ttl-minutes MINUTES] [--read-only]`
  - `codexdeck lock [--reason TEXT]`
  - `codexdeck unlock`
  - `codexdeck lan enable [--bind-host HOST]`
  - `codexdeck lan disable`
- `pair` creates a one-time pairing code through the shared SQLite migration/repository path, prints the raw pairing code and expiry, stores only the pairing-code hash, and does not create a durable auth-device token.
- `lock`, `unlock`, `lan enable`, and `lan disable` mutate shared settings and append CLI audit events in the same SQLite transaction.
- LAN output prints the resulting bind mode/host/port, a reversal command, and the current restart/rebind limitation.

## Coverage

- CLI config tests cover state/database defaults, env/config-file inputs, flag overrides, and existing invalid-config exit behavior.
- CLI shell contract tests cover pairing output, expiry visibility, read-only pairing, lock/unlock JSON and text output, LAN enable/disable output, and local-admin call shape.
- Local admin storage tests inspect SQLite state directly:
  - Pairing rows store `sha256:` hashes, not raw codes.
  - `pair` leaves `auth_devices` empty before a separate claim.
  - A generated pairing code remains claimable through the existing pairing repository.
  - Pairing audit payloads do not contain the raw code or device-token material.
  - Lock/unlock state persists and has `lock` / `unlock` audit events.
  - LAN enable/disable state persists and has `lan_enable` / `lan_disable` audit events with visible bind state and `restart_required`.
- Existing API route tests still cover dashboard remote unlock rejection, dashboard LAN mutation rejection, pairing claim behavior, trust/security state, and CSRF-backed dashboard lock.

## Validation

Commands:

```text
pnpm --filter @hostdeck/cli typecheck
pnpm test:unit -- packages/cli/src/config.test.ts packages/cli/src/local-admin.test.ts packages/cli/src/cli.contract.test.ts
pnpm test:contract
pnpm lint
pnpm install --frozen-lockfile
pnpm typecheck
pnpm -r --if-present typecheck
pnpm test:unit
pnpm test
pnpm check:scaffold
git diff --check
pnpm test:tmux
HOSTDECK_REQUIRE_TMUX_SMOKE=1 pnpm exec vitest run tests/cli-tmux-smoke.test.ts
```

Results:

- `pnpm --filter @hostdeck/cli typecheck`: passed.
- Focused CLI unit/contract command: passed; Vitest reported 29 files and 172 tests passing with 1 skipped file/test.
- `pnpm test:contract`: passed; 6 files and 60 tests.
- `pnpm lint`: passed; Biome checked 103 files and package exports passed.
- `pnpm install --frozen-lockfile`: passed; lockfile was current after adding the CLI storage workspace dependency.
- `pnpm typecheck`: passed for the root tsconfig.
- `pnpm -r --if-present typecheck`: passed for all 8 workspace packages with typecheck scripts.
- `pnpm test:unit`: passed; 29 files / 172 tests, with 1 skipped file/test.
- `pnpm test`: passed; same unit suite result.
- `pnpm check:scaffold`: passed; 8 packages and 12 root scripts.
- `git diff --check`: passed.
- `pnpm test:tmux`: passed; 1 real server/tmux smoke test.
- `HOSTDECK_REQUIRE_TMUX_SMOKE=1 pnpm exec vitest run tests/cli-tmux-smoke.test.ts`: passed; 1 CLI real-tmux smoke test.

## Remaining Gaps

- This still does not add a packaged runnable `codexdeck` binary.
- The command reference release task remains in `REL-V1-003`; final copy-paste CLI commands should be documented after the runnable service/packaging path is verified or explicit gaps are recorded.
- Full all-command CLI matrix coverage remains in `IFC-V1-013`.
- Foreground/long-running service-mode smoke remains in `IFC-V1-012`.
