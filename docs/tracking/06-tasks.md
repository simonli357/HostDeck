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
| 1 | `INT-V1-113` Automatic shared-session enrollment | in_progress | none | Reconcile loaded roots and live notifications into the completed native-UUID membership transaction. |

`REL-V1-109` records the approved shared-session/Ubuntu rebaseline. The dependency chain then proceeds through contracts, binding/state, broker, automatic enrollment, selected API/CLI, live catalog UI, hardening, Ubuntu packaging, physical phone acceptance, and clean release acceptance. Completed adoption and Windows work remains historical; unfinished Windows and superseded aggregate tasks are deferred rather than release blockers.

## Intentional Blockers

| Gate | Owner | Blocker | Unblocks |
| --- | --- | --- | --- |
| Release | `REL-V1-010` | `REL-V1-110` Ubuntu candidate evidence and human acceptance | V1 release and V2 planning. |
| Physical device | `FE-V1-108` | Connected unlocked Android phone after the installed candidate exists | Clean Ubuntu release acceptance. |

## Status Vocabulary

- `ready`: all task dependencies are done and scope/evidence are executable.
- `todo`: defined and ordered behind unfinished task dependencies.
- `blocked`: requires human choice, physical device/account/consent, or external state beyond task dependencies.
- `in_progress`: active work.
- `done`: current wording and evidence are complete.
- `deferred`: explicitly outside V1.
