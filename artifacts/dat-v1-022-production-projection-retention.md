# DAT-V1-022 Production Projection Retention

Date: 2026-07-10

## Outcome

- The production projection append port snapshots a validated retention policy and passes it into every append transaction. Omitted configuration uses `defaultRetentionPolicy`.
- The selected-state repository inserts the triggering event, prunes due rows, inserts one durable `replay_boundary`, updates the final projection counters, and commits once under the existing immediate transaction.
- Publication starts only after commit and receives the triggering event with the final post-retention projection and revision.
- The boundary occupies one retained event slot. Selected production policies therefore require at least two output-event slots: one for the boundary and one for the newest real event.

## Hard Success Criteria

| Criterion | Evidence |
| --- | --- |
| Production invocation | The production port always supplies a frozen validated policy; direct port tests cross both configured caps. |
| Exact no-op | A projection exactly at the count cap remains contiguous with no boundary or deletion. |
| Count pruning | Repeated overflow deletes multiple old rows as needed and keeps total retained rows at the configured cap. |
| Byte pruning | UTF-8 serialized record bytes, including the persisted boundary, select the largest newest contiguous suffix that fits. |
| Newest oversize | The newest real event is retained even when it plus the mandatory boundary exceeds the byte cap; the exception is explicit and visible. |
| Atomic boundary | Event insert, deletion, boundary insert, counters, and projection update share one immediate transaction. |
| Failure rollback | A forced boundary-insert failure after deletion restores prior rows, removes the triggering event, preserves projection state, and publishes nothing. |
| Concurrent writers | Two stale writers produce one committed/published winner and one explicit `projection_conflict`. |
| Durable replay | Reopen preserves the boundary and a later append advances it monotonically without cursor renumbering. |
| Post-retention publication | The publisher can read the final projection and replay cursor from SQLite before it is invoked. |

## Retention Semantics

1. Validate the full policy before accepting production work; reject selected policies with fewer than two event slots.
2. Validate the current durable row aggregate and full expected revision inside the immediate transaction.
3. Insert the newest addressed event.
4. If neither cap is exceeded, update the projection without cleanup.
5. Otherwise ignore the prior synthetic boundary while selecting real events newest-first, reserve one row for a replacement boundary, and retain the largest contiguous suffix that satisfies count and byte limits.
6. Always retain the newest real event. When that event and the mandatory boundary exceed the byte limit, preserve both as the documented newest-oversize exception.
7. Delete through the new boundary cursor, insert the replacement boundary at that cursor, and persist exact aggregate count, UTF-8 bytes, earliest cursor, and monotonic boundary metadata.
8. Commit before invoking the required publisher.

## Failure And Integrity Review

- Invalid policies fail during port composition and again at the repository boundary for direct callers.
- Existing projection/row aggregate corruption, stale revisions, duplicate identities, SQLite failures, and backward boundaries fail explicitly; no retention error is swallowed.
- The triggering event is never pruned, so a successful publication always names a durable event.
- Boundary replacement preserves contiguous stored cursors while making missing older history explicit to replay consumers.
- No transcript copy, raw secret, fallback success, retry, or new dependency was introduced.

## Validation

- Focused production append/selected repository: 33 passed.
- Full storage suite: 14 files, 101 passed.
- Downstream projection service/event pipeline: 13 passed.
- Root and all-package typechecks: passed.
- Lint and package exports: 226 files and 9 packages passed.
- Unit: 571 passed, 23 explicit external tests skipped.
- Contract: 115 passed; integration: 16 passed; web: 14 passed.
- Scaffold: 9 packages and 18 root scripts.
- Exact Codex 0.144.0 binding: 671 files and reviewed SHA-256 identity passed.
- Frozen offline install and production dependency audit: passed; no known vulnerabilities.
- Planning, manual transaction/replay/raw-row review, and `git diff --check`: passed.

## Remaining Ownership

- `DAT-V1-023` owns the selected accepted-to-terminal audit state machine.
- `DAT-V1-024` owns bounded startup retention, large-backlog progress/degradation reporting, and audit cleanup invocation.
- `IFC-V1-018` owns replay/live handoff and recovery around post-commit publication.
- `DAT-V1-091` still owns full selected-state module hardening; this leaf does not complete the block or release.
