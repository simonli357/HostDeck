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
```

## Regenerate Reviewed Codex Binding

```bash
pnpm generate:codex-bindings
```

## Explicit Gaps

- CLI binary: the source command contract includes `remote status`, `remote enable`, `remote disable`, `resume SESSION_ID`, and `usage SESSION_ID [--json]`, but `codexdeck` is not installed as a workspace or packaged executable yet; `pnpm exec codexdeck --help` currently fails with command not found. Keep `codexdeck ...` examples out of copy-paste command blocks until build/package or clean install smoke provides a runnable executable path.
- E2E validation: `pnpm test:e2e` intentionally exits nonzero until `REL-V1-007` implements it.
- Build/package: `pnpm build` intentionally exits nonzero until `IFC-V1-021` implements it.
- Local release smoke: `pnpm smoke:local` intentionally exits nonzero until `REL-V1-006` implements it.
