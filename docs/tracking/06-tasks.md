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
| 1 | `IFC-V1-016` Select and probe the exact Fastify production stack | in_progress | none | Freezes maintained versions, validation/error ownership, resource inputs, SSE/static boundaries, and lifecycle behavior before server implementation. |
| 2 | `INT-V1-006` Probe exact real Codex operation semantics | ready | none | Independent real-boundary spike; unblocks every structured operation port and the mobile state contract. |
| 3 | `DAT-V1-020` Implement commit-before-publish projection append | ready | none | Independent data leaf; establishes durable event truth for normalization and fanout. |
| 4 | `DAT-V1-023` Implement accepted-to-terminal audit state machine | ready | none | Independent data leaf; establishes truthful mutation outcomes before write/security integration. |
| 5 | `IFC-V1-015` Prove HTTPS certificate enrollment on a real phone | ready | none | Independent physical-device spike; resolves the blocking LAN trust boundary when the setup is available. |

## Intentional Blockers

| Gate | Owner | Blocker | Unblocks |
| --- | --- | --- | --- |
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
