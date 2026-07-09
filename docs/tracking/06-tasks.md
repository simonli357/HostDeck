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
| 16 | `DAT-V1-003` Output and audit retention caps spike | done | none | `DEC-016` chose output/audit caps, cleanup timing, and replay/audit boundary semantics. |
| 17 | `DAT-V1-010` SQLite migration runner and base schema | done | none | Base storage schema and migration runner are implemented with migration failure tests. |
| 18 | `DAT-V1-011` Settings/config repository | done | none | Settings repository now persists safe defaults, lock/LAN state, state dir, port, retention values, and invalid-startup rejection. |
| 19 | `DAT-V1-012` Session registry and metadata repositories | done | none | Session and metadata repositories now persist registry state and validate failed/reload cases. |
| 20 | `DAT-V1-013` Auth devices and pairing-code repositories | done | none | Auth persistence now stores only hashed pairing/device/CSRF secrets and rejects expired, used, revoked, read-only, and CSRF-mismatched writes. |
| 21 | `DAT-V1-014` Durable audit repository and bounded payload summaries | done | none | Audit repository now persists bounded payload summaries and required V1 action types. |
| 22 | `DAT-V1-015` Retention cleanup and replay-boundary storage metadata | done | none | Retention repository now enforces output/audit caps and records replay/audit boundaries. |
| 23 | `DAT-V1-017` Optional git branch metadata capture | done | none | Optional git branch capture now persists branch metadata when available and returns null when git/non-git state is unavailable. |
| 24 | `DAT-V1-016` Storage restart-persistence tests | done | none | Cross-repository restart persistence now covers settings, session, metadata, auth, audit, output retention, and durable/ephemeral separation. |
| 25 | `DAT-V1-090` Local state/auth/audit/config hardening | done | none | Storage-owned hardening now covers migration drift, malformed raw secrets, audit unavailability, retention boundaries, newest-output retention, restart persistence, and local state inspection. |
| 26 | `INT-V1-010` Tmux adapter interface and fake adapter | done | none | Fake adapter interface now covers deterministic lifecycle, send, stop, attach, output, stale, and missing-target cases without real tmux/Codex. |
| 27 | `IFC-V1-005` Pairing/token claim and security/network state API routes | done | none | Security route handlers now cover pairing claim, trust/security state, network state, dashboard lock, remote unlock rejection, LAN mutation rejection, CSRF enforcement, and revoked/expired/used/invalid pairing-code rejection. |
| 28 | `REL-V1-001` Wire aggregate validation command names and artifact locations | done | none | Validation command wiring now distinguishes implemented commands from planned placeholders, and unavailable commands fail loudly with future owner task IDs. |

## Current Blocked Gates

| Gate | Owning leaf task(s) | Requires | Blocker |
| --- | --- | --- | --- |
| Real tmux work | `INT-V1-001`, `INT-V1-011` | Ubuntu host with `tmux` available | Current environment lacks `tmux`; `command -v tmux && tmux -V` exited 1 with no output on 2026-07-08. |
| Main implementation queue | `IFC-V1-001`, `IFC-V1-002`, `IFC-V1-004`, `FE-V1-001`, downstream release tasks | real tmux/startup prerequisites or completed API dependencies | After `REL-V1-001`, no current queue leaf is ready without unblocking tmux/startup-dependent work or completing prerequisite API/session tasks. |
| UI visual direction | `FE-V1-002`, `FE-V1-003` | human acceptance | Mockups require UI state coverage first, then human selection before UI implementation. |
| Release readiness | `REL-V1-005` to `REL-V1-010` | validation artifacts and human acceptance | Release tasks wait for module hardening, docs, smoke evidence, and go/no-go review. |

## Status Vocabulary

- `ready`: all dependencies are done, requirements are available, and validation is known.
- `todo`: planned but waiting for earlier implementation or sequencing.
- `blocked`: waiting on physical devices, app-store accounts, certificates, permissions, human acceptance, legal/privacy review, or another task.
- `done`: validation/evidence exists in the owning backlog file or linked artifact.
- `deferred`: not in the current release; keep visible for roadmap planning.
