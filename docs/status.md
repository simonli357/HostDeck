# Status

Current handoff only. Detailed scope, tasks, and evidence live in owning docs/artifacts.

## Snapshot

- Phase: M1 selected foundation.
- Active task: `IFC-V1-023` bounded Fastify SSE transport adapter.
- Other ready tasks: `INT-V1-006` real Codex semantic spike, `DAT-V1-020` production projection append, `DAT-V1-023` audit state machine, `IFC-V1-015` physical-device HTTPS spike, and `IFC-V1-024` static-dashboard boundary.
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
- `FND-V1-017` closed `BUG-001`: every unfinished selected-path row was manually classified and decomposed into a 196-task/622-edge graph; resource policy now precedes implementation, operation/read routes have separate owners, and deliberate aggregate gates are explicit. Evidence: `artifacts/fnd-v1-017-selected-backlog-granularity.md`; commit `481cb44`.
- `IFC-V1-016` selected exact Fastify 5.10.0, Zod 4.4.3, `@fastify/sse` 0.5.0, and `@fastify/static` 9.3.0 dependencies with local validation/error ownership, a mandatory Readable-backed SSE path, and explicit deny-by-policy static routing. Six executable boundary probes and production dependency review pass. Evidence: `artifacts/ifc-v1-016-fastify-stack-spike.md`.
- `IFC-V1-020` defines one 59-field strict resource policy across HTTP, SSE, admission, protocol, lifecycle, and CLI boundaries; stable oversized/overload codes; exact Fastify and complete Codex option mappings; and timer-owning/external-signal monotonic deadline forms. Cross-limit and fake-clock matrices pass. Evidence: `artifacts/ifc-v1-020-resource-budget-deadline.md`.
- `IFC-V1-022` implements an unbound typed Fastify factory over exact frozen policy and explicit API/SSE/static registrations. It owns local Zod request/response validation, generated request ids, content/URL/parameter/body/route ceilings, pre-routing plus route error normalization, same-signal deadline views, and handler-plus-response in-flight accounting. Real timeout and pinned SSE/static compatibility probes pass. Evidence: `artifacts/ifc-v1-022-fastify-app-factory.md`.
- Selected mappings, projections, projected events, compatibility results, start recovery, and legacy dispositions now have additive migration and repository ownership with transactional/concurrency/restart/corruption evidence.
- `@hostdeck/codex-adapter` owns an exact 0.144.0 experimental generated binding, deterministic schema-drift check, fail-closed required-capability policy, and a real no-model initialize/Plan catalog smoke.
- The adapter now also owns a bounded Unix-only WebSocket transport, strict wire decoder, correlated request/server-request broker, initialize/degradation state machine, deterministic raw-protocol fake, explicit no-auto-retry reconnect, and a real private-socket no-model smoke.
- Managed thread startup now reserves before dispatch, recovers pre-id unknown outcomes through bounded loaded-thread reads, persists the returned id before exact-version legacy materialization, and never redispatches ambiguity. Durable mappings drive reconciliation/archive after Codex drops the transient marker.
- The installed 0.144.0 no-model lifecycle passes stored list/read, exact authenticated TUI resume over the private Unix socket, archive, and cleanup. Evidence: `artifacts/int-v1-005-managed-thread-lifecycle.md`; `DEC-022`.
- Local path startup now resolves without mutation, bootstraps only owner state/lease, acquires a real Linux descriptor lock, then creates owner-only config/runtime/database paths. Hostile ownership/type/link/substitution cases, later-failure cleanup, real modes, duplicate owners, and child-process crash recovery pass. Evidence: `artifacts/dat-v1-019-secure-paths-daemon-lease.md`.

## Not Proven

- Real Codex turn/event/control/approval/restart behavior through HostDeck.
- Production Fastify SSE/static route composition, real-listener/Node-limit enforcement, continuous projection/fanout, runtime health, retention invocation, or graceful shutdown; the unbound app factory and app-level limits are proven, not those downstream integrations.
- HTTPS LAN certificate enrollment, paired LAN reads, CSRF reload, rate limits, or device revocation.
- Runnable packaged CLI, built dashboard, user services, clean Ubuntu install, real phone workflow, or release readiness.

## Blockers

- Prove the real Codex operation semantics and remaining turn/control/restart vertical (`INT-V1-006`, `INT-V1-017` to `INT-V1-032`).
- Prove phone HTTPS enrollment (`IFC-V1-015`).
- Regenerate/select mobile mockups only after real structured states are stable.

## Validation

