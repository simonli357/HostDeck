# DAT-V1-091 Selected Local-State Hardening

Date: 2026-07-12

Status: hard-success criteria frozen; execution pending.

## Purpose

Re-run production hardening across the complete selected local-state, authentication, and audit module after every `DAT-V1-018` through `DAT-V1-030` leaf is complete. This gate must prove that the selected repositories share one real migrated SQLite database and preserve coherent truth across restart, failure, retention, authentication, and privacy boundaries. Passing isolated leaf tests is necessary but is not sufficient.

## Selected Scope

The aggregate owns evidence for these already-selected boundaries:

- forward-only migrations and current-schema opening;
- selected session mapping, projection, projected events, start recovery, and legacy dispositions;
- production projection append and append-time retention;
- persisted runtime compatibility;
- append-only selected audit, orphan reconciliation, and startup audit/output retention primitives;
- current auth-device, CSRF rotation, device-list, revoke, selected pairing issuance/rate/claim, and monotonic last-used repositories;
- secure local path preparation, secure database-file opening, and the single-daemon descriptor lease.

Historical `sessions`, `session_metadata`, `output_events`, `audit_events`, settings, legacy pairing, and legacy retention repositories remain migration compatibility surfaces. Their continued schema presence must be inspected, but this gate must not treat the historical host-service/CLI composition as the selected production runtime.

## Frozen Aggregate Scenario

One test-owned state root and one on-disk database must exercise the following lifecycle without repository-specific replacement databases:

1. Resolve and prepare owner-only state paths, acquire the daemon lease, securely create/open the database file, and apply all published migrations.
2. Persist selected runtime compatibility, one managed-session mapping, start-recovery truth, a selected projection, and committed projected events through the production append port with due retention.
3. Issue and claim a selected high-entropy pairing code; rotate CSRF state; authenticate and monotonically touch the device; list it; then revoke it and prove subsequent authority checks fail.
4. Persist representative rejected, accepted-to-terminal, and accepted-only selected audit trails, including at least one current security action.
5. Close every handle, release the lease, reopen the same paths/database, and prove exact durable state plus expected absence of raw ephemeral credentials and in-memory publication state.
6. Reconcile only eligible accepted-only audit work, then run retention in the required primitive order and prove protected/newer work and replay boundaries remain truthful.
7. Inspect schema, indexes, triggers, query plans, row aggregates, filesystem modes, SQLite health results, and raw database sidecar bytes.

The scenario may use deterministic entropy and clocks only through existing injected test ports. It must use production repository constructors and real SQLite transactions. Direct SQL is limited to fixture seeding where no selected public write API exists, deliberate corruption, and independent state inspection.

## Hard Success Criteria

| Criterion | Required evidence |
| --- | --- |
| Exact migration lineage | All 11 published migration versions and checksums remain unchanged and ordered. Fresh, prior-version, current read-only reopen, unknown migration, sequence gap, checksum mismatch, untracked schema, and failed-migration rollback evidence pass. No migration is rewritten for this aggregate. |
| Current schema health | The aggregate database reports `foreign_keys = 1`, `quick_check = ok`, and no `foreign_key_check` rows. Exact selected tables, indexes, and append-only audit triggers exist after reopen. Health inspection is evidence, not a new claim that every production startup performs an unbounded full integrity scan. |
| One durable source of truth | Selected mapping, recovery, projection, event, compatibility, auth, pairing-rate, and audit repositories coexist in one database. Close/reopen preserves exact committed rows and counters; no test substitutes an in-memory mirror or reconstructs durable truth from expected values. |
| Session saga truth | A pre-runtime-id reservation, runtime-id persistence, selected mapping/projection state, and recoverable start state preserve their documented distinctions. Ambiguous or incomplete startup state remains explicit and cannot become a duplicate hidden session or fabricated success. Existing concurrency/corruption leaf evidence is linked rather than weakened. |
| Commit-before-publication | Production projection append commits event, projection, counters, and due retention boundary atomically before publication. Rollback publishes nothing; publication uncertainty does not relabel committed storage. Restart reads the committed state independently of publication memory. |
| Bounded projection retention | Count and UTF-8 byte policy is invoked by the production append path, preserves the newest event, advances a durable monotonic replay boundary, and exposes retained aggregate truth after reopen. Startup batches remain bounded and resumable. |
| Runtime compatibility durability | Exact selected version/schema/capability/check state survives restart and malformed or contradictory stored data fails through its owning repository without a permissive compatibility fallback. |
| Append-only audit truth | Rejected trails contain one terminal row; accepted operations contain a separate accepted row and at most one terminal. Current security summaries remain versioned and secret-free. Accepted-only work survives restart as pending and can only gain a truthful terminal. |
| Startup ordering interoperability | Eligible orphan audit reconciliation runs before audit retention in the aggregate evidence. Reconciliation creates only `incomplete/runtime_unavailable`; cutoff-equal/newer accepted work stays protected; later retention removes only complete trails and never splits phases. This proves primitive interoperability, not the still-owned daemon readiness composition. |
| Authentication lifecycle | Selected pairing issuance persists only hashes/metadata; one claim wins; CSRF rotation increments authority; successful auth advances `last_used_at` monotonically; listing remains bounded/non-secret; revoke atomically invalidates bearer and CSRF authority and survives restart. Read/write permission distinctions remain explicit. |
| Auth races remain real | Existing two-connection/worker evidence covers pairing claim, CSRF rotation, monotonic auth, revoke ordering, and audit terminal contention. The aggregate links exact cases and adds cross-repository state assertions; it must not replace real contention with sequential mocks. |
| Failure isolation | Deliberate corruption in one selected domain causes its owning read or maintenance operation to fail loudly. No fallback skips the row, returns partial trusted truth, repairs it silently, or mutates unaffected selected domains. Failed multi-row work leaves pre-operation aggregates unchanged. |
| Secure filesystem ownership | State/runtime directories and database/lease files have the selected owner-only modes and canonical identities. A second daemon lease fails while held and succeeds after clean release/restart. Existing hostile link, ownership, substitution, and child-crash evidence remains part of the gate. No claim is made against a malicious same-UID process. |
| Raw-secret and transcript absence | Unique sentinels for pairing code, bearer token, CSRF token, private material, and an attempted unapproved full-transcript payload are absent from selected rows, SQLite main/WAL/SHM bytes, path names, repository errors, and durable audit summaries after the full lifecycle. Hashes and approved bounded projected message text are not misreported as raw secrets or a full transcript. |
| Bounded access paths | Device pagination, selected event replay, retention candidates, orphan candidates, CSRF lookup, pairing-rate lookup, and audit phase lookup use their selected bounds and expected indexes. Aggregate inspection records plans without introducing an unbounded fallback scan in product code. |
| Explicit corruption boundary | `openMigratedDatabase` must reject migration/schema-state corruption it owns. Repository-owned row corruption must reject when that repository reads or maintains the row. The gate must not claim that database open validates every page or every domain row. |
| No hidden database policy change | Journal, synchronous, and busy-timeout policy remains unchanged unless a failing criterion demonstrates a selected requirement gap. The daemon lease and one owner handle remain the deployment assumption; leaf race tests intentionally use extra connections only as adversarial evidence. |
| Manual state inspection | Independent SQL/filesystem inspection matches the owning planning docs: exact table/index/trigger inventory, selected-versus-legacy separation, bounded row counts/bytes, replay boundary, audit trails, auth lifecycle, migration history, path modes, and raw-byte privacy. |
| Honest release boundary | Passing this gate closes the selected storage/auth/audit module only. It does not complete HTTP audit orchestration, startup readiness composition, Codex reconciliation, UI, Android packaging, TLS/LAN runtime, systemd confinement, same-UID sandboxing, or release readiness. |

