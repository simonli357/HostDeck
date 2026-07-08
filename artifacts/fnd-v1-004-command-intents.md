# FND-V1-004 Command Intents And Write Eligibility Evidence

Date: 2026-07-08

## Scope

- Added V1 command intent and write-action types.
- Added primary slash commands `/model`, `/goal`, `/plan`.
- Added utility slash commands `/usage`, `/compact`, `/skills`.
- Added one-session write eligibility checks.
- Added trust, read-only, host lock, unsupported slash, non-writable lifecycle, raw-input confirmation, and audit-availability denials.
- Added denial-to-error-code mapping for API/CLI consumers.

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
Result: passed. Biome checked 39 files and package export check passed for 8 packages.

pnpm test
Result: passed. Alias ran the unit test suite.

pnpm test:unit
Result: passed. Vitest reported 4 test files and 31 tests passing.
```

## Intentional Gaps

- API/stream Zod schemas remain in `FND-V1-006`.
- Storage/config/auth/audit contracts remain in `FND-V1-012`.
- UI fixture/view-model contracts remain in `FND-V1-013`.
