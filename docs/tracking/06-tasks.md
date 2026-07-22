# Tasks

Current execution queue only. Detailed cards and historical evidence live in `docs/tracking/backlog/`.

## Rules

- Execute leaf tasks from this queue unless the user changes priority.
- `ready` requires every task dependency done and validation known.
- Keep completed history out of this file; completion remains in the owning backlog/artifact.
- Do not start React screen implementation before `FE-V1-003` human visual selection.
- Do not use tmux/fake-Codex evidence to complete the selected app-server runtime.
- Do not use direct-LAN/custom-CA evidence to complete the selected remote path, and do not implement Tailscale behavior before `IFC-V1-070` freezes it.
- Update status only for handoff truth and run `pnpm check:planning` before completion/commit.

## Current Next Queue

| Order | Task | Status | Blocked by | Why next |
| --- | --- | --- | --- | --- |
| 1 | `IFC-V1-083` Implement and accept the selected foreground serve lifecycle | in_progress | none | The real production graph now reaches exact reconciled runtime readiness without publishing a listener; compose the accepted loopback Fastify, post-listen remote observation, signal/runtime-exit handling, and shutdown lifecycle next. |
| 2 | `IFC-V1-055` Generate versioned unprivileged systemd user units with explicit ownership/dependencies | ready | none | The compiled package and accepted runtime lifecycle are complete; units remain independent, but the foreground serve lifecycle is ordered first. |

## Intentional Blockers

| Gate | Owner | Blocker | Unblocks |
| --- | --- | --- | --- |
| Mobile visual direction | `FE-V1-003` | Human selection of exact Signal Ledger or Focus Rail assets and any approved drift | React screen implementation. |
| Release | `REL-V1-010` | All module hardening, clean package/service/remote-phone/profile/security evidence, human acceptance | V1 release and V2 planning. |

## Status Vocabulary

- `ready`: all task dependencies are done and scope/evidence are executable.
- `todo`: defined and ordered behind unfinished task dependencies.
- `blocked`: requires human choice, physical device/account/consent, or external state beyond task dependencies.
- `in_progress`: active work.
- `done`: current wording and evidence are complete.
- `deferred`: explicitly outside V1.
