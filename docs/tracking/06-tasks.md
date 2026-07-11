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
| 1 | `INT-V1-024` Implement structured skills listing | in_progress | none | Implements the remaining observed read-only utility boundary. |
| 2 | `IFC-V1-019` Freeze the selected API route manifest | ready | none | Converts the completed semantic matrix and normalized contracts into one unambiguous public route inventory. |
| 3 | `IFC-V1-047` Enforce real HTTP resource limits | ready | none | Extends proven option inventory into raw-socket limit and cleanup behavior. |
| 4 | `IFC-V1-015` Prove HTTPS certificate enrollment on a real phone | ready | none | Resolves the independent physical-device LAN trust gate when hardware setup is available. |

## Intentional Blockers

| Gate | Owner | Blocker | Unblocks |
| --- | --- | --- | --- |
| LAN security | `IFC-V1-015` | Real phone certificate-enrollment proof | Auth lifecycle, pairing UI, security/release review. |
| Real Codex operation implementation | `INT-V1-018` to `INT-V1-027` | Exact semantics, ordered normalization, prompt, model, goal, Plan, approval, and interrupt controls pass; remaining utility ports and assembled proof remain | Production operation API, stable mobile state matrix, approvals. |
| Mobile visual direction | Reopened `FE-V1-002`, `FE-V1-003` | Real state matrix, two replacement options, human selection | React screen implementation. |
| Release | `REL-V1-010` | All module hardening, clean package/service/phone/security evidence, human acceptance | V1 release and V2 planning. |

## Status Vocabulary

- `ready`: all task dependencies are done and scope/evidence are executable.
- `todo`: defined and ordered behind unfinished task dependencies.
- `blocked`: requires human choice, physical device/account/certificate, or external state beyond task dependencies.
- `in_progress`: active work.
- `done`: current wording and evidence are complete.
- `deferred`: explicitly outside V1.
