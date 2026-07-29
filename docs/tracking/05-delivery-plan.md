# Delivery Plan

Owns milestone, module maturity, production passes, and release truth.

## Snapshot

- Current pass: aggregate physical mobile-dashboard acceptance and release hardening after completing the selected runtime/interface and security/privacy review.
- Current milestone: M1 selected foundation, M2 real structured vertical, and M3 remote host interface are complete; M4 mobile dashboard is in progress.
- Release state: no-go; the selected runtime, interface, package/service path, complete dashboard behavior, browser matrix, fidelity, copy/workflow, user guide, and security/privacy review pass, but aggregate physical-device and downstream release gates remain incomplete.
- Next exit: `FE-V1-090` runs strict aggregate physical Android dashboard acceptance against the current verified package.

## Milestones

| Milestone | Scope | Exit | Status |
| --- | --- | --- | --- |
| M0 Rebaseline | Audit prior direction/evidence; select app-server/mobile/Tailscale-remote path; repair requirements, blueprint, blocks, tasks, queue, and planning checker. | `REL-V1-011`, `REL-V1-012`; owner docs agree, `pnpm check:planning` passes, selected-path leaf graph is executable. | Complete |
| M1 Selected foundation | Normalized runtime/remote-ingress contracts and invariants; mapping/projection/auth/remote-config/audit/permissions/retention foundations; Codex compatibility and IPC adapter. | Prior foundation evidence plus `FND-V1-018`, `FND-V1-092`, `DAT-V1-031`, `DAT-V1-032`, `DAT-V1-092`, and adapter handshake/broker pass. | Complete |
| M2 Real structured vertical | Real thread start/resume, prompt/events/status, controls, approval, interrupt, TUI multi-client, reconnect/restart; legacy disposition. | `INT-V1-091` with L3 real-Codex artifact. | Complete |
| M3 Production remote host interface | Loopback Fastify/SSE/static, Tailscale profile/Serve ingress, external-origin/proxy/app auth, QR pairing, fanout/health/shutdown, selected API/CLI, bounds, build/user services. | `IFC-V1-079`, `IFC-V1-091`, clean production-path smoke. | Complete |
| M4 Mobile dashboard | Rebased remote/profile state matrix, two mobile options, human selection, complete screens/controls/approval/trust states, responsive/accessibility/fidelity, remote-phone proof. | `FE-V1-090` with screenshots and L4 device/profile artifact. | In progress |
| M5 Release hardening | Security/privacy, clean Ubuntu/Tailscale package/service/real-Codex/browser/remote-phone, company-profile noninterference, docs, aggregate validation, block matrix, go/no-go. | `REL-V1-010` human decision. | In progress |

## Module Maturity

| Block | Current maturity | Reopened gap | Completion owner |
| --- | --- | --- | --- |
| `BLK-V1-01` Contracts/core/fixtures | Structured-runtime and remote-ingress/access contracts, invariants, fixtures, generated/normalized adapter boundaries, planning checker, executable-leaf audit, and focused hardening pass. | None; block complete. | `FND-V1-018`, `FND-V1-092` |
| `BLK-V1-02` State/auth/audit | Mapping/recovery/projection/runtime compatibility, remote-ingress config/profile/Serve/observation durability, exact remote enable/disable audit with historical preservation, retention, pairing/CSRF/device authority, secure paths/lease, and combined aggregate migration/restart/conflict/query-plan/privacy hardening pass. | None; block complete. | `DAT-V1-092` |
| `BLK-V1-03` Codex runtime/events | Exact binding, private IPC/handshake, thread/control/event vertical, production supervision, restart/reconciliation, multi-client lifecycle, executable tmux-runtime removal, and clean-commit aggregate hardening pass. | None; block complete. | `INT-V1-005` to `INT-V1-008`, `INT-V1-017` to `INT-V1-032`, `INT-V1-091` |
| `BLK-V1-04` API/CLI/security/service | Typed loopback Fastify/SSE/static boundaries, app-auth primitives, bounded fanout, retention-safe replay/live handoff, complete drain, independent local/remote health, exact Tailscale observation/Serve ownership/proxy trust/application authorization, remote control, production remote lifecycle, aggregate hostile plus physical Android acceptance, exact selected route composition, legacy isolation, bounded CLI, cross-owner resource stress, deterministic server/CLI plus real dashboard package output, foreground resources/application/listener, one verified command, one independently restartable packaged service process, exact runtime-proven systemd user units, persistent lifecycle, safe uninstall, bounded release retention, clean supported-user parity, and aggregate module hardening pass. | No implementation gap; formal completion-matrix status is owned by `REL-V1-008`. | `IFC-V1-091`, `REL-V1-008` |
| `BLK-V1-05` Mobile dashboard | Structured phone-state contract, selected Focus Rail targets, real packaged two-route React/Vite dashboard, bounded coordinated browser clients, complete production screens/actions/trust/recovery states, responsive layout, semantic accessibility, selected-target fidelity, copy/workflow review, focused physical Android evidence, and exact Chromium/Firefox phone/desktop package coverage. | Aggregate phone module acceptance and release-device evidence remain. | `FE-V1-090` |
| `BLK-V1-06` Release | Baseline commands, both rebaseline decisions, selected-path user guide, and security/privacy review are complete. | Aggregate physical phone, clean selected-path release smoke, aggregate validation, completion matrix, final delivery truth, and go/no-go remain. | `REL-V1-006` to `REL-V1-010` |

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
| Remote HTTPS/app-auth/security boundary | Complete | Aggregate hostile/physical acceptance, selected composition, legacy isolation, resource stress, package/service ownership, live profile noninterference, and `IFC-V1-091` module hardening pass. |
| Build/package/user services | Complete | Deterministic server/CLI plus dashboard output, executable/service process, exact user units, persistent lifecycle, safe uninstall, release retention, and one no-retry clean supported-environment acceptance pass. |
| Mobile visual selection/UI/device | In progress | Visual contracts/selection, complete dashboard screens/actions/trust/recovery states, responsive layout, semantic accessibility, selected-target fidelity, copy/workflow review, packaged assets, focused phone evidence, and exact Chromium/Firefox phone/desktop package coverage are complete. Aggregate phone module acceptance and release acceptance remain. |
| Security/privacy | Complete | `REL-V1-005`; all 24 criteria pass, two findings fixed, zero unresolved security/privacy blocker. |
| Clean Ubuntu/aggregate/docs | Blocked | `REL-V1-006`, `REL-V1-007` |
| Final go/no-go | Blocked | `REL-V1-008` to `REL-V1-010` |
