# Status

Current handoff only. Detailed scope, tasks, and evidence live in owning docs/artifacts.

## Snapshot

- Phase: M1 selected foundation.
- Active task: `INT-V1-005` managed Codex thread lifecycle and exact laptop TUI resume.
- Other ready tasks: `DAT-V1-019`, `IFC-V1-016`, `DAT-V1-020`, and `IFC-V1-015`.
- Direction: phone-first HostDeck dashboard over a version-gated Codex app-server adapter on a private Unix socket; existing tmux runtime is legacy evidence pending `INT-V1-008`.
- UI gate: prior Option A/B boards are rejected as desktop-led; `FE-V1-002` is reopened and `FE-V1-003` remains blocked until two complete mobile-first replacements exist.
- Release state: no-go. All capability blocks affected by the new runtime/security/mobile outcome are reopened.

## Proven

- Baseline workspace checks pass: scaffold, typecheck, lint, unit, contract, integration, web, and historical tmux smoke.
- Existing core, storage, tmux, headless API/CLI, and UI-fixture packages contain substantial reusable package-level work.
- Local Codex 0.144.0 app-server smoke proved generated TypeScript bindings, initialize, model/thread listing, persisted goal set/get/delete, and normal TUI attachment over loopback and Unix-socket transports without a model call.
- Selected app-server runtime, operation, storage, audit, and phone view-model contracts now replace legacy assumptions for new work; required structured/mobile fixture inventories pass public contract tests.
- Legacy tmux, terminal-output, slash-injection, raw-input, storage, and desktop-led UI contracts remain exported only as explicitly deprecated migration surfaces pending `INT-V1-008`.
- `BLK-V1-01` is complete for normalized contracts, core invariants, deterministic fixtures, planning integrity, and generated-protocol isolation; production consumers remain reopened in their owning blocks.
- Selected mappings, projections, projected events, compatibility results, start recovery, and legacy dispositions now have additive migration and repository ownership with transactional/concurrency/restart/corruption evidence.
- `@hostdeck/codex-adapter` owns an exact 0.144.0 experimental generated binding, deterministic schema-drift check, fail-closed required-capability policy, and a real no-model initialize/Plan catalog smoke.
- The adapter now also owns a bounded Unix-only WebSocket transport, strict wire decoder, correlated request/server-request broker, initialize/degradation state machine, deterministic raw-protocol fake, explicit no-auto-retry reconnect, and a real private-socket no-model smoke.

## Not Proven

- Real Codex turn/event/control/approval/restart behavior through HostDeck.
- Production Fastify/SSE composition, continuous projection/fanout, runtime health, retention invocation, or graceful shutdown.
- HTTPS LAN certificate enrollment, paired LAN reads, CSRF reload, rate limits, device revocation, owner-only state, or one-daemon lease.
- Runnable packaged CLI, built dashboard, user services, clean Ubuntu install, real phone workflow, or release readiness.

## Blockers

- Complete managed thread lifecycle, recovery mapping, and exact TUI resume in `INT-V1-005`.
- Run `IFC-V1-015` when the real phone/LAN test setup is available.
- Prove the remaining real Codex vertical (`INT-V1-005` to `INT-V1-007`).
- Prove phone HTTPS enrollment (`IFC-V1-015`).
- Regenerate/select mobile mockups only after real structured states are stable.

## Validation

- `FND-V1-015`: scaffold, root/package typechecks, lint/exports, unit (193 passed, 1 skipped), contract (92), integration (15), web (14), planning, and diff checks passed.
- Evidence: `artifacts/fnd-v1-015-selected-path-contracts.md`.
- `FND-V1-016`: root/package typechecks, lint/exports, unit (211 passed, 1 skipped), contract (100), integration (15), web (14), planning, and diff checks passed.
- Evidence: `artifacts/fnd-v1-016-selected-foundation-invariants.md`.
- `FND-V1-091`: root/package typechecks, lint/exports, unit (211 passed, 1 skipped), contract (104), integration (15), web (14), planning, generated-import boundary, and diff checks passed.
- Evidence: `artifacts/fnd-v1-091-selected-foundation-hardening.md`.
- `DAT-V1-018`: root/package typechecks, lint/exports, unit (233 passed, 1 skipped), contract (104), integration (15), web (14), scaffold, 71 storage tests, historical migration checksums, and diff checks passed.
- Evidence: `artifacts/dat-v1-018-selected-state-migration.md`.
- `INT-V1-003`: frozen install, binding regeneration, root/all-package typechecks, unit (260 passed, 2 skipped), contract (104), integration (15), web (14), scaffold, package exports, and real installed compatibility smoke passed.
- Evidence: `artifacts/int-v1-003-codex-binding-compatibility.md`.
- `INT-V1-004`: frozen install, scaffold/planning/binding checks, root/all-package typechecks, lint/exports, unit (329 passed, 3 skipped), adapter (96 passed, 2 skipped), contract (104), integration (15), web (14), production audit, real stdio compatibility, and repeated private Unix IPC smokes passed.
- Evidence: `artifacts/int-v1-004-codex-unix-ipc-broker.md`.

## Git

- `FND-V1-015` is pushed as `f0da007`; `FND-V1-016` as `b497f66`; `FND-V1-091` as `59c7252`.
- Completed coherent units through `INT-V1-004` are pushed to `origin/main`.
- Next action: execute `INT-V1-005`, beginning with generated thread method payload normalization and the recoverable start/mapping contract.
