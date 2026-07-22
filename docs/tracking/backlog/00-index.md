# Backlog Index

Execution map for the rebaselined V1. Detailed leaf tasks live in group files; required outcomes live in `docs/planning/05-blocks/`.

## Program Areas

| Program area | Block | Group file | Active epics | Prefix |
| --- | --- | --- | --- | --- |
| Foundation / Contracts | `BLK-V1-01` | `foundation.md` | Planning integrity; normalized app-server/mobile/security/remote-ingress contracts; invariant hardening | `FND-V1-*` |
| Data / Local State | `BLK-V1-02` | `local-state-auth-audit.md` | Mapping/projection migration; secure paths/lease; production retention/audit; auth/CSRF; remote config/audit | `DAT-V1-*` |
| Integrations / Codex Runtime | `BLK-V1-03` | `tmux-output.md` | Compatibility/schema; IPC adapter; real structured vertical; supervision/restart; legacy disposition | `INT-V1-*` |
| Interface / API And CLI | `BLK-V1-04` | `api-cli-control-plane.md` | Loopback Fastify/SSE; Tailscale profile/Serve ingress; app auth; fanout/health; selected operations; resource bounds; package/services | `IFC-V1-*` |
| Frontend / Mobile Dashboard | `BLK-V1-05` | `web-dashboard.md` | Mobile remote-state rebaseline; replacement visual gate; screens/controls/approval; responsive/fidelity | `FE-V1-*` |
| Release / Hardening | `BLK-V1-06` | `hardening-release.md` | System/remote rebaseline; module gates; security/privacy; clean remote-phone release; go/no-go | `REL-V1-*` |

The `tmux-output.md` filename is retained temporarily so historical artifact links remain stable. Its active scope is Codex app-server runtime integration.

## Critical Dependency Graph

