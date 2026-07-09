# Status

Current handoff only. Detailed scope, tasks, and evidence live in owning docs/artifacts.

## Snapshot

- Phase: M1 selected foundation.
- Active task: None at handoff.
- Next ready task: `FND-V1-015` normalized contract/fixture rebase; `IFC-V1-015` HTTPS phone spike is also ready.
- Direction: phone-first HostDeck dashboard over a version-gated Codex app-server adapter on a private Unix socket; existing tmux runtime is legacy evidence pending `INT-V1-008`.
- UI gate: prior Option A/B boards are rejected as desktop-led; `FE-V1-002` is reopened and `FE-V1-003` remains blocked until two complete mobile-first replacements exist.
- Release state: no-go. All capability blocks affected by the new runtime/security/mobile outcome are reopened.

## Proven

- Baseline workspace checks pass: scaffold, typecheck, lint, unit, contract, integration, web, and historical tmux smoke.
- Existing core, storage, tmux, headless API/CLI, and UI-fixture packages contain substantial reusable package-level work.
- Local Codex 0.144.0 app-server smoke proved generated TypeScript bindings, initialize, model/thread listing, persisted goal set/get/delete, and normal TUI attachment over loopback and Unix-socket transports without a model call.

## Not Proven

- Real Codex turn/event/control/approval/restart behavior through HostDeck.
- Production Fastify/SSE composition, continuous projection/fanout, runtime health, retention invocation, or graceful shutdown.
- HTTPS LAN certificate enrollment, paired LAN reads, CSRF reload, rate limits, device revocation, owner-only state, or one-daemon lease.
- Runnable packaged CLI, built dashboard, user services, clean Ubuntu install, real phone workflow, or release readiness.

## Blockers

- Implement `FND-V1-015` normalized contracts and fixtures; run `IFC-V1-015` when the real phone/LAN test setup is available.
- Prove Codex compatibility/real vertical (`INT-V1-003` to `INT-V1-007`).
- Prove phone HTTPS enrollment (`IFC-V1-015`).
- Regenerate/select mobile mockups only after real structured states are stable.

## Validation

- Pre-audit baseline: `pnpm check:scaffold`, `pnpm typecheck`, `pnpm lint`, `pnpm test:unit` (184 passed, 1 skipped), `pnpm test:contract` (68), `pnpm test:integration` (15), `pnpm test:web` (14), and `pnpm test:tmux` passed.
- Rebaseline validation passed: planning, scaffold, typecheck, lint, unit, contract, integration, web, historical tmux regression, and diff checks.

## Git

- Last implementation/planning push: `2e06d4b` on `origin/main`.
- Audit closure: recorded in the current handoff commit and pushed to `origin/main`.
- Next action: start `FND-V1-015` from `foundation.md`.
