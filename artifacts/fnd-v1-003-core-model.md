# FND-V1-003 Core Session Model Evidence

Date: 2026-07-08

## Scope

- Added `@hostdeck/core` session identity, name, cwd, timestamp, and output cursor branded types.
- Added lifecycle, status, attention, backend metadata, recent output, and managed-session TypeScript shapes.
- Added validation helpers for ids, names, absolute cwd values, timestamps, and output cursors.
- Added lifecycle transition, writable lifecycle, status-to-attention, attention-priority, and duplicate-name helpers.
- Added unit tests for invalid ids/names, duplicate names, metadata validation, explicit state transitions, non-writable unknown/stale states, and unknown advisory behavior.

## Commands

```text
pnpm install --frozen-lockfile
Result: passed. Lockfile was up to date.

pnpm check:scaffold
Result: passed. HostDeck scaffold OK: 8 packages and 12 root scripts.

pnpm typecheck
Result: passed.

pnpm -r --if-present typecheck
Result: passed. All 8 package typecheck scripts completed.

pnpm lint
Result: passed. Biome checked 35 files and package export check passed for 8 packages.

pnpm test
Result: passed. Alias ran the unit test suite.

pnpm test:unit
Result: passed. Vitest reported 2 test files and 12 tests passing.
```

## Intentional Gaps

- Command intents and full write eligibility remain in `FND-V1-004`.
- Shared API/CLI error envelope remains in `FND-V1-005`.
- API/storage/UI Zod schemas remain in `FND-V1-006`, `FND-V1-012`, and `FND-V1-013`.
