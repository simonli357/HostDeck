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
| 1 | `IFC-V1-047` Enforce real HTTP resource limits | in_progress | none | Extends proven option inventory into raw-socket limit and cleanup behavior while the runtime aggregate is externally blocked. |
| 2 | `IFC-V1-015` Prove HTTPS certificate enrollment on a real phone | ready | none | Resolves the independent physical-device LAN trust gate when hardware setup is available. |
| 3 | `INT-V1-027` Prove the assembled real structured vertical | blocked | Authenticated turn usage reset; host Bubblewrap AppArmor profile | Resume the unchanged aggregate when both external runtime conditions are available. |

## Intentional Blockers

| Gate | Owner | Blocker | Unblocks |
| --- | --- | --- | --- |
| LAN security | `IFC-V1-015` | Real phone certificate-enrollment proof | Auth lifecycle, pairing UI, security/release review. |
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