| Predecessor | Enables | Reason |
| --- | --- | --- |
| `REL-V1-011` audit/rebaseline | Current selected-path execution | Owner docs, block truth, and no-go state must be corrected first. |
| `REL-V1-012` remote-access rebaseline | `IFC-V1-070` and selected remote-path execution | Cross-network intent, loopback/Serve architecture, profile isolation, changed block truth, and no-go state are fixed before probing or implementation. |
| `FND-V1-014` planning checker | `FND-V1-017` and every ready/completion claim | Graph/trace/queue drift becomes executable failure. |
| `FND-V1-015` normalized contracts | `FND-V1-016`, `DAT-V1-018`, `INT-V1-003`, `IFC-V1-016` | Storage/adapter/API need stable HostDeck types. |
| `FND-V1-016` invariant hardening | New module hardening and consumers | Fixes timestamp/cursor/transition/target/outcome defects before propagation. |
| `FND-V1-017` leaf-granularity audit | `DAT-V1-020`, `DAT-V1-021`, `DAT-V1-023`, `INT-V1-006`, `INT-V1-007`, `IFC-V1-016` to `IFC-V1-021`, `FE-V1-013`, `FE-V1-019` | Selected execution resumes only after every former rollup has a handoff-sized owner and dependency/evidence route. |
| `INT-V1-003` compatibility gate | `INT-V1-004` | IPC broker cannot accept an undefined protocol/version policy. |
| `INT-V1-004` IPC adapter | `INT-V1-005` | Thread lifecycle consumes a tested transport/broker. |
| `DAT-V1-018` mapping migration | `INT-V1-005`, `DAT-V1-020` | Real threads and projected events need durable recoverable identity. |
| `INT-V1-005` thread/TUI lifecycle | `INT-V1-006` | Semantic probes need stable managed-thread identity and exact attach behavior. |
| `DAT-V1-020` production append | `DAT-V1-022`, `INT-V1-017`, `IFC-V1-018` | Normalization and live publication consume committed projection truth only. |
| `DAT-V1-023` audit state machine | `DAT-V1-024`, `DAT-V1-027`, `DAT-V1-030`, `IFC-V1-032`, `IFC-V1-049`, `IFC-V1-066` | Every production mutation and recovery path needs accepted-to-terminal truth. |
| `IFC-V1-070` Tailscale spike | `FND-V1-018`, `IFC-V1-071`, `IFC-V1-073` | Exact saved-profile, Serve, proxy-header, SSE, permission, phone, and noninterference behavior is observed before contracts or code. |
| `FND-V1-018` remote contracts | `DAT-V1-031`, `DAT-V1-032`, `IFC-V1-071`, `IFC-V1-073`, `IFC-V1-075`, `FE-V1-004` | Storage, adapter, trust, manifest, and UI consume one normalized remote state model. |
| `DAT-V1-031`, `DAT-V1-032`, `IFC-V1-071` | `IFC-V1-072`, then `IFC-V1-076` | Serve ownership and remote commands require durable config/audit plus a bounded observer. |
| `IFC-V1-073`, `IFC-V1-074` | `IFC-V1-077` | External-origin/proxy/source trust precedes fragment-safe QR pairing. |
| `IFC-V1-072` to `IFC-V1-077` plus generic lifecycle | `IFC-V1-078`, then `IFC-V1-079` | Selected ingress composition precedes hostile and physical cellular/profile-switch acceptance. |
| `DAT-V1-021` CSRF storage | `DAT-V1-025` to `DAT-V1-029` | Device list, last-used, pairing, revoke, and security audit storage extend one hash-only generation model. |
| `DAT-V1-022`, `DAT-V1-023` | `DAT-V1-024`, then `DAT-V1-030` | Startup retention and orphan accepted-operation reconciliation have separate bounded owners. |
| `DAT-V1-025` to `DAT-V1-029` | `IFC-V1-026` to `IFC-V1-032`, `IFC-V1-059`; selected remote adaptation `IFC-V1-074`, `IFC-V1-077` | Browser security routes consume completed device/pairing/revoke/audit storage; deferred `IFC-V1-033` is historical only. |
| `INT-V1-006` exact semantic spike | `INT-V1-017` to `INT-V1-026` | Event/control/approval behavior must be observed for the pinned runtime before implementation. |
| `INT-V1-019` pending model control | `INT-V1-020`, `INT-V1-021` | Goal activation needs the unapplied-setting guard; Plan composition needs the exact pending model contract. |
| `INT-V1-019`, `INT-V1-021` | `INT-V1-018` | The normal prompt dispatcher must atomically compose and settle pending model/Plan settings. |
| `INT-V1-017` to `INT-V1-026` | `INT-V1-027` | The real structured vertical assembles already-implemented exact operation ports. |
| `INT-V1-027` real structured vertical | `INT-V1-007`, `IFC-V1-066`, selected operation routes, `FE-V1-004` | Runtime supervision, exact write dispatch, and mobile states require accepted real semantics. |
| `DAT-V1-019`, `INT-V1-027` | `INT-V1-007` | Process/socket supervision needs secure ownership and an accepted adapter vertical. |
| `INT-V1-007` supervisor | `INT-V1-028` to `INT-V1-031` | Reconnect, crash, HostDeck restart, and TUI coexistence consume explicit process ownership. |
| `DAT-V1-030`, `INT-V1-028` to `INT-V1-031` | `INT-V1-032` | Aggregate lifecycle acceptance includes durable incomplete/boundary recovery. |
| `INT-V1-032` lifecycle acceptance | `INT-V1-008`, `IFC-V1-036`, `IFC-V1-037` | Legacy disposition and mutable host lifecycle wait for accepted restart behavior. |
| `INT-V1-008` legacy removal | `INT-V1-091` selected-runtime hardening | The executable tmux path is gone; aggregate hardening now closes the only production runtime. |
| `IFC-V1-016` Fastify stack spike | `IFC-V1-020`, then `IFC-V1-022` to `IFC-V1-025` | Exact dependencies are selected first; resource units/defaults/deadline ownership freeze before server implementation. |
| `IFC-V1-020` resource contract | App/SSE/lifecycle implementations and `IFC-V1-047` to `IFC-V1-052` | No transport or client invents its own larger limit, unit, timeout, or cancellation extension. |
| `IFC-V1-022` typed app factory | `IFC-V1-017`, `IFC-V1-019`, `IFC-V1-023` to `IFC-V1-025`, `IFC-V1-032` | Security, route manifest, SSE, static, lifecycle, and audit ports share one validation/error policy. |
| `INT-V1-006`, `IFC-V1-022` | `IFC-V1-019` route manifest | Route implementation waits for observed operation semantics and one typed app boundary. |
| `IFC-V1-017`, `DAT-V1-025` to `DAT-V1-029`, `IFC-V1-019`, `IFC-V1-032` | `IFC-V1-026` to `IFC-V1-031`, `IFC-V1-059` | Reusable cookie, CSRF, pair/device/revoke, lock, and historical network controls consume one trust, route, and audit model. Selected remote adaptation is owned by `IFC-V1-073` to `IFC-V1-077`. |
| `DAT-V1-023`, `INT-V1-027`, `IFC-V1-019`, `IFC-V1-026`, `IFC-V1-027`, `IFC-V1-030`, `IFC-V1-032` | `IFC-V1-066` exact write gate | Selected mutations share one ordered target/auth/lock/audit/dispatch boundary. |
| `DAT-V1-020`, `INT-V1-017`, `IFC-V1-023`, `IFC-V1-020` | `IFC-V1-018`, then `IFC-V1-034` to `IFC-V1-038` | Fanout begins only with committed events, resource bounds, and a proven SSE transport; replay, queues, health, and shutdown remain separate leaves. |
| `IFC-V1-019`, `IFC-V1-075`, `IFC-V1-066`, exact runtime/repository/read ports | `IFC-V1-039` to `IFC-V1-045`, `IFC-V1-059` to `IFC-V1-065`, `IFC-V1-068`, `IFC-V1-069`, `IFC-V1-076` | Each API/CLI operation or read family is an independently testable route leaf with one target and owner; selected network controls are remote-only. |
| Remote security/physical acceptance `IFC-V1-079`, exact write gate, and fanout/lifecycle leaves | `IFC-V1-046` | Remote security and stream acceptance precede selected production composition; deferred `IFC-V1-033` is not a gate. |
| `IFC-V1-020` plus assembled HTTP/SSE/operation/CLI boundaries | `IFC-V1-047` to `IFC-V1-052` | Enforcement and aggregate stress prove the already-frozen resource/deadline contract. |
| `IFC-V1-046` selected API/CLI acceptance | `IFC-V1-067` legacy-listener disposition | Destructive cleanup follows accepted selected behavior and has separate evidence. |
| `DAT-V1-019`, `DAT-V1-025`, `IFC-V1-024`, `IFC-V1-025`, `IFC-V1-038`, `IFC-V1-046`, `IFC-V1-052`, `IFC-V1-067` | `IFC-V1-021`, `IFC-V1-054`, `IFC-V1-055`, and `IFC-V1-080` to `IFC-V1-086` are complete; `FE-V1-010` now establishes the source shell and advances the client/UI/assets chain before `IFC-V1-053` and `IFC-V1-056` to `IFC-V1-058` | Deterministic outputs now include the selected grammar, API/local commands, resources, application, foreground/service lifecycles, executable, and exact user units. Real dashboard assets, persistent service lifecycle/install, uninstall, and clean parity remain separate leaves. |
| `IFC-V1-058`, `IFC-V1-079`, `IFC-V1-091` | Production interface completion | Clean packaged parity, remote physical proof, and module hardening close the block. |
| `FE-V1-004` state rebaseline | Reopened `FE-V1-002` | New mockups must use real mobile/structured/remote-profile states. |
| Reopened `FE-V1-002` | Human `FE-V1-003` | Two complete alternatives precede selection. |
| Completed `FE-V1-003`, `IFC-V1-046`, `FE-V1-010`, bounded JSON/SSE clients `FE-V1-019`/`FE-V1-023`, in-memory CSRF `FE-V1-024`, and coordinator `FE-V1-025` | Ready `FE-V1-011`, `FE-V1-012`, and `FE-V1-013` | The approved phone targets and completed route-backed clients now unblock the default inventory, detail feed, and access/pairing screen groups. |
| Coordinated typed clients | `FE-V1-011` to `FE-V1-015`, `FE-V1-020` to `FE-V1-038` | Screens and actions consume shared exact state instead of owning transport guesses; Mission Control precedes detail and access implementation in the current queue. |
| Complete UI states/actions | `FE-V1-016`, `FE-V1-039`, `FE-V1-040`, then `FE-V1-017`, `FE-V1-018`, `FE-V1-090` | Responsive, accessibility, browser, fidelity, copy, and module hardening follow implementation. |
| `FND-V1-092`, `DAT-V1-092`, `INT-V1-091`, `IFC-V1-091`, `FE-V1-090` | `REL-V1-004` to `REL-V1-010` | Release proof uses only the selected remote production path. |

