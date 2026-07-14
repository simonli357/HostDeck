# DAT-V1-032 Remote Audit Catalog

Date: 2026-07-13

Task: `DAT-V1-032`

Implementation: `7d24f51`

Migration: `202607130014_remote_audit_catalog`

## Outcome

The selected audit path now records exact `remote_enable` and `remote_disable` operations while retaining valid LAN/certificate rows strictly as historical data. Pair request remains the owner of secret-free pairing issuance, and remote status remains read-only with no invented audit action.

## Catalog And Provenance

- The active catalog contains 18 actions: ten selected operations and eight current security actions.
- The persisted read catalog contains 22 unique actions so four retired LAN/certificate actions remain readable without becoming selected write actions.
- Current security writes use schema version 2. Historical security rows retain version 1, and pre-version generic rows retain their original nullable provenance.
- `createSelectedAuditRepository` rejects historical LAN/certificate actions before transition work. A separately named historical repository keeps legacy route tests explicit until `IFC-V1-075` removes those routes.
- The selected route manifest marks legacy LAN entries `historical`; they cannot count as remote-access evidence.

## Migration And Repository

- Migration 014 rebuilds `selected_audit_events`, copies every prior column and `record_json` value unchanged, and recreates both indexes plus all append-only/state triggers.
- SQLite constraints admit only the exact provenance/action combinations, including explicit non-null checks that avoid three-valued-logic gaps.
- Reads validate nullable legacy, version-1 historical, and version-2 active rows against their own schemas and fail closed with cause-redacted errors on corruption.
- Remote summaries must agree with the outer action, phase, and outcome. Accepted enable/disable, rejected admission, successful mutation, partial cleanup, and restart-incomplete states each have exact bounded invariants.
- Startup reconciliation appends only `incomplete/runtime_unavailable` for accepted-only remote trails, with unknown external truth represented explicitly rather than inferred.

## Evidence Matrix

| Case | Result |
| --- | --- |
| Fresh/prior database | Migration 014 creates the current schema; valid generic and version-1 rows retain exact values and remain readable. |
| Atomicity/versioning | Forced migration failure rolls back; checksum, missing-current, and unknown-future migration guards remain fail-closed. |
| Selected writes | Current remote and common security actions write version 2; retired LAN/certificate actions reject before any transition. |
| Remote outcomes | Profile mismatch, ownership conflict, mutation failure, cleanup conflict, and unknown restart truth use bounded rejected/failed/incomplete records without read-action invention. |
| Reconciliation/retention | Accepted-only remote trails reconcile once, terminal trails remain unchanged, and shared whole-trail retention still protects pending/newest records. |
| Concurrency/corruption | Immediate transactions preserve accepted-to-terminal order under real SQLite contention; malformed provenance, rows, and summaries fail loudly. |
| Privacy | Pairing fragments/codes, Tailscale keys/credentials, full account/profile/node identities, raw CLI output, and foreign Serve payloads reject before SQLite and are absent from database, WAL, SHM, and cause-redacted error bytes. |

## Validation

Passed on implementation `7d24f51`:

- `pnpm vitest run packages/storage/src --maxWorkers=2`: 28 files/253 tests.
- `pnpm vitest run --maxWorkers=2`: 115 files/1,055 tests; 16 files/30 tests skipped by existing device/environment gates.
- `pnpm test:contract`: 26 files/223 tests.
- `pnpm test:integration`: 2 files/16 tests.
- `pnpm test:web`: 2 files/14 tests.
- `pnpm lint`: 348 files and all 9 package exports.
- `pnpm typecheck`.
- `pnpm check:scaffold`: 9 packages and 18 root scripts.
- `pnpm check:planning`: 212 tasks, 84 requirements, 649 dependencies, and 20 queued tasks before closure synchronization.
- `git diff --check`.
- Manual contract, migration SQL, SQLite constraint, repository, reconciliation, retention, manifest, error-redaction, and raw-byte review.

The final unit run emitted the existing `adb: no devices/emulators found` path. This headless storage task makes no physical-device claim; `IFC-V1-079` owns remote-phone acceptance.

## Review Corrections

Manual production-hardening review found and fixed two gaps before the implementation commit:

- migration checks now require explicit non-null schema versions before version/action disjunctions;
- cleanup-incomplete audit summaries now require persisted disable intent and unknown Serve outcome.

## Downstream Ownership

- `DAT-V1-092`: aggregate remote state/audit migration, permissions, query-plan, restart, concurrency, retention, reconciliation, corruption, and raw-byte hardening.
- `IFC-V1-072`, `IFC-V1-075`, and `IFC-V1-076`: orchestrator adoption, historical route removal, and CLI composition.
- `IFC-V1-079`: physical remote-phone/profile acceptance.

No Tailscale mutation, route removal, UI, service, phone, or release claim is made here.
