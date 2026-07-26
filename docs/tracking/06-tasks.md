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
| 1 | `FE-V1-032` Implement paired-device management | ready | none | Add exact device listing and revocation after the pairing authority path is proven. |
| 2 | `FE-V1-033` Implement visible host-lock state | ready | none | Carry lock authority into every protected dashboard action without adding remote unlock. |
| 3 | `FE-V1-034` Implement remote connection recovery | ready | none | Expose actionable profile, Tailscale, and Serve truth without mutating external state. |
| 4 | `FE-V1-035` Implement compatibility state | ready | none | Surface exact runtime compatibility before complete-dashboard failure hardening. |
| 5 | `FE-V1-028` Implement usage utility | ready | none | Add the first secondary structured utility after the primary controls. |
| 6 | `FE-V1-029` Implement compact utility | ready | none | Add bounded context compaction through its exact structured route. |
| 7 | `FE-V1-030` Implement skills utility | ready | none | Add capability-aware skill discovery after the primary controls. |
| 8 | `FE-V1-014` Implement bounded event diagnostics | ready | none | Add diagnostic disclosure without weakening the semantic timeline or privacy boundary. |
| 9 | `FE-V1-036` Implement interrupt affordance | ready | none | Add the first bounded session action after the primary workflow. |
| 10 | `FE-V1-037` Implement archive affordance | ready | none | Add explicit archive confirmation and outcome handling. |
| 11 | `FE-V1-038` Implement laptop-resume affordance | ready | none | Add the selected TUI-resume handoff after other session actions. |

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
