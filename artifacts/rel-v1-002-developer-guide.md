# REL-V1-002 Developer Guide Setup/Service Docs

Task: `REL-V1-002` update developer guide setup after runtime/service facts are validated.

Date: 2026-07-09

## Scope

- Updated `docs/delivery/09-developer-guide.md`.
- Kept the update focused on setup, environment, state/config paths, foreground service behavior, LAN/safety notes, common failures, and known release gaps.
- Did not update `docs/delivery/11-command-reference.md`; `REL-V1-003` owns final copy-paste command reference and the packaged-binary gap.

## Facts Verified

- Runtime pin: `.nvmrc` and `package.json` both specify Node.js `22.22.2`.
- Package manager pin: `package.json` specifies `pnpm 10.29.2`.
- Current local tool versions available in this workspace:
  - `node --version`: `v22.22.2`
  - `pnpm --version`: `10.29.2`
  - `tmux -V`: `tmux 3.4`
  - `codex --version`: `codex-cli 0.143.0`
- `packages/cli/package.json` does not define a `bin`; a packaged runnable `codexdeck` binary remains a release gap.
- CLI config sources in `packages/cli/src/config.ts` match the documented flags, env vars, defaults, and JSON keys.
- `IFC-V1-090` proves the foreground HTTP service route families and loopback/browser write boundaries.

## Guide Changes

- Replaced scaffold-era setup notes with the actual supported local environment and validated install command.
- Added current development command table with implemented commands and loud-failing placeholders.
- Documented default API host/port, state directory, SQLite database path, config flags, env vars, and JSON config keys.
- Updated foreground service behavior to include startup checks, route families, local-admin loopback policy, browser cookie+CSRF policy, dashboard unlock/LAN mutation rejection, and shutdown behavior.
- Documented LAN safety notes and common failure causes.
- Linked existing service, network, tmux, API/CLI hardening, and validation evidence.

## Validation

Commands:

```text
node --version
pnpm --version
tmux -V
codex --version
pnpm install --frozen-lockfile
pnpm exec vitest run tests/service-mode-smoke.test.ts
pnpm check:scaffold
git diff --check
pnpm lint
```

Results:

- Version probes matched the documented local versions.
- `pnpm install --frozen-lockfile`: passed; lockfile was current and workspace was already up to date.
- `pnpm exec vitest run tests/service-mode-smoke.test.ts`: passed; Vitest reported 1 file and 2 tests.
- `pnpm check:scaffold`: passed; 8 packages and 12 root scripts.
- `git diff --check`: passed.
- `pnpm lint`: passed; Biome checked 109 files and package exports passed.

## Remaining Gaps

- Packaged `codexdeck` binary path remains in `REL-V1-003`.
- Clean Ubuntu install/run/service wrapper smoke remains in `REL-V1-006`.
- Web dashboard serving remains blocked by later web/dashboard tasks.
- `pnpm build`, `pnpm test:web`, `pnpm test:e2e`, and `pnpm smoke:local` remain loud placeholders owned by later release/web tasks.
