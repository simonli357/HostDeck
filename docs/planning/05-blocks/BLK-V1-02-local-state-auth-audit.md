# BLK-V1-02 Local State, Auth, Audit, And Retention

Owns HostDeck's durable state and local filesystem safety. Codex remains the owner of full thread history.

## Outcome

- SQLite persists managed thread mappings, bounded event/session projections, runtime compatibility, settings, device/pairing/CSRF lifecycle, and truthful audit outcomes.
- Production append/startup paths enforce output and audit retention.
- State, database, key, certificate, and runtime paths are owner-only and protected by one daemon lease.
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
| Retention | 10,000 events or 10 MB per session; 5,000 audit rows or 30 days until a new decision. Cleanup is observable and production-invoked. |
| Filesystem | Pure path resolution, minimal state/lease bootstrap, canonical owner-only directories/files, no-follow plus descriptor/path-identity checks, secure socket/key/cert validators, and a nonblocking Linux daemon lock before other mutation. |

## Migration Rules

- Add app-server mapping/projection/compatibility fields in a forward-only migration.
- Do not reinterpret tmux targets as Codex thread ids.
- Preserve legacy columns until `INT-V1-008`; legacy records never appear live.
- Thread creation plus DB persistence uses the recoverable saga in the blueprint.
- Startup maintenance is bounded; large cleanup cannot hold readiness indefinitely without a visible degraded result.

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
| Orphan accepted-operation reconciliation | `DAT-V1-030` | In progress over the completed startup runner and audit state machine. |
| CSRF bootstrap and rotation storage | `DAT-V1-021` | Blocked by the physical HTTPS/browser policy proof. |
| Device listing storage | `DAT-V1-025` | Blocked by CSRF-capable device storage. |
| Authentication last-used update storage | `DAT-V1-029` | Blocked by CSRF-capable device storage. |
| Pair claim and rate/concurrency storage | `DAT-V1-026` | Blocked by CSRF-capable pairing storage. |
| Atomic device revoke and CSRF invalidation | `DAT-V1-028` | Blocked by CSRF-capable device storage. |
| Security-action audit storage completion | `DAT-V1-027` | Blocked by CSRF and audit state-machine leaves. |
| Reopened module hardening | `DAT-V1-091` | Blocked by `DAT-V1-018` to `DAT-V1-030`. |

Owning backlog: `docs/tracking/backlog/local-state-auth-audit.md`.

## Validation

| Layer | Evidence |
| --- | --- |
| L1 | Schemas, repositories, migrations, audit state machine, permission policy. |
| L2 | Real SQLite transactions, concurrent start/retention/revoke/lease races, restart and corruption cases. |
| L3 inspection | Actual state/runtime tree modes, raw-secret absence, bounded data after real Codex/browser use. |

## Done Criteria

- Prior and empty databases migrate or fail atomically with actionable version detail.
- Thread-created/storage-failed and response-failed cases do not create duplicate hidden sessions.
- Production paths invoke projection and audit retention and expose boundaries.
- Pair/reload/revoke leaves no raw device/CSRF secret in durable storage.
- Owner-only paths and one-daemon lease are proven against hostile permissions and concurrent startup.
- Full Codex transcript is absent from HostDeck storage.
- `DAT-V1-091` passes and the block matrix links current selected-path evidence.
