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
| `scripts/` | Scaffold, planning graph, generated-binding, package-export, and loud-placeholder checks |
| `packages/core/` | Framework-free domain state, command eligibility, deadlines, classification, and errors |
| `packages/contracts/` | Stable API, runtime, operation, storage, resource-policy, UI, and mobile schemas |
| `packages/test-fixtures/` | Deterministic selected-runtime, dashboard-state, session-state, and historical output fixtures |
| `packages/storage/` | SQLite migrations/repositories, projection append/retention, auth/audit, secure paths, startup maintenance, and daemon lease |
| `packages/codex-adapter/` | Generated Codex binding, compatibility, private IPC, normalized thread lifecycle, and TUI resume command |
| `packages/tmux-adapter/` | Legacy tmux evidence pending selected-runtime disposition |
| `packages/server/` | Structured Codex services plus selected Fastify app/SSE/static/lifecycle and historical route composition |
| `packages/cli/` | Source-level CLI parser, API client, local administration, config, rendering, and exit contracts |
| `packages/web/` | Mobile view-model foundations; product React/Vite UI is not implemented |
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
| CLI shell/API client | `packages/cli/src/` | `packages/cli/src/config.test.ts`, `packages/cli/src/api-client.test.ts`, `packages/cli/src/cli.contract.test.ts`, `pnpm test`, `pnpm test:contract` |
| Write rejection integration | `tests/write-rejection.integration.test.ts`, `packages/server/src/write-routes.ts` | `pnpm test:integration` |
| Contract scalar validators | `packages/contracts/src/scalars.ts` | Covered through API and storage contract tests |
| Storage/config/auth/audit contracts | `packages/contracts/src/storage.ts` | `packages/contracts/src/storage.contract.test.ts`, `pnpm test:contract` |
| UI fixture and view-model contracts | `packages/contracts/src/ui.ts` | `packages/contracts/src/ui.contract.test.ts`, `pnpm test:contract` |
| Deterministic fake Codex/session/host fixtures | `packages/test-fixtures/src/` | `packages/test-fixtures/src/fixtures.test.ts`, `pnpm test:unit` |
| Codex binding/private IPC/thread lifecycle | `packages/codex-adapter/src/` | Adapter unit tests plus `pnpm smoke:codex-compatibility`, `pnpm smoke:codex-ipc`, and `pnpm smoke:codex-threads` |
| Durable managed-thread saga | `packages/server/src/managed-thread-service.ts` | `packages/server/src/managed-thread-service.test.ts` |
| Structured Codex controls and projection | `packages/codex-adapter/src/*-client.ts`, `packages/server/src/codex-*-control-service.ts`, `packages/server/src/codex-event-pipeline.ts` | Focused unit tests plus opt-in exact-Codex smokes and `pnpm test:codex` |
| Selected Fastify boundaries | `packages/server/src/fastify-*.ts`, `packages/server/src/projection-*.ts`, `packages/server/src/selected-api-route-manifest.ts` | Focused unit/listener tests; production assembly remains incomplete |
| Owner-only local paths and daemon lease | `packages/storage/src/secure-local-paths.ts`, `packages/storage/src/daemon-lease.ts`, `packages/server/src/startup.ts` | Storage/startup unit tests plus `tests/daemon-lease.integration.test.ts` |
| Cross-package contract compatibility | `packages/test-fixtures/src/cross-package.contract.test.ts` | `pnpm test:contract` |
| Remaining later validation layers | `scripts/not-implemented.mjs` placeholders | E2E, build, and local smoke placeholders fail loudly with owning task IDs |

## Boundaries

- Domain/core: `packages/core` must stay free of HTTP, React, tmux, filesystem, SQLite, and process-spawn imports.
- Adapters: `packages/storage`, `packages/codex-adapter`, and legacy `packages/tmux-adapter` own external boundaries; generated Codex types remain private to the Codex adapter.
- UI: `packages/web` consumes API/contracts later and must not import storage, tmux, or Codex process control.
- Generated artifacts: keep bulky command logs, screenshots, and smoke notes under `artifacts/`.
