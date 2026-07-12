# DAT-V1-027 Security Action Audit Storage

Date: 2026-07-11

Status: hard success criteria frozen before implementation.

## Scope

Complete the selected append-only audit boundary for security and access actions. This leaf owns the durable action catalog, strict current-write record contracts, SQLite compatibility, and repository validation. It does not own route orchestration, emergency-lock fallback policy, pairing/revoke/network mutations, cookie issuance, CSRF responses, or public audit reads.

## Current Gaps

- The selected catalog has 19 actions but omits `csrf_bootstrap`; the route manifest carries it as a temporary `DAT-V1-027` extension.
- Migration 007 has an action `CHECK` that rejects `csrf_bootstrap`, so the generic repository cannot persist that route's accepted or terminal truth.
- Pair claims have no truthful actor shape before a device exists. Treating an unpaired remote claimant as `system`, `cli`, or an already paired dashboard device would be false attribution.
- Security actions currently accept the generic free-form primitive summary. Sensitive-key detection does not stop a raw code, bearer, CSRF token, private key, or certificate from being placed under an innocuous key.
- Action-specific actor, target, intent, and safe result metadata are not enforced on current writes.
- Dedicated security evidence for migration preservation, restart, orphan reconciliation, retention, rollback, corruption, raw SQLite artifacts, and manifest catalog closure is absent.

## Frozen Catalog And Authority

The selected security catalog is exactly:

1. `pair_request`
2. `pair_claim`
3. `csrf_bootstrap`
4. `device_revoke`
5. `lock`
6. `unlock`
7. `lan_configure`
8. `lan_enable`
9. `lan_disable`
10. `certificate_rotate`

| Action | Required actor | Required target |
| --- | --- | --- |
| `pair_request` | local-admin CLI | local host |
| `pair_claim` | unpaired pairing client with canonical admitted origin and no device/permission claim | local host |
| `csrf_bootstrap` | paired dashboard device with read or write permission | the same authenticated device |
| `device_revoke` | local-admin CLI or paired dashboard writer | exact named device |
| `lock` | local-admin CLI or paired dashboard writer | local host |
| `unlock` | local-admin CLI | local host |
| `lan_configure`, `lan_enable`, `lan_disable`, `certificate_rotate` | local-admin CLI | local host |

System actors remain reserved for system-owned reconciliation records and cannot initiate a user security action. Read-only dashboard actors cannot create security mutation records except the already-approved CSRF bootstrap available to both device permissions.

## Versioned Safe Summaries

Every new security record uses strict `schema_version: 1` summary data. Unknown keys, nested values, arbitrary text, and noncanonical values reject. Rejected, failed, and incomplete records may omit unavailable action fields but still require the version. Orphan reconciliation may add only `reconciliation_reason: host_restart_without_terminal`.

| Action | Safe intent/result fields |
| --- | --- |
| `pair_request` | read/write permission, label-presence boolean, canonical expiry, and successful non-secret pairing id |
| `pair_claim` | read/write permission, label-presence boolean, successful device-created boolean, and successful non-secret device id |
| `csrf_bootstrap` | positive safe generation before/after rotation and rotated boolean |
| `device_revoke` | prior-revoked boolean and authority-invalidated boolean |
| `lock`, `unlock` | requested/current locked booleans constrained to the action |
| `lan_configure` | address-family enum, valid port, certificate-change-requested boolean, and configuration-changed boolean |
| `lan_enable`, `lan_disable` | requested/current LAN-enabled booleans constrained to the action |
| `certificate_rotate` | rotation/certificate-changed booleans, optional lowercase SHA-256 fingerprint, and canonical certificate expiry |

Accepted records require their safe intent fields. Succeeded records require the corresponding safe result fields. Outcome and `error_code` remain owned by the existing state machine and cannot contradict the summary.

## Hard Success Criteria

