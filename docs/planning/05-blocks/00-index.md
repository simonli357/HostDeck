# V1 Capability Blocks

Owns the required V1 capability map and completion truth between global planning and leaf tasks.

## Rules

- A block is complete only when its required production outcome and evidence level are met.
- Historical task evidence remains linked after a rebaseline but does not complete a changed outcome.
- Every requirement maps to at least one block and executable leaf task in `02-requirements.md`.
- Every block has foundation, integration, hardening, and release evidence appropriate to its risk.
- Completion status is one of `reopened`, `in progress`, `blocked`, or `complete`; qualified phrases such as "complete for owned scope" are not release truth.

## Block Map

| Block | Required outcome | Primary requirements | Depends on | Backlog | Status |
| --- | --- | --- | --- | --- | --- |
| `BLK-V1-01` Contracts, core, fixtures | Stable normalized HostDeck contracts for app-server threads/turns/events/approvals/controls, native thread adoption, and remote ingress/access state, strict invariants, deterministic fixtures, and planning integrity validation. | `FR-002`, `FR-006` to `FR-009`, `FR-012` to `FR-021`, `NFR-003`, `NFR-005` to `NFR-007`, `SFR-005`, `SFR-010` to `SFR-012`, `SFR-015` | Rebaselined planning, exact adoption spike, and remote-ingress spike | `foundation.md` | Reopened |
| `BLK-V1-02` Local state, auth, audit | Durable started/adopted mappings/projections, atomic unmanage, compatibility and remote-ingress state, production retention, CSRF/device lifecycle, audit outcomes, permissions, and one-daemon lease. | `FR-020`, `FR-021`, `DR-001` to `DR-011`, `NFR-008`, `NFR-010`, `NFR-011`, `NFR-013`, `PR-009`, `SFR-006`, `SFR-007`, `SFR-014` to `SFR-016` | `BLK-V1-01` | `local-state-auth-audit.md` | Reopened |
| `BLK-V1-03` Codex runtime and events | Private app-server runtime, version/schema gate, IPC adapter, new and adopted thread lifecycle, bounded adoption history, real turn/control/approval/events, TUI resume, restart/multi-client behavior, and legacy tmux disposition. | `FR-001`, `FR-003` to `FR-009`, `FR-013` to `FR-021`, `NFR-002`, `NFR-012`, `PR-001`, `PR-006`, `PR-010` | `BLK-V1-01`, storage mapping work | `tmux-output.md` | Reopened |
| `BLK-V1-04` Host API, security, CLI | Loopback Fastify API/SSE/static production path, Tailscale profile/Serve remote HTTPS, authorization/CSRF/rate/origin/proxy controls, real runtime compatibility diagnostics, runnable CLI/build, and user services. | `FR-011`, `FR-012`, `FR-017`, `FR-018`, `IR-006`, `IR-008`, `NFR-001`, `NFR-002`, `NFR-005`, `NFR-009` to `NFR-012`, `PR-002` to `PR-005`, `PR-007` to `PR-012`, `SFR-001` to `SFR-008`, `SFR-012` to `SFR-018` | `BLK-V1-01` to `BLK-V1-03` | `api-cli-control-plane.md` | Reopened |
| `BLK-V1-05` Mobile dashboard | Approved mobile-first design and implemented Mission Control, Session Detail, structured controls/approvals, trust/failure states, accessibility, screenshots, and real-phone evidence. | `FR-002`, `FR-005` to `FR-010`, `FR-016`, `IR-001` to `IR-012`, `NFR-004`, `PR-005` | Stable contracts/API plus selected Focus Rail targets | `web-dashboard.md` | Reopened |
| `BLK-V1-06` Hardening and release | Clean native package/lifecycle install, security/privacy, browser/phone/real-Codex/aggregate validation, support docs, completion matrix, and explicit go/no-go. | All NFR/platform/safety release gates | `BLK-V1-01` to `BLK-V1-05`, `BLK-V1-07` | `hardening-release.md` | In progress |
| `BLK-V1-07` Cross-platform distribution | Native Ubuntu/Windows paths, local Codex transport, lifecycle, packages, signing, updates, rollback, publication, and clean-host evidence. | `NFR-009`, `NFR-013`, `NFR-014`, `PR-001`, `PR-002`, `PR-007` to `PR-010`, `PR-012` to `PR-018`, `SFR-015` | Shared behavior in `BLK-V1-01` to `BLK-V1-05` | `cross-platform-distribution.md` | In progress |

## Completion Matrix

