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
| 1 | `FE-V1-090` Mobile dashboard physical hardening | blocked | phone unavailable | Diagnose physical touch delivery and run one distinct immutable candidate when the phone returns; retain only a complete no-retry pass. |
| 2 | `INT-V1-104` Complete Windows Codex vertical | blocked | authenticated Windows Codex host | Production composition and secret-free native recovery pass; run the committed no-retry model-backed launcher on an authenticated Windows host and retain its strict report. |
| 3 | `IFC-V1-102` Deterministic native package tree | in_progress | none | Bundle the exact runtime closure and target-native modules into verified Linux and Windows package trees. |
| 4 | `FND-V1-104` Operation descriptor design | ready | none | Nine Codex operations repeat one shape across ~45 files and ~30k lines; design the descriptor and decompose the sweep into per-operation leaf tasks. |

`IFC-V1-110` completes the local-only non-destructive discover/adopt/unmanage control plane with exact Codex 0.144.0 handoff evidence, and `INT-V1-109` closed full existing-dashboard/runtime interoperability hardening through `cbc5638` with shared-history fixes `495fde2` and `dbe641e`. `DAT-V1-104` is complete through `c7a50f3` and native run `31518677087`; `REL-V1-102` is complete through `0dd98f3` and run `31513897607`; `DAT-V1-103` is complete through `42fd03c` and run `31509712124`. `INT-V1-104` implementation is pushed through `25f45b1`; native Windows harness/preflight and no-model recovery passed run `31502834945`, and the model-backed Linux aggregate passed locally, but neither substitutes for the outstanding authenticated Windows report. `INT-V1-103` is complete through `040c133` and native run `31494425909`; `INT-V1-102` remains complete through run `31490136692`, `INT-V1-101` through run `31481942844`, `IFC-V1-100` through run `31474471365`, and `IFC-V1-101` through run `31471194169`. The latest `FE-V1-090` branch candidate `6829bd2` reached a stable first continuation target but delivered no request after the tap; no acceptance evidence was retained. The next phone run must use a distinct commit after touch-delivery diagnosis.

## Intentional Blockers

| Gate | Owner | Blocker | Unblocks |
| --- | --- | --- | --- |
| Release | `REL-V1-010` | All module hardening, clean package/service/remote-phone/profile/security evidence, human acceptance | V1 release and V2 planning. |
| Native distribution | `REL-V1-108` | Native Ubuntu/Windows packages, lifecycle, signing, clean-host acceptance, docs, and aggregate Android evidence | First distributable V1 release candidate. |

Review remediation from `artifacts/rev-2026-08-21-architecture-review.md` is queued as `FND-V1-104`; `IFC-V1-111` and `FND-V1-103` are closed; `FND-V1-106` closed `BUG-092`; `INT-V1-110` closed under `DEC-031`; `FND-V1-107` closed the nondeterministic unit gate, with `FND-V1-104`, `FND-V1-105`, and `IFC-V1-112` ordered behind them. `BUG-090` and `BUG-091` are closed in place.

## Status Vocabulary

- `ready`: all task dependencies are done and scope/evidence are executable.
- `todo`: defined and ordered behind unfinished task dependencies.
- `blocked`: requires human choice, physical device/account/consent, or external state beyond task dependencies.
- `in_progress`: active work.
- `done`: current wording and evidence are complete.
- `deferred`: explicitly outside V1.
