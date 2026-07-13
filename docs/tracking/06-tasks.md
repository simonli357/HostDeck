# Tasks

Current execution queue only. Detailed cards and historical evidence live in `docs/tracking/backlog/`.

## Rules

- Execute leaf tasks from this queue unless the user changes priority.
- `ready` requires every task dependency done and validation known.
- Keep completed history out of this file; completion remains in the owning backlog/artifact.
- Do not start React screen implementation before `FE-V1-003` human visual selection.
- Do not use tmux/fake-Codex evidence to complete the selected app-server runtime.
- Update status only for handoff truth and run `pnpm check:planning` before completion/commit.

## Current Next Queue

| Order | Task | Status | Blocked by | Why next |
| --- | --- | --- | --- | --- |
| 1 | `IFC-V1-066` Implement the reusable exact-target write gate | ready | none | The accepted real structured vertical completes its final dependency; this gate directly unblocks paired-device revocation and the physical phone security matrix. |
| 2 | `IFC-V1-069` Implement the bounded projected-event diagnostic read route | ready | none | Exposes the completed retained projection contract through one bounded authenticated read. |
| 3 | `IFC-V1-060` Implement managed-thread resume metadata API and CLI | ready | none | Exposes the completed exact safe TUI resume contract without executing a phone shell. |
| 4 | `IFC-V1-043` Implement the read-only usage API and CLI | ready | none | Exposes the completed exact usage capability through the authenticated selected manifest. |
| 5 | `IFC-V1-065` Implement the read-only skills API and CLI | ready | none | Exposes the completed exact skills capability through the authenticated selected manifest. |
| 6 | `INT-V1-007` Implement runtime process/socket supervision | ready | none | The accepted structured vertical now permits explicit foreground/service ownership work, but it is behind the requested physical-phone path. |
| 7 | `FE-V1-004` Rebase the mobile structured-state matrix | ready | none | Accepted real states now permit the mobile-first design-contract rebaseline; screen implementation and mockups remain later gated work. |

## Intentional Blockers

| Gate | Owner | Blocker | Unblocks |
| --- | --- | --- | --- |
| Selected mutation boundary | `IFC-V1-066` | The common ordered target/auth/CSRF/lock/audit/dispatch gate remains | Paired-device revocation, selected mutation routes, and physical phone security acceptance. |
| Mobile visual direction | Reopened `FE-V1-002`, `FE-V1-003` | Real state matrix, two replacement options, human selection | React screen implementation. |
| Release | `REL-V1-010` | All module hardening, clean package/service/phone/security evidence, human acceptance | V1 release and V2 planning. |

## Status Vocabulary

- `ready`: all task dependencies are done and scope/evidence are executable.
- `todo`: defined and ordered behind unfinished task dependencies.
- `blocked`: requires human choice, physical device/account/certificate, or external state beyond task dependencies.
- `in_progress`: active work.
- `done`: current wording and evidence are complete.
- `deferred`: explicitly outside V1.
