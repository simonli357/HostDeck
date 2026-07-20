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
| 1 | `IFC-V1-067` Isolate every legacy production interface path | ready | none | The selected 22-registration/35-route production composition is accepted, so legacy custom-listener, direct-LAN/certificate, raw, tmux, config, export, and fallback reachability can now be removed or isolated without losing the selected behavior oracle. |
| 2 | `IFC-V1-050` Propagate end-to-end deadlines and cancellation | ready | none | The resource contract, reconnect controller, selected operations, and assembled HTTP handlers are complete; this leaf closes HTTP-to-service-to-protocol deadline truth before aggregate stress. |
| 3 | `IFC-V1-051` Bound selected CLI API transports and errors | ready | none | The exact production manifest and 21-operation source-client inventory are accepted; shared connect/request/body/stream limits can now replace client-local assumptions before packaging. |

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
