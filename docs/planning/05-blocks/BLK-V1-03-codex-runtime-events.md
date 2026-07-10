# BLK-V1-03 Codex Runtime, Threads, And Events

Owns the selected Codex boundary: dedicated app-server process, private Unix transport, normalized adapter, real session/turn/control/approval/event behavior, TUI resume, and restart.

## Outcome

- HostDeck controls supported Codex through generated, version-checked app-server contracts rather than TUI text.
- One dedicated runtime supports multiple managed threads plus a normal laptop TUI client.
- Real events drive durable projections, attention, controls, approvals, and replay.
- HostDeck/app-server restart and uncertain outcomes are honest and recoverable.
- Legacy tmux runtime code is removed or explicitly deferred after the structured path passes.

Requirement refs: `FR-001`, `FR-003` to `FR-009`, `FR-013` to `FR-018`, `NFR-002`, `NFR-005` to `NFR-007`, `NFR-010`, `NFR-012`, `PR-001`, `PR-006`, `PR-007`, `PR-010`, `SFR-010`, `SFR-011`.

## Local Architecture

| Part | Responsibility | Failure state |
| --- | --- | --- |
| Runtime supervisor | Start/await dedicated app-server and private socket according to foreground/service ownership. | Missing/incompatible binary, socket collision, crash loop, wrong owner/mode. |
| IPC adapter | `ws+unix:` connection, initialize handshake, request broker, frame/message validation, reconnect. | Timeout, malformed/unknown required message, overload, disconnect/incomplete mutation. |
| Thread service port | Start/list/read/archive and stable id mapping. | Duplicate alias, uncertain partial start, missing/archived thread. |
| Turn/control port | Prompt/steer/interrupt/model/goal/plan/usage/compact/skills. | Unsupported capability, active-turn conflict, unknown outcome. |
| Approval router | Pending server request registration and exact response. | Duplicate/expired/superseded/connection-generation mismatch. |
| Event pipeline | Identity-gate unmanaged TUI notifications, normalize managed runtime events, and serialize durable projection/publication. | Unknown required semantic, malformed managed payload/order, mapping race, bounded-capacity exhaustion, storage/publication failure. |

## Required Real Proof

- Schema generation/drift and supported-version startup.
- Two threads, exact targeting, ordered event/status projection.
- Model, goal, plan, usage, compact, and skills behavior for the pinned runtime.
- Safe approval approve/deny/duplicate/expiry.
- Interrupt distinct from completion/archive.
- TUI resume of the exact thread on the same Unix socket while HostDeck is connected.
- HostDeck-only restart, app-server crash/restart, event gap/boundary, and persisted-thread recovery.
- Bounded request/frame/in-flight/reconnect behavior.

No fake-Codex or fake-tmux test can satisfy these gates.

## Task Map

| Work | Tasks | Status |
| --- | --- | --- |
| Historical tmux/capture adapter and smoke | `INT-V1-001`, `INT-V1-010` to `INT-V1-016`, `INT-V1-090` | Retained legacy evidence; not block completion. |
| Architecture reassessment | `INT-V1-002` | Done: `artifacts/int-v1-002-codex-integration-reassessment.md`. |
| Version/schema/capability gate | `INT-V1-003` | Done: exact 0.144.0 experimental binding and real no-model compatibility smoke. |
| Unix IPC client and request broker | `INT-V1-004` | Done: bounded transport/broker/handshake/reconnect and real private-socket smoke. |
| Thread lifecycle and exact TUI resume | `INT-V1-005` | Done: id-first recovery saga, 0.144.0 legacy materialization, durable mapping/reconciliation, exact archive, and real no-model TUI smoke. |
| Exact real turn/control/event semantic spike | `INT-V1-006` | Done: event-gated operation matrix, real approvals/control/TUI/reconnect, bounded compact incompleteness, and corrected handshake/materialization bugs. |
| Event normalization and exact prompt targeting | `INT-V1-017`, `INT-V1-018` | Normalization in progress; exact semantics and production append prerequisites are complete. |
| Model, goal, plan, usage, compact, and skills ports | `INT-V1-019` to `INT-V1-024` | Ready from the exact semantic matrix. |
| Approval and interrupt ports | `INT-V1-025`, `INT-V1-026` | Blocked by observed semantics and event identity. |
| Assembled real structured vertical | `INT-V1-027` | Blocked by `INT-V1-017` to `INT-V1-026`. |
| Runtime process/socket supervisor | `INT-V1-007` | Blocked by the assembled real vertical. |
| Reconnect, crash, HostDeck restart, and TUI coexistence | `INT-V1-028` to `INT-V1-031` | Blocked by the supervisor, with explicit local-state prerequisites. |
| Aggregate runtime lifecycle acceptance | `INT-V1-032` | Blocked by `INT-V1-028` to `INT-V1-031`. |
| Legacy tmux disposition | `INT-V1-008` | Blocked by lifecycle acceptance and historical evidence review. |
| Reopened runtime hardening | `INT-V1-091` | Blocked by selected lifecycle, data maintenance, and legacy disposition. |

Owning backlog: `docs/tracking/backlog/tmux-output.md` (filename retained to preserve historical links; title/scope are rebaselined).

## Done Criteria

- Supported Codex versions and generated schema identity are explicit and validated.
- Real required operations and approval semantics pass with no terminal-text fallback.
- HostDeck and TUI share the runtime/thread safely.
- Restart/disconnect marks stale, interrupted, boundary, and incomplete outcomes truthfully.
- App-server remains private to the user and has one process owner per mode.
- Legacy tmux path has one explicit disposition and is absent from the selected production path.
- `INT-V1-091` passes and the block matrix links L2/L3 current evidence.
