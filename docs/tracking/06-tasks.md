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
| 1 | `FE-V1-091` Correct shared Session Actions handoff budget | ready | none | Preserve one authority owner without consuming the post-`Done` admission budget before the Interrupt workflow finishes; add an integrated handoff test. |
| 2 | `FE-V1-092` Complete destructive mutation snapshots | ready | none | Prove zero pre-confirmation and exactly one final mutation locally for every destructive path. |
| 3 | `FE-V1-093` Complete route-owned destination settlement | ready | none | Reject retained Session Detail/result controls, not only a stable Mission title and subscriber count. |
| 4 | `FE-V1-094` Correct profile-away settlement | ready | none | Require zero host-received route generations while admission is closed and stable generic failure truth. |
| 5 | `FE-V1-095` Separate every real sheet/header context | ready | none | Fix impossible global/nested Host, event-close, goal-close, and close-completion ownership. |
| 6 | `FE-V1-096` Complete structured-control ownership and counters | ready | none | Bind goal/model/plan/Compact actions to exact current structure and local before/after counters. |
| 7 | `FE-V1-097` Correct utility, Resume, and clipboard boundaries | ready | none | Use header-owned Back selectors, reject ambiguous outcomes, and preserve navigation authority. |
| 8 | `FE-V1-098` Complete stable exact reload settlement | ready | none | Replace remaining stale/current one-sample completion and add missing hostile transition tests. |

Independent `FE-V1-100` review rejects `a746820` despite all non-physical checks passing. Delegate the complete `FE-V1-091` to `FE-V1-098` correction batch together, then complete dependent executable guard `FE-V1-099` and stop for a new independent `FE-V1-100` review. `FE-V1-090`, the phone, Tailscale, Serve state, package repinning, and failed candidates remain out of scope until that review passes.

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
