# Delivery Plan

Owns milestone, module maturity, production passes, and release truth.

## Snapshot

- Current pass: shared ordinary-Codex foundation under `DEC-031`, followed by Ubuntu-only release hardening under `DEC-032`.
- Release state: no-go. The prior private-runtime/adoption product is runnable but is not the selected session-continuity architecture.
- Next exit: complete `IFC-V1-113` and package one immutable Ubuntu candidate for physical phone and clean-host acceptance.

## Milestones

| Milestone | Scope | Exit | Status |
| --- | --- | --- | --- |
| M0 Prior foundation | App-server, Tailscale remote ingress, Focus Rail dashboard, auth/security, storage, controls, package/lifecycle foundations. | Historical completed block evidence remains valid where contracts are unchanged. | Complete |
| M1 Shared-session rebaseline | Exact 0.147.0 standard socket, native/public identity, automatic enrollment, live catalog, Ubuntu-only release graph. | `REL-V1-109`; owner docs and planning checker agree. | Complete |
| M2 Shared runtime | Binding/state, standard broker, loaded-before/created-after enrollment, ordinary TUI coexistence, removed adoption flow. | `INT-V1-110` to `INT-V1-114`, `FND-V1-103`, `DAT-V1-106`, `IFC-V1-111`. | Complete |
| M3 Live mobile surface | Catalog SSE and Focus Rail Mission Control integration. | `IFC-V1-112`, `FE-V1-107`; browser/manual inspection passes without refresh/poll fallback. | Complete |
| M4 Ubuntu candidate | Deterministic package and independent broker/HostDeck systemd user lifecycle. | `IFC-V1-113`; install/upgrade/rollback/uninstall and supply-chain gates pass. | Todo |
| M5 Physical and clean release | Unrelated-network Android bidirectional shared-session workflow plus clean Ubuntu install-to-uninstall aggregate. | `FE-V1-108`, `REL-V1-110`, then human `REL-V1-010`. | Todo |

## Module Maturity

| Block | Retained foundation | Reopened gap | Completion owner |
| --- | --- | --- | --- |
| `BLK-V1-01` Contracts/core/fixtures | Structured runtime, controls, remote access, UI, and prior adoption contracts. | Shared broker/enrollment/catalog/native-public identity contracts. | `FND-V1-103` |
| `BLK-V1-02` State/auth/audit | Mapping/projection/retention/auth/security and prior adoption storage. | Idempotent native-UUID enrollment and historical compatibility. | `DAT-V1-106` |
| `BLK-V1-03` Codex runtime/events | Exact 0.144.0 private-runtime vertical and controls. | Exact 0.147.0 binding, standard broker, auto-enrollment, ordinary TUI continuity, hardening. | `INT-V1-110` to `INT-V1-114` |
| `BLK-V1-04` API/CLI/security/service | Loopback Fastify/SSE, pairing, Tailscale Serve, controls, package/service foundations. | Remove selected adoption administration, add broker commands/native UUID targeting/catalog stream. | `IFC-V1-111`, `IFC-V1-112` |
| `BLK-V1-05` Mobile dashboard | Approved complete Focus Rail UI and browser/accessibility evidence. | Live catalog integration and focused physical shared-session pass. | `FE-V1-107`, `FE-V1-108` |
| `BLK-V1-06` Release | Security/privacy and prior user guidance. | Exact Ubuntu candidate, aggregate clean-host evidence, current docs, human decision. | `REL-V1-110`, `REL-V1-010` |
| `BLK-V1-07` Ubuntu distribution | Linux package/systemd baseline and reusable native/supply-chain work. | Standard-broker lifecycle migration and clean Ubuntu candidate. | `IFC-V1-113`, `REL-V1-110` |

## Delivery Passes

1. Foundation: exact shared-runtime contracts, binding, state, broker, and automatic enrollment.
2. Module hardening: selected API/CLI/catalog/UI plus runtime race/failure/resource/manual inspection.
3. Release hardening: deterministic Ubuntu package, physical phone, clean host, Tailscale/profile, security/privacy, docs, and go/no-go.

## Release Gates

| Gate | Status | Blocking owner |
| --- | --- | --- |
| Planning/trace/dependency integrity | Complete | `REL-V1-109`; 289 tasks/94 requirements/777 dependencies validate |
| Exact shared Codex runtime | Complete | `INT-V1-110` to `INT-V1-114` |
| Selected API/CLI and live catalog | Complete | `IFC-V1-111`, `IFC-V1-112`, `FE-V1-107` |
| Remote HTTPS/app authorization | Retained complete | Existing Tailscale Serve/pairing/security evidence; rerun on candidate in `FE-V1-108` |
| Ubuntu package/lifecycle/supply chain | Todo | `IFC-V1-113` |
| Physical phone shared-session workflow | Todo | `FE-V1-108` |
| Clean Ubuntu aggregate and docs | Todo | `REL-V1-110` |
| Final go/no-go | Blocked | `REL-V1-010` and human acceptance |
