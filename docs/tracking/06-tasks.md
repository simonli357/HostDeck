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
| 1 | `FE-V1-092` Preserve destructive mutation baselines | ready | none | Keep one immutable pre-confirmation baseline through final settlement and fail immediately on selector or counter invariants. |
| 2 | `FE-V1-093` Repair and cover Mission destination settlement | ready | none | Remove the recursive selector, directly test retained-source rejection, and preserve exact destination authority. |
| 3 | `FE-V1-094` Complete profile-away/return hostile proof | ready | none | Exercise the repaired destination, continuously closed zero-delta away truth, exact return, and foreign-state preservation. |
| 4 | `FE-V1-095` Enforce coherent fixed sheet headers | ready | none | Replace title-anywhere ownership, preserve positive close destinations, and stop swallowing selector failures. |
| 5 | `FE-V1-096` Enforce local structured-control state and counters | ready | none | Prove the exact selected option and reject prechanged or duplicate model/goal/plan/Compact counters locally. |
| 6 | `FE-V1-097` Complete utility, Resume, and clipboard ownership | ready | none | Require coherent header geometry, exact clipboard result ownership, immutable authority, and the missing hostile cases. |
| 7 | `FE-V1-098` Complete exact reload/reconnect coverage | ready | none | Stabilize fragment-free Mission reload and cover current/stale, zero/extra/prechanged, subscriber, hierarchy, and mutation cases. |

Independent `FE-V1-100` review accepts only the corrected `FE-V1-091` fresh-budget boundary and rejects `e2201fb`/`bf7a521` on runtime and test-oracle findings. Delegate `FE-V1-092` through `FE-V1-098` together, then complete dependent `FE-V1-099` and stop for a new independent `FE-V1-100` review. `FE-V1-090`, the phone, Tailscale, Serve state, package repinning, and failed candidates remain out of scope until that review passes.

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
