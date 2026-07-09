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
| 1 | `INT-V1-003` Implement Codex binding and compatibility gate | in_progress | none | Establishes reviewed generated bindings and blocks incompatible required operations before IPC work. |
| 2 | `DAT-V1-019` Enforce owner-only paths and daemon lease | ready | none | Establishes the state/runtime ownership boundary required by runtime supervision and packaging. |
| 3 | `IFC-V1-016` Build the Fastify/SSE composition root | ready | none | Replaces the partial custom listener with the production typed server lifecycle used by later security and fanout work. |
| 4 | `DAT-V1-020` Integrate production projection, retention, and audit outcomes | ready | none | Makes selected projection and audit durability part of production append/startup paths before interface fanout work. |
| 5 | `IFC-V1-015` Prove HTTPS certificate enrollment on a real phone | ready | none | Resolves the blocking LAN trust boundary when a real phone/LAN setup is available. |

## Intentional Blockers

| Gate | Owner | Blocker | Unblocks |
| --- | --- | --- | --- |
| Codex compatibility | `INT-V1-003` | Reviewed generated binding identity and required-capability gate | IPC transport, managed-thread lifecycle, and real structured controls. |
| LAN security | `IFC-V1-015` | Real phone certificate-enrollment proof | Auth lifecycle, pairing UI, security/release review. |
| Real Codex semantics | `INT-V1-006` | Contracts, adapter, mapping, and thread lifecycle | Production operation API, mobile state matrix, approvals. |
| Mobile visual direction | Reopened `FE-V1-002`, `FE-V1-003` | Real state matrix, two replacement options, human selection | React screen implementation. |
| Release | `REL-V1-010` | All module hardening, clean package/service/phone/security evidence, human acceptance | V1 release and V2 planning. |

## Status Vocabulary

- `ready`: all task dependencies are done and scope/evidence are executable.
- `todo`: defined and ordered behind unfinished task dependencies.
- `blocked`: requires human choice, physical device/account/certificate, or external state beyond task dependencies.
- `in_progress`: active work.
- `done`: current wording and evidence are complete.
- `deferred`: explicitly outside V1.
