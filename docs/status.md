# Status

Current handoff only. Detailed scope, tasks, and evidence live in owning docs/artifacts.

## Snapshot

- Phase: M1 selected foundation.
- Active task: `FND-V1-091` selected foundation module hardening.
- Other ready tasks: `IFC-V1-015`, `DAT-V1-018`, `INT-V1-003`, `DAT-V1-019`, and `IFC-V1-016`.
- Direction: phone-first HostDeck dashboard over a version-gated Codex app-server adapter on a private Unix socket; existing tmux runtime is legacy evidence pending `INT-V1-008`.
- UI gate: prior Option A/B boards are rejected as desktop-led; `FE-V1-002` is reopened and `FE-V1-003` remains blocked until two complete mobile-first replacements exist.
- Release state: no-go. All capability blocks affected by the new runtime/security/mobile outcome are reopened.

## Proven

- Baseline workspace checks pass: scaffold, typecheck, lint, unit, contract, integration, web, and historical tmux smoke.
- Existing core, storage, tmux, headless API/CLI, and UI-fixture packages contain substantial reusable package-level work.
- Local Codex 0.144.0 app-server smoke proved generated TypeScript bindings, initialize, model/thread listing, persisted goal set/get/delete, and normal TUI attachment over loopback and Unix-socket transports without a model call.
- Selected app-server runtime, operation, storage, audit, and phone view-model contracts now replace legacy assumptions for new work; required structured/mobile fixture inventories pass public contract tests.
- Legacy tmux, terminal-output, slash-injection, raw-input, storage, and desktop-led UI contracts remain exported only as explicitly deprecated migration surfaces pending `INT-V1-008`.

## Not Proven

- Real Codex turn/event/control/approval/restart behavior through HostDeck.
- Production Fastify/SSE composition, continuous projection/fanout, runtime health, retention invocation, or graceful shutdown.
- HTTPS LAN certificate enrollment, paired LAN reads, CSRF reload, rate limits, device revocation, owner-only state, or one-daemon lease.
- Runnable packaged CLI, built dashboard, user services, clean Ubuntu install, real phone workflow, or release readiness.

## Blockers

- Complete `FND-V1-091` cross-package foundation hardening and block-matrix evidence.
- Run `IFC-V1-015` when the real phone/LAN test setup is available.
- Prove Codex compatibility/real vertical (`INT-V1-003` to `INT-V1-007`).
- Prove phone HTTPS enrollment (`IFC-V1-015`).
- Regenerate/select mobile mockups only after real structured states are stable.

## Validation

- `FND-V1-015`: scaffold, root/package typechecks, lint/exports, unit (193 passed, 1 skipped), contract (92), integration (15), web (14), planning, and diff checks passed.
- Evidence: `artifacts/fnd-v1-015-selected-path-contracts.md`.
- `FND-V1-016`: root/package typechecks, lint/exports, unit (211 passed, 1 skipped), contract (100), integration (15), web (14), planning, and diff checks passed.
- Evidence: `artifacts/fnd-v1-016-selected-foundation-invariants.md`.

## Git

- Last pushed baseline before this unit: `9dd5a9b` on `origin/main`.
- `FND-V1-015` is pushed as `f0da007`; the current `FND-V1-016` completion unit is pending commit/push.
- Next action: complete `FND-V1-091`, then advance the first ready dependency-aware selected-runtime task.
