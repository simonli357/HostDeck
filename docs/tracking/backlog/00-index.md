# Backlog Index

Execution map for the rebaselined V1. Detailed leaf tasks live in group files; required outcomes live in `docs/planning/05-blocks/`.

## Program Areas

| Program area | Block | Group file | Active epics | Prefix |
| --- | --- | --- | --- | --- |
| Foundation / Contracts | `BLK-V1-01` | `foundation.md` | Planning integrity; normalized app-server/mobile/security contracts; invariant hardening | `FND-V1-*` |
| Data / Local State | `BLK-V1-02` | `local-state-auth-audit.md` | Mapping/projection migration; secure paths/lease; production retention/audit; auth/CSRF | `DAT-V1-*` |
| Integrations / Codex Runtime | `BLK-V1-03` | `tmux-output.md` | Compatibility/schema; IPC adapter; real structured vertical; supervision/restart; legacy disposition | `INT-V1-*` |
| Interface / API And CLI | `BLK-V1-04` | `api-cli-control-plane.md` | HTTPS; Fastify/SSE; auth; fanout/health; selected runtime operations; resource bounds; package/services | `IFC-V1-*` |
| Frontend / Mobile Dashboard | `BLK-V1-05` | `web-dashboard.md` | Mobile state rebaseline; replacement visual gate; screens/controls/approval; responsive/fidelity | `FE-V1-*` |
| Release / Hardening | `BLK-V1-06` | `hardening-release.md` | System rebaseline; module gates; security/privacy; clean release; go/no-go | `REL-V1-*` |

The `tmux-output.md` filename is retained temporarily so historical artifact links remain stable. Its active scope is Codex app-server runtime integration.

## Critical Dependency Graph

| Predecessor | Enables | Reason |
| --- | --- | --- |
| `REL-V1-011` audit/rebaseline | Current selected-path execution | Owner docs, block truth, and no-go state must be corrected first. |
| `FND-V1-014` planning checker | Every ready/completion claim | Graph/trace/queue drift becomes executable failure. |
| `FND-V1-015` normalized contracts | `FND-V1-016`, `DAT-V1-018`, `INT-V1-003`, `IFC-V1-016` | Storage/adapter/API need stable HostDeck types. |
| `FND-V1-016` invariant hardening | New module hardening and consumers | Fixes timestamp/cursor/transition/target/outcome defects before propagation. |
| `INT-V1-003` compatibility gate | `INT-V1-004` | IPC broker cannot accept an undefined protocol/version policy. |
| `INT-V1-004` IPC adapter | `INT-V1-005` | Thread lifecycle consumes a tested transport/broker. |
| `DAT-V1-018` mapping migration | `INT-V1-005`, `DAT-V1-020` | Real threads need durable recoverable mapping/projection. |
| `INT-V1-005` thread/TUI lifecycle | `INT-V1-006` | Real turns/controls need stable thread identity and attach path. |
| `INT-V1-006` real vertical | `INT-V1-007`, `IFC-V1-019`, `FE-V1-004` | Event/control/approval semantics must be observed, not invented downstream. |
| `INT-V1-007` supervision/restart | `INT-V1-008`, `INT-V1-091`, `IFC-V1-018` | Selected runtime lifecycle must be proven before legacy removal/hardening. |
| `INT-V1-008`, `INT-V1-091` | Selected integration completion | One production runtime remains with strict evidence. |
| `IFC-V1-015` HTTPS spike | `DAT-V1-021`, `IFC-V1-017`, `FE-V1-013`, `REL-V1-005` | Certificate/browser policy drives auth and release proof. |
| `DAT-V1-019` secure paths/lease | `INT-V1-007`, `IFC-V1-021` | Production processes need safe ownership and duplicate prevention. |
| `DAT-V1-020`, `DAT-V1-021` | `IFC-V1-017` to `IFC-V1-019` | Production interface needs complete retention/audit/auth storage semantics. |
| `IFC-V1-016` Fastify/SSE | `IFC-V1-017`, `IFC-V1-018` | Security and fanout integrate into the selected server lifecycle. |
| `IFC-V1-017` auth + `IFC-V1-018` fanout | `IFC-V1-019`, `IFC-V1-020` | Selected operations require protected bounded transport. |
| `IFC-V1-019` selected runtime operations | `IFC-V1-020`, frontend API consumers | Exposes real controls/approvals rather than tmux handlers. |
| `IFC-V1-020`, `IFC-V1-021`, `IFC-V1-091` | Production interface completion | Resource/package/service hardening. |
| `FE-V1-004` state rebaseline | Reopened `FE-V1-002` | New mockups must use real mobile/structured states. |
| Reopened `FE-V1-002` | Human `FE-V1-003` | Two complete alternatives precede selection. |
| Human `FE-V1-003` plus production API | `FE-V1-010` to `FE-V1-022` | UI implementation gate. |
| UI implementation | `FE-V1-016` to `FE-V1-018`, `FE-V1-090` | Responsive/fidelity/copy/module hardening. |
| All module hardening | `REL-V1-004` to `REL-V1-010` | Release proof uses selected production path. |

## Requirement Trace Ownership

Exact requirement-to-task rows live in `docs/planning/02-requirements.md` and are checked by `pnpm check:planning`.

| Requirement set | Primary backlog owners |
| --- | --- |
| `FR-001` to `FR-018` | Foundation contracts, Codex runtime, API/CLI, dashboard according to trace rows. |
| `NFR-001` to `NFR-013` | Cross-block hardening with aggregate release proof. |
| `IR-001` to `IR-012` | Frontend plus API/security state providers. |
| `DR-001` to `DR-011` | Data/local state plus adapter event sources. |
| `PR-001` to `PR-012` | Runtime, interface/package, frontend device, and release tasks. |
| `SFR-001` to `SFR-018` | Data auth/audit, interface security/resources, frontend safety states, release review. |

## Ready-State Rules

- `ready`: every task id in `Blocked by` is `done`, external requirements are available, and scope/evidence need no new decision.
- `todo`: defined but ordered behind unfinished task dependencies.
- `blocked`: cannot progress because of a human decision, physical device/account/certificate, or external-state dependency not represented by a task.
- `in_progress`: exactly the currently owned active task; use sparingly.
- `done`: success criteria and evidence are complete for the current task wording.
- `deferred`: explicitly outside V1.

A completed task retains its real historical dependencies. Completion does not rewrite `Blocked by` to `none`.

## Quality Gates

- Every leaf row has status, block and requirement refs, `Requires`, real `Blocked by`, `Blocks`, bounded description, measurable criteria, and evidence.
- Every requirement id is covered by one or more defined task ids; no unknown task/requirement reference exists.
- Dependency graph is acyclic; `ready` dependencies are done; no task blocks itself.
- Current queue lists only in-progress/ready tasks and intentional external/human blockers.
- Module hardening, UI fidelity, security/privacy, package/service, clean setup, device, and go/no-go tasks exist.
- Superseded evidence is labeled historical/legacy and cannot complete the selected block.
- Planning checks run in normal validation and fail loudly.
