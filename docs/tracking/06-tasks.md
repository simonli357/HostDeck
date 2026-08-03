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
| 1 | `FE-V1-091` Correct physical Session Actions admission | in_progress | none | Fix the three independent-review blockers in candidate `d3da630`; do not rerun it. |
| 2 | `FE-V1-092` Own destructive confirmations exactly | ready | none | Remove ambiguous or repeated taps from the highest-risk physical mutations. |
| 3 | `FE-V1-093` Own route returns exactly | ready | none | Prove detail/result exits through route and authority transitions, not labels. |
| 4 | `FE-V1-094` Own profile recovery exactly | ready | none | Replace range-based recovery with one-attempt admission and exact request generations. |
| 5 | `FE-V1-095` Own dock and sheet boundaries exactly | ready | none | Remove broad trigger/close acquisition across the primary physical surfaces. |
| 6 | `FE-V1-096` Own structured-control actions exactly | ready | none | Bind model, goal, plan, and compact actions to current sheets and exact counters. |
| 7 | `FE-V1-097` Own utility and clipboard actions exactly | ready | none | Bind utility, Resume, and clipboard actions to their current route and authority. |
| 8 | `FE-V1-098` Make physical transition deltas exact | ready | none | Remove remaining loose bootstrap, reload, detail, and reconnect success predicates. |

The implementation agent should complete this whole ordered batch without a phone run, then advance through dependent `FE-V1-099` and stop at independent review gate `FE-V1-100`. `FE-V1-090`, the phone, Tailscale, Serve state, package repinning, and failed candidates remain out of scope until that one consolidated review passes.

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
