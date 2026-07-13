# Tasks

Current execution queue only. Detailed cards and historical evidence live in `docs/tracking/backlog/`.

## Rules

- Execute leaf tasks from this queue unless the user changes priority.
- `ready` requires every task dependency done and validation known.
- Keep completed history out of this file; completion remains in the owning backlog/artifact.
- Do not start React screen implementation before `FE-V1-003` human visual selection.
- Do not use tmux/fake-Codex evidence to complete the selected app-server runtime.
- Update status only for handoff truth and run `pnpm check:planning` before completion/commit.

## Current Next Queue

| Order | Task | Status | Blocked by | Why next |
| --- | --- | --- | --- | --- |
| 1 | `IFC-V1-033` Run aggregate browser trust and physical Android security authorization matrix | in_progress | none | Exact trust, pairing, CSRF, lock, LAN, device-list, revoke, and write-gate boundaries are complete; execute their aggregate real-device acceptance now. |
| 2 | `IFC-V1-069` Implement the bounded projected-event diagnostic read route | ready | none | Exposes the completed retained projection contract through one bounded authenticated read. |
| 3 | `IFC-V1-060` Implement managed-thread resume metadata API and CLI | ready | none | Exposes the completed exact safe TUI resume contract without executing a phone shell. |
| 4 | `IFC-V1-043` Implement the read-only usage API and CLI | ready | none | Exposes the completed exact usage capability through the authenticated selected manifest. |
| 5 | `IFC-V1-065` Implement the read-only skills API and CLI | ready | none | Exposes the completed exact skills capability through the authenticated selected manifest. |
| 6 | `IFC-V1-040` Implement exact managed-session start API and CLI command | ready | none | Exposes the completed managed-thread start service through the selected write gate. |
| 7 | `IFC-V1-061` Implement exact managed-thread archive API and CLI command | ready | none | Exposes the completed archive service through the selected write gate. |
| 8 | `IFC-V1-041` Implement one-session prompt API and CLI send command | ready | none | Exposes the completed prompt runtime service through the selected write gate. |
| 9 | `IFC-V1-042` Implement exact model catalog/read/select API and CLI mappings | ready | none | Exposes the selected model capability without slash-command fallback. |
| 10 | `IFC-V1-062` Implement exact goal API and CLI mappings | ready | none | Exposes the selected goal lifecycle without slash-command fallback. |
| 11 | `IFC-V1-063` Implement exact plan API and CLI mappings | ready | none | Exposes the selected plan-mode capability without slash-command fallback. |
| 12 | `IFC-V1-064` Implement compact progress read and confirmed compact API/CLI mapping | ready | none | Exposes the selected compact capability and truthful progress state. |
| 13 | `IFC-V1-044` Implement pending-approval read/respond API and CLI mappings | ready | none | Exposes the completed approval service through the selected read and write boundaries. |
| 14 | `IFC-V1-045` Implement exact active-turn interrupt API and CLI command | ready | none | Exposes the completed exact-turn interrupt service through the selected write gate. |
| 15 | `IFC-V1-049` Enforce operation idempotency and concurrency limits | ready | none | Hardens duplicate and concurrent selected writes before aggregate production composition. |
| 16 | `INT-V1-007` Implement runtime process/socket supervision | ready | none | The accepted structured vertical now permits explicit foreground/service ownership work, but it is behind the requested physical-phone path. |
| 17 | `FE-V1-004` Rebase the mobile structured-state matrix | ready | none | Accepted real states now permit the mobile-first design-contract rebaseline; screen implementation and mockups remain later gated work. |
| 18 | `IFC-V1-035` Add bounded subscriber queues and revoke/disconnect/archive cleanup | ready | none | Exact active and opening-stream revoke is complete; bounded aggregate subscriber ownership is now unblocked behind the requested physical-phone path. |

## Intentional Blockers

| Gate | Owner | Blocker | Unblocks |
| --- | --- | --- | --- |
| Physical security matrix | `IFC-V1-033` | Aggregate injection plus real-browser/device evidence and inspection remain | Physical phone security acceptance and downstream production composition. |
| Mobile visual direction | Reopened `FE-V1-002`, `FE-V1-003` | Real state matrix, two replacement options, human selection | React screen implementation. |
| Release | `REL-V1-010` | All module hardening, clean package/service/phone/security evidence, human acceptance | V1 release and V2 planning. |

## Status Vocabulary

- `ready`: all task dependencies are done and scope/evidence are executable.
- `todo`: defined and ordered behind unfinished task dependencies.
- `blocked`: requires human choice, physical device/account/certificate, or external state beyond task dependencies.
- `in_progress`: active work.
- `done`: current wording and evidence are complete.
- `deferred`: explicitly outside V1.
