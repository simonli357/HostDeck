# Delivery Plan

Owns milestone, module maturity, production passes, and release truth.

## Snapshot

- Current pass: selected foundation contracts and blocking HTTPS phone spike.
- Current milestone: M1 Selected foundation.
- Release state: no-go; selected production path is not implemented.
- Next exit: normalized contracts/invariants, compatibility/IPC foundation, and secure state migration are executable.

## Milestones

| Milestone | Scope | Exit | Status |
| --- | --- | --- | --- |
| M0 Rebaseline | Audit prior direction/evidence; select app-server/mobile/HTTPS path; repair requirements, blueprint, blocks, tasks, queue, planning checker. | Owner docs agree, `pnpm check:planning` passes, selected-path leaf graph is executable. | Complete |
| M1 Selected foundation | Normalized contracts/invariants; mapping/projection/auth/permissions/retention migrations; Codex compatibility and IPC adapter. | `FND-V1-091`, data foundation tasks, adapter handshake/broker pass. | Planned |
| M2 Real structured vertical | Real thread start/resume, prompt/events/status, controls, approval, interrupt, TUI multi-client, reconnect/restart; legacy disposition. | `INT-V1-091` with L3 real-Codex artifact. | Planned |
| M3 Production host interface | HTTPS phone enrollment, Fastify/SSE/static, auth/rate/origin/CSRF, fanout/health/shutdown, selected API/CLI, bounds, build/user services. | `IFC-V1-091`, clean production-path smoke. | Planned |
| M4 Mobile dashboard | Rebased state matrix, two mobile options, human selection, complete screens/controls/approval/trust states, responsive/accessibility/fidelity, phone proof. | `FE-V1-090` with screenshots and L4 device artifact. | Planned |
| M5 Release hardening | Security/privacy, clean Ubuntu package/service/real-Codex/browser/phone, docs, aggregate validation, block matrix, go/no-go. | `REL-V1-010` human decision. | Planned |

## Module Maturity

| Block | Current maturity | Reopened gap | Completion owner |
| --- | --- | --- | --- |
| `BLK-V1-01` Contracts/core/fixtures | Strong historical tmux-shaped L1 base. | App-server/events/approval/mobile/security contracts, strict invariants, planning checker. | `FND-V1-014` to `FND-V1-016`, `FND-V1-091` |
| `BLK-V1-02` State/auth/audit | Strong historical repository L1/L2 base. | Thread projection migration, production retention/audit, CSRF lifecycle, secure paths/lease. | `DAT-V1-018` to `DAT-V1-021`, `DAT-V1-091` |
| `BLK-V1-03` Codex runtime/events | Architecture spike complete; tmux mechanics are legacy. | Selected adapter and real turn/control/approval/TUI/restart path absent. | `INT-V1-003` to `INT-V1-008`, `INT-V1-091` |
| `BLK-V1-04` API/CLI/security/service | Historical headless/custom listener and source CLI base. | Fastify/SSE/HTTPS/full auth/fanout/health/bounds/build/services absent. | `IFC-V1-015` to `IFC-V1-021`, `IFC-V1-091` |
| `BLK-V1-05` Mobile dashboard | View-model helpers only; old boards rejected. | Mobile state/visual gate and all product UI/device evidence absent. | `FE-V1-004`, reopened `FE-V1-002`, `FE-V1-003`, `FE-V1-010` to `FE-V1-022`, `FE-V1-090` |
| `BLK-V1-06` Release | Baseline commands and historical docs exist. | Selected-path clean install/security/device/aggregate/docs/go-no-go absent. | `REL-V1-004` to `REL-V1-011` |

## Delivery Passes

1. Foundation: M0 through M3 establishes one runnable selected vertical with bounded failure behavior.
2. Module hardening: `FND-V1-091`, `DAT-V1-091`, `INT-V1-091`, `IFC-V1-091`, and `FE-V1-090` close each module against strict matrices.
3. Release hardening: M5 validates packaging, setup, security/privacy, docs/support, actual phone/browser/Codex workflows, and handoff.

## Release Gates

| Gate | Status | Blocking owner |
| --- | --- | --- |
| Planning/trace/dependency integrity | Complete | `REL-V1-011`, `FND-V1-014` |
| Real Codex compatibility and vertical | Blocked | `INT-V1-003` to `INT-V1-091` |
| HTTPS/auth/security boundary | Blocked | `IFC-V1-015`, `DAT-V1-021`, `IFC-V1-017`, `IFC-V1-091` |
| Build/package/user services | Blocked | `IFC-V1-021` |
| Mobile visual selection/UI/device | Blocked | `FE-V1-004`, `FE-V1-002`, human `FE-V1-003`, `FE-V1-090` |
| Security/privacy | Blocked | `REL-V1-005` |
| Clean Ubuntu/aggregate/docs | Blocked | `REL-V1-004`, `REL-V1-006`, `REL-V1-007` |
| Final go/no-go | Blocked | `REL-V1-008` to `REL-V1-010` |
