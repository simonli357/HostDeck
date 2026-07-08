# FND-V1-001 Scaffold Evidence

Date: 2026-07-08

## Scope

- Added root `pnpm` workspace files and lockfile.
- Added package shells for `core`, `contracts`, `test-fixtures`, `storage`, `tmux-adapter`, `server`, `cli`, and `web`.
- Added strict TypeScript scaffold config.
- Added root scripts for planned validation commands.
- Added placeholder script failures for later tasks so missing validation cannot report fake readiness.

## Environment

```text
node --version -> v22.22.2
pnpm --version -> 10.29.2
```

## Commands

```text
pnpm install
Result: passed. Installed TypeScript 7.0.2 and generated pnpm-lock.yaml.

pnpm install --frozen-lockfile
Result: passed. Lockfile was up to date.

pnpm check:scaffold
Result: passed. HostDeck scaffold OK: 8 packages and 11 root scripts.

pnpm typecheck
Result: passed. Strict TypeScript no-emit check completed.

pnpm -r --if-present typecheck
Result: passed. All 8 package typecheck scripts completed.

pnpm lint
Result: expected failure. Placeholder exited 1 with blocking task FND-V1-002.
```

## Intentional Gaps

- `pnpm lint` remains blocked by `FND-V1-002`.
- Unit, contract, integration, tmux, web, E2E, build, and local smoke scripts are present but intentionally fail until their owning tasks replace the placeholders.
