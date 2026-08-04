# Tasks

Current execution queue only. Detailed cards and historical evidence live in `docs/tracking/backlog/`.

## Rules

- Execute leaf tasks from this queue unless the user changes priority.
- `ready` requires every task dependency done and validation known.
- Keep completed history out of this file; completion remains in the owning backlog/artifact.
- React screen implementation must use the selected Focus Rail assets and design system under `DEC-028`; unapproved cross-option drift is not allowed.
- Do not use tmux/fake-Codex evidence to complete the selected app-server runtime.
- Do not use direct-LAN/custom-CA evidence to complete the selected remote path, and do not implement Tailscale behavior before `IFC-V1-070` freezes it.
- Update status only for handoff truth and run `pnpm check:planning` before completion/commit.

## Current Next Queue

| Order | Task | Status | Blocked by | Why next |
| --- | --- | --- | --- | --- |
| 1 | `FE-V1-092` Reject prechanged destructive baselines | ready | none | Bind self-revoke to the exact prior Office revoke count and add path-specific hostile mutation proof. |
| 2 | `FE-V1-093` Require a complete Mission destination | ready | none | Make stable route settlement require the full Mission shell, not one title plus source-control absence. |
| 3 | `FE-V1-094` Bind profile settlement to external state | ready | none | Snapshot and continuously preserve foreign Serve and manager state through away and return settlement. |
| 4 | `FE-V1-095` Finish coherent sheet ownership | ready | none | Reject competing overlays and replace mutable-status utility ownership with complete fixed headers. |
| 5 | `FE-V1-096` Finish exact structured-state proof | ready | none | Require owner-local selected/applied/terminal model, goal, Plan, and Compact truth with hostile stale-copy cases. |
| 6 | `FE-V1-097` Preserve utility and Resume authority | ready | none | Keep one immutable navigation snapshot through utility/Resume paths and owner-bind the copy outcome. |
| 7 | `FE-V1-098` Stabilize fragment-free Mission reload | ready | none | Read exact counters and the complete current hierarchy together through one stable reload window. |

Independent `FE-V1-100` review rejects `4d4e3fc`/`80b69c5` while retaining the valid recursion, cause-propagation, geometry, and exact-delta corrections. Delegate `FE-V1-092` through `FE-V1-098` together, then complete dependent `FE-V1-099` and stop for a new independent `FE-V1-100` review. `FE-V1-090`, the phone, Tailscale, Serve state, package repinning, and failed candidates remain out of scope until that review passes.

## Intentional Blockers

| Gate | Owner | Blocker | Unblocks |
| --- | --- | --- | --- |
| Release | `REL-V1-010` | All module hardening, clean package/service/remote-phone/profile/security evidence, human acceptance | V1 release and V2 planning. |

## Status Vocabulary

- `ready`: all task dependencies are done and scope/evidence are executable.
- `todo`: defined and ordered behind unfinished task dependencies.
- `blocked`: requires human choice, physical device/account/consent, or external state beyond task dependencies.
- `in_progress`: active work.
- `done`: current wording and evidence are complete.
- `deferred`: explicitly outside V1.
