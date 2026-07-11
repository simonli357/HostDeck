# DAT-V1-023 Selected Audit Operation State Machine

Date: 2026-07-10

## Outcome

- Forward-only migration `202607100007_selected_audit_state` adds append-only `selected_audit_events` without rewriting the historical audit table or its rows.
- `createSelectedAuditRepository` exposes explicit `recordAccepted`, `recordRejected`, and `recordTerminal` transitions plus strict operation-id lookup.
- One operation has exactly one legal shape: standalone pre-dispatch `rejected`, pending `accepted`, or `accepted` followed by one `succeeded`, `failed`, or `incomplete` terminal record.
- Accepted truth is a separate immutable row. A crash leaves it durably queryable as pending; later code can append a terminal outcome but cannot relabel the accepted record.

## Hard Success Criteria

| Criterion | Evidence |
| --- | --- |
| Forward-only state | Fresh and six-migration databases add migration 007 transactionally; published migration checksums remain fixed and a seeded historical audit row is unchanged. |
| Legal state graph | Repository methods admit only standalone rejection or accepted-to-terminal trails. Non-rejection terminal-before-accepted, accepted-after-rejected, duplicate phases, and second terminals reject. |
| Exact continuity | Operation id, record id, actor/device/permission/origin, action, and exact target remain coherent across phases. Approval, turn, device, session, and host targets retain their complete typed identity. |
| Complete action inventory | All 19 selected actions persist through their required target shapes, including approval, interrupt, pairing, device, LAN, and certificate actions. |
| Honest chronology | Terminal order compares parsed instants rather than ISO string order; positive and negative offset cases prove both directions and equal instants remain legal. |
| Bounded private data | Contract validation rejects unknown actions, incoherent outcomes/errors, sensitive keys, nested values, and oversized summary values before SQLite. Stored record JSON is also capped at 65,536 UTF-8 bytes. |
| Append-only truth | SQLite rejects every row update. Terminal outcomes are separate inserts, and retention may later delete rows only through its owning policy. |
| Atomic failure | Immediate transactions combine current-trail validation and insert. Forced `AFTER INSERT` aborts leave no accepted row or leave the prior accepted-only trail unchanged. |
| Real connection serialization | A worker connection holds a real `BEGIN IMMEDIATE` transaction after inserting each winning phase while a second repository connection contends; one accepted and one terminal row survive. |
| Corruption handling | Structural columns are cross-checked against strict record JSON. Contradictory columns, actor continuity drift, impossible raw transitions, malformed stored truth, and closed storage fail loudly. |
| Restart truth | Reopen returns accepted-only work as pending, preserves the exact accepted JSON, and appends explicit `incomplete` without rewriting it. |

## Durable Model

`selected_audit_events` stores immutable record id, operation id, timestamp, action, phase, outcome, nullable error code, and the complete strict record JSON. The table has:

- a primary key on record id;
- one unique row per operation and phase;
- an `(at, id)` retention index;
- phase/outcome/error constraints;
- start-empty, terminal-requires-accepted, and no-update triggers;
- valid-JSON and 64 KiB record bounds.

The repository runs both transitions under immediate SQLite transactions and re-reads committed state inside the transaction. It never retries a write, converts pending to success, truncates hidden fields, or treats a database failure as acceptance.

## Compatibility And Scope

- The historical `audit_events` repository remains unchanged for legacy callers and retained evidence. Selected app-server operations use the new typed repository when their API/application owners wire them.
- Audit targets intentionally have no foreign key to selected sessions: rejection of a missing target must still be auditable, and retained audit identity must not disappear with session lifecycle changes.
- `DAT-V1-024` owns production count/age cleanup and startup maintenance for selected audit rows.
- `DAT-V1-030` owns bounded startup conversion of policy-eligible orphaned accepted operations to explicit `incomplete` outcomes.
- `DAT-V1-027` and interface write tasks own selected security/action caller integration. This leaf proves the storage boundary, not those routes.

## Validation

- Selected audit repository: 12 passed, including complete action inventory, real two-connection lock contention, forced rollback, append-only restart, raw corruption, and unavailable storage.
- Focused selected audit plus migration: 22 passed.
- Full storage suite: 15 files, 114 passed.
- Selected path contract: 22 passed; full contract suite: 115 passed.
- Root and all 9 package typechecks: passed.
- Lint and package exports: 236 files and 9 packages passed.
- Unit: 624 passed, 25 explicit external tests skipped.
- Integration: 16 passed; web: 14 passed.
- Scaffold: 9 packages and 18 root scripts.
- Planning: 196 tasks, 84 requirements, 626 dependencies, 8 queued.
- Exact Codex 0.144.0 binding: 671 files; SHA-256 `e1a1a5cff3ab91862f9215dd06538eae1ea0b00bae48cbb7d87061faaee27e24`.
- Migration 006 remains SHA-256 `b82cd7abd76ab71ab73d7b361cd318dd862edd64749ce64942598c6f972e90fa`; migration 007 is `965189761889f62c787c07f190b5c0aa76d90f17b00b4f97fcbe46121bfec9f2`.
- Frozen offline install, production dependency audit, planning, manual state/SQL/privacy review, and `git diff --check`: passed; no known vulnerabilities.

## Remaining Ownership

- `DAT-V1-024`: bounded selected output/audit startup retention and progress/degradation reporting.
- `DAT-V1-030`: orphan accepted-operation reconciliation after crash.
- `DAT-V1-027`: security-action persistence through this repository.
- `IFC-V1-019` and later write-route leaves: public route inventory and accepted/terminal application orchestration.
- `DAT-V1-091`: aggregate selected-state module hardening.
