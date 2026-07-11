# Delivery Plan

Owns milestone, module maturity, production passes, and release truth.

## Snapshot

- Current pass: selected foundation data leaves and exact runtime/interface spikes.
- Current milestone: M1 Selected foundation.
- Release state: no-go; selected production path is not implemented.
- Next exit: selected data retention/audit leaves and exact Codex production event/control ports are implemented with bounded evidence.

## Milestones

| Milestone | Scope | Exit | Status |
| --- | --- | --- | --- |
| M0 Rebaseline | Audit prior direction/evidence; select app-server/mobile/HTTPS path; repair requirements, blueprint, blocks, tasks, queue, planning checker. | Owner docs agree, `pnpm check:planning` passes, selected-path leaf graph is executable. | Complete |
| M1 Selected foundation | Normalized contracts/invariants; mapping/projection/auth/permissions/retention foundations; Codex compatibility and IPC adapter. | `FND-V1-091`, `DAT-V1-018` to `DAT-V1-030`, `DAT-V1-091`, and adapter handshake/broker pass. | In progress |
| M2 Real structured vertical | Real thread start/resume, prompt/events/status, controls, approval, interrupt, TUI multi-client, reconnect/restart; legacy disposition. | `INT-V1-091` with L3 real-Codex artifact. | Planned |
| M3 Production host interface | HTTPS phone enrollment, Fastify/SSE/static, auth/rate/origin/CSRF, fanout/health/shutdown, selected API/CLI, bounds, build/user services. | `IFC-V1-091`, clean production-path smoke. | Planned |
| M4 Mobile dashboard | Rebased state matrix, two mobile options, human selection, complete screens/controls/approval/trust states, responsive/accessibility/fidelity, phone proof. | `FE-V1-090` with screenshots and L4 device artifact. | Planned |
| M5 Release hardening | Security/privacy, clean Ubuntu package/service/real-Codex/browser/phone, docs, aggregate validation, block matrix, go/no-go. | `REL-V1-010` human decision. | Planned |

## Module Maturity

| Block | Current maturity | Reopened gap | Completion owner |
| --- | --- | --- | --- |
| `BLK-V1-01` Contracts/core/fixtures | Selected normalized contracts, invariants, fixtures, generated boundary, planning checker, and executable-leaf audit pass. | No foundation blocker; production consumers remain in their owning blocks. | `FND-V1-014` to `FND-V1-017`, `FND-V1-091` |
| `BLK-V1-02` State/auth/audit | Selected mapping/projection migration, secure paths/daemon lease, transactional append/retention, and append-only accepted-to-terminal audit state pass over a strong repository base. | Bounded startup maintenance, orphan reconciliation, and CSRF/device/pairing/revoke lifecycle remain. | `DAT-V1-018` to `DAT-V1-030`, `DAT-V1-091` |
| `BLK-V1-03` Codex runtime/events | Exact binding, private IPC/handshake, corrected no-model thread lifecycle, ordered projection, prompt/model/goal/Plan controls, strict real deny/approve/expiry routing, and exact active-turn interrupt pass; tmux mechanics are legacy. | Usage, compact, skills, assembled callback/runtime composition, command-sandbox reproducibility, supervision, restart acceptance, and legacy disposition remain. | `INT-V1-005` to `INT-V1-008`, `INT-V1-017` to `INT-V1-032`, `INT-V1-091` |
| `BLK-V1-04` API/CLI/security/service | Typed Fastify/SSE/static/lifecycle boundaries, bounded commit-only fanout, and retention-safe headless replay-to-live continuity pass over the historical headless/CLI base. | Sustained subscriber queues, authenticated SSE assembly, HTTPS/security, health/routes, legacy disposition, enforced bounds, build, and services remain. | `IFC-V1-015` to `IFC-V1-069`, `IFC-V1-091` |
| `BLK-V1-05` Mobile dashboard | View-model helpers only; old boards rejected. | Mobile state/visual gate and all product UI/device evidence remain. | `FE-V1-004`, reopened `FE-V1-002`, `FE-V1-003`, `FE-V1-010` to `FE-V1-040`, `FE-V1-090` |
| `BLK-V1-06` Release | Baseline commands and historical docs exist. | Selected-path clean install/security/device/aggregate/docs/go-no-go absent. | `REL-V1-004` to `REL-V1-011` |

## Delivery Passes

1. Foundation: M0 through M3 establishes one runnable selected vertical with bounded failure behavior.
2. Module hardening: `FND-V1-091`, `DAT-V1-091`, `INT-V1-091`, `IFC-V1-091`, and `FE-V1-090` close each module against strict matrices.
3. Release hardening: M5 validates packaging, setup, security/privacy, docs/support, actual phone/browser/Codex workflows, and handoff.

## Release Gates

| Gate | Status | Blocking owner |
| --- | --- | --- |
| Planning/trace/dependency integrity | Complete | `REL-V1-011`, `FND-V1-014`, `FND-V1-017` |
| Real Codex compatibility and vertical | Blocked | `INT-V1-003` to `INT-V1-008`, `INT-V1-017` to `INT-V1-032`, `INT-V1-091` |
| HTTPS/auth/security boundary | Blocked | `IFC-V1-015`, `DAT-V1-021`, `DAT-V1-025` to `DAT-V1-029`, `IFC-V1-017`, `IFC-V1-026` to `IFC-V1-033`, `IFC-V1-059`, `IFC-V1-066`, `IFC-V1-091` |
| Build/package/user services | Blocked | `IFC-V1-021`, `IFC-V1-053` to `IFC-V1-058` |
| Mobile visual selection/UI/device | Blocked | `FE-V1-004`, `FE-V1-002`, human `FE-V1-003`, `FE-V1-010` to `FE-V1-040`, `FE-V1-090` |
| Security/privacy | Blocked | `REL-V1-005` |
| Clean Ubuntu/aggregate/docs | Blocked | `REL-V1-004`, `REL-V1-006`, `REL-V1-007` |
| Final go/no-go | Blocked | `REL-V1-008` to `REL-V1-010` |