| Criterion | Required evidence |
| --- | --- |
| Forward-only catalog migration | Migration 010 rebuilds only `selected_audit_events`, adds `csrf_bootstrap` to the action constraint, preserves every prior row byte-for-byte, and recreates the primary/unique constraints, both retention indexes, and all append-only/state triggers. Published migrations remain byte-identical. Fresh and 009 databases pass; failed rebuild rolls back. |
| Complete selected catalog | Core exposes exactly 20 total selected audit actions and the exact 10-action security subset with no duplicates. CSRF bootstrap becomes catalog-backed in the selected API manifest; only `session_start` remains an owned extension. |
| Truthful actors | A strict unpaired pairing-client actor is added without breaking stored legacy actors. Action-specific current writes reject system impersonation, paired identity before claim, dashboard local-admin claims, read-only mutation outside CSRF bootstrap, wrong origin shape, and CLI/device/origin contradictions. |
| Exact targets | CSRF bootstrap targets the same dashboard actor device; revoke targets the named device; all other security actions target `local_host`. Wrong target type or mismatched authenticated device rejects before SQLite. |
| Safe current-write summaries | Each action accepts only its frozen version-1 fields and phase-appropriate required values. Unknown/missing versions, unknown keys, nested values, wrong literals, malformed ids/times/fingerprints, unsafe integers, and action/summary mismatches reject without a row. |
| Secret absence | Raw pairing code, device bearer, CSRF token, private key, certificate PEM/DER, cookie/header values, and sentinels under generic-looking keys all reject cause-free. They remain absent from rows, main/WAL bytes, errors, logs, artifacts, and public durable records. Hashes are not accepted as a substitute summary except the dedicated certificate SHA-256 fingerprint. |
| Legacy compatibility | Pre-010 selected security records that passed the former generic contract remain readable and retain exact JSON. Every repository write after migration uses the strict versioned contract; compatibility does not become a fallback for new writes. |
| State-machine continuity | All ten actions pass standalone rejection and accepted-to-succeeded/failed/incomplete trails. Actor/action/target continuity, chronology, immutable accepted truth, one terminal, real two-connection serialization, and exact stored columns remain governed by the existing append-only repository. |
| Failure and corruption | Forced start/terminal/commit failure rolls back with generic bounded audit errors and no secret cause. Closed/read-only storage fails explicitly. Raw column/JSON/action/version/actor/target/summary contradiction fails loudly and never returns a partial trail. |
| Restart, orphan, and retention | Reopen preserves exact security trails. Eligible accepted-only security work receives one strict versioned `incomplete/runtime_unavailable` terminal. Count/age cleanup deletes only whole terminal trails, protects pending work, preserves the newest exception, and retains actor/target/outcome continuity for survivors. |
| Ownership boundaries | This leaf does not execute security mutations, issue credentials, parse cookies, rotate/revoke state, choose emergency-lock behavior, or claim route completion. `IFC-V1-032` owns accepted-to-terminal orchestration and degraded emergency policy; data/interface leaves own each mutation. No hidden fallback is added. |

## Validation Plan

- Core/contract tests for exact action inventory, pairing-client actor, canonical origin, target authority, all versioned summary shapes, outcome requirements, and hostile secret/value matrices.
- Migration tests for fresh and 009 upgrade, row JSON/column preservation, action constraint, indexes, triggers, failed rebuild rollback, and unchanged historical checksums.
- Direct repository tests for every action and transition, action/actor/target/summary mismatch, generic legacy read versus strict current write, forced start/terminal/commit failure, real contention, corruption, restart, and main/WAL secret inspection.
- Focused orphan/retention tests for strict security incomplete terminals, whole-trail deletion, pending protection, reopen, and continuity.
- Manifest contract update proving `csrf_bootstrap` is selected and only `session_start` remains an owned extension.
- Full storage/server/unit/contract/integration/web, typecheck/lint, scaffold/planning/exact-binding, frozen offline install, production audit, manual SQL/privacy/ownership review, and diff checks.

## Remaining Ownership

- `DAT-V1-026` owns pairing rate/claim state and the non-secret ids/permission values supplied to audit summaries.
- `DAT-V1-028` owns atomic revoke and CSRF invalidation state.
- `IFC-V1-032` owns security mutation audit preflight, accepted/terminal orchestration, and emergency-lock degradation semantics.
- `IFC-V1-027`, `IFC-V1-028`, `IFC-V1-030`, `IFC-V1-031`, and `IFC-V1-059` own the selected security routes and mutation-specific result mapping.
- `DAT-V1-091` owns aggregate storage/audit hardening.
