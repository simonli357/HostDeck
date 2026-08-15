# INT-V1-113 Automatic Session Enrollment

## Result

- Reconciles every bounded loaded root and enrolls eligible ordinary Codex TUI sessions by exact native UUID.
- Handles roots loaded before HostDeck and roots created or resumed afterward without creating a turn.
- Imports a bounded user/agent history suffix, subscribes before mapping, and replays buffered live notifications in order without duplicating imported turns/items.
- Commits deterministic identity, projection events, membership, and accepted-to-terminal audit truth through the production storage/event pipeline.
- Bounds pending threads, events, bytes, retries, and deadlines. Invalid metadata, capacity, generation changes, audit/storage failures, and replay failures terminate explicitly with no silent fallback.
- Reconciliation, concurrent clients, and HostDeck reconnect converge on one durable mapping. Ineligible child, subagent, ephemeral, incompatible, noninteractive, and invalid-path roots remain absent.

## Validation

- Focused adapter/server/storage/event tests: 4 files, 36 tests passed.
- Full unit: 289 files, 3,276 tests passed; 32 files and 34 intentional smoke tests skipped.
- Contract: 44 files, 307 tests passed. Integration: 21 files, 36 tests passed.
- Exact Codex 0.147.0 standard-socket smoke passed twice with one ordinary TUI loaded before HostDeck and one created afterward; both exact UUIDs enrolled, reconnect produced no duplicate, no turn was started, and process/socket/temp cleanup completed.
- Typecheck, lint/package exports, scaffold, selected-runtime boundary, deterministic Codex binding, and diff checks passed.

## Remaining Boundary

`IFC-V1-111` composes this service into the selected API/CLI runtime, removes superseded adoption administration, and exposes native UUID targeting. Catalog SSE and browser consumption remain downstream tasks.
