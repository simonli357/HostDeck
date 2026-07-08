# BLK-V1-XX Block Name

Owns local architecture, detailed design, implementation sequence, validation, epics, and task links for one active-version capability block.

Keep this concise. Link global docs instead of duplicating them.

## Summary

- Goal: Replace with the block outcome.
- Required for V1: Yes or no.
- User/workflow value: Replace with the user or operator value.
- In scope: Replace with owned capabilities.
- Out / deferred: Replace with explicit exclusions.
- Requirement refs: Replace with requirement IDs.
- UX refs: Replace with UX flow or interface refs when relevant.
- Decision refs: Replace with decision IDs.

## Local Architecture

| Part | Responsibility | Inputs | Outputs | Failure states |
| --- | --- | --- | --- | --- |
| Replace with part | Replace with responsibility | Replace with inputs | Replace with outputs | Replace with failures |

## Contracts And Data

| Contract/data item | Owner | Rules | Validation |
| --- | --- | --- | --- |
| Replace with contract or data item | Replace with package or doc owner | Replace with invariants | Replace with tests or inspection |

## Implementation Blueprint

| Slice | Goal | Epics/tasks | Dependencies | Exit evidence |
| --- | --- | --- | --- | --- |
| Foundation | Smallest working path for this block | Replace with expected epics/tasks | Replace with dependencies | Replace with evidence |
| Hardening | Production-grade behavior for this block | Replace with expected epics/tasks | Replace with dependencies | Replace with evidence |
| Release readiness | Docs, setup, acceptance, and handoff for this block | Replace with expected epics/tasks | Replace with dependencies | Replace with evidence |

## Validation Plan

| Layer | What to prove | Evidence |
| --- | --- | --- |
| Unit | Replace with unit proof | Replace with command or artifact |
| Integration | Replace with integration proof | Replace with command or artifact |
| System / E2E | Replace with system proof | Replace with command or artifact |
| Manual / device | Replace with manual proof | Replace with artifact |

## Backlog Links

| Epic | Leaf tasks | Status | Evidence |
| --- | --- | --- | --- |
| Replace with epic | Replace with task links after backlog decomposition | Planned | Replace with evidence |

## Done Criteria

- Required requirements are implemented or explicitly deferred.
- Primary happy path works end to end.
- Important edge cases and failure states are validated.
- Contracts, data, and adapters fail loudly for invalid state or missing config.
- Screen states, accessibility, device behavior, and visual fidelity are inspected when this block has UI.
- Block evidence is recorded in this file, owning tasks, or artifacts.
- V1 completion matrix in `00-index.md` is updated.

## Open Questions / Spikes

| ID | Question | Owner | Exit evidence |
| --- | --- | --- | --- |
| SPK-BLK-V1-XX-01 | Replace with spike question or `None` | Replace with owner | Replace with artifact or decision |
