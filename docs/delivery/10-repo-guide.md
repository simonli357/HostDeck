# Repo Guide

Owns repo structure, module boundaries, and behavior-to-code mapping.

## Structure

| Path | Owns |
| --- | --- |
| `package.json` | Root workspace metadata, pinned package manager, validation script entrypoints |
| `pnpm-workspace.yaml` | Workspace package selection |
| `tsconfig.base.json`, `tsconfig.json` | Shared strict TypeScript scaffold configuration |
| `biome.json` | Shared lint configuration |
| `vitest.config.ts`, `tests/` | Shared unit-test runner and convention tests |
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
| Later validation layers | `scripts/not-implemented.mjs` placeholders | Placeholder scripts fail loudly with owning task IDs |

## Boundaries

- Domain/core: `packages/core` must stay free of HTTP, React, tmux, filesystem, SQLite, and process-spawn imports.
- Adapters: `packages/storage` and `packages/tmux-adapter` are adapter shells; they consume contracts/core later.
- UI: `packages/web` consumes API/contracts later and must not import storage, tmux, or Codex process control.
- Generated artifacts: keep bulky command logs, screenshots, and smoke notes under `artifacts/`.