## Failure Matrix

| Boundary | Required failure truth |
| --- | --- |
| Migration/schema | Stable `HostDeckMigrationError`; failed migration is atomic; no partially recorded version. |
| Selected session/projection | Stable selected-state failure; no partial event/projection/counter/boundary commit. |
| Publication | Durable commit remains readable; caller receives explicit publication-unknown state; no retry is invented. |
| Runtime compatibility | Invalid stored compatibility is rejected and cannot enable mutations. |
| Audit | Invalid trail or corrupt row prevents trusted listing/maintenance; no phase is overwritten or skipped as complete. |
| Auth/pairing | Invalid, expired, revoked, rate-limited, conflicting, or corrupt authority produces no trusted credential result and no secret-bearing durable error. |
| Startup maintenance | Timeout, abort, corruption, contention, or storage failure reports bounded partial/degraded truth and never reports completion without a completed scan. |
| Filesystem/lease | Unsafe type, mode, identity, link, ownership, or held lease fails before later mutation and cleans up acquired resources. |

## Evidence Plan

- Add a focused aggregate storage hardening test instead of duplicating all leaf matrices.
- Re-run every storage test so the aggregate remains backed by migration, transaction, worker-race, retention, corruption, path, and lease leaf evidence.
- Run root unit, contract, integration, web, typecheck, lint/export, scaffold, planning, exact-binding, frozen-install, production-audit, and diff checks required by the repository workflow.
- Record direct test counts, exact manual SQL/filesystem/raw-byte observations, implementation commit, and remaining owners in this artifact after execution.

## Reuse And Dependency Decision

Use existing `better-sqlite3`, Node filesystem/crypto APIs, Vitest, selected repositories, secure path helpers, and daemon lease. No dependency or new abstraction is justified for this aggregate. Production changes are allowed only when an executable criterion exposes a root-cause gap; evidence-only assertions must stay in the aggregate test or artifact.

## Owner Mapping

- Product/storage truth: `docs/planning/01-prd.md`, `docs/planning/02-requirements.md`, `docs/planning/04-technical-plan.md`, and `docs/planning/04a-implementation-blueprint.md`.
- Validation truth: `docs/planning/04b-test-plan.md` and the `04b:Storage And Audit Matrix` requirement group.
- Capability completion: `docs/planning/05-blocks/BLK-V1-02-local-state-auth-audit.md`.
- Task/dependency truth: `docs/tracking/backlog/local-state-auth-audit.md`, `docs/tracking/backlog/00-index.md`, and `docs/tracking/06-tasks.md`.
- Handoff/release truth: `docs/status.md` and `docs/delivery/08-technical-delivery-plan.md` only when execution changes those facts.

## Remaining Ownership

- `IFC-V1-032`, `IFC-V1-036`, and related interface leaves own mutation audit orchestration and selected startup/readiness ordering.
- `INT-V1-028` and `INT-V1-029` own selected runtime startup and recovery composition.
- `INT-V1-008` owns removal/isolation of legacy tmux runtime composition.
- `FE-*`, Android/device, package, and `REL-*` tasks own UI and release evidence.
