# Status

Current handoff only. Detailed scope, tasks, and evidence live in owning docs/artifacts.

## Snapshot

- Phase: V1 architecture and delivery rebaseline; product implementation paused.
- Active task: `REL-V1-011` system hardening audit/rebaseline.
- Next task after rebaseline: `FND-V1-015` normalized contract/fixture rebase.
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

- Finish `REL-V1-011` owner-doc/task rebaseline; `FND-V1-014` planning validation now passes.
- Prove Codex compatibility/real vertical (`INT-V1-003` to `INT-V1-007`).
- Prove phone HTTPS enrollment (`IFC-V1-015`).
- Regenerate/select mobile mockups only after real structured states are stable.

## Validation

- Pre-audit baseline: `pnpm check:scaffold`, `pnpm typecheck`, `pnpm lint`, `pnpm test:unit` (184 passed, 1 skipped), `pnpm test:contract` (68), `pnpm test:integration` (15), `pnpm test:web` (14), and `pnpm test:tmux` passed.
- Current rebaseline validation and planning check are pending completion of `REL-V1-011`.

## Git

- Working tree: audit/rebaseline changes in progress; stage only intended files.
- Last push: `origin/main` before `REL-V1-011`.
- Next action: finish consistency/validation, close `REL-V1-011`, then commit and push one coherent audit/planning unit.
