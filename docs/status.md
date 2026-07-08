# Status

Current handoff only. Keep detail in owner docs or artifacts.

## Snapshot

- Phase: Implementation
- Active task: `FND-V1-013` UI fixture and view-model contract schemas
- End goal: Approved as planning target in `docs/planning/00-end-goal.md`.
- UI direction: Pending later visual-direction/mockup pass after UX contract, state coverage, and detailed design are defined.
- Release state: Foundation implementation started.
- Last validation: `pnpm install --frozen-lockfile`, `pnpm check:scaffold`, `pnpm typecheck`, `pnpm -r --if-present typecheck`, `pnpm lint`, `pnpm test`, `pnpm test:unit`, `pnpm test:contract`, and `git diff --check` passed after `FND-V1-012`.
- Next action: Implement `FND-V1-013` UI fixture and view-model contract schemas.
- Blockers: Visual mockups before UI implementation.
- Last commit:
- Last push:

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
- No HostDeck product workflow behavior is proven yet.

## Open Gates

- Planning sign-off.
- Foundation implementation.
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
| FND-V1-013 | Implementation | ready | `docs/tracking/backlog/foundation.md` | Next ready leaf after storage contract completion. |

## Decisions Needed

| Question | Owner | Blocking? |
| --- | --- | --- |
| UI visual direction selection after state coverage and generated mockups. | `docs/tracking/backlog/web-dashboard.md` | Later, before UI implementation |

## Repo Hygiene

- Use `git status --short` for dirty-state truth.
- Keep routine evidence updates to 0-2 owner docs when possible.
