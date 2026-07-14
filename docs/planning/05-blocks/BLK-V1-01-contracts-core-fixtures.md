# BLK-V1-01 Contracts, Core, And Fixtures

Status: complete.

Owns the normalized HostDeck language consumed by storage, Codex adapter, API/CLI, and UI.

## Outcome

- App-server and external-ingress details are isolated behind stable HostDeck thread, turn, event, approval, control, compatibility, remote-ingress, trust, and audit contracts.
- Strict core invariants reject invalid timestamps, unsafe cursors, impossible transitions, ambiguous targets, unsupported capabilities, and contradictory outcomes.
- Deterministic fixtures cover required structured runtime, Tailscale/profile/Serve, security, replay, and mobile states.
- Planning validation makes task/requirement/dependency drift fail in the normal check path.

Requirement refs: `FR-002`, `FR-006` to `FR-009`, `FR-011` to `FR-018`, `NFR-001` to `NFR-003`, `NFR-005` to `NFR-007`, `IR-001` to `IR-012`, `DR-010`, `PR-002`, `PR-003`, `PR-005`, `PR-007`, `PR-009`, `SFR-001`, `SFR-002`, `SFR-005`, `SFR-008`, `SFR-010` to `SFR-013`, `SFR-015`, `SFR-016`, `SFR-018`.

## Local Design

| Part | Owns | Must prove |
| --- | --- | --- |
| Core | Stable ids, lifecycle/reconciliation transitions, status/attention, control intent, eligibility, audit outcome. | Normal, invalid, impossible, repeated, and concurrent decisions are deterministic. |
| Contracts | API, persistence, projection, compatibility, remote ingress, trust, audit, and UI runtime schemas. | Malformed/unknown required shapes fail with bounded errors. |
| Codex normalization port | HostDeck-owned adapter input/output/event interfaces. | No generated app-server type leaks to consumers. |
| Fixtures | Structured events, approvals, turns, controls, errors, Tailscale/profile/Serve, trust/network, replay/boundary, and mobile states. | Complete inventory from `SFR-011`, `SFR-015`, and the UX state matrix. |
| Planning checker | Markdown task/requirement graph validation. | Duplicate/unknown refs, cycles, invalid ready state, and uncovered requirement fail. |

## Invariants

- `HostDeckSessionId`, Codex thread id, alias, approval request id, and client operation id are distinct types.
- Timestamp parsing validates the actual calendar value and canonical round trip.
- Cursor/count values are non-negative safe integers.
- User lifecycle and reconciliation transitions are separate explicit tables.
- Accepted dispatch and terminal success are separate audit/result states.
- A required unsupported Codex capability is `incompatible`, not `unknown` or a terminal-text fallback.
- One mutation has one typed target; union ambiguity rejects at schema boundary.

## Task Map

| Work | Tasks | Status |
| --- | --- | --- |
| Historical workspace/core/contracts/fixtures | `FND-V1-001` to `FND-V1-013` | Done for superseded contract set; evidence retained. |
| Planning integrity | `FND-V1-014` | Done. |
| App-server/mobile/security contract rebaseline | `FND-V1-015` | Done. |
| Core invariant and reconciliation hardening | `FND-V1-016` | Done. |
| Reopened module hardening | `FND-V1-091` | Done. |
| Remote-ingress/access contract and fixture rebaseline | `FND-V1-018` | Done; `artifacts/fnd-v1-018-remote-ingress-contracts.md`. |
| Focused remote contract hardening | `FND-V1-092` | Done; `artifacts/fnd-v1-092-remote-ingress-hardening.md`. |

Owning backlog: `docs/tracking/backlog/foundation.md`.

## Validation

| Layer | Evidence |
| --- | --- |
| L1 | Core and contract tests for every invariant and fixture category. |
| L2 | Cross-package fixtures/public exports consume normalized contracts, and an executable boundary guard prevents generated Codex protocol imports outside the adapter. Production consumer adoption is owned by Blocks 02 to 05. |
| Manual | Fixture review confirms unknown, stale, unsupported, and incomplete never appear healthy/successful. |

## Done Criteria

- `pnpm check:planning`, typecheck, lint, unit, and contract tests pass.
- Every active requirement is traceable to defined tasks and no dependency cycle/invalid ready task exists.
- Generated Codex bindings are private to the adapter boundary.
- Required structured, remote-ingress, and UI fixture inventories are complete.
- Timestamp, cursor, lifecycle, target, compatibility, and audit outcome defects identified by `REL-V1-011` have regression tests.
- `FND-V1-092` links current remote-path evidence and the block matrix marks complete without qualification.

Prior structured-foundation hardening evidence: `artifacts/fnd-v1-091-selected-foundation-hardening.md`. Remote-ingress completion evidence: `artifacts/fnd-v1-092-remote-ingress-hardening.md`.
