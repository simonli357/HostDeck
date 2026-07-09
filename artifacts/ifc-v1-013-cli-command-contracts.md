# IFC-V1-013 CLI Command Contracts

Task: `IFC-V1-013` add CLI command contract tests.

Date: 2026-07-09

## Coverage Added

- Added a parser matrix for every V1 CLI command: `help`, `version`, `serve`, `status`, `start`, `list`, `send`, `attach`, `stop`, `pair`, `lock`, `unlock`, `lan enable`, and `lan disable`.
- Added success output coverage for previously uncovered `help` and `version` commands.
- Expanded malformed-argument coverage across every command family with stable usage exit-code assertions and help text.
- Added `serve` invalid-config coverage that proves the foreground service is not started when port config fails.
- Added daemon-unavailable coverage for every daemon-backed command: `status`, `start`, `list`, `send`, `attach`, and `stop`.
- Added typed API failure coverage for every daemon-backed command with preserved HTTP status and field context.

## Scope Notes

- `serve` starts the daemon instead of calling an existing daemon, so daemon-unavailable behavior is not applicable to that command; its startup/config failure path is covered instead.
- `pair`, `lock`, `unlock`, `lan enable`, and `lan disable` are local-admin commands, so daemon-unavailable behavior is not applicable; their success output and typed usage/config failures are covered.
- Write rejection integration coverage remains in `IFC-V1-014`.
- Packaged binary smoke remains in `REL-V1-003`; these tests exercise the shell contract directly.

## Validation

Commands:

```text
pnpm --filter @hostdeck/cli typecheck
pnpm exec vitest run --config vitest.contract.config.ts packages/cli/src/cli.contract.test.ts
git diff --check
pnpm test:contract
pnpm typecheck
pnpm lint
pnpm test:unit
```

Results:

- `pnpm --filter @hostdeck/cli typecheck`: passed.
- Focused CLI contract command: passed; Vitest reported 1 file and 23 tests.
- `git diff --check`: passed.
- `pnpm test:contract`: passed; Vitest reported 6 files and 68 tests.
- `pnpm typecheck`: passed.
- `pnpm lint`: passed; Biome checked 106 files and package exports passed.
- `pnpm test:unit`: passed; Vitest reported 31 passed files and 1 skipped file, with 174 passed tests and 1 skipped test.
