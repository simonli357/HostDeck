# Repo Guide

Owns repo structure, module boundaries, and behavior-to-code mapping.

## Structure

| Path | Owns |
| --- | --- |
| `package.json` | Root workspace metadata, pinned package manager, validation script entrypoints |
| `pnpm-workspace.yaml` | Workspace package selection |
| `tsconfig.base.json`, `tsconfig.json` | Shared strict TypeScript scaffold configuration |
| `biome.json` | Shared lint configuration |
| `vitest.config.ts`, `vitest.contract.config.ts`, `tests/` | Shared unit-test and contract-test runners plus convention tests |
| `scripts/` | Scaffold checks, package export checks, and placeholder validation-script failures |
| `packages/core/` | Domain/core package shell |
| `packages/contracts/` | Shared contract package shell |
| `packages/test-fixtures/` | Test-fixture package shell |
| `packages/storage/` | Local storage package shell |
| `packages/tmux-adapter/` | tmux adapter package shell |
| `packages/server/` | Host daemon/server package shell |
| `packages/cli/` | `codexdeck` CLI package shell |
| `packages/web/` | Dashboard web package shell |
| `docs/` | Planning, tracking, delivery docs |
| `assets/` | UI concepts and product assets |
| `artifacts/` | Task evidence and validation notes |

## Module Map

| Behavior | Code/module | Tests |
| --- | --- | --- |
| Scaffold/package layout | `package.json`, `pnpm-workspace.yaml`, `packages/*` | `pnpm check:scaffold` |
| Root typecheck | `tsconfig.json`, `packages/*/src` | `pnpm typecheck` |
| Lint and package exports | `biome.json`, `scripts/check-package-exports.mjs`, `packages/*/package.json` | `pnpm lint` |
| Workspace conventions | `tests/workspace-conventions.test.ts` | `pnpm test:unit` |
| Core session model | `packages/core/src/session.ts` | `packages/core/src/session.test.ts` |
| Conservative Codex output classifier | `packages/core/src/classifier.ts` | `packages/test-fixtures/src/classifier.test.ts`, `pnpm test:unit` |
| Command intents and write eligibility | `packages/core/src/commands.ts` | `packages/core/src/commands.test.ts` |
| Shared error envelope | `packages/core/src/errors.ts` | `packages/core/src/errors.test.ts` |
| API and stream contracts | `packages/contracts/src/api.ts` | `packages/contracts/src/api.contract.test.ts`, `pnpm test:contract` |
| Contract scalar validators | `packages/contracts/src/scalars.ts` | Covered through API and storage contract tests |
| Storage/config/auth/audit contracts | `packages/contracts/src/storage.ts` | `packages/contracts/src/storage.contract.test.ts`, `pnpm test:contract` |
| UI fixture and view-model contracts | `packages/contracts/src/ui.ts` | `packages/contracts/src/ui.contract.test.ts`, `pnpm test:contract` |
| Deterministic fake Codex/session/host fixtures | `packages/test-fixtures/src/` | `packages/test-fixtures/src/fixtures.test.ts`, `pnpm test:unit` |
| Cross-package contract compatibility | `packages/test-fixtures/src/cross-package.contract.test.ts` | `pnpm test:contract` |
| Later validation layers | `scripts/not-implemented.mjs` placeholders | Placeholder scripts fail loudly with owning task IDs |

## Boundaries

- Domain/core: `packages/core` must stay free of HTTP, React, tmux, filesystem, SQLite, and process-spawn imports.
- Adapters: `packages/storage` and `packages/tmux-adapter` are adapter shells; they consume contracts/core later.
- UI: `packages/web` consumes API/contracts later and must not import storage, tmux, or Codex process control.
- Generated artifacts: keep bulky command logs, screenshots, and smoke notes under `artifacts/`.
