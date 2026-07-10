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
| 1 | `INT-V1-018` Implement exact prompt/turn targeting | in_progress | none | Consumes the completed model/Plan transaction boundary in the first assembled primary-control turn path. |
| 2 | `INT-V1-025` Implement pending approval routing | ready | none | Uses normalized request/item identity to implement exactly-once approve/deny behavior. |
| 3 | `DAT-V1-022` Invoke production projection retention | ready | none | Extends the proven append transaction with bounded pruning and visible replay boundaries. |
| 4 | `DAT-V1-023` Implement accepted-to-terminal audit state machine | ready | none | Establishes truthful mutation outcomes before write/security integration. |
| 5 | `IFC-V1-018` Implement commit-only projection fanout | ready | none | Carries only committed ordered projection truth into the later replay/live boundary. |
| 6 | `INT-V1-022` Implement structured usage retrieval | ready | none | Implements observed account/runtime usage without inventing billing scope. |
| 7 | `INT-V1-023` Implement accepted/incomplete compact lifecycle | ready | none | Prevents the utility from reporting context reduction from immediate acceptance. |
| 8 | `INT-V1-024` Implement structured skills listing | ready | none | Implements the remaining observed read-only utility boundary. |
| 9 | `IFC-V1-019` Freeze the selected API route manifest | ready | none | Converts the completed semantic matrix and normalized contracts into one unambiguous public route inventory. |
| 10 | `IFC-V1-047` Enforce real HTTP resource limits | ready | none | Extends proven option inventory into raw-socket limit and cleanup behavior. |
| 11 | `IFC-V1-015` Prove HTTPS certificate enrollment on a real phone | ready | none | Resolves the independent physical-device LAN trust gate when hardware setup is available. |

## Intentional Blockers

| Gate | Owner | Blocker | Unblocks |
| --- | --- | --- | --- |
| LAN security | `IFC-V1-015` | Real phone certificate-enrollment proof | Auth lifecycle, pairing UI, security/release review. |
| Real Codex operation implementation | `INT-V1-018` to `INT-V1-027` | Exact semantics, ordered normalization, model, goal, and Plan control pass; assembled prompt plus remaining control ports and real proof remain | Production operation API, stable mobile state matrix, approvals. |
| Mobile visual direction | Reopened `FE-V1-002`, `FE-V1-003` | Real state matrix, two replacement options, human selection | React screen implementation. |
| Release | `REL-V1-010` | All module hardening, clean package/service/phone/security evidence, human acceptance | V1 release and V2 planning. |

## Status Vocabulary

- `ready`: all task dependencies are done and scope/evidence are executable.
- `todo`: defined and ordered behind unfinished task dependencies.
- `blocked`: requires human choice, physical device/account/certificate, or external state beyond task dependencies.
- `in_progress`: active work.
- `done`: current wording and evidence are complete.
- `deferred`: explicitly outside V1.
