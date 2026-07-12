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
| 1 | `IFC-V1-030` Implement host lock state and lock/unlock boundary | in_progress | none | Consumes the completed authentication, CSRF, settings, manifest, and security-audit boundaries. |
| 2 | `IFC-V1-031` Implement LAN configuration and enable/disable boundary | ready | none | Consumes the completed HTTPS enrollment, trust, CSRF, manifest, and security-audit boundaries. |
| 3 | `IFC-V1-069` Implement the bounded projected-event diagnostic read route | ready | none | Exposes the completed retained projection contract through one bounded authenticated read. |
| 4 | `IFC-V1-060` Implement managed-thread resume metadata API and CLI | ready | none | Exposes the completed exact safe TUI resume contract without executing a phone shell. |
| 5 | `IFC-V1-043` Implement the read-only usage API and CLI | ready | none | Exposes the completed exact usage capability through the authenticated selected manifest. |
| 6 | `IFC-V1-065` Implement the read-only skills API and CLI | ready | none | Exposes the completed exact skills capability through the authenticated selected manifest. |
| 7 | `INT-V1-027` Prove the assembled real structured vertical | blocked | Authenticated turn usage reset; host Bubblewrap AppArmor profile | Resume the unchanged aggregate when both external runtime conditions are available. |

## Intentional Blockers

| Gate | Owner | Blocker | Unblocks |
| --- | --- | --- | --- |
| Real Codex operation implementation | `INT-V1-027` | Every exact operation port passes; the assembled real two-thread callback vertical remains | Production operation API, stable mobile state matrix, approvals. |
| Mobile visual direction | Reopened `FE-V1-002`, `FE-V1-003` | Real state matrix, two replacement options, human selection | React screen implementation. |
| Release | `REL-V1-010` | All module hardening, clean package/service/phone/security evidence, human acceptance | V1 release and V2 planning. |

## Status Vocabulary

- `ready`: all task dependencies are done and scope/evidence are executable.
- `todo`: defined and ordered behind unfinished task dependencies.
- `blocked`: requires human choice, physical device/account/certificate, or external state beyond task dependencies.
- `in_progress`: active work.
- `done`: current wording and evidence are complete.
- `deferred`: explicitly outside V1.
