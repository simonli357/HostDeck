# DAT-V1-020 Production Projection Append

Date: 2026-07-10

## Outcome

- Added a public `ProductionProjectionAppendPort` over the selected-state repository.
- Production callers provide one session, an unaddressed normalized event, a cursor-free next session projection, and the complete revision they read.
- Storage owns session/cursor addressing, replay-boundary `next_cursor`, exact UTF-8 bytes, retained counters, earliest cursor, and boundary metadata.
- The repository now checks mapping timestamp, projection timestamp, and last cursor inside the immediate append transaction before inserting the event and updating the projection.
- The required publisher receives a frozen committed event/projection/revision only after SQLite commit.

## Ordering Contract

1. Strictly validate input shape and prohibit caller-owned address/cursor fields.
2. Read one selected session and verify the supplied full revision matches that preparation state.
3. Assign the next contiguous cursor, validate the addressed event/session projection, and derive storage counters.
4. In one immediate transaction, re-read durable state, validate row/counter integrity, recheck the full revision, insert the event, and update the projection.
5. Freeze the committed result and invoke the captured publisher.
6. On publisher throw/rejection, return no success: throw `HostDeckProjectionPublicationError` with `durability: committed`, `publication_outcome: unknown`, and the committed result. Never roll back or republish automatically.

## Hardening Findings

- The prior low-level append had no explicit revision token. A metadata-only update could keep the same cursor and then be overwritten by an event projection built from stale state. Full revision checks before preparation and inside the transaction close both race windows.
- Replay-boundary `next_cursor` was initially still caller-controlled. The production port now rejects it and derives both cursor fields.
- Unexpected SQLite append failures were previously classified as invalid events. They now use `projection_write_failed`, while duplicate cursor/upstream identity remains `event_exists`.
- Constructor dependencies are validated and captured, and the returned port plus committed callback payload are frozen against later option or callback mutation.

## Evidence Matrix

| Case | Evidence |
| --- | --- |
| Commit before publish | Publisher reads the committed event/projection from SQLite and receives the matching revision. |
| Storage ownership | Caller `session_id`, `cursor`, replay `next_cursor`, and session `last_event_cursor` fields reject before persistence. |
| Rollback | A real SQLite trigger aborts the projection update after event insertion; the transaction leaves zero event rows and invokes no publisher. |
| Metadata concurrency | Two connections prove stale-before-read and change-after-preparation writers conflict without reverting winning name/model/summary state. |
| Event concurrency | Two connections with one revision produce one committed/published winner and one `projection_conflict`. |
| Upstream duplicate | Reusing a non-null Codex event id produces `event_exists`, one retained row, and no second publication. |
| Corruption | Counters/cursor that contradict raw event rows fail `invalid_projection` before commit/publication. |
| Publisher failure | Synchronous throw and asynchronous rejection preserve one durable event across restart, expose unknown publication, and do not auto-republish on duplicate retry. |
| Replay boundary | Storage derives matching cursor/`next_cursor`; replay returns one visible truncated boundary. |

## Validation

- Focused selected repository/production port: 27 passed.
- Full storage suite: 14 files, 95 passed.
- Root and all-package typechecks: passed.
- Lint and package exports: 194 files and 9 packages passed.
- Unit: 438 passed, 19 explicit external tests skipped.
- Contract: 111 passed; integration: 16 passed; web: 14 passed.
- Scaffold: 9 packages and 18 root scripts.
- Planning: 196 tasks, 84 requirements, 622 dependencies, 12 queued after task advancement.
- Exact Codex 0.144.0 binding: 671 files, reviewed SHA-256 identity passed.
- Production dependency audit: no known vulnerabilities.
- Manual API/transaction/raw-row review and `git diff --check`: passed.

## Remaining Ownership

- `DAT-V1-022` adds production retention/pruning and visible replay-boundary writes inside this same transaction before publication.
- `INT-V1-017` supplies strict exact-Codex event normalization and session projection updates through this port.
- `IFC-V1-018` owns replay/live fanout, health degradation, and recovery after unknown publication.
- `DAT-V1-091` still owns selected-state module hardening; this leaf does not complete the block or release.
