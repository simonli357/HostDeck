# Backlog Index

Execution map for V1. Detailed task cards live in the group files. Capability blocks live in `docs/planning/05-blocks/`.

## Selected Program Areas

| Program area | Block refs | Group file | Epics | Leaf task prefix |
| --- | --- | --- | --- | --- |
| Foundation / Contracts | `BLK-V1-01` | `foundation.md` | Workspace, core model, contracts, fixtures, foundation hardening | `FND-V1-*` |
| Data / Local State | `BLK-V1-02` | `local-state-auth-audit.md` | Storage spikes, migrations, auth, audit, retention, config hardening | `DAT-V1-*` |
| Integrations / Tmux Output | `BLK-V1-03` | `tmux-output.md` | Tmux spike, adapter, output reader, restart reconciliation, tmux hardening | `INT-V1-*` |
| Interface / API And CLI | `BLK-V1-04` | `api-cli-control-plane.md` | Server startup, API routes, write pipeline, CLI, network controls, interface hardening | `IFC-V1-*` |
| Frontend / Dashboard UX | `BLK-V1-05` | `web-dashboard.md` | UI fixtures, visual direction, screen groups, responsive states, UI fidelity | `FE-V1-*` |
| Release / Hardening | `BLK-V1-06` | `hardening-release.md` | Aggregate validation, docs, security/privacy, release smoke, go/no-go | `REL-V1-*` |

## Dependency Graph

Track meaningful ordering dependencies here. Group files own exact task cards.

| Block/task | Enables | Notes |
| --- | --- | --- |
| Backlog approval and implementation authorization | `FND-V1-001` | Product code remains blocked until the human authorizes implementation. |
| `FND-V1-001` workspace scaffold | All implementation tasks | Creates runnable workspace, packages, and planned command surface. |
| `BLK-V1-01` complete via `FND-V1-001` to `FND-V1-013` plus `FND-V1-010`/`FND-V1-011` | `DAT-V1-001`, `DAT-V1-002`, `DAT-V1-003`, `INT-V1-010`, later API/CLI/UI consumers | Storage, fake adapters, API, CLI, and UI consume typed contracts and deterministic fixtures; real tmux capture still requires `tmux`. |
| `DAT-V1-001` SQLite spike | `DAT-V1-010` to `DAT-V1-017` | Resolved by `DEC-014`; storage implementation uses `better-sqlite3` plus a first-party migration runner. |
| `DAT-V1-002` token transport spike | `DAT-V1-013`, `IFC-V1-005`, `FE-V1-013` | Resolved by `DEC-015`; auth routes and UI trust states use host-only `HttpOnly` cookie transport with CSRF write headers. |
| `DAT-V1-003` retention spike | `DAT-V1-015`, `INT-V1-014`, `FE-V1-015` | Resolved by `DEC-016`; output/audit retention and replay-boundary behavior use visible boundaries and exported default caps. |
| `INT-V1-001` tmux capture spike | `INT-V1-014`, `IFC-V1-003`, output smoke tasks | Stream/replay implementation waits for capture mechanism and cursor semantics. |
| `DAT-V1-010` to `DAT-V1-017` local state foundation | `INT-V1-015`, `IFC-V1-004`, release privacy checks | Restart, auth, audit, settings, and optional branch metadata are durable before write paths harden. |
| `INT-V1-010` to `INT-V1-016` tmux/output foundation and smoke | `INT-V1-090`, `IFC-V1-003`, `IFC-V1-004`, `FE-V1-012` | API/CLI and dashboard can consume real managed session state; tmux hardening remains before release gates. |
| `IFC-V1-001` to `IFC-V1-014` API/CLI foundation | `FE-V1-010` to `FE-V1-021`, command reference tasks | Web and delivery docs consume stable local API and CLI behavior. |
| `FE-V1-001` UI state matrix | `FE-V1-002` visual direction spike | Mockups are generated from approved state coverage, not before it. |
| `FE-V1-002` and `FE-V1-003` visual direction approval | `FE-V1-010` to `FE-V1-021` UI implementation/fidelity | UI implementation waits for generated options, human selection, and recorded decision. |
| Block hardening tasks `FND-V1-010`, `DAT-V1-090`, `INT-V1-090`, `IFC-V1-090`, `FE-V1-090` | `REL-V1-006` to `REL-V1-010` | Release readiness waits for module/workflow hardening evidence. |
| `REL-V1-001` to `REL-V1-010` | V1 human acceptance and `REL-V1-999` | Release go/no-go depends on aggregate validation, docs, smoke, security/privacy, and known gaps. |

