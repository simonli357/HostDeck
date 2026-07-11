# DAT-V1-030 Orphan Audit Reconciliation

Date: 2026-07-11

## Outcome

- `reconcileSelectedAuditOrphansBatch` selects only accepted-only trails whose canonical acceptance timestamp is strictly before one explicit `eligible_before` cutoff.
- Each selected operation gains one separate `incomplete` terminal at the fixed `reconciled_at` timestamp with `runtime_unavailable`; the accepted row, actor, action, exact target, and operation id remain unchanged.
- Terminal ids use a deterministic SHA-256-derived internal id and terminal payload is the fixed secret-free summary `host_restart_without_terminal`.
- `runStartupAuditOrphanReconciliation` repeats bounded batches under the shared startup monotonic clock/deadline owner and returns frozen progress, protected-recent counts, tri-state remaining truth, and bounded reasons/failure.
- Existing retention treats reconciled operations as ordinary complete terminal trails and deletes both phases together when later count/age policy selects them.

Implementation: `95f7fc9`.

## Hard Success Criteria

| Criterion | Evidence |
| --- | --- |
| Exact eligibility | Only pending trails with `accepted.at < eligible_before` are candidates. Cutoff-equal/newer accepted rows are counted as protected recent operations and remain byte-for-byte unchanged. |
| Fixed chronology | Canonical timestamps validate before mutation; `reconciled_at >= eligible_before`, so every generated terminal follows its eligible accepted record. |
| Bounded candidate work | One indexed query materializes at most `max_reconciled_operations + 1` operation ids; each selected trail contains exactly one accepted row before reconciliation. |
| Append-only truth | Reconciliation inserts a second terminal row and never updates/relabels accepted truth. Strict trail validation proves operation, actor, action, target, phase, outcome, timestamp, payload, and error continuity. |
| Honest outcome | Crash ambiguity becomes only `incomplete/runtime_unavailable`; reconciliation never invents succeeded, failed, or rejected. |
| Deterministic restart | Terminal ids derive from the operation id. Durable phase uniqueness, not an in-memory cursor, owns idempotence across retry, second runner, and reopen. |
| Atomic batch | Candidate revalidation and every terminal insert share one immediate transaction. A forced failure on a later operation rolls back all earlier terminals in that batch. |
| Concurrent terminal | A worker-held real terminal transaction wins before reconciliation and remains unchanged; when reconciliation wins, a later real terminal is rejected by the existing one-terminal contract. |
| Existing terminals | Rejected/succeeded/failed/incomplete terminal trails are excluded and never rewritten. |
| Corruption | Contradictory eligible accepted columns/JSON fail before terminal insertion. No fallback skips malformed truth and reports completion. |
| Bounded runner | Exact option keys, database shape, timestamps, operation/batch/deadline bounds, monotonic clock, and abort signal validate before mutation. Batch limit, timeout, abort, clock, and storage failures are explicit. |
| Tri-state progress | `true` means the last committed batch proved eligible work remains; `false` requires an exact completed scan; `null` means no truthful determination after pre-scan abort or failed storage work. |
| Shared deadline owner | Retention and orphan runners use one startup clock helper for initial validation, clock-regression failure, between-transaction abort/timeout checks, final overrun reporting, and duration. |
| Retention interoperability | A reconciled two-row incomplete trail is later removed atomically by ordinary count retention while the newer trail remains. |

## Query And State Inspection

- Manual `EXPLAIN QUERY PLAN` confirms candidate selection uses covering index `selected_audit_events_phase_at_operation_idx (phase, at, operation_id)`.
- The `NOT EXISTS` terminal lookup uses the unique `(operation_id, phase)` index.
- Raw SQLite inspection confirms accepted `record_json` is unchanged, each reconciled operation has exactly two rows, generated terminal payload contains only the fixed reason, and no duplicate terminal survives runner interleaving.
- Pending totals use scalar aggregates; record collections remain bounded to the configured candidate batch.

## Validation

- Direct orphan batch/runner matrix: 14 passed, including real worker-held SQLite contention.
- Combined retention/orphan runner matrix: 32 passed.
- Adjacent selected audit, migration, retention, and orphan matrix: 55 passed.
- Storage suite: 147 passed.
- Unit: 669 passed; 25 explicit external tests skipped.
- Contract: 115 passed; integration: 16 passed; web: 14 passed.
- Root/storage typechecks and lint/package exports: 243 files and 9 packages passed.
- Scaffold: 9 packages and 18 root scripts.
- Planning: 196 tasks, 84 requirements, 626 dependencies, 8 queued before closure.
- Exact Codex 0.144.0 binding: 671 files; SHA-256 `e1a1a5cff3ab91862f9215dd06538eae1ea0b00bae48cbb7d87061faaee27e24`.
- Frozen install, production audit (0 vulnerabilities across 121 dependencies), query-plan/raw-state/privacy review, and `git diff --check`: passed.

## Remaining Ownership

- `IFC-V1-036` chooses the startup cutoff, runs orphan reconciliation before audit retention, and projects incomplete/protected/degraded truth into readiness.
- `INT-V1-029` consumes this durable incomplete truth during runtime crash/restart continuity reconciliation after `INT-V1-028`.
- `IFC-V1-037` uses the same append-only terminal path during graceful shutdown when accepted mutations cannot be proven terminal.
- `DAT-V1-091` re-runs aggregate selected storage/audit hardening after the remaining auth and security leaves.
