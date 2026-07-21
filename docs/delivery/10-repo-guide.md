# Repo Guide

Owns repo structure, module boundaries, and behavior-to-code mapping.

## Structure

| Path | Owns |
| --- | --- |
| `package.json` | Root workspace metadata, pinned package manager, validation script entrypoints |
| `pnpm-workspace.yaml` | Workspace package selection |
| `tsconfig.base.json`, `tsconfig.json` | Shared strict TypeScript scaffold configuration |
| `biome.json` | Shared lint configuration |
| `vitest.config.ts`, `vitest.contract.config.ts`, `vitest.integration.config.ts`, `vitest.codex.config.ts`, `tests/` | Shared unit, contract, integration, and frozen selected-runtime test runners plus convention tests |
| `scripts/` | Scaffold/planning/export/runtime-boundary checks, Codex binding generation, deterministic package build/verifier/acceptance, and validation/smoke entrypoints |
| `packages/core/` | Selected identifiers, errors, deadlines, remote ingress, and runtime invariants |
| `packages/contracts/` | Selected API, authentication, operation, storage, and mobile runtime contracts |
| `packages/test-fixtures/` | Selected mobile, remote-ingress, and structured-runtime fixtures |
| `packages/storage/` | Selected local-state repositories plus exact bounded historical migration/session-reset compatibility |
| `packages/codex-adapter/` | Generated Codex binding, compatibility, private IPC, normalized thread lifecycle, and TUI resume command |
| `packages/server/` | Selected application services, accepted Fastify route composition/lifecycle, Codex integration, and Tailscale ingress boundaries; compiled startup remains downstream |
| `packages/cli/` | `codexdeck` source command contracts, selected loopback clients, local legacy administration, config loading, and error rendering; the compiled library package exists, while executable dispatch remains downstream |
| `packages/web/` | Headless pairing bootstrap boundary; production dashboard implementation remains downstream |
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
| Selected identifiers and validation | `packages/core/src/identifiers.ts`, `packages/core/src/selected-runtime.ts` | `packages/core/src/identifiers.test.ts`, selected-runtime contract/unit tests |
| Shared error envelope | `packages/core/src/errors.ts` | `packages/core/src/errors.test.ts` |
| Shared API errors and route parameters | `packages/contracts/src/api-error.ts`, `packages/contracts/src/route-params.ts` | Their contract tests plus `pnpm test:contract` |
| CLI parser/shell and selected clients | `packages/cli/src/` | `packages/cli/src/config.test.ts`, `packages/cli/src/cli.contract.test.ts`, focused client/CLI tests, `pnpm test`, `pnpm test:contract` |
| Selected write admission/audit | `packages/server/src/selected-write-gate.ts`, `packages/server/src/selected-write-audit-executor.ts` | Focused unit tests and `tests/selected-write-admission.integration.test.ts` |
| Contract scalar validators | `packages/contracts/src/scalars.ts` | Covered through selected API and storage contract tests |
| Storage/config/auth/audit contracts | `packages/contracts/src/storage.ts` | `packages/contracts/src/storage.contract.test.ts`, `pnpm test:contract` |
| Selected mobile/runtime fixtures | `packages/test-fixtures/src/mobile-design-contract.ts`, `packages/test-fixtures/src/remote-ingress.ts`, `packages/test-fixtures/src/structured-runtime.ts` | `packages/test-fixtures/src/fixtures.test.ts`, `pnpm test:web` |
| Codex binding/private IPC/thread lifecycle | `packages/codex-adapter/src/` | Adapter unit tests plus `pnpm smoke:codex-compatibility`, `pnpm smoke:codex-ipc`, and `pnpm smoke:codex-threads` |
| Durable managed-thread saga | `packages/server/src/managed-thread-service.ts` | `packages/server/src/managed-thread-service.test.ts` |
| Owner-only local paths and daemon lease | `packages/storage/src/secure-local-paths.ts`, `packages/storage/src/daemon-lease.ts` | Storage unit tests plus `tests/daemon-lease.integration.test.ts` |
| Inert legacy-session status/reset | `packages/storage/src/legacy-session-repository.ts`, `packages/cli/src/legacy-session-admin.ts` | Repository/admin tests plus `pnpm check:runtime-boundary` |
| Legacy production-interface isolation | `scripts/check-selected-runtime-boundary.mjs` | Mutation tests plus `pnpm check:runtime-boundary` |
| Deterministic production package | `scripts/build-production-package.mjs`, `scripts/verify-production-package.mjs` | `pnpm build`, `pnpm test:package`, relocated `dist/hostdeck/verify.mjs` |
| Remaining later validation layers | `scripts/not-implemented.mjs` placeholders | E2E and local release-smoke placeholders fail loudly with owning task IDs |

## Boundaries

- Domain/core: `packages/core` must stay free of HTTP, React, tmux, filesystem, SQLite, and process-spawn imports.
- Adapters: `packages/storage` and `packages/codex-adapter` own local-state and Codex external boundaries; generated Codex types remain private to the Codex adapter. No production tmux adapter exists.
- UI: `packages/web` consumes API/contracts later and must not import storage, tmux, or Codex process control.
- Generated artifacts: keep bulky command logs, screenshots, and smoke notes under `artifacts/`.
