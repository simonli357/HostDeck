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
| 1 | `IFC-V1-048` Enforce aggregate SSE subscriber and queue overload policy | in_progress | none | Strict replay-retention, heartbeat-write, reconnect-storm, slow-reader, and leak criteria are frozen. |
| 2 | `IFC-V1-038` Run aggregate fanout, health, reconnect, and shutdown acceptance | ready | none | All four fanout/health/shutdown leaves are complete; run the aggregate only after focused SSE overload hardening. |
| 3 | `IFC-V1-039` Implement liveness, readiness, and host status routes | ready | none | The selected manifest, read authority, and mutable health port are complete. |
| 4 | `IFC-V1-068` Implement managed-session list and detail routes | ready | none | The selected manifest, read authority, projection repository, and health port are complete. |

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
