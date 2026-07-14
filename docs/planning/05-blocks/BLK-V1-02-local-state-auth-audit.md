# BLK-V1-02 Local State, Auth, Audit, And Retention

Status: reopened only for focused remote-storage hardening.

Owns HostDeck's durable state and local filesystem safety. Codex remains the owner of full thread history.

## Outcome

- SQLite persists managed thread mappings, bounded event/session projections, runtime compatibility, remote-ingress settings/observations, device/pairing/CSRF lifecycle, and truthful audit outcomes.
- Production append/startup paths enforce output and audit retention.
- State, database, and runtime paths are owner-only and protected by one daemon lease; no Tailscale node key or reusable credential enters HostDeck storage.
- Restart and partial failure preserve recoverable truth without raw secrets or duplicate full Codex transcripts.

Requirement refs: `DR-001` to `DR-011`, `NFR-008`, `NFR-010`, `NFR-011`, `NFR-013`, `PR-009`, `SFR-006`, `SFR-007`, `SFR-014` to `SFR-016`.

## Local Design

| Area | Rules |
| --- | --- |
| Managed mappings | HostDeck id/alias maps to one Codex thread id; pre-release tmux records are explicit legacy state. |
| Projection | Event append, cursor assignment, session projection update, and due retention occur transactionally before publication. |
| Compatibility | Observed Codex version/schema/capabilities/check result survive restart and gate mutation readiness. |
| Auth | Only hashes and lifecycle metadata persist; CSRF generation rotates on bootstrap/reload and invalidates on revoke. |
| Audit | `accepted` and terminal outcome are separate; crash can leave explicit `incomplete`; payload is bounded/sanitized. |
| Remote ingress | Persist selected-profile comparison metadata, canonical external origin, exact HostDeck-owned Serve descriptor, enablement, and bounded observations; never persist Tailscale credentials. |
| Retention | 10,000 events or 10 MB per session; 5,000 audit rows or 30 days until a new decision. Cleanup is observable and production-invoked. |
| Filesystem | Pure path resolution, minimal state/lease bootstrap, canonical owner-only directories/files, no-follow plus descriptor/path-identity checks, secure socket and sensitive-file validators, and a nonblocking Linux daemon lock before other mutation. |

## Migration Rules

- Add app-server mapping/projection/compatibility fields in a forward-only migration.
- Do not reinterpret tmux targets as Codex thread ids.
- Preserve legacy columns until `INT-V1-008`; legacy records never appear live.
- Thread creation plus DB persistence uses the recoverable saga in the blueprint.
- Startup maintenance is bounded; large cleanup cannot hold readiness indefinitely without a visible degraded result.
- Add remote-ingress settings and audit actions through forward-only migrations; historical LAN diagnostics remain historical and are not reinterpreted as remote proof.

## Task Map

| Work | Tasks | Status |
| --- | --- | --- |
| Historical migrations/settings/session/auth/audit/retention/branch/restart | `DAT-V1-001` to `DAT-V1-017`, `DAT-V1-090` | Done for prior schema; reusable evidence retained. |
| App-server mapping and projection migration | `DAT-V1-018` | Done; selected migration/repository evidence recorded. |
| Secure paths and daemon lease | `DAT-V1-019` | Done; phased owner paths, descriptor identity, real Linux lease/crash recovery, and cleanup evidence recorded. |
| Transactional production projection append | `DAT-V1-020` | Done; full-revision immediate commit and post-commit publication evidence recorded. |
| Production projection retention and boundaries | `DAT-V1-022` | Done; append-time count/byte pruning, durable boundaries, rollback, concurrency, publication, and restart evidence recorded. |
| Accepted-to-terminal audit state machine | `DAT-V1-023` | Done; append-only migration/repository, exact trail transitions, real SQLite contention, rollback, corruption, and restart evidence recorded. |
| Bounded startup retention maintenance | `DAT-V1-024` | Done; fixed-policy output/audit batches, indexed candidate plans, deadline/failure truth, and restart evidence recorded. |
| Orphan accepted-operation reconciliation | `DAT-V1-030` | Done; fixed-cutoff incomplete append, bounded runner, real terminal race, restart, and retention interoperability recorded. |
| CSRF bootstrap and rotation storage | `DAT-V1-021` | Complete; strict migration, atomic rotation, real contention, rollback, restart, indexed lookup, and raw-secret evidence pass. |
| Device listing storage | `DAT-V1-025` | Complete; strict 1..100 ID-keyset pagination, one-statement primary-index snapshot, full-lookahead validation, frozen non-secret projection, large traversal, concurrent-revoke, corruption, restart, and privacy evidence pass. |
| Authentication last-used update storage | `DAT-V1-029` | Complete; strict chronology, immediate authority/touch, monotonic conflict/no-op behavior, update/commit rollback, real race/revoke ordering, restart, index, and privacy evidence pass. |
| Pair claim and rate/concurrency storage | `DAT-V1-026` | Complete; policy-bound 128-bit issue, selected owner provenance, durable source/global windows, bounded cleanup, one-winner claim/revoke, rollback, corruption, restart, and raw-file privacy evidence pass. |
| Atomic device revoke and CSRF invalidation | `DAT-V1-028` | Complete; strict chronology, immediate raw-state CAS, stable idempotency, bearer/write/bootstrap denial, real ordering, rollback, restart, corruption, index, and privacy evidence pass. |
| Security-action audit storage completion | `DAT-V1-027` | Complete; exact catalog, durable legacy/current provenance, strict actor/target/summary contracts, migration preservation, secret rejection, restart/orphan/retention, and full workspace evidence pass. |
| Selected module hardening | `DAT-V1-091` | Complete; one secure on-disk aggregate proves selected cross-repository migration, restart, retention, auth, audit, lease, corruption, query-plan, and privacy truth. Evidence: `artifacts/dat-v1-091-selected-local-state-hardening.md`. |
| Remote-ingress configuration migration | `DAT-V1-031` | Complete; `artifacts/dat-v1-031-remote-ingress-state-storage.md`. |
| Remote-ingress audit migration and historical preservation | `DAT-V1-032` | Complete; `artifacts/dat-v1-032-remote-audit-catalog.md`. |
| Focused remote storage hardening | `DAT-V1-092` | In progress. |

Owning backlog: `docs/tracking/backlog/local-state-auth-audit.md`.

## Validation

| Layer | Evidence |
| --- | --- |
| L1 | Schemas, repositories, migrations, audit state machine, permission policy. |
| L2 | Real SQLite transactions, concurrent start/retention/revoke/lease races, restart and corruption cases. |
| L3 inspection | Actual owner-only state/runtime modes, lease restart, exact SQLite inventory/health/query plans, bounded selected rows, raw-secret/full-transcript absence, and explicit downstream Codex/browser composition boundary. |

## Done Criteria

- Prior and empty databases migrate or fail atomically with actionable version detail.
- Thread-created/storage-failed and response-failed cases do not create duplicate hidden sessions.
- Production paths invoke projection and audit retention and expose boundaries.
- Pair/reload/revoke leaves no raw device/CSRF secret in durable storage.
- Owner-only paths and one-daemon lease are proven against hostile permissions and concurrent startup.
- Full Codex transcript is absent from HostDeck storage.
- Tailscale node keys, reusable credentials, and raw pairing fragments are absent from HostDeck storage and artifacts.
- `DAT-V1-092` passes and the block matrix links current selected-path evidence.
