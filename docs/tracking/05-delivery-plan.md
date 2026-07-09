# Delivery Plan

Owns milestone, module maturity, production pass, and release truth.

## Snapshot

- Current pass: Storage-owned local state/auth/audit, tmux fake adapter foundation, tmux output-capture spike, real tmux target primitives, real managed start/send/stop/attach/output/restart/smoke/hardening, pairing/security API route foundation, validation wiring, headless API/CLI startup readiness, headless read/stream/write route contracts, aggregate route contracts, localhost/LAN network smoke, CLI shell, CLI session commands, and CLI pairing/lock/LAN commands complete; service-mode smoke is next
- Current milestone: M1 Foundation complete
- Release state: Not release-ready; product workflow blocks remain incomplete
- Go/no-go:

## Milestones

| Milestone | Scope | Status | Evidence |
| --- | --- | --- | --- |
| M1 Foundation | Workspace, core model, contracts, fixtures, compatibility, and foundation hardening | Complete | `artifacts/fnd-v1-011-foundation-completion.md` |
| M2 Module hardening |  | Planned |  |
| M3 Release hardening |  | Planned |  |

## Module Maturity

| Module | Status | Open gaps | Evidence |
| --- | --- | --- | --- |
| `BLK-V1-01` Foundation / Contracts | Complete | Product workflow behavior still unproven until storage, tmux, API/CLI, UI, and release blocks complete. | `artifacts/fnd-v1-001-scaffold.md` through `artifacts/fnd-v1-011-foundation-completion.md` |
| `BLK-V1-02` Local State / Auth / Audit | Complete for storage-owned scope | API write preflight and release privacy/setup evidence remain in later blocks. | `artifacts/dat-v1-001-sqlite-driver-spike.md`, `artifacts/dat-v1-002-token-transport-spike.md`, `artifacts/dat-v1-003-retention-caps-spike.md`, `artifacts/dat-v1-010-sqlite-migration-runner.md`, `artifacts/dat-v1-011-settings-repository.md`, `artifacts/dat-v1-012-session-repositories.md`, `artifacts/dat-v1-013-auth-repositories.md`, `artifacts/dat-v1-014-audit-repository.md`, `artifacts/dat-v1-015-retention-repository.md`, `artifacts/dat-v1-016-restart-persistence.md`, `artifacts/dat-v1-017-branch-metadata.md`, `artifacts/dat-v1-090-storage-hardening.md` |
| `BLK-V1-03` Tmux Session / Output | Complete for tmux-owned scope | API stream/CLI/dashboard exposure and clean release setup remain in later blocks. | `artifacts/int-v1-001-tmux-capture-spike.md`, `artifacts/int-v1-010-fake-tmux-adapter.md`, `artifacts/int-v1-011-real-tmux-targets.md`, `artifacts/int-v1-012-real-tmux-start.md`, `artifacts/int-v1-013-real-tmux-operations.md`, `artifacts/int-v1-014-output-reader.md`, `artifacts/int-v1-015-restart-reconciliation.md`, `artifacts/int-v1-016-real-tmux-smoke.md`, `artifacts/int-v1-090-tmux-output-hardening.md` |
| `BLK-V1-04` API / CLI Control Plane | In progress | Service controls, full CLI command matrix, interface hardening, and remaining negative failure coverage remain planned. | `artifacts/ifc-v1-001-startup-readiness.md`, `artifacts/ifc-v1-002-read-routes.md`, `artifacts/ifc-v1-003-stream-routes.md`, `artifacts/ifc-v1-004-write-routes.md`, `artifacts/ifc-v1-005-security-routes.md`, `artifacts/ifc-v1-006-cli-shell.md`, `artifacts/ifc-v1-007-cli-session-commands.md`, `artifacts/ifc-v1-008-cli-admin-commands.md`, `artifacts/ifc-v1-010-api-route-contracts.md`, `artifacts/ifc-v1-011-network-smoke.md` |
| `BLK-V1-06` Hardening / Release | In progress | Integration, tmux, web, E2E, build, local smoke, setup docs, security review, and go/no-go remain planned or blocked by product workflow gaps. | `artifacts/rel-v1-001-validation-wiring.md` |

## Release Gates

| Gate | Status | Owner | Evidence |
| --- | --- | --- | --- |
| Build/package | Planned |  |  |
| Validation | Planned |  |  |
| Docs/support | Planned |  |  |
