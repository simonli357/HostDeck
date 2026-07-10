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
| `BLK-V1-01` Contracts, core, fixtures | Stable normalized HostDeck contracts for app-server threads/turns/events/approvals/controls, strict invariants, deterministic fixtures, and planning integrity validation. | `FR-002`, `FR-006` to `FR-009`, `FR-012` to `FR-017`, `NFR-003`, `NFR-005` to `NFR-007`, `SFR-005`, `SFR-010`, `SFR-011` | Rebaselined planning | `foundation.md` | Complete |
| `BLK-V1-02` Local state, auth, audit | Durable app-server mappings/projections, compatibility state, production retention, CSRF/device lifecycle, audit outcomes, permissions, and one-daemon lease. | `DR-001` to `DR-011`, `NFR-008`, `NFR-010`, `NFR-011`, `NFR-013`, `SFR-006`, `SFR-007`, `SFR-014` to `SFR-016` | `BLK-V1-01` | `local-state-auth-audit.md` | Reopened |
| `BLK-V1-03` Codex runtime and events | Private app-server runtime, version/schema gate, IPC adapter, real thread/turn/control/approval/events, TUI resume, restart/multi-client behavior, and legacy tmux disposition. | `FR-001`, `FR-003` to `FR-009`, `FR-013` to `FR-018`, `NFR-002`, `NFR-012`, `PR-001`, `PR-006`, `PR-010` | `BLK-V1-01`, storage mapping work | `tmux-output.md` | In progress |
| `BLK-V1-04` Host API, security, CLI | Fastify API/SSE/static production path, HTTPS LAN, authorization/CSRF/rate/origin controls, runtime orchestration/health, runnable CLI/build, and user services. | `FR-011`, `FR-012`, `FR-018`, `NFR-001`, `NFR-009` to `NFR-011`, `PR-002` to `PR-004`, `PR-007` to `PR-012`, `SFR-001` to `SFR-008`, `SFR-012` to `SFR-018` | `BLK-V1-01` to `BLK-V1-03` | `api-cli-control-plane.md` | Reopened |
| `BLK-V1-05` Mobile dashboard | Approved mobile-first design and implemented Mission Control, Session Detail, structured controls/approvals, trust/failure states, accessibility, screenshots, and real-phone evidence. | `FR-002`, `FR-005` to `FR-010`, `FR-016`, `IR-001` to `IR-012`, `NFR-004`, `PR-005` | Stable contracts/API plus visual selection | `web-dashboard.md` | Reopened |
| `BLK-V1-06` Hardening and release | Clean Ubuntu package/service install, security/privacy, browser/phone/real-Codex/aggregate validation, support docs, completion matrix, and explicit go/no-go. | All NFR/platform/safety release gates | `BLK-V1-01` to `BLK-V1-05` | `hardening-release.md` | In progress |

## Completion Matrix

| Block | Historical evidence retained | New blocking evidence | Minimum level | Status |
| --- | --- | --- | --- | --- |
| `BLK-V1-01` | `FND-V1-001` to `FND-V1-013`, prior foundation artifacts. | `FND-V1-014` to `FND-V1-016`, `FND-V1-091`; selected fixtures/public exports and generated-import guard pass. | L1/L2 | Complete; normalized contract/core/fixture boundary hardened. |
| `BLK-V1-02` | `DAT-V1-001` to `DAT-V1-017`, `DAT-V1-090`, prior storage artifacts. | `DAT-V1-018` to `DAT-V1-021`, `DAT-V1-091`; production invocation and permission/lease proof. | L1/L2/L3 inspection | Reopened by mapping/auth/audit/retention ownership changes. |
| `BLK-V1-03` | Tmux artifacts `INT-V1-001`, `INT-V1-010` to `INT-V1-016`, `INT-V1-090`. | `INT-V1-002` to `INT-V1-008`, `INT-V1-091`; real Codex vertical and TUI/restart evidence. | L2/L3 | In progress; binding/compatibility gate done, IPC and real vertical absent. |
| `BLK-V1-04` | `IFC-V1-001` to `IFC-V1-014`, `IFC-V1-090`, prior headless/custom-listener artifacts. | `IFC-V1-015` to `IFC-V1-021`, `IFC-V1-091`; production Fastify/HTTPS/SSE/package/service proof. | L2/L3/L4 | Reopened; current CLI is source-only and LAN is unsafe. |
| `BLK-V1-05` | `FE-V1-001` fixture helpers and rejected `FE-V1-002` boards. | `FE-V1-004`, reopened `FE-V1-002`, human `FE-V1-003`, implementation `FE-V1-010` to `FE-V1-022`, `FE-V1-090`. | L1/L3/L4 | Reopened; no approved target or implemented UI. |
| `BLK-V1-06` | `REL-V1-001` to `REL-V1-003` and baseline audit commands. | `REL-V1-011`, all module gates, clean install/phone/security/aggregate/go-no-go tasks. | L4 | In progress; release no-go. |

## Cross-Block Gates

| Gate | Requires | Enables |
| --- | --- | --- |
| Planning integrity | `REL-V1-011`, `FND-V1-014` | Reliable execution queue and traceability. |
| Structured contract gate | `FND-V1-015`, `FND-V1-016` | Adapter/storage/API implementation. |
| Real Codex gate | `INT-V1-003` to `INT-V1-007` | Legacy decision, production interface, mobile state/mockups. |
| LAN security gate | `IFC-V1-015` | LAN/auth UI and release phone smoke. |
| Visual gate | `FE-V1-004`, `FE-V1-002`, human `FE-V1-003` | React screen implementation. |
| Module hardening | `FND-V1-091`, `DAT-V1-091`, `INT-V1-091`, `IFC-V1-091`, `FE-V1-090` | Aggregate release validation. |
| Release gate | Security/privacy, clean install/service, real Codex, browser/phone, docs, aggregate validation | Human go/no-go. |

## Completion Rule

`REL-V1-008` may mark a block complete only when this matrix links current selected-path evidence, all blocking leaf tasks are done, validation gaps are explicit and approved, and `pnpm check:planning` passes. Historical evidence alone cannot restore completion after a block is reopened.
