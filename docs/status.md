# Status

Current handoff only. Keep detail in owner docs or artifacts.

## Snapshot

- Phase: Implementation
- Active task: `IFC-V1-011` Localhost/LAN config and network smoke coverage
- End goal: Approved as planning target in `docs/planning/00-end-goal.md`.
- UI direction: Pending later visual-direction/mockup pass after UX contract, state coverage, and detailed design are defined.
- Release state: Foundation, storage-owned local state/auth/audit, tmux fake adapter foundation, tmux output-capture spike, real tmux target discovery/reconciliation, real managed tmux start/send/stop/attach/output/restart/smoke path/hardening, pairing/security API route foundation, validation command wiring, headless `codexdeck serve` startup/readiness, headless host/session/output read route contracts, headless one-session stream route contracts, headless write pipeline route contracts, aggregate API route/stream contract tests, and CLI shell/API client foundation are complete; localhost/LAN network smoke is next.
- Last validation: `command -v codex && codex --version && command -v tmux && tmux -V && lsb_release -ds && date -Iseconds`, `pnpm install --frozen-lockfile`, `pnpm --filter @hostdeck/cli typecheck`, `pnpm --filter @hostdeck/contracts typecheck`, `pnpm test:contract`, `pnpm lint`, `pnpm check:scaffold`, `pnpm -r --if-present typecheck`, `pnpm test`, `pnpm test:tmux`, and `git diff --check` passed for `IFC-V1-006`.
- Next action: Start `IFC-V1-011` localhost/LAN config and network smoke coverage.
- Blockers: Clean release tmux setup still needs later install/run/service smoke docs; visual mockups before UI implementation.
- Last commit: `IFC-V1-006` CLI shell/API client commit.
- Last push: `origin/main` after the `IFC-V1-006` commit.

## What Is Proven