| Block | Historical evidence retained | New blocking evidence | Minimum level | Status |
| --- | --- | --- | --- | --- |
| `BLK-V1-01` | `FND-V1-001` to `FND-V1-018`, `FND-V1-091`, `FND-V1-092`, prior foundation artifacts. | `FND-V1-102`; native adoption/unmanage contracts, fixtures, public exports, and privacy invariants. | L1/L2 | Reopened pending `FND-V1-102`. |
| `BLK-V1-02` | `DAT-V1-001` to `DAT-V1-032`, `DAT-V1-090` to `DAT-V1-092`, prior storage artifacts. | `DAT-V1-105`; atomic adoption bootstrap/unmanage, audit migration, failure/restart/privacy evidence. | L1/L2/L3 inspection | Reopened pending `DAT-V1-105`. |
| `BLK-V1-03` | Tmux artifacts `INT-V1-001`, `INT-V1-010` to `INT-V1-016`, `INT-V1-090`; selected runtime through `INT-V1-091`. | `INT-V1-106` to `INT-V1-109`; exact native discovery/adoption/resume/unmanage and interoperability hardening. | L2/L3 | Reopened pending native session interoperability evidence. |
| `BLK-V1-04` | `IFC-V1-001` to `IFC-V1-032`, `IFC-V1-034`, `IFC-V1-047`, `IFC-V1-053` to `IFC-V1-058`, `IFC-V1-070` to `IFC-V1-079`, `IFC-V1-086`, `IFC-V1-087`, `IFC-V1-090`, and prior headless/Fastify/direct-LAN artifacts. | `IFC-V1-091`; aggregate interface hardening. | L2/L3/L4 | Reopened pending formal `REL-V1-008` matrix closure; all selected interface implementation and hardening evidence now passes at `artifacts/ifc-v1-091-selected-production-interface-hardening.md` and directory. |
| `BLK-V1-05` | `FE-V1-001` fixture helpers and rejected legacy boards. | Completed `FE-V1-002` to `FE-V1-004`, `FE-V1-010` to `FE-V1-018`, `FE-V1-019` to `FE-V1-040`, and `IFC-V1-053`; remaining `FE-V1-090`. | L1/L3/L4 | Reopened; Focus Rail, the complete production dashboard behavior, packaged assets, responsive layout, semantic accessibility, selected-target fidelity, copy/workflow review, focused physical phone evidence, and exact Chromium/Firefox phone/desktop package coverage pass. Aggregate phone module acceptance remains. |
| `BLK-V1-06` | `REL-V1-001` to `REL-V1-003`, `REL-V1-011`, `REL-V1-012`, and baseline audit commands. | All module gates, clean install/remote-phone/profile/security/aggregate/go-no-go tasks. | L4 | In progress; release no-go. |
| `BLK-V1-07` | Current Linux package/service/clean-user evidence is retained as the Linux behavioral baseline. | `REL-V1-100`, `FND-V1-100` to `FND-V1-101`, `DAT-V1-100` to `DAT-V1-104`, `INT-V1-100` to `INT-V1-105`, `IFC-V1-100` to `IFC-V1-109`, `REL-V1-101` to `REL-V1-108`. | L1/L2/L3/L4 native | In progress; planning is complete, implementation and native Windows evidence remain. |

## Cross-Block Gates

| Gate | Requires | Enables |
| --- | --- | --- |
| Planning integrity | `REL-V1-011`, `FND-V1-014`, `FND-V1-017` | Reliable executable leaf queue and traceability. |
| Structured contract gate | `FND-V1-015`, `FND-V1-016` | Adapter/storage/API implementation. |
| Real Codex gate | `INT-V1-003` to `INT-V1-008`, `INT-V1-017` to `INT-V1-032` | Legacy decision, production interface, mobile state/mockups. |
| Remote ingress gate | `REL-V1-012`, `IFC-V1-070`, `FND-V1-018`, `DAT-V1-031`, `DAT-V1-032` | Profile-safe Tailscale implementation, remote/auth UI, and release phone smoke. |
| Visual gate | Completed `FE-V1-004`, `FE-V1-002`, `FE-V1-003`; Focus Rail under `DEC-028` | React screen implementation. |
| Module hardening | `FND-V1-092`, `DAT-V1-092`, `INT-V1-091`, `IFC-V1-091`, `FE-V1-090` | Aggregate release validation. |
| Native distribution gate | `BLK-V1-07` contracts, native packages/lifecycle, clean Ubuntu/Windows, signing and publication evidence | Cross-platform aggregate release validation. |
| Native session interoperability | `INT-V1-106`, `FND-V1-102`, `DAT-V1-105`, `INT-V1-107` to `INT-V1-109`, `IFC-V1-110` | Same persisted thread can move between native Codex, HostDeck phone control, and shared TUI without transcript copy or destructive conversion. |
| Release gate | Security/privacy, clean install/service, real Codex, browser/phone, native distribution, docs, aggregate validation | Human go/no-go. |

## Completion Rule

`REL-V1-008` may mark a block complete only when this matrix links current selected-path evidence, all blocking leaf tasks are done, validation gaps are explicit and approved, and `pnpm check:planning` passes. Historical evidence alone cannot restore completion after a block is reopened.