## Requirement Trace

| Requirement group | Leaf task coverage |
| --- | --- |
| `FR-001` to `FR-004`, `FR-013`, `FR-014` session lifecycle/output/restart | `INT-V1-010` to `INT-V1-016`, `IFC-V1-002` to `IFC-V1-004`, `IFC-V1-014`, `INT-V1-090` |
| `FR-005` output refresh/streaming | `INT-V1-014`, `IFC-V1-003`, `FE-V1-012`, `FE-V1-015`, `FE-V1-019` |
| `FR-006` to `FR-008`, `FR-015` prompt/slash writes | `FND-V1-004`, `IFC-V1-004`, `IFC-V1-007`, `FE-V1-020`, `FE-V1-021` |
| `FR-009`, `SFR-011` status and fixture heuristics | `FND-V1-007`, `FND-V1-008`, `FE-V1-001`, `FE-V1-015` |
| `FR-010`, `IR-001` to `IR-009`, `PR-005` dashboard UX | `FE-V1-001` to `FE-V1-021`, `FE-V1-090` |
| `FR-011`, `FR-012`, `PR-002` to `PR-004`, `PR-007`, `PR-008` API/CLI/service | `IFC-V1-001` to `IFC-V1-014`, `REL-V1-003` |
| `DR-001` to `DR-010` data/audit | `DAT-V1-001` to `DAT-V1-017`, `DAT-V1-090` |
| `SFR-001` to `SFR-010` trust/safety/failure | `FND-V1-004`, `DAT-V1-002`, `DAT-V1-013`, `DAT-V1-014`, `IFC-V1-004`, `IFC-V1-005`, `FE-V1-013`, `FE-V1-014`, hardening tasks |
| `NFR-001` to `NFR-009`, `PR-001` to `PR-009` platform/local-first/release | `IFC-V1-001`, `IFC-V1-011`, `REL-V1-001` to `REL-V1-010` |

## Backlog Quality Gates

Before implementation starts, the backlog must satisfy these checks:

- Every active-version requirement maps to at least one leaf task, explicit spike, or explicit release deferral.
- Every required V1 block in `docs/planning/05-blocks/00-index.md` maps to backlog epics, leaf tasks, validation evidence, and completion-matrix status.
- Every selected program area has a group file with epics, leaf tasks, dependencies, success criteria, and validation/evidence.
- Every user-facing screen group has state coverage, accessibility/fidelity validation, and asset tasks when UI exists.
- Every native capability, service, data store, account, certificate, or permission has setup, denial/failure-state, and validation tasks.
- Every module or workflow has a module-hardening task with strict success criteria and manual inspection where automation cannot prove behavior.
- Release readiness is represented with build/package, clean local setup, docs/support, security/privacy, and go/no-go tasks.
- No broad implementation task is allowed as a leaf task.

## Ordering Rules

Prefer this order unless a task dependency requires a narrower sequence:

1. Contracts and data models.
2. Fixtures, mocks, and sample data.
3. Core/headless logic.
4. Native adapters and permission flows.
5. UI consuming existing contracts.
6. Error, empty, loading, and failure states.
7. Persistence, sync, import/export, and redaction.
8. Performance, accessibility, privacy, and security hardening.
9. Device/runtime/release gates.
10. Human acceptance.
