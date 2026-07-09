# Status

Current handoff only. Keep detail in owner docs or artifacts.

## Snapshot

- Phase: Implementation
- Active task: `DAT-V1-016` storage restart-persistence tests
- End goal: Approved as planning target in `docs/planning/00-end-goal.md`.
- UI direction: Pending later visual-direction/mockup pass after UX contract, state coverage, and detailed design are defined.
- Release state: Foundation block complete; data/auth/storage repositories are underway.
- Last validation: `command -v git && git --version`, `pnpm install --frozen-lockfile`, `pnpm --filter @hostdeck/storage typecheck`, `pnpm check:scaffold`, `pnpm typecheck`, `pnpm -r --if-present typecheck`, `pnpm lint`, `pnpm test`, `pnpm test:unit -- packages/storage/src/branch-metadata.test.ts packages/storage/src/session-repository.test.ts packages/contracts/src/storage.contract.test.ts`, `pnpm test:contract`, and `git diff --check` passed for `DAT-V1-017`.
- Next action: Start `DAT-V1-016` storage restart-persistence tests.
- Blockers: `INT-V1-001` needs `tmux` in the environment; visual mockups before UI implementation.
- Last commit: `DAT-V1-017` branch metadata commit.
- Last push: `origin/main` after the `DAT-V1-017` commit.

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
- No HostDeck product workflow behavior is proven yet.

## Open Gates

- Remaining data/auth/storage repositories and restart persistence.
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
| DAT-V1-016 | Implementation | ready | `docs/tracking/backlog/local-state-auth-audit.md` | Next ready leaf: storage restart-persistence tests for registry, auth, settings, audit, and durable state. |

## Decisions Needed

| Question | Owner | Blocking? |
| --- | --- | --- |
| UI visual direction selection after state coverage and generated mockups. | `docs/tracking/backlog/web-dashboard.md` | Later, before UI implementation |

## Repo Hygiene

- Use `git status --short` for dirty-state truth.
- Keep routine evidence updates to 0-2 owner docs when possible.
