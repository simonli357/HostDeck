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
| 1 | TBD | blocked | Planning sign-off | Replace with the first ready leaf task after the backlog is decomposed. |

## Current Blocked Gates

| Gate | Owning leaf task(s) | Requires | Blocker |
| --- | --- | --- | --- |
| Planning sign-off | TBD | human acceptance | Product scope and backlog are not approved yet. |

## Status Vocabulary

- `ready`: all dependencies are done, requirements are available, and validation is known.
- `todo`: planned but waiting for earlier implementation or sequencing.
- `blocked`: waiting on physical devices, app-store accounts, certificates, permissions, human acceptance, legal/privacy review, or another task.
- `done`: validation/evidence exists in the owning backlog file or linked artifact.
- `deferred`: not in the current release; keep visible for roadmap planning.
