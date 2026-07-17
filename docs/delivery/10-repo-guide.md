# Repo Guide

Owns repo structure, module boundaries, and behavior-to-code mapping.

## Structure

| Path | Owns |
| --- | --- |
| `package.json` | Root workspace metadata, pinned package manager, validation script entrypoints |
| `pnpm-workspace.yaml` | Workspace package selection |
| `tsconfig.base.json`, `tsconfig.json` | Shared strict TypeScript scaffold configuration |
| `biome.json` | Shared lint configuration |
| `vitest.config.ts`, `vitest.contract.config.ts`, `vitest.integration.config.ts`, `tests/` | Shared unit, contract, and integration test runners plus convention tests |
| `scripts/` | Scaffold/planning/export/runtime-boundary checks, Codex binding generation, and validation/smoke entrypoints |
| `packages/core/` | Domain/core package shell |
| `packages/contracts/` | Shared contract package shell |
| `packages/test-fixtures/` | Test-fixture package shell |
| `packages/storage/` | Local storage package shell |
| `packages/codex-adapter/` | Generated Codex binding, compatibility, private IPC, normalized thread lifecycle, and TUI resume command |
| `packages/server/` | Selected application services, Fastify primitives/routes, Codex lifecycle integration, and Tailscale ingress boundaries; production composition remains downstream |
| `packages/cli/` | `codexdeck` source command contracts, selected loopback clients, local legacy administration, config loading, and error rendering; packaging remains downstream |
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
| CLI parser/shell and selected clients | `packages/cli/src/` | `packages/cli/src/config.test.ts`, `packages/cli/src/cli.contract.test.ts`, focused client/CLI tests, `pnpm test`, `pnpm test:contract` |
| Selected write admission/audit | `packages/server/src/selected-write-gate.ts`, `packages/server/src/selected-write-audit-executor.ts` | Focused unit tests and `tests/selected-write-admission.integration.test.ts` |
| Contract scalar validators | `packages/contracts/src/scalars.ts` | Covered through API and storage contract tests |
| Storage/config/auth/audit contracts | `packages/contracts/src/storage.ts` | `packages/contracts/src/storage.contract.test.ts`, `pnpm test:contract` |
| UI fixture and view-model contracts | `packages/contracts/src/ui.ts` | `packages/contracts/src/ui.contract.test.ts`, `pnpm test:contract` |
| Deterministic fake Codex/session/host fixtures | `packages/test-fixtures/src/` | `packages/test-fixtures/src/fixtures.test.ts`, `pnpm test:unit` |
| Codex binding/private IPC/thread lifecycle | `packages/codex-adapter/src/` | Adapter unit tests plus `pnpm smoke:codex-compatibility`, `pnpm smoke:codex-ipc`, and `pnpm smoke:codex-threads` |
| Durable managed-thread saga | `packages/server/src/managed-thread-service.ts` | `packages/server/src/managed-thread-service.test.ts` |
| Owner-only local paths and daemon lease | `packages/storage/src/secure-local-paths.ts`, `packages/storage/src/daemon-lease.ts` | Storage unit tests plus `tests/daemon-lease.integration.test.ts` |
| Inert legacy-session status/reset | `packages/storage/src/legacy-session-repository.ts`, `packages/cli/src/local-admin.ts` | Repository, local-admin, and CLI contract tests plus `pnpm check:runtime-boundary` |
| Cross-package contract compatibility | `packages/test-fixtures/src/cross-package.contract.test.ts` | `pnpm test:contract` |
| Remaining later validation layers | `scripts/not-implemented.mjs` placeholders | Web, E2E, build, and local smoke placeholders fail loudly with owning task IDs |

## Boundaries

- Domain/core: `packages/core` must stay free of HTTP, React, tmux, filesystem, SQLite, and process-spawn imports.
- Adapters: `packages/storage` and `packages/codex-adapter` own local-state and Codex external boundaries; generated Codex types remain private to the Codex adapter. No production tmux adapter exists.
- UI: `packages/web` consumes API/contracts later and must not import storage, tmux, or Codex process control.
- Generated artifacts: keep bulky command logs, screenshots, and smoke notes under `artifacts/`.
