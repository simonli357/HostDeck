# INT-V1-108 Native Session Adoption Service

Status: passed

## Result

- Discovery returns only bounded unmanaged native identities and never native history.
- Adoption serializes membership changes, validates native identity before and after bounded history capture, atomically commits mapping/projection/events/membership, then resumes the unchanged Codex thread id exactly once.
- A failed post-commit resume durably marks the session stale and recovery-required. Queued cancellation commits nothing and reports an explicit timeout.
- Adopted `cli`-source threads are accepted only with exact durable membership during regular and restart reconciliation. Unmanaged CLI notifications remain outside projection.
- Quiet unmanage removes only HostDeck state, sends no Codex mutation, waits behind in-flight event publication, clears normalizer membership, and permits clean re-adoption of the same thread.

## Validation

| Gate | Result |
| --- | --- |
| Affected matrix | 121/121 passed across adapter parsing/normalization and server projection, event, managed-thread, restart, and adoption services. |
| Concurrency | Adoption race, queued cancellation, activation/event race, publication/unmanage ordering, and clean re-adoption passed. |
| Exact Codex | Pinned `0.144.0` standalone shell-only CLI thread adopted by unchanged id, survived SQLite reopen, unmanaged, and remained natively readable; no model turn. |
| Static | Adapter/server typechecks, focused Biome, selected-runtime boundary, and 275-task planning graph passed. |
| Privacy/destruction | Discovery omits history; projection retains only bounded user/agent terminal history; unmanage issues no Codex create/fork/archive/delete request; exact smoke retains no transcript evidence and removes temporary resources. |

## Remaining Boundary

- No public command or HTTP route exposes this service yet. `IFC-V1-110` owns local-only API/CLI gates, audit/idempotency, production composition, packaging, and command documentation.
