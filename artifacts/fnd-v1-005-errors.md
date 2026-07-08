# FND-V1-005 Shared Error Envelope Evidence

Date: 2026-07-08

## Scope

- Added stable shared error code families for API/CLI boundary failures.
- Added `ErrorEnvelope` with `code`, `message`, `retryable`, optional `field`, optional `sessionId`, and optional bounded `details`.
- Added runtime construction/parsing helpers that throw or reject invalid envelopes instead of silently truncating.
- Added bounded detail rules for field count, key length, string length, finite numbers, flat values only, and sensitive key rejection.
- Added unit tests for stable code families, retryability, bounded details, sensitive-detail rejection, nested-detail rejection, long-detail rejection, and loud construction failure.

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
Result: passed. Biome checked 37 files and package export check passed for 8 packages.

pnpm test
Result: passed. Alias ran the unit test suite.

pnpm test:unit
Result: passed. Vitest reported 3 test files and 18 tests passing.
```

## Intentional Gaps

- Error-envelope Zod schemas remain in `FND-V1-006`, `FND-V1-012`, and `FND-V1-013`.
- Write-specific denial mapping remains in `FND-V1-004`.