- Planning: every active V1 requirement has a trace row to blocks, leaf tasks, and evidence route.
- Planning: referenced V1 task IDs resolve to defined leaf tasks.
- Planning: the V1 backlog dependency graph has no detected task cycles.
- Implementation: `FND-V1-001` workspace scaffold is in place with 8 package shells, pinned Node/pnpm/TypeScript versions, a passing scaffold check, and failing placeholders for later validation layers.
- Implementation: `FND-V1-002` shared conventions are in place with Biome linting, package export checks, Vitest unit runner, and source export conventions.
- Implementation: `FND-V1-003` core session model is in place with stable ids/names, lifecycle/status/attention states, metadata validation, and unknown/stale write-safety helpers.
- Implementation: `FND-V1-005` shared error envelope is in place with stable code families, retryability, bounded details, and sensitive-detail rejection.
- Implementation: `FND-V1-004` command intents and write eligibility are in place with V1 slash allowlists, one-session targeting, trust/read-only/lock checks, raw-input confirmation, audit availability, and non-writable lifecycle denials.
- Implementation: `FND-V1-006` API and stream contract schemas are in place with runtime validation for host status, sessions, output, stream events, writes, pairing, security, lock, and network state.
- Implementation: `FND-V1-012` storage/config/auth/audit/retention contract schemas are in place with runtime validation for migration, session, metadata, output cursor, retention boundary, hashed auth, pairing, settings, and bounded audit records.
- Implementation: `FND-V1-013` UI fixture and view-model contract schemas are in place for session cards, session detail, host safety, trust state, output boundaries, and disabled write controls.
- Implementation: `FND-V1-007` deterministic fake Codex/session/host fixtures cover all required `SFR-011` categories and parse fake API/UI/host states through shared contracts.
- Implementation: `FND-V1-008` conservative status/attention classifier is in place and keeps unrecognized output as `unknown`.
- Implementation: `FND-V1-009` cross-package contract compatibility tests cover fixture/API/UI compatibility, API error shape, and audit payload bounds.
- Implementation: `FND-V1-010` foundation production-hardening tightened output/session, cursor, LAN, UI trust/sort/write-control, classifier, storage settings, and audit invariants.
- Implementation: `FND-V1-011` marks `BLK-V1-01` complete and promotes downstream data spikes plus fake-adapter work.
- Planning/spike: `DAT-V1-001` chose `better-sqlite3` plus a first-party migration runner for V1 local storage.
- Planning/spike: `DAT-V1-002` chose host-only `HttpOnly` cookie device-token transport plus CSRF write headers for dashboard writes.
- Planning/spike: `DAT-V1-003` chose output/audit retention defaults and replay/audit boundary semantics.
- Implementation: `DAT-V1-010` added the SQLite migration runner, base schema, `better-sqlite3` dependency, and native build approval.
- Implementation: `DAT-V1-011` added the SQLite-backed settings/config repository with safe localhost defaults, bind-host validation, lock/LAN persistence, and invalid-startup rejection.
- Implementation: `DAT-V1-012` added SQLite-backed session registry and metadata repositories, duplicate-name/id handling, invalid cwd/stale/reload rejection, and a migration for the valid `failed` metadata status.
- Implementation: `DAT-V1-013` added hash-only pairing/auth repositories with CSRF hash storage, one-time pairing claim, read-only/write distinction, revocation/expiry checks, and direct SQLite raw-secret absence assertions.
- Implementation: `DAT-V1-014` added durable audit event append/read/list with bounded payload summaries, required V1 action coverage, duplicate/missing errors, and invalid persisted JSON rejection.
- Implementation: `DAT-V1-015` added retention cleanup and replay-boundary storage metadata with output event/byte caps, audit event/age caps, monotonic cursor checks, and corrupt boundary rejection.
- Implementation: `DAT-V1-017` added optional git branch metadata capture with real worktree persistence, non-git null behavior, missing-git tolerance, malformed output rejection, and invalid-cwd failure.
- Implementation: `DAT-V1-016` added cross-repository restart persistence coverage for settings, sessions, metadata, auth/pairing, audit, output retention, migration no-op reopen, and durable/ephemeral storage separation.
- Implementation: `DAT-V1-090` hardened storage-owned behavior for migration drift, raw secret validation, audit unavailable errors, retention boundary schema, newest-output retention, restart persistence, and local state privacy inspection.
- Implementation: `INT-V1-010` added the typed tmux adapter interface and deterministic fake adapter with lifecycle, send, stop, attach, output, stale, and missing-target coverage.
- Implementation: `INT-V1-011` added HostDeck-only deterministic real tmux target naming, live target lookup/listing, and live/stale/unmanaged reconciliation without importing arbitrary terminals.
- Implementation: `INT-V1-012` added real tmux managed start/list/get behavior with cwd and command preflight, duplicate id/name checks, launch verification, and partial-target cleanup.
- Implementation: `INT-V1-013` added real tmux pane-targeted send, explicit stop, socket-aware attach metadata, and missing/stale target failures.
- Implementation: `INT-V1-014` added live pipe capture, bounded capture reads, storage output append, replay-boundary response mapping, and observable output-reader failures.
- Implementation: `INT-V1-015` added storage-backed restart reconciliation for live, missing, stopped, and unmanaged HostDeck tmux targets.
- Implementation: `INT-V1-016` added required real Ubuntu tmux smoke coverage for managed start, attach metadata, send targeting, stop, output read, SQLite output drain, restart reconciliation, output-reader restart hook, and stale target behavior.
- Hardening: `INT-V1-090` tightened tmux/output suffix continuity, repeated lifecycle cleanup, invalid replay, append/capture failure visibility, and restart output-reader failure reporting.
- Implementation: `IFC-V1-005` added storage-backed pairing/security/network route handlers, revoked pairing-code support, CSRF-backed dashboard lock, and explicit remote unlock/LAN mutation rejection.
- Implementation: `IFC-V1-001` added headless host startup/readiness with state directory access, SQLite migrations, settings/bind validation, tmux discovery, registry reconciliation, output-reader startup gating for live sessions, non-ready typed failure statuses, and startup negative tests.
- Implementation: `IFC-V1-002` added headless host status/session read/output route handlers with schema-validated responses, attention-sorted sessions, bounded recent-output summaries, explicit read authorization injection, and typed permission/not-found/invalid-cursor/stale failures.
- Implementation: `IFC-V1-003` added headless one-session stream route handlers with explicit read authorization, retained replay after cursor, stale-cursor/retention boundaries, live-source session validation, and typed stream failure events.
- Implementation: `IFC-V1-004` added headless prompt, slash, stop, and raw-input write route handlers with auth/CSRF, lock, lifecycle, one-session, slash allowlist, raw confirmation, audit preflight, tmux dispatch, stopped-state persistence, and typed rejection coverage.
- Implementation: `IFC-V1-010` added aggregate API route contract coverage for 16 current V1 host/session/stream/write/pairing/security/network routes with method, auth, request, response, stream-event, route error body, and typed error assertions.
- Implementation: `IFC-V1-006` added the CLI core shell, API client, config loading, stable exit-code families, status rendering, and daemon/API error rendering with unit and contract coverage.
- Release support: `REL-V1-001` wired validation command placeholders to future owner tasks and recorded command smoke evidence without claiming unavailable layers are implemented.
- Planning/spike: `INT-V1-001` chose tmux `pipe-pane` for live output ingestion plus bounded `capture-pane` startup/restart recovery.
- No end-to-end HostDeck product workflow through API, CLI, or UI is proven yet.

