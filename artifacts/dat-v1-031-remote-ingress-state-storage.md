# DAT-V1-031 Remote Ingress State Storage

Date: 2026-07-13

Task: `DAT-V1-031`

Implementation: `bd4bc4e`

Migration: `202607130013_remote_ingress_state`

## Outcome

HostDeck now has one forward-only SQLite migration and one frozen repository for durable normalized remote-ingress configuration and observation state. The row stores only bounded HostDeck-owned fields from `RemoteIngressState`; it does not store raw Tailscale output, credentials, node identity, pairing material, or arbitrary JSON.

## Durable Shape

- One fixed row id and schema version.
- Intent, availability, admission, observation, client, profile state/relation, bounded profile comparison hashes, Serve classification, exact expected private Serve descriptor, canonical external origin, bounded operation failure/reason, last observation time, and update time.
- Initial generation is exactly 1 and every update is exactly `+1`, enforced by repository validation, compare-and-set, and SQLite insert/update triggers.
- Disabling changes durable intent and closes admission; the state is never deleted.
- Profile key or expected Serve descriptor can change only from an unconfigured disabled state or after current, available, dedicated-profile, Serve-absent verified disablement.
- Once a successful observation time exists, later writes cannot clear or regress it. Update chronology cannot regress.

## Evidence Matrix

| Case | Result |
| --- | --- |
| Fresh database | Migration 013 creates the bounded table and three generation/delete triggers; current schema has 13 checksummed migrations. |
| Prior database | Migration 013 applies alone and preserves the historical selected-LAN row byte-for-byte while creating no invented remote state. |
| Interrupted migration | Migration 013 and a forced later failure roll back atomically; no partial table or migration record remains. |
| Future/downgrade | Existing unknown-future migration rejection remains; current databases reject code missing migration 013 without mutation. |
| Compare-and-set | Initial write requires generation 1; two real SQLite connections serialize, one stale writer rejects, and restart reads exact frozen state. |
| Disable/selection | Enabled selection cannot change. Admission can close before cleanup, but profile/descriptor change remains blocked until exact Serve-absent readback is persisted. |
| Profile observation | Dedicated, profile-away, failed observer with retained last-seen time, and recovery states persist without changing the selected comparison identity. |
| Invalid/corrupt state | Extra/secret-bearing/accessor/proxy inputs reject before write. Contradictory raw rows, read-only/closed/locked storage, chronology regression, and generation exhaustion fail closed with bounded errors. |
| SQLite enforcement | Initial generation, exact update step, bounded enums/hashes/origins/timestamps, profile comparison matrix, descriptor all-or-none shape, and no-delete behavior are constrained below the repository. |
| Privacy | Table inventory and raw database bytes contain only the expected synthetic origin/profile hash. Unique credential and peer-address sentinels, `tskey-`, node-key, and raw-output markers are absent. Repository errors retain no cause or raw input and the module emits no logs. |

The existing pairing privacy test now uses a unique loopback peer sentinel. Generic `127.0.0.1` is no longer a valid secret sentinel because the selected remote state schema intentionally persists `http://127.0.0.1:<port>` as the exact HostDeck Serve proxy target.

## Validation

Passed on implementation `bd4bc4e`:

- `pnpm check:scaffold`: 9 packages and 18 root scripts.
- `pnpm typecheck`.
- `pnpm -r --if-present typecheck`: all 9 package scripts.
- `pnpm lint`: 347 files and all 9 package exports.
- `pnpm vitest run packages/storage/src --maxWorkers=2`: 27 files/249 tests.
- focused migration/repository/aggregate matrix: 3 files/26 tests.
- isolated pairing route regression: 1 file/15 tests.
- `pnpm vitest run --maxWorkers=2`: 114 files/1,050 tests passed; 16 files/30 tests skipped by existing environment gates.
- `pnpm test:contract`: 26 files/222 tests.
- `pnpm test:integration`: 2 files/16 tests.
- `pnpm test:web`: 2 files/14 tests.
- `pnpm check:planning`: 212 tasks, 84 requirements, 649 dependencies, and 21 queued tasks before closure synchronization.
- `git diff --check`.
- Manual migration, repository, transaction, schema, error, raw-row, and raw-byte review.

The unit run emitted the existing device-aware `adb: no devices/emulators found` skip path. This storage task makes no physical-device claim.

## Downstream Ownership

- `DAT-V1-032`: remote enable/disable audit catalog migration and historical LAN/certificate preservation.
- `DAT-V1-092`: aggregate remote storage/audit hardening, query-plan, permission, retention, and reconciliation proof.
- `IFC-V1-071`, `IFC-V1-072`, and `IFC-V1-076`: real observer, orchestrator, and local CLI consumers of this repository.
- `IFC-V1-079`: physical remote-phone acceptance.

No Tailscale observation or mutation, audit catalog change, route, CLI command, UI, service, or release claim is made here.
