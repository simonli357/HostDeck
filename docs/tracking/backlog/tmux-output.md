# Integrations / Tmux Output Backlog

Owns `BLK-V1-03`: tmux adapter, Codex process lifecycle, output ingestion, restart reconciliation, and real Ubuntu smoke evidence.

## EP-INT-01 Tmux Capture Spike And Adapter Foundation

| ID | Status | Refs | Requires | Blocked by | Blocks | Description | Success criteria | Validation / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `INT-V1-001` | blocked | `BLK-V1-03`, `SPK-ARCH-001`, `FR-005`, `FR-013`, `DR-008` | Ubuntu with tmux | `tmux` binary unavailable in current environment | `INT-V1-014`, `IFC-V1-003` | Prototype tmux output capture with fake Codex output. | Chosen mechanism preserves order, survives reader restart as designed, supports cursor/replay boundary semantics, and documents failure modes. | Blocker observed on 2026-07-08: `command -v tmux && tmux -V` exited 1 with no output. Spike artifact with commands, tmux version, captured events, chosen mechanism, rejected options remains required. |
| `INT-V1-010` | ready | `BLK-V1-03`, `FR-001`, `FR-003`, `NFR-007`, `PR-001` | none | none | `INT-V1-011`, `INT-V1-013`, `IFC-V1-002` | Define tmux adapter interface and deterministic fake adapter. | Fake adapter supports start/list/send/stop/attach/output/stale cases without real Codex model calls. | Unit/integration tests for fake lifecycle and failure cases. |
| `INT-V1-011` | todo | `BLK-V1-03`, `FR-001`, `FR-014`, `DR-007`, `PR-006` | Ubuntu with tmux | `INT-V1-010` | `INT-V1-012`, `INT-V1-015` | Implement real tmux target naming, target lookup, and list/reconcile primitives. | Targets are deterministic enough for restart reconciliation and do not import arbitrary terminals. | Fake and real adapter tests for target naming, live target list, missing target. |
| `INT-V1-012` | todo | `BLK-V1-03`, `FR-001`, `NFR-005`, `PR-001`, `PR-006` | Ubuntu with tmux and Codex CLI | `INT-V1-011` | `INT-V1-013`, `IFC-V1-007` | Implement managed Codex session start with cwd validation and partial-failure cleanup. | Missing Codex, invalid cwd, duplicate name, and launch failure return explicit errors; partial tmux/registry state is cleaned or marked failed. | Adapter integration tests plus negative start cases. |
| `INT-V1-013` | todo | `BLK-V1-03`, `FR-003`, `FR-004`, `FR-006`, `SFR-010` | Ubuntu with tmux | `INT-V1-012`, `FND-V1-004` | `IFC-V1-004`, `IFC-V1-007`, `INT-V1-016` | Implement send, stop, and attach metadata operations. | Send targets exactly one writable session; stop is explicit; attach fails for stale/missing targets and prints usable metadata when needed. | Adapter tests for send/stop/attach, stale/missing target, and exact target selection. |

## EP-INT-02 Output And Restart

| ID | Status | Refs | Requires | Blocked by | Blocks | Description | Success criteria | Validation / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `INT-V1-014` | todo | `BLK-V1-03`, `FR-005`, `FR-013`, `DR-004`, `DR-008`, `IR-009` | Ubuntu with tmux | `INT-V1-001` | `IFC-V1-003`, `FE-V1-012`, `FE-V1-015` | Implement output reader, cursor assignment, storage append, and replay-boundary handoff. | Output order is per-session monotonic; invalid/stale cursors and retention boundaries are explicit; reader failure is observable. | Output ordering/reconnect/retention tests plus reader failure test; storage retention primitives are available from `DAT-V1-015`. |
| `INT-V1-015` | todo | `BLK-V1-03`, `FR-014`, `NFR-002`, `DR-007`, `SFR-010` | Ubuntu with tmux | `INT-V1-011`, `DAT-V1-016` | `IFC-V1-001`, `IFC-V1-004` | Implement restart reconciliation between durable registry and live tmux targets. | Live targets become running/known; missing targets become stale; unknown HostDeck-looking targets are ignored or flagged without import; stale writes reject. | Restart integration test with live, missing, and unknown targets. |
| `INT-V1-016` | todo | `BLK-V1-03`, `FR-001` to `FR-004`, `NFR-002`, `PR-001` | Ubuntu with tmux and Codex CLI | `INT-V1-013`, `INT-V1-014`, `INT-V1-015` | `REL-V1-006`, `INT-V1-090` | Create real Ubuntu tmux smoke path for managed sessions. | Smoke starts at least two sessions, attaches/prints target metadata, sends input to one, stops one, restarts daemon, and verifies stale behavior. | Artifact with Ubuntu version, tmux version, commands, outputs, and gaps. |

## EP-INT-03 Tmux Hardening

| ID | Status | Refs | Requires | Blocked by | Blocks | Description | Success criteria | Validation / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `INT-V1-090` | todo | `BLK-V1-03`, `04b:Startup And Config Matrix`, `production-hardening` | Ubuntu with tmux | `INT-V1-016` | `REL-V1-008` | Harden tmux lifecycle, output, attach, restart, and stale-session handling. | Missing tmux/Codex, invalid cwd, partial start, reader crash, missing target, stale cursor, and repeated start/stop cycles fail loudly and are inspected. | Hardening artifact with automated output, manual tmux smoke, failure cases, remaining gaps, and block matrix update. |
