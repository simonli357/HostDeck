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
| 29 | `INT-V1-001` Prototype tmux output capture with fake Codex output | done | none | `DEC-017` selects live `pipe-pane` plus bounded `capture-pane` startup/restart recovery for V1 output ingestion. |
| 30 | `INT-V1-011` Real tmux target naming, lookup, and list/reconcile primitives | done | none | Real HostDeck-only tmux target naming, lookup, list, and reconcile primitives are implemented and validated with isolated real tmux tests. |
| 31 | `INT-V1-012` Managed Codex session start with cwd validation and partial-failure cleanup | done | none | Real tmux managed start/list/get behavior is implemented with cwd/command preflight, duplicate checks, launch verification, and partial cleanup. |
| 32 | `INT-V1-013` Send, stop, and attach metadata operations | done | none | Real send, stop, and attach metadata operations target exact HostDeck tmux panes and fail loudly for missing/stale targets. |
| 33 | `INT-V1-014` Output reader, cursor assignment, storage append, and replay-boundary handoff | done | none | Live pipe capture, bounded capture reads, storage append, replay-boundary mapping, and reader failure state are implemented. |
| 34 | `INT-V1-015` Restart reconciliation between durable registry and live tmux targets | done | none | Restart reconciliation updates live durable sessions, marks missing ones stale, ignores stopped records, and reports unmanaged HostDeck-looking targets without import. |
| 35 | `INT-V1-016` Real Ubuntu tmux smoke path for managed sessions | ready | none | Real start, attach, send, stop, output, and restart primitives exist; full smoke can exercise them together. |

## Current Blocked Gates

| Gate | Owning leaf task(s) | Requires | Blocker |
| --- | --- | --- | --- |
| Clean release tmux setup | `REL-V1-006` | clean Ubuntu install/run path | Current work can use user-local `tmux 3.4`; clean release setup still needs documented install/run smoke evidence. |
| UI visual direction | `FE-V1-002`, `FE-V1-003` | human acceptance | Mockups require UI state coverage first, then human selection before UI implementation. |
| Release readiness | `REL-V1-005` to `REL-V1-010` | validation artifacts and human acceptance | Release tasks wait for module hardening, docs, smoke evidence, and go/no-go review. |

## Status Vocabulary

- `ready`: all dependencies are done, requirements are available, and validation is known.
- `todo`: planned but waiting for earlier implementation or sequencing.
- `blocked`: waiting on physical devices, app-store accounts, certificates, permissions, human acceptance, legal/privacy review, or another task.
- `done`: validation/evidence exists in the owning backlog file or linked artifact.
- `deferred`: not in the current release; keep visible for roadmap planning.
