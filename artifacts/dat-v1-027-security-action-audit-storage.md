# DAT-V1-027 Security Action Audit Storage

Date: 2026-07-11

Status: complete and validated. Catalog counts below describe this leaf at closure; `DAT-V1-032` later rebaselined selected remote actions and `IFC-V1-040` catalog-backed `session_start`.

## Outcome

- At this leaf's closure, the durable selected catalog had exactly 20 actions, including the exact ten-action security subset and catalog-backed `csrf_bootstrap` manifest ownership.
- Migration 010 preserves every prior field and JSON byte, restores both indexes and all append-only/state triggers, and marks migrated rows with nullable legacy provenance. Every current security repository write stores `security_schema_version = 1`; non-security and migrated legacy rows remain unversioned.
- Current security writes enforce truthful actors, exact targets, strict phase-specific version-1 summaries, and cause-free bounded errors. Pairing-client identity is valid only for `pair_claim`.
- Legacy security rows remain readable even when their former generic summary contains a `schema_version` key. Versioned rows are revalidated strictly on every read, and corrupt security reads/writes do not expose native causes or variable identifiers.
- No route orchestration, credential mutation, network mutation, emergency policy, dependency, setup, or command behavior was added.

## Scope

Complete the selected append-only audit boundary for security and access actions. This leaf owns the durable action catalog, strict current-write record contracts, SQLite compatibility, and repository validation. It does not own route orchestration, emergency-lock fallback policy, pairing/revoke/network mutations, cookie issuance, CSRF responses, or public audit reads.

## Gaps Closed

- Closed the missing `csrf_bootstrap` catalog and SQLite action support.
- Added truthful pre-device pairing-client attribution without broadening it to other actions.
- Replaced generic current security summaries with strict action/phase-specific contracts.
- Added durable legacy/current provenance instead of inferring provenance from payload keys.
- Added migration, repository, privacy, restart, orphan, retention, rollback, corruption, contention, and manifest evidence.

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
| Complete selected catalog | At this leaf's closure, core exposed exactly 20 total selected audit actions and the exact 10-action security subset with no duplicates. CSRF bootstrap became catalog-backed in the selected API manifest; `session_start` remained the downstream `IFC-V1-040` extension at that time. |
| Truthful actors | A strict unpaired pairing-client actor is added without breaking stored legacy actors. Action-specific current writes reject system impersonation, paired identity before claim, dashboard local-admin claims, read-only mutation outside CSRF bootstrap, wrong origin shape, and CLI/device/origin contradictions. |
| Exact targets | CSRF bootstrap targets the same dashboard actor device; revoke targets the named device; all other security actions target `local_host`. Wrong target type or mismatched authenticated device rejects before SQLite. |
| Safe current-write summaries | Each action accepts only its frozen version-1 fields and phase-appropriate required values. Unknown/missing versions, unknown keys, nested values, wrong literals, malformed ids/times/fingerprints, unsafe integers, and action/summary mismatches reject without a row. |
| Secret absence | Raw pairing code, device bearer, CSRF token, private key, certificate PEM/DER, cookie/header values, and sentinels under generic-looking keys all reject cause-free. They remain absent from rows, main/WAL bytes, errors, logs, artifacts, and public durable records. Hashes are not accepted as a substitute summary except the dedicated certificate SHA-256 fingerprint. |
| Legacy compatibility | Pre-010 selected security records that passed the former generic contract remain readable and retain exact JSON. Every repository write after migration uses the strict versioned contract; compatibility does not become a fallback for new writes. |
| State-machine continuity | All ten actions pass standalone rejection and accepted-to-succeeded/failed/incomplete trails. Actor/action/target continuity, chronology, immutable accepted truth, one terminal, real two-connection serialization, and exact stored columns remain governed by the existing append-only repository. |
| Failure and corruption | Forced start/terminal/commit failure rolls back with generic bounded audit errors and no secret cause. Closed/read-only storage fails explicitly. Raw column/JSON/action/version/actor/target/summary contradiction fails loudly and never returns a partial trail. |
| Restart, orphan, and retention | Reopen preserves exact security trails. Eligible accepted-only security work receives one strict versioned `incomplete/runtime_unavailable` terminal. Count/age cleanup deletes only whole terminal trails, protects pending work, preserves the newest exception, and retains actor/target/outcome continuity for survivors. |
| Ownership boundaries | This leaf does not execute security mutations, issue credentials, parse cookies, rotate/revoke state, choose emergency-lock behavior, or claim route completion. `IFC-V1-032` owns accepted-to-terminal orchestration and degraded emergency policy; data/interface leaves own each mutation. No hidden fallback is added. |

## Validation

- Storage: 20 files and 176 tests passed, including all ten actions across rejection, accepted/succeeded, failed, incomplete, migration, restart, orphan, retention, rollback, real contention, corruption, and raw-file privacy cases.
- Server: 35 files and 305 tests passed; seven explicit external smoke files remained skipped by their existing gates.
- Aggregate: 805 unit tests passed with 29 explicit external skips; 146 contract, 16 integration, and 14 web tests passed.
- Typecheck, Biome/package exports, scaffold, planning graph, and exact Codex 0.144.0 binding checks passed. Planning reported 196 tasks, 84 requirements, 631 dependencies, and six queued tasks before closure.
- Frozen offline install passed. Production audit reported zero known vulnerabilities across 140 production dependencies.
- Migration 010 checksum is `1db9a127f80ba20f120cd8bbf9b65bc57fc2ca859d82e50a4f213f10d16ba0ab`; every published pre-010 checksum remains locked by test.
- Manual SQL review confirmed explicit legacy/current provenance, exact action/version constraints including SQLite `NULL` behavior, row-copy fidelity, both indexes, all three triggers, and whole-migration rollback. Manual privacy/ownership review found no raw credential path or route/mutation ownership leak. Diff checks passed.
- No live listener, Android, browser, or Codex runtime evidence is claimed because this leaf changes only headless contracts and SQLite storage.

## Remaining Gaps

None within this leaf. Security mutation execution and caller-supplied audit values remain with the downstream owners below.

## Remaining Ownership

- `DAT-V1-026` owns pairing rate/claim state and the non-secret ids/permission values supplied to audit summaries.
- `DAT-V1-028` owns atomic revoke and CSRF invalidation state.
- `IFC-V1-032` owns security mutation audit preflight, accepted/terminal orchestration, and emergency-lock degradation semantics.
- `IFC-V1-027`, `IFC-V1-028`, `IFC-V1-030`, `IFC-V1-031`, and `IFC-V1-059` own the selected security routes and mutation-specific result mapping.
- `DAT-V1-091` owns aggregate storage/audit hardening.
