# Command Reference

Copy-paste commands only. Put explanation in `docs/delivery/09-developer-guide.md`.

## Setup

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
```

## Run

```bash
pnpm check:scaffold
pnpm check:planning
pnpm check:codex-bindings
```

## Validate

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm test:unit
pnpm test:contract
pnpm test:integration
pnpm test:web
pnpm test:browser:pairing
pnpm test:tmux
pnpm exec vitest run packages/cli/src/remote-control-client.test.ts packages/cli/src/remote-cli.test.ts
pnpm exec vitest run packages/cli/src/start-client.test.ts packages/cli/src/start-cli.test.ts packages/server/src/selected-write-audit-executor.test.ts packages/server/src/session-start-routes.test.ts packages/server/src/managed-thread-service.test.ts packages/storage/src/session-start-audit-catalog-migration.test.ts tests/service-mode-smoke.test.ts
pnpm exec vitest run packages/cli/src/archive-client.test.ts packages/cli/src/archive-cli.test.ts packages/server/src/selected-write-audit-executor.test.ts packages/server/src/selected-write-gate.test.ts packages/server/src/session-archive-routes.test.ts packages/server/src/managed-thread-service.test.ts
pnpm exec vitest run --config vitest.integration.config.ts tests/archive-vertical.integration.test.ts
pnpm exec vitest run packages/cli/src/prompt-client.test.ts packages/cli/src/prompt-cli.test.ts packages/server/src/codex-prompt-control-service.test.ts packages/server/src/prompt-routes.test.ts packages/server/src/selected-write-audit-executor.test.ts packages/server/src/selected-write-gate.test.ts
pnpm exec vitest run --config vitest.integration.config.ts tests/prompt-vertical.integration.test.ts
pnpm exec vitest run packages/cli/src/model-client.test.ts packages/cli/src/model-cli.test.ts packages/server/src/codex-model-control-service.test.ts packages/server/src/model-routes.test.ts
pnpm exec vitest run --config vitest.integration.config.ts tests/model-vertical.integration.test.ts
pnpm exec vitest run packages/cli/src/goal-client.test.ts packages/cli/src/goal-cli.test.ts packages/codex-adapter/src/goal-client.test.ts packages/server/src/codex-goal-control-service.test.ts packages/server/src/goal-routes.test.ts
pnpm exec vitest run --config vitest.integration.config.ts tests/goal-vertical.integration.test.ts
pnpm exec vitest run packages/codex-adapter/src/plan-client.test.ts packages/server/src/codex-plan-control-service.test.ts packages/server/src/plan-routes.test.ts packages/cli/src/plan-client.test.ts packages/cli/src/plan-cli.test.ts
pnpm exec vitest run --config vitest.integration.config.ts tests/plan-vertical.integration.test.ts
pnpm exec vitest run packages/codex-adapter/src/compact-client.test.ts packages/server/src/codex-compact-control-service.test.ts packages/server/src/compact-routes.test.ts packages/cli/src/compact-client.test.ts packages/cli/src/compact-cli.test.ts
pnpm exec vitest run --config vitest.contract.config.ts packages/contracts/src/compact.contract.test.ts packages/server/src/selected-api-route-manifest.contract.test.ts
pnpm exec vitest run --config vitest.integration.config.ts tests/compact-vertical.integration.test.ts
pnpm exec vitest run packages/server/src/codex-approval-control-service.test.ts packages/server/src/approval-routes.test.ts packages/cli/src/approval-client.test.ts packages/cli/src/approval-cli.test.ts
pnpm exec vitest run --config vitest.contract.config.ts packages/contracts/src/approval.contract.test.ts
pnpm exec vitest run --config vitest.integration.config.ts tests/approval-vertical.integration.test.ts
pnpm exec vitest run packages/server/src/codex-interrupt-control-service.test.ts packages/server/src/interrupt-routes.test.ts packages/cli/src/interrupt-client.test.ts packages/cli/src/interrupt-cli.test.ts
pnpm exec vitest run --config vitest.contract.config.ts packages/contracts/src/interrupt.contract.test.ts
pnpm exec vitest run --config vitest.integration.config.ts tests/interrupt-vertical.integration.test.ts
pnpm exec vitest run packages/server/src/selected-write-admission-policy.test.ts packages/server/src/selected-write-gate.test.ts
pnpm exec vitest run --config vitest.integration.config.ts tests/selected-write-admission.integration.test.ts
pnpm exec vitest run packages/server/src/codex-runtime-supervisor.test.ts
pnpm exec vitest run --config vitest.integration.config.ts tests/codex-runtime-supervisor.integration.test.ts
pnpm smoke:remote-control
pnpm smoke:codex-compatibility
pnpm smoke:codex-ipc
pnpm smoke:codex-threads
pnpm exec vitest run tests/service-mode-smoke.test.ts
```

