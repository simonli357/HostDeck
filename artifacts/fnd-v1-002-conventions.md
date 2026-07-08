# FND-V1-002 Shared Conventions Evidence

Date: 2026-07-08

## Scope

- Added Biome lint configuration.
- Added Vitest unit-test runner configuration.
- Added package source export conventions for all 8 workspace packages.
- Added package export convention check used by `pnpm lint`.
- Added workspace convention unit tests.
- Replaced `pnpm lint` and `pnpm test:unit` placeholders with real commands.

## Commands

```text
pnpm install --frozen-lockfile
Result: passed. Lockfile was up to date after dependency pins.

pnpm check:scaffold
Result: passed. HostDeck scaffold OK: 8 packages and 12 root scripts.

pnpm typecheck
Result: passed. Root strict TypeScript no-emit check completed.

pnpm -r --if-present typecheck
Result: passed. All 8 package typecheck scripts completed.

pnpm lint
Result: passed. Biome checked 33 files and package export check passed for 8 packages.

pnpm test
Result: passed. Alias ran the unit test suite.

pnpm test:unit
Result: passed. Vitest reported 1 test file and 3 tests passing.
```

## Intentional Gaps

- `pnpm test:contract`, `pnpm test:integration`, `pnpm test:tmux`, `pnpm test:web`, `pnpm test:e2e`, `pnpm build`, and `pnpm smoke:local` remain explicit failing placeholders for later leaf tasks.
