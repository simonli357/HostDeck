# Tasks

Task dashboard and current execution queue. Detailed task cards live in `docs/tracking/backlog/`.

## Rules

- Use concrete leaf tasks, not broad rollups, for implementation work.
- Pick from Current Next Queue first unless the user changes priority.
- Read only the relevant backlog group file before starting a task.
- Respect `Blocked by` and `Blocks`; do not mark a task `ready` until its dependencies are done.
- Update the task card that owns the changed fact; update `docs/status.md` only when handoff truth changes.
- Store bulky command output, simulator/device screenshots, videos, and JSON evidence in `artifacts/`.

## Backlog Structure

| Layer | Meaning | Owner |
| --- | --- | --- |
| Capability block | Required V1 capability, workflow, screen group, native capability, infrastructure area, or release path | `docs/planning/05-blocks/` |
| Program area | Stable workstream selected from the program area profiles | `docs/tracking/backlog/00-index.md` |
| Epic | Small outcome group inside a program area | Backlog group file |
| Leaf task | Concrete action with refs, requirements, dependencies, success criteria, and validation/evidence | Backlog group file |

## Pre-Implementation Backlog Checks

Before replacing the placeholder queue:

- Every active-version requirement maps to a leaf task, spike, or explicit deferral.
- Every required V1 block maps to backlog epics, leaf tasks, and completion evidence.
- Current Next Queue uses leaf tasks only; no broad rollups like "finish UI", "add auth", or "ship release".
- Each ready task has block refs, requirement refs, dependencies, success criteria, and validation/evidence.
- Module-hardening, applicable UI-fidelity, and release-readiness gates exist.
- Ambiguity is represented as a spike or blocked human decision, not hidden inside a task description.

## Current Next Queue

Create this queue after planning. Keep only unblocked or intentionally blocked next work here.

| Order | Task | Status | Blocked by | Why next |
| --- | --- | --- | --- | --- |
| 1 | `FND-V1-001` Scaffold workspace and validation command skeleton | done | none | First implementation leaf completed; all later packages and validation commands now have a workspace base. |
| 2 | `FND-V1-002` Shared TypeScript/lint/test conventions | done | none | Establishes repo-wide engineering guardrails before core contracts. |
| 3 | `FND-V1-003` Core session model | done | none | Contracts, storage, tmux, API, and UI need stable session states first. |
| 4 | `FND-V1-005` Shared API/CLI error envelope | done | none | Route, CLI, storage, and UI failures need one bounded error contract. |
| 5 | `FND-V1-004` Command intents and write eligibility | done | none | Write safety and slash controls depend on this headless rule set. |
| 6 | `FND-V1-006` API and stream contract schemas | done | none | API and stream routes now have runtime contract schemas and contract tests. |
| 7 | `FND-V1-012` Storage/config/auth/audit/retention contract schemas | done | none | Storage and safety contracts now have runtime schemas and contract tests. |
| 8 | `FND-V1-013` UI fixture and view-model contract schemas | done | none | UI state contracts now have runtime schemas and contract tests. |
| 9 | `FND-V1-007` Deterministic fake Codex/session/host fixtures | done | none | Fixture inventory now covers required Codex-like output categories and fake session/host/UI states. |
| 10 | `FND-V1-008` Conservative status/attention classifier tests | done | none | Classifier covers every required fixture category and keeps unknown output unknown. |
| 11 | `FND-V1-009` Cross-package contract compatibility tests | done | none | API, storage, audit, and UI fixture contract compatibility is now tested. |
| 12 | `FND-V1-010` Foundation production-hardening pass | done | none | Hardening tightened cross-field contracts and classifier boundaries before downstream modules consume foundation packages. |
| 13 | `FND-V1-011` Foundation completion evidence update | done | none | `BLK-V1-01` completion evidence is recorded and downstream ready tasks are surfaced. |
| 14 | `DAT-V1-001` SQLite driver and migration spike | done | none | `better-sqlite3` and a first-party migration runner were selected in `DEC-014`. |
| 15 | `DAT-V1-002` Dashboard token transport spike | done | none | `DEC-015` chose host-only `HttpOnly` cookie token transport plus CSRF write headers. |
| 16 | `DAT-V1-003` Output and audit retention caps spike | ready | none | Storage, output replay, and UI boundary work need explicit retention caps. |
| 17 | `DAT-V1-010` SQLite migration runner and base schema | ready | none | Base storage schema can start after the driver/migration decision. |
| 18 | `INT-V1-010` Tmux adapter interface and fake adapter | ready | none | Fake adapter work can proceed without real tmux and unblocks later API/session tasks. |

## Current Blocked Gates

| Gate | Owning leaf task(s) | Requires | Blocker |
| --- | --- | --- | --- |
| Tmux capture spike | `INT-V1-001` | Ubuntu host with `tmux` available | Current environment lacks `tmux`; `command -v tmux && tmux -V` exited 1 with no output on 2026-07-08. |
| UI visual direction | `FE-V1-002`, `FE-V1-003` | human acceptance | Mockups require UI state coverage first, then human selection before UI implementation. |
| Release readiness | `REL-V1-005` to `REL-V1-010` | validation artifacts and human acceptance | Release tasks wait for module hardening, docs, smoke evidence, and go/no-go review. |

## Status Vocabulary

- `ready`: all dependencies are done, requirements are available, and validation is known.
- `todo`: planned but waiting for earlier implementation or sequencing.
- `blocked`: waiting on physical devices, app-store accounts, certificates, permissions, human acceptance, legal/privacy review, or another task.
- `done`: validation/evidence exists in the owning backlog file or linked artifact.
- `deferred`: not in the current release; keep visible for roadmap planning.