## Physical Android Security Acceptance

```bash
pnpm smoke:pairing-android
pnpm smoke:android-security
```

## Authenticated Exact-Codex Probe

```bash
HOSTDECK_CODEX_BIN=/absolute/path/to/codex-0.144.0 pnpm smoke:codex-semantics
HOSTDECK_CODEX_BIN=/absolute/path/to/codex-0.144.0 pnpm smoke:codex-model
HOSTDECK_CODEX_BIN=/absolute/path/to/codex-0.144.0 pnpm smoke:codex-goal
HOSTDECK_CODEX_BIN=/absolute/path/to/codex-0.144.0 pnpm smoke:codex-plan
HOSTDECK_CODEX_BIN=/absolute/path/to/codex-0.144.0 pnpm smoke:codex-usage
HOSTDECK_CODEX_BIN=/absolute/path/to/codex-0.144.0 pnpm smoke:codex-compact
HOSTDECK_CODEX_BIN=/absolute/path/to/codex-0.144.0 pnpm smoke:codex-skills
HOSTDECK_CODEX_BIN=/absolute/path/to/codex-0.144.0 pnpm smoke:codex-prompt
HOSTDECK_CODEX_BIN=/absolute/path/to/codex-0.144.0 pnpm smoke:codex-approval
HOSTDECK_CODEX_BIN=/absolute/path/to/codex-0.144.0 pnpm smoke:codex-interrupt
HOSTDECK_CODEX_BIN=/absolute/path/to/codex-0.144.0 pnpm smoke:codex-vertical
HOSTDECK_CODEX_BIN=/absolute/path/to/codex-0.144.0 pnpm smoke:codex-supervisor
```

## Regenerate Reviewed Codex Binding

```bash
pnpm generate:codex-bindings
```

## Explicit Gaps

- CLI binary: the source command contract includes `start --name NAME --cwd PATH [--json]`, `send SESSION_ID TEXT... [--json]`, the selected `model` read/select forms, the selected `goal` read/set/pause/resume/complete/clear forms, the selected `plan` read/enter/exit forms, `compact SESSION_ID [--json]`, `compact SESSION_ID --confirm [--json]`, `approvals SESSION_ID [--json]`, `approvals SESSION_ID REQUEST_ID approve|deny --confirm [--json]`, `interrupt SESSION_ID TURN_ID --confirm [--json]`, `remote status`, `remote enable`, `remote disable`, `resume SESSION_ID`, `archive SESSION_ID [--json]`, `usage SESSION_ID [--json]`, and `skills SESSION_ID [--json]`, but `codexdeck` is not installed as a workspace or packaged executable yet; `pnpm exec codexdeck --help` currently fails with command not found. Keep `codexdeck ...` examples out of copy-paste command blocks until build/package or clean install smoke provides a runnable executable path.
- E2E validation: `pnpm test:e2e` intentionally exits nonzero until `REL-V1-007` implements it.
- Build/package: `pnpm build` intentionally exits nonzero until `IFC-V1-021` implements it.
- Local release smoke: `pnpm smoke:local` intentionally exits nonzero until `REL-V1-006` implements it.
