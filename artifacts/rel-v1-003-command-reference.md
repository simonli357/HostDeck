# REL-V1-003 Command Reference Evidence

Date: 2026-07-09

## Scope

Updated `docs/delivery/11-command-reference.md` so copy-paste command blocks include only commands that are runnable in the current workspace. Explicit gaps remain visible for unavailable CLI binary, web validation, E2E validation, build/package, and local release smoke.

## Verified Runnable Commands

| Command | Result |
| --- | --- |
| `corepack enable` | Passed. |
| `pnpm install --frozen-lockfile` | Passed; lockfile was up to date. |
| `pnpm check:scaffold` | Passed; 8 packages and 12 root scripts verified. |
| `pnpm typecheck` | Passed. |
| `pnpm lint` | Passed; Biome checked 109 files and package exports passed. |
| `pnpm test` | Passed; delegates to unit tests. |
| `pnpm test:unit` | Passed; 31 files passed, 1 skipped. |
| `pnpm test:contract` | Passed; 6 files and 68 tests passed. |
| `pnpm exec vitest run --config vitest.contract.config.ts packages/cli/src/cli.contract.test.ts` | Passed; 1 file and 23 tests passed. |
| `pnpm test:integration` | Passed; 1 file and 15 tests passed. |
| `pnpm test:tmux` | Passed; required real tmux smoke passed. |
| `pnpm exec vitest run tests/service-mode-smoke.test.ts` | Passed; 1 file and 2 tests passed. |

## Explicit Gap Checks

| Check | Current result | Owner |
| --- | --- | --- |
| `pnpm exec codexdeck --help` | Fails with command not found; `@hostdeck/cli` has no package `bin` and direct TypeScript execution cannot load compiled `.js` specifiers before a build step. | `REL-V1-006` / `REL-V1-007` release install/build smoke |
| `pnpm test:web` | Fails loudly through `scripts/not-implemented.mjs`. | `FE-V1-001` |
| `pnpm test:e2e` | Fails loudly through `scripts/not-implemented.mjs`. | `REL-V1-007` |
| `pnpm build` | Fails loudly through `scripts/not-implemented.mjs`. | `REL-V1-007` |
| `pnpm smoke:local` | Fails loudly through `scripts/not-implemented.mjs`. | `REL-V1-006` |

## CLI Help Correction

The old command reference and CLI help showed global connection/state flags after commands, but the parser requires those flags before the command. `packages/cli/src/render.ts` now renders the correct flag order and the contract test asserts the help output.
