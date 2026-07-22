# Delivery Plan

Owns milestone, module maturity, production passes, and release truth.

## Snapshot

- Current pass: Tailscale-first production host interface and selected mobile-dashboard integration after completing selected runtime integration.
- Current milestone: M1 selected foundation and M2 real structured vertical are complete; M3 remote host interface and M4 mobile dashboard are in progress.
- Release state: no-go; deterministic server/CLI output, accepted foreground/service processes, and exact runtime-proven user units exist, but real dashboard assets, persistent service lifecycle/install parity, UI, and release hardening remain incomplete.
- Next exit: `FE-V1-019` implements the typed bounded same-origin HTTP client foundation on the completed Focus Rail phone shell.

## Milestones

| Milestone | Scope | Exit | Status |
| --- | --- | --- | --- |
| M0 Rebaseline | Audit prior direction/evidence; select app-server/mobile/Tailscale-remote path; repair requirements, blueprint, blocks, tasks, queue, and planning checker. | `REL-V1-011`, `REL-V1-012`; owner docs agree, `pnpm check:planning` passes, selected-path leaf graph is executable. | Complete |
| M1 Selected foundation | Normalized runtime/remote-ingress contracts and invariants; mapping/projection/auth/remote-config/audit/permissions/retention foundations; Codex compatibility and IPC adapter. | Prior foundation evidence plus `FND-V1-018`, `FND-V1-092`, `DAT-V1-031`, `DAT-V1-032`, `DAT-V1-092`, and adapter handshake/broker pass. | Complete |
| M2 Real structured vertical | Real thread start/resume, prompt/events/status, controls, approval, interrupt, TUI multi-client, reconnect/restart; legacy disposition. | `INT-V1-091` with L3 real-Codex artifact. | Complete |
| M3 Production remote host interface | Loopback Fastify/SSE/static, Tailscale profile/Serve ingress, external-origin/proxy/app auth, QR pairing, fanout/health/shutdown, selected API/CLI, bounds, build/user services. | `IFC-V1-079`, `IFC-V1-091`, clean production-path smoke. | In progress |
| M4 Mobile dashboard | Rebased remote/profile state matrix, two mobile options, human selection, complete screens/controls/approval/trust states, responsive/accessibility/fidelity, remote-phone proof. | `FE-V1-090` with screenshots and L4 device/profile artifact. | In progress |
| M5 Release hardening | Security/privacy, clean Ubuntu/Tailscale package/service/real-Codex/browser/remote-phone, company-profile noninterference, docs, aggregate validation, block matrix, go/no-go. | `REL-V1-010` human decision. | Planned |

## Module Maturity

| Block | Current maturity | Reopened gap | Completion owner |
| --- | --- | --- | --- |
| `BLK-V1-01` Contracts/core/fixtures | Structured-runtime and remote-ingress/access contracts, invariants, fixtures, generated/normalized adapter boundaries, planning checker, executable-leaf audit, and focused hardening pass. | None; block complete. | `FND-V1-018`, `FND-V1-092` |
| `BLK-V1-02` State/auth/audit | Mapping/recovery/projection/runtime compatibility, remote-ingress config/profile/Serve/observation durability, exact remote enable/disable audit with historical preservation, retention, pairing/CSRF/device authority, secure paths/lease, and combined aggregate migration/restart/conflict/query-plan/privacy hardening pass. | None; block complete. | `DAT-V1-092` |
| `BLK-V1-03` Codex runtime/events | Exact binding, private IPC/handshake, thread/control/event vertical, production supervision, restart/reconciliation, multi-client lifecycle, executable tmux-runtime removal, and clean-commit aggregate hardening pass. | None; block complete. | `INT-V1-005` to `INT-V1-008`, `INT-V1-017` to `INT-V1-032`, `INT-V1-091` |
| `BLK-V1-04` API/CLI/security/service | Typed loopback Fastify/SSE/static boundaries, app-auth primitives, bounded fanout, retention-safe replay/live handoff, complete drain, independent local/remote health, exact Tailscale observation/Serve ownership/proxy trust/application authorization, remote control, production remote lifecycle, aggregate hostile plus physical Android acceptance, exact selected route composition, legacy isolation, bounded CLI, cross-owner resource stress, deterministic package output, foreground resources/application/listener, one verified command, one independently restartable packaged service process, and exact runtime-proven systemd user units pass. | Built assets, persistent service lifecycle/install, uninstall/parity, and interface hardening remain. | `IFC-V1-053` to `IFC-V1-058`, `IFC-V1-091` |
| `BLK-V1-05` Mobile dashboard | Structured phone-state contract, two replacement directions, human-selected Focus Rail targets, and the real two-route React/Vite phone shell with component/browser/screenshot evidence pass. | Typed clients, product screens/actions, packaged assets, broad browser/accessibility/fidelity, and real-device evidence remain. | `FE-V1-019`, `FE-V1-011` to `FE-V1-040`, `FE-V1-090` |
| `BLK-V1-06` Release | Baseline commands/historical docs and both rebaseline decisions exist. | Selected remote-path clean install/security/device/profile/aggregate/docs/go-no-go absent. | `REL-V1-004` to `REL-V1-010`, `REL-V1-012` |

## Delivery Passes

1. Foundation: M0 through M3 establishes one runnable selected remote vertical with bounded local and remote failure behavior.
2. Module hardening: `FND-V1-092`, `DAT-V1-092`, `INT-V1-091`, `IFC-V1-091`, and `FE-V1-090` close each module against strict matrices.
3. Release hardening: M5 validates packaging, Tailscale/profile setup, security/privacy, docs/support, actual remote-phone/browser/Codex workflows, company-profile noninterference, and handoff.

## Release Gates

| Gate | Status | Blocking owner |
| --- | --- | --- |
| Planning/trace/dependency integrity | Complete | `REL-V1-011`, `REL-V1-012`, `FND-V1-014`, `FND-V1-017` |
| Remote contracts and durable state | Complete | `IFC-V1-070`, `FND-V1-018`, `FND-V1-092`, `DAT-V1-031`, `DAT-V1-032`, `DAT-V1-092` |
| Real Codex compatibility and vertical | Complete | `INT-V1-003` to `INT-V1-008`, `INT-V1-017` to `INT-V1-032`, `INT-V1-091` |
| Remote HTTPS/app-auth/security boundary | In progress | Aggregate hostile/physical acceptance, full selected composition, legacy isolation, and aggregate resource stress pass; packaged-path module hardening remains `IFC-V1-091`. |
| Build/package/user services | In progress | `IFC-V1-021` deterministic package, `IFC-V1-054` executable dispatch, `IFC-V1-086` packaged service process, and `IFC-V1-055` exact user units are complete. Web assets and persistent lifecycle/install parity remain `IFC-V1-053` and `IFC-V1-056` to `IFC-V1-058`, behind human-selected UI implementation. |
| Mobile visual selection/UI/device | In progress | `FE-V1-004`, `FE-V1-002`, `FE-V1-003`, and shell foundation `FE-V1-010` are complete; typed clients, screens/actions, responsive/accessibility/browser/fidelity, and device hardening remain. |
| Security/privacy | Blocked | `REL-V1-005` |
| Clean Ubuntu/aggregate/docs | Blocked | `REL-V1-004`, `REL-V1-006`, `REL-V1-007` |
| Final go/no-go | Blocked | `REL-V1-008` to `REL-V1-010` |
