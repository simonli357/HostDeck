# BLK-V1-03 Tmux Session Lifecycle And Output Ingestion

Owns the real process adapter for HostDeck-managed Codex sessions and ordered output capture.

## Summary

- Goal: Start, list, attach, send to, stop, observe, and reconcile HostDeck-managed tmux/Codex sessions without importing arbitrary terminals.
- Required for V1: Yes.
- User/workflow value: Laptop sessions keep running while the phone disconnects, and the dashboard/CLI see truthful state instead of fake process success.
- In scope: Tmux adapter interfaces and fake adapter, real tmux target naming, Codex process launch, attach metadata, stop behavior, output reader, stream cursor events, stale detection, restart reconciliation.
- Out / deferred: `codex resume` import, arbitrary terminal discovery/import, bulk session operations, cloud relay.
- Requirement refs: `FR-001`, `FR-003` to `FR-005`, `FR-013`, `FR-014`, `NFR-002`, `NFR-005` to `NFR-007`, `PR-001`, `PR-006`, `SFR-010`.
- UX refs: `UX-002`, `UX-003`, `UX-006`, `UX-007`, `UX-009`, `IR-006`, `IR-009`.
- Decision refs: `DEC-006`, `DEC-007`, `DEC-008`, `DEC-010`, `DEC-011`.

## Local Architecture

| Part | Responsibility | Inputs | Outputs | Failure states |
| --- | --- | --- | --- | --- |
| Tmux adapter interface | Abstract tmux start/list/attach/send/stop/output operations for fakes and real adapter. | Core contracts, storage session records. | Deterministic fake behavior and real adapter commands. | Unsupported operation, missing tmux, target mismatch, invalid session id. |
| Real tmux adapter | Create named targets, launch Codex, send input, stop targets, expose attach metadata. | Codex executable path, cwd, session id/name, tmux binary. | Running tmux target and lifecycle results. | Missing binary, invalid cwd, launch failure, stale/missing target, partial start cleanup. |
| Output reader | Capture ordered output events and feed storage/API stream. | `DEC-017` live `pipe-pane` plus bounded `capture-pane` recovery, retention policy from `DEC-016`. | Monotonic HostDeck cursors, replay boundary markers, live fanout input. | Reader crash, retention boundary, invalid cursor, reordered output, unprovable continuity. |
| Restart reconciler | Compare registry records with live tmux targets at daemon startup. | Durable session registry and tmux target list. | Running or stale session state, restarted output readers. | Missing target, unknown HostDeck-looking target, unreconciled session, stale write attempt. |

## Contracts And Data

| Contract/data item | Owner | Rules | Validation |
| --- | --- | --- | --- |
| Tmux target naming | Tmux adapter | Targets must be deterministic enough for restart reconciliation and avoid colliding with arbitrary user sessions. | Fake and real adapter tests. |
| Session lifecycle transitions | Core and tmux adapter | Failed starts clean partial state or mark explicit failure; missing targets become stale, not recreated. | Lifecycle unit tests and restart integration tests. |
| Output events and cursors | Tmux adapter/storage/server | Cursors are monotonic per session and expose replay/truncation boundaries. | Output ordering, reconnect, and retention tests. |
| Attach metadata | Tmux adapter/CLI | Laptop attach path is explicit and fails for stale/missing targets. | CLI/manual tmux attach smoke. |

## Implementation Blueprint

| Slice | Goal | Epics/tasks | Dependencies | Exit evidence |
| --- | --- | --- | --- | --- |
| Foundation | Build fake adapter, real adapter skeleton, and output capture spike. | Backlog must create leaf tasks for adapter interface, fake adapter, `SPK-ARCH-001`, tmux target naming, real start/list/send/stop, output reader, and registry integration. | `BLK-V1-01`, `BLK-V1-02`, `SPK-ARCH-001`; retention resolved by `DEC-016`. | Fake adapter tests and spike artifact. |
| Hardening | Prove process failures, stale targets, restart reconciliation, output ordering, and write rejection. | Backlog must create hardening tasks for missing tmux/Codex, invalid cwd, partial start cleanup, stale target, reader failure, cursor boundary, and restart recovery. | Foundation adapter/output tasks. | Real tmux smoke and negative-test artifacts. |
| Release readiness | Provide Ubuntu smoke instructions and capture supported tmux/Codex assumptions. | Backlog must create docs/release tasks through `BLK-V1-06` once commands exist. | Real adapter works. | Release smoke artifact with OS/tool versions. |

## Validation Plan

| Layer | What to prove | Evidence |
| --- | --- | --- |
| Unit | Lifecycle transition helpers, target naming, stale/write eligibility integration. | Planned `pnpm test:unit` output. |
| Integration | Fake adapter start/list/send/stop, output ordering/replay, restart reconciliation. | Planned `pnpm test:integration` output. |
| System / E2E | Daemon starts real managed tmux sessions and API/CLI can observe them. | Later API/CLI and release smoke artifacts. |
| Manual / device | Ubuntu tmux smoke with at least two sessions, attach, send, stop, restart, stale behavior. | Tmux smoke artifact. |

## Backlog Links

| Epic | Leaf tasks | Status | Evidence |
| --- | --- | --- | --- |
| Tmux capture spike and adapter foundation | `INT-V1-001`, `INT-V1-010` to `INT-V1-013` | In progress: `INT-V1-001` and `INT-V1-010` done; real tmux target work next | `artifacts/int-v1-001-tmux-capture-spike.md`, `artifacts/int-v1-010-fake-tmux-adapter.md`, `docs/tracking/backlog/tmux-output.md` |
| Output and restart | `INT-V1-014` to `INT-V1-016` | Planned | `docs/tracking/backlog/tmux-output.md` |
| Tmux hardening | `INT-V1-090` | Planned | `docs/tracking/backlog/tmux-output.md` |

## Done Criteria

- Fake adapter supports deterministic lifecycle, output, and failure tests.
- Real adapter validates tmux and Codex availability before accepting starts.
- Managed sessions use stable target metadata and are not confused with arbitrary terminals.
- Output capture preserves order, cursor semantics, and retention boundaries.
- Restart reconciliation marks missing targets stale and rejects stale writes.
- Manual Ubuntu tmux smoke evidence exists.
- Block evidence is recorded in this file, owning tasks, or artifacts.
- V1 completion matrix in `00-index.md` is updated.

## Open Questions / Spikes

| ID | Question | Owner | Exit evidence |
| --- | --- | --- | --- |
| `SPK-ARCH-001` | Can tmux `pipe-pane` or an equivalent mechanism provide ordered, reconnectable per-session output for V1? | Resolved by `DEC-017` / `INT-V1-001` | `artifacts/int-v1-001-tmux-capture-spike.md`. |
| `SPK-ARCH-004` | What output and audit retention caps should V1 use? | Resolved by `DEC-016` / `DAT-V1-003` | `artifacts/dat-v1-003-retention-caps-spike.md`. |