## Open Gates

- Module hardening.
- UI fidelity evidence.
- Release/handoff validation.

## Active Work

| ID | Type | Status | Owner doc | Evidence |
| --- | --- | --- | --- | --- |
| FND-V1-001 | Implementation | done | `docs/tracking/backlog/foundation.md` | Workspace scaffold, package shells, root validation scripts, pinned lockfile, command/setup docs, and `artifacts/fnd-v1-001-scaffold.md`. |
| FND-V1-002 | Implementation | done | `docs/tracking/backlog/foundation.md` | Shared strict TypeScript/lint/test conventions, package exports, command docs, and `artifacts/fnd-v1-002-conventions.md`. |
| FND-V1-003 | Implementation | done | `docs/tracking/backlog/foundation.md` | Core session model and `artifacts/fnd-v1-003-core-model.md`. |
| FND-V1-005 | Implementation | done | `docs/tracking/backlog/foundation.md` | Shared error envelope and `artifacts/fnd-v1-005-errors.md`. |
| FND-V1-004 | Implementation | done | `docs/tracking/backlog/foundation.md` | Command intents, write eligibility, and `artifacts/fnd-v1-004-command-intents.md`. |
| FND-V1-006 | Implementation | done | `docs/tracking/backlog/foundation.md` | API and stream contracts and `artifacts/fnd-v1-006-api-contracts.md`. |
| FND-V1-012 | Implementation | done | `docs/tracking/backlog/foundation.md` | Storage/config/auth/audit/retention contracts and `artifacts/fnd-v1-012-storage-contracts.md`. |
| FND-V1-013 | Implementation | done | `docs/tracking/backlog/foundation.md` | UI fixture/view-model contracts and `artifacts/fnd-v1-013-ui-contracts.md`. |
| FND-V1-007 | Implementation | done | `docs/tracking/backlog/foundation.md` | Codex/session/host fixtures and `artifacts/fnd-v1-007-fixtures.md`. |
| FND-V1-008 | Implementation | done | `docs/tracking/backlog/foundation.md` | Conservative classifier and `artifacts/fnd-v1-008-classifier.md`. |
| FND-V1-009 | Implementation | done | `docs/tracking/backlog/foundation.md` | Cross-package compatibility tests and `artifacts/fnd-v1-009-cross-package-contracts.md`. |
| FND-V1-010 | Hardening | done | `docs/tracking/backlog/foundation.md` | Foundation hardening and `artifacts/fnd-v1-010-foundation-hardening.md`. |
| FND-V1-011 | Documentation | done | `docs/tracking/backlog/foundation.md` | Foundation completion rollup and `artifacts/fnd-v1-011-foundation-completion.md`. |
| DAT-V1-001 | Spike | done | `docs/tracking/backlog/local-state-auth-audit.md` | SQLite driver/migration decision and `artifacts/dat-v1-001-sqlite-driver-spike.md`. |
| DAT-V1-002 | Spike | done | `docs/tracking/backlog/local-state-auth-audit.md` | Token transport decision/API contract and `artifacts/dat-v1-002-token-transport-spike.md`. |
| DAT-V1-003 | Spike | done | `docs/tracking/backlog/local-state-auth-audit.md` | Retention defaults/boundary decision and `artifacts/dat-v1-003-retention-caps-spike.md`. |
| DAT-V1-010 | Implementation | done | `docs/tracking/backlog/local-state-auth-audit.md` | SQLite migration runner/base schema and `artifacts/dat-v1-010-sqlite-migration-runner.md`. |
| DAT-V1-011 | Implementation | done | `docs/tracking/backlog/local-state-auth-audit.md` | Settings/config repository and `artifacts/dat-v1-011-settings-repository.md`. |
| DAT-V1-012 | Implementation | done | `docs/tracking/backlog/local-state-auth-audit.md` | Session registry/metadata repositories and `artifacts/dat-v1-012-session-repositories.md`. |
| DAT-V1-013 | Implementation | done | `docs/tracking/backlog/local-state-auth-audit.md` | Auth/pairing repositories and `artifacts/dat-v1-013-auth-repositories.md`. |
| DAT-V1-014 | Implementation | done | `docs/tracking/backlog/local-state-auth-audit.md` | Audit repository and `artifacts/dat-v1-014-audit-repository.md`. |
| DAT-V1-015 | Implementation | done | `docs/tracking/backlog/local-state-auth-audit.md` | Retention repository and `artifacts/dat-v1-015-retention-repository.md`. |
| DAT-V1-017 | Implementation | done | `docs/tracking/backlog/local-state-auth-audit.md` | Optional git branch metadata and `artifacts/dat-v1-017-branch-metadata.md`. |
| DAT-V1-016 | Implementation | done | `docs/tracking/backlog/local-state-auth-audit.md` | Restart persistence and `artifacts/dat-v1-016-restart-persistence.md`. |
| DAT-V1-090 | Hardening | done | `docs/tracking/backlog/local-state-auth-audit.md` | Storage hardening and `artifacts/dat-v1-090-storage-hardening.md`. |
| INT-V1-010 | Implementation | done | `docs/tracking/backlog/tmux-output.md` | Fake tmux adapter and `artifacts/int-v1-010-fake-tmux-adapter.md`. |
| IFC-V1-005 | Implementation | done | `docs/tracking/backlog/api-cli-control-plane.md` | Security routes and `artifacts/ifc-v1-005-security-routes.md`. |
| REL-V1-001 | Release support | done | `docs/tracking/backlog/hardening-release.md` | Validation wiring and `artifacts/rel-v1-001-validation-wiring.md`. |
| INT-V1-001 | Spike | done | `docs/tracking/backlog/tmux-output.md` | Tmux output capture spike and `artifacts/int-v1-001-tmux-capture-spike.md`. |
| INT-V1-011 | Implementation | done | `docs/tracking/backlog/tmux-output.md` | Real tmux target primitives and `artifacts/int-v1-011-real-tmux-targets.md`. |
| INT-V1-012 | Implementation | done | `docs/tracking/backlog/tmux-output.md` | Real tmux managed start and `artifacts/int-v1-012-real-tmux-start.md`. |
| INT-V1-013 | Implementation | done | `docs/tracking/backlog/tmux-output.md` | Real tmux send/stop/attach and `artifacts/int-v1-013-real-tmux-operations.md`. |
| INT-V1-014 | Implementation | done | `docs/tracking/backlog/tmux-output.md` | Output reader/replay handoff and `artifacts/int-v1-014-output-reader.md`. |
| INT-V1-015 | Implementation | done | `docs/tracking/backlog/tmux-output.md` | Restart reconciliation and `artifacts/int-v1-015-restart-reconciliation.md`. |
| INT-V1-016 | Implementation | done | `docs/tracking/backlog/tmux-output.md` | Real Ubuntu tmux smoke and `artifacts/int-v1-016-real-tmux-smoke.md`. |
| INT-V1-090 | Hardening | done | `docs/tracking/backlog/tmux-output.md` | Tmux/output hardening and `artifacts/int-v1-090-tmux-output-hardening.md`. |
| IFC-V1-001 | Implementation | done | `docs/tracking/backlog/api-cli-control-plane.md` | Startup readiness service and `artifacts/ifc-v1-001-startup-readiness.md`. |
| IFC-V1-002 | Implementation | done | `docs/tracking/backlog/api-cli-control-plane.md` | Read route handlers and `artifacts/ifc-v1-002-read-routes.md`. |
| IFC-V1-003 | Implementation | done | `docs/tracking/backlog/api-cli-control-plane.md` | Stream route handlers and `artifacts/ifc-v1-003-stream-routes.md`. |
| IFC-V1-004 | Implementation | done | `docs/tracking/backlog/api-cli-control-plane.md` | Write route handlers and `artifacts/ifc-v1-004-write-routes.md`. |
| IFC-V1-010 | Implementation | done | `docs/tracking/backlog/api-cli-control-plane.md` | Aggregate API route contracts and `artifacts/ifc-v1-010-api-route-contracts.md`. |
| IFC-V1-006 | Implementation | done | `docs/tracking/backlog/api-cli-control-plane.md` | CLI shell/API client and `artifacts/ifc-v1-006-cli-shell.md`. |
| IFC-V1-011 | Implementation | ready | `docs/tracking/backlog/api-cli-control-plane.md` | Next ready localhost/LAN config and network smoke leaf. |
| IFC-V1-007 | Implementation | ready | `docs/tracking/backlog/api-cli-control-plane.md` | Unblocked CLI session command leaf after CLI shell/API client foundation. |
| IFC-V1-008 | Implementation | ready | `docs/tracking/backlog/api-cli-control-plane.md` | Unblocked CLI pairing, lock/unlock, and LAN command leaf after security routes and CLI shell/API client foundation. |

## Decisions Needed

| Question | Owner | Blocking? |
| --- | --- | --- |
| UI visual direction selection after state coverage and generated mockups. | `docs/tracking/backlog/web-dashboard.md` | Later, before UI implementation |

## Repo Hygiene

- Use `git status --short` for dirty-state truth.
- Keep routine evidence updates to 0-2 owner docs when possible.