## Requirement Trace Ownership

Exact requirement-to-task rows live in `docs/planning/02-requirements.md` and are checked by `pnpm check:planning`.

The trace table is the canonical V1 completion chain. A task card may cite additional requirements as local design/test context; those contextual refs do not add an execution dependency unless the canonical trace or `Blocked by` graph names it.

| Requirement set | Primary backlog owners |
| --- | --- |
| `FR-001` to `FR-018` | Foundation contracts, Codex runtime, API/CLI, dashboard according to trace rows. |
| `NFR-001` to `NFR-013` | Cross-block hardening with aggregate release proof. |
| `IR-001` to `IR-012` | Frontend plus API/security state providers. |
| `DR-001` to `DR-011` | Data/local state plus adapter event sources. |
| `PR-001` to `PR-012` | Runtime, interface/package, frontend device, and release tasks. |
| `SFR-001` to `SFR-018` | Data auth/audit, interface security/resources, frontend safety states, release review. |

## Ready-State Rules

- `Blocked by` is the complete authoritative execution dependency set and is parsed by `pnpm check:planning`.
- `Blocks` is a concise downstream-impact index, not an exhaustive reverse-edge mirror; it may name major gates/ranges but cannot determine readiness.
- `ready`: every task id in `Blocked by` is `done`, external requirements are available, and scope/evidence need no new decision.
- `todo`: defined but ordered behind unfinished task dependencies.
- `blocked`: cannot progress because of a human decision, physical device/account/consent, or external-state dependency not represented by a task.
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