- `FND-V1-015`: scaffold, root/package typechecks, lint/exports, unit (193 passed, 1 skipped), contract (92), integration (15), web (14), planning, and diff checks passed.
- Evidence: `artifacts/fnd-v1-015-selected-path-contracts.md`.
- `FND-V1-016`: root/package typechecks, lint/exports, unit (211 passed, 1 skipped), contract (100), integration (15), web (14), planning, and diff checks passed.
- Evidence: `artifacts/fnd-v1-016-selected-foundation-invariants.md`.
- `FND-V1-091`: root/package typechecks, lint/exports, unit (211 passed, 1 skipped), contract (104), integration (15), web (14), planning, generated-import boundary, and diff checks passed.
- Evidence: `artifacts/fnd-v1-091-selected-foundation-hardening.md`.
- `FND-V1-017`: manual unfinished-row/handoff audit, owner-doc synchronization, scaffold, lint/exports, planning (196 tasks, 84 requirements, 622 edges), and diff checks passed.
- Evidence: `artifacts/fnd-v1-017-selected-backlog-granularity.md`.
- `DAT-V1-018`: root/package typechecks, lint/exports, unit (233 passed, 1 skipped), contract (104), integration (15), web (14), scaffold, 71 storage tests, historical migration checksums, and diff checks passed.
- Evidence: `artifacts/dat-v1-018-selected-state-migration.md`.
- `INT-V1-003`: frozen install, binding regeneration, root/all-package typechecks, unit (260 passed, 2 skipped), contract (104), integration (15), web (14), scaffold, package exports, and real installed compatibility smoke passed.
- Evidence: `artifacts/int-v1-003-codex-binding-compatibility.md`.
- `INT-V1-004`: frozen install, scaffold/planning/binding checks, root/all-package typechecks, lint/exports, unit (329 passed, 3 skipped), adapter (96 passed, 2 skipped), contract (104), integration (15), web (14), production audit, real stdio compatibility, and repeated private Unix IPC smokes passed.
- Evidence: `artifacts/int-v1-004-codex-unix-ipc-broker.md`.
- `INT-V1-005`: frozen offline install, scaffold/planning/binding checks, typecheck, lint/exports, unit (367 passed, 4 skipped), contract (104), integration (15), web (14), focused lifecycle matrix, real compatibility/IPC, and authenticated no-model thread/TUI lifecycle smokes passed.
- Evidence: `artifacts/int-v1-005-managed-thread-lifecycle.md`.
- `DAT-V1-019`: forced frozen offline install/native rebuild, scaffold/planning/binding checks, root/all-package typechecks, lint/exports, unit (386 passed, 4 skipped), contract (105), integration (16), web (14), storage (83), service smoke (2), production license/audit, hostile path/lease matrix, real modes, and child crash recovery passed.
- Evidence: `artifacts/dat-v1-019-secure-paths-daemon-lease.md`.
- `IFC-V1-016`: frozen install, scaffold/planning/binding checks, root/all-package typechecks, lint/exports, focused stack probes (6), deterministic unit (378 passed, 18 explicit external tests skipped), dedicated real tmux (21), contract (105), integration (16), web (14), production audit/license/tree review, and diff checks passed. Aggregate validation also found and closed `BUG-002` by separating opportunistic real-process tests from the unit gate.
- Evidence: `artifacts/ifc-v1-016-fastify-stack-spike.md`.
- `IFC-V1-020`: frozen install, scaffold/planning/binding checks, root/all-package typechecks, lint/exports, focused policy/deadline/Fastify/Codex matrices, unit (391 passed, 18 external tests skipped), contract (110), integration (16), web (14), production audit, manual downstream ownership review, and diff checks passed.
- Evidence: `artifacts/ifc-v1-020-resource-budget-deadline.md`.
- `IFC-V1-022`: focused factory matrix (6), actual Fastify handler-timeout retention, pinned SSE/static compatibility, scaffold/planning/binding checks, root/all-package typechecks, lint/exports, unit (397 passed, 18 external tests skipped), contract (111), integration (16), web (14), production audit, and diff checks pass.
- Evidence: `artifacts/ifc-v1-022-fastify-app-factory.md`.

## Git

- `FND-V1-015` is pushed as `f0da007`; `FND-V1-016` as `b497f66`; `FND-V1-091` as `59c7252`.
- Completed coherent units through `DAT-V1-019` are pushed to `origin/main`; implementation commit `7f873c7`.
- `FND-V1-017` planning decomposition is pushed as `481cb44`; closure/resume state is pushed as `3cfb1f2`.
- `BUG-002` deterministic unit/real-tmux smoke separation is pushed as `bb66095`; `IFC-V1-016` exact stack/probe/docs closure is pushed as `4e87d30`.
- `IFC-V1-020` resource/deadline implementation and docs are pushed as `620f4f0`.
- `IFC-V1-022` app-factory implementation and docs are the current unit pending final aggregate validation, commit, and push.
- Next action: implement `IFC-V1-023` as an explicit `sse` registration using only the selected Readable-backed plugin path and required injected event source.
