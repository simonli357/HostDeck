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
| 1 | `IFC-V1-075` Rebaseline selected routes and audit ownership to remote access | in_progress | none | Removes the temporary historical LAN/certificate production surface now that the remote audit catalog is durable. |
| 2 | `IFC-V1-071` Implement bounded read-only Tailscale observer adapter | ready | none | Converts exact 1.98.8 raw reads into the normalized contract without mutation or identity leakage. |
| 3 | `IFC-V1-073` Implement external-origin and Serve proxy trust boundary | ready | none | Applies the frozen Host/Origin/header/provenance contract before app authorization. |
| 4 | `FE-V1-004` Rebase mobile information architecture and state matrix | ready | none | Maps phone-first journeys to the accepted remote/access contracts before replacement visual directions are generated. |
| 5 | `IFC-V1-069` Implement the bounded projected-event diagnostic read route | ready | none | Exposes the completed retained projection contract through one bounded authenticated read. |
| 6 | `IFC-V1-060` Implement managed-thread resume metadata API and CLI | ready | none | Exposes the completed exact safe TUI resume contract without executing a phone shell. |
| 7 | `IFC-V1-043` Implement the read-only usage API and CLI | ready | none | Exposes the completed exact usage capability through the authenticated selected manifest. |
| 8 | `IFC-V1-065` Implement the read-only skills API and CLI | ready | none | Exposes the completed exact skills capability through the authenticated selected manifest. |
| 9 | `IFC-V1-040` Implement exact managed-session start API and CLI command | ready | none | Exposes the completed managed-thread start service through the selected write gate. |
| 10 | `IFC-V1-061` Implement exact managed-thread archive API and CLI command | ready | none | Exposes the completed archive service through the selected write gate. |
| 11 | `IFC-V1-041` Implement one-session prompt API and CLI send command | ready | none | Exposes the completed prompt runtime service through the selected write gate. |
| 12 | `IFC-V1-042` Implement exact model catalog/read/select API and CLI mappings | ready | none | Exposes the selected model capability without slash-command fallback. |
| 13 | `IFC-V1-062` Implement exact goal API and CLI mappings | ready | none | Exposes the selected goal lifecycle without slash-command fallback. |
| 14 | `IFC-V1-063` Implement exact plan API and CLI mappings | ready | none | Exposes the selected plan-mode capability without slash-command fallback. |
| 15 | `IFC-V1-064` Implement compact progress read and confirmed compact API/CLI mapping | ready | none | Exposes the selected compact capability and truthful progress state. |
| 16 | `IFC-V1-044` Implement pending-approval read/respond API and CLI mappings | ready | none | Exposes the completed approval service through the selected read and write boundaries. |
| 17 | `IFC-V1-045` Implement exact active-turn interrupt API and CLI command | ready | none | Exposes the completed exact-turn interrupt service through the selected write gate. |
| 18 | `IFC-V1-049` Enforce operation idempotency and concurrency limits | ready | none | Hardens duplicate and concurrent selected writes before aggregate production composition. |
| 19 | `INT-V1-007` Implement runtime process/socket supervision | ready | none | The accepted structured vertical permits explicit foreground/service ownership work independently of remote contract implementation. |
| 20 | `IFC-V1-035` Add bounded subscriber queues and revoke/disconnect/archive cleanup | ready | none | Exact active/opening-stream revoke is complete; bounded subscriber ownership can progress independently of the ingress spike. |

## Intentional Blockers

| Gate | Owner | Blocker | Unblocks |
| --- | --- | --- | --- |
| Mobile visual direction | Reopened `FE-V1-002`, `FE-V1-003` | Real state matrix, two replacement options, human selection | React screen implementation. |
| Release | `REL-V1-010` | All module hardening, clean package/service/remote-phone/profile/security evidence, human acceptance | V1 release and V2 planning. |

## Status Vocabulary

- `ready`: all task dependencies are done and scope/evidence are executable.
- `todo`: defined and ordered behind unfinished task dependencies.
- `blocked`: requires human choice, physical device/account/consent, or external state beyond task dependencies.
- `in_progress`: active work.
- `done`: current wording and evidence are complete.
- `deferred`: explicitly outside V1.
