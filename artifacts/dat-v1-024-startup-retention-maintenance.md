# DAT-V1-024 Startup Retention Maintenance

Date: 2026-07-10

## Outcome

- `runStartupRetentionMaintenance` snapshots one strict retention policy and wall-clock cutoff, then alternates independently budgeted output and audit work under one monotonic deadline.
- Output maintenance materializes at most the configured real-event batch plus boundary lookahead, deletes only oldest real events, replaces or advances one durable replay boundary, and updates projection aggregates from committed rows.
- Audit maintenance materializes at most the configured record batch plus one sentinel. It deletes complete terminal operation trails only and protects accepted-only operations for `DAT-V1-030`.
- Forward-only migration `202607100008_selected_retention_indexes` adds the covering audit candidate index without rewriting migration 007 or retained audit rows.
- The frozen result distinguishes complete scans, definite work, unknown work, known minimum-retained-set exceptions, protected pending operations, deadline/abort limits, clock failure, concurrent output drift, and storage failure.

Implementation: `93f79a0`.

## Hard Success Criteria

| Criterion | Evidence |
| --- | --- |
| Fixed configuration | Exact option keys, policy schema, output minimum of two slots, bounded batch/deadline values, wall clock, supported cutoff, monotonic clock, database shape, and abort signal validate before mutation. The policy and cutoff are captured once. |
| Bounded output batch | Each transaction reads at most `max_pruned_events + 2` oldest rows, prunes at most the configured real-event count, and preserves the newest real event. |
| Exact output state | Existing aggregates and cursor contiguity validate before mutation. Delete count, replacement boundary, raw aggregate recomputation, projection update, and post-write integrity check share one immediate transaction. |
| Durable output resume | Partial batches persist only rows, projection counters, and the advanced boundary. Reopen and stricter-policy runs recompute work without an in-memory cursor. |
| Output exceptions | A single newest event or boundary-plus-newest minimum set that exceeds the byte cap remains durable and is returned explicitly; it is not retried forever or reported compliant. |
| Bounded audit candidates | Age and count candidates use separate indexed reads with a combined `max_deleted_records + 1` limit. Only selected candidate and newest trails, each at most two records, are materialized and contract-validated. |
| Whole audit trails | Rejection deletes one terminal row; dispatched completion deletes accepted plus terminal together. Exact row-count checks and one immediate transaction prevent phase splitting. |
| Pending protection | Accepted-only operations are never deleted. Exact protected count, age/count blocking, and tri-state remaining truth are returned for later orphan reconciliation. |
| Audit exceptions | Age cleanup may remove the newest terminal trail. Count cleanup preserves the newest operation; a two-row newest trail under a one-row cap is explicit. |
| Independent budgets | Output and audit alternate one batch at a time and have separate batch ceilings, so one backlog cannot consume the other scope's allowance. |
| Deadline and abort truth | Guards run before every transaction. A transaction that completes after the deadline remains committed but the final result is degraded with `timeout`; no asynchronous SQLite interruption or rollback is invented. |
| Failure truth | Config errors throw before mutation. Runtime storage/clock failures return a bounded code and unknown fields where truth was not established; no failure path reports complete. |
| Concurrency and repetition | Immediate transactions serialize writers. Two-connection append/terminal interleavings, second-runner resume, exact-budget completion, repeated runs, and reopen preserve newest data and idempotence. |
| Immutable diagnostics | Result, nested scope results, reason list, failure, and exception id list are frozen; no event/audit payload or raw thrown error is retained. |

## Result Model

- `actionable_remaining: true` means a validated current batch proved more deletable work.
- `actionable_remaining: false` requires a complete scan or an exact final count containing only identified exceptions.
- `actionable_remaining: null` means timeout, abort, failure, or an exhausted scan budget prevented a truthful determination.
- `policy_violation_session_count` is the final scalar count of output projections still above the fixed policy; known newest-event exceptions are listed separately.
- Protected pending audit operations are counted separately from deletable work and degrade only when they block age/count policy.

## Transaction And Query Inspection

- Projection maintenance uses the `(session_id, cursor)` primary key for ordered bounded lookahead and deletion. Manual raw-row inspection confirmed monotonic boundary replacement and exact `COUNT/SUM/MIN/MAX` projection state.
- Audit age and count candidate plans use covering index `selected_audit_events_phase_at_operation_idx (phase, at, operation_id)`; correlated trail sizes use the existing unique `(operation_id, phase)` index.
- Audit total/pending truth uses scalar aggregates and materializes no unbounded record collection. Candidate deletion remains bounded even when retained history exceeds the current policy.
- Forced boundary insert and audit delete triggers proved complete rollback. Corrupt candidate/newest rows fail before deletion.

## Validation

- Startup retention matrix: 18 passed.
- Migration plus startup retention matrix: 29 passed.
- Storage suite: 132 passed.
- Unit: 655 passed; 25 explicit external tests skipped.
- Contract: 115 passed; integration: 16 passed; web: 14 passed.
- Root and storage typechecks: passed.
- Lint/package exports: 240 files and 9 packages passed.
- Scaffold: 9 packages and 18 root scripts.
- Planning: 196 tasks, 84 requirements, 626 dependencies, 8 queued before closure.
- Exact Codex 0.144.0 binding: 671 files; SHA-256 `e1a1a5cff3ab91862f9215dd06538eae1ea0b00bae48cbb7d87061faaee27e24`.
- Frozen install, production audit (0 vulnerabilities across 121 dependencies), migration checksum/preservation review, query-plan inspection, raw SQLite state review, and `git diff --check`: passed.

## Remaining Ownership

- `DAT-V1-030`: reconcile policy-eligible accepted-only operations to explicit `incomplete` terminal records before audit retention can remove them.
- `IFC-V1-036`: compose the proven runner into selected startup/readiness and project degraded reasons into mutable health.
- `DAT-V1-091`: aggregate selected storage/audit retention, corruption, restart, concurrency, and privacy hardening.
- No setup, command, dependency, product-scope, or delivery-guide fact changed; Tier 1 task/artifact/status updates are sufficient.
