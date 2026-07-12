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
| 1 | `DAT-V1-028` Implement atomic device revoke storage | in_progress | none | Invalidates bearer and CSRF authority together before the revoke route. |
| 2 | `DAT-V1-025` Implement bounded non-secret device listing | ready | none | Supplies the safe device-read model after security-critical mutation storage. |
| 3 | `IFC-V1-026` Implement HttpOnly cookie authentication context | ready | none | Consumes the completed trust and monotonic-auth contracts after the storage security leaves, before selected protected routes. |
| 4 | `IFC-V1-032` Implement the security mutation audit executor | ready | none | Consumes the completed strict security audit storage before route-specific mutations. |
| 5 | `INT-V1-027` Prove the assembled real structured vertical | blocked | Authenticated turn usage reset; host Bubblewrap AppArmor profile | Resume the unchanged aggregate when both external runtime conditions are available. |

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
