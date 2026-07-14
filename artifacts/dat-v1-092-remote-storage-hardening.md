# DAT-V1-092 Remote Storage Hardening

Date: 2026-07-13

Task: `DAT-V1-092`

Frozen criteria: `e841760`

Implementation evidence: `68d4fc9`

## Outcome

The complete selected remote state and audit storage boundary now passes one production-shaped real-SQLite aggregate on an owner-only state root. The aggregate composes migrations 013/014, historical preservation, state generations, exact remote audit trails, profile/Serve conflict truth, two-handle competition, restart reconciliation, whole-trail retention, read-only reopen, corruption isolation, query plans, permissions, lease recovery, and raw-byte privacy.

No production code, dependency, fallback, database policy, setup, or command change was required. The completed `DAT-V1-031` and `DAT-V1-032` implementations satisfy the frozen aggregate criteria.

## Evidence Matrix

| Boundary | Result |
| --- | --- |
| Fresh and upgrade | A fresh database applies all 14 checksummed migrations. A migration-12 database upgrades through 013/014 while exact historical LAN audit columns and `record_json` bytes remain unchanged and no remote state is invented. |
| Interrupted migration | Forced failures inside migration 013 leave no state table/version; forced failure inside migration 014 leaves its prior table, rows, and version history exact. Each migration remains independently atomic. |
| Remote lifecycle | Accepted enable precedes ready state and success; profile-away, recovery, foreign Serve, rejected repeat enable, fail-closed disable, cleanup-incomplete, verified Serve-absent cleanup, and profile-selection change preserve exact generations and chronology. |
| Competition | Two real SQLite handles produce one generation-9 enable winner and one legal terminal audit winner. Stale disable and competing terminal writes reject cause-free; existing worker-held leaf tests retain simultaneous lock-contention proof. |
| Restart and maintenance | Lease release/reacquisition and writable restart preserve state generation 9 and one accepted-only disable. Reconciliation appends exact remote `incomplete/runtime_unavailable`; count retention then deletes four complete trails/seven rows and retains two newest whole trails/four rows. |
| Invalid/corrupt state | Secret-bearing extra state/audit input rejects before SQLite. Transaction-scoped SQL-valid semantic corruption makes only its owning repository fail; rollback restores exact state, audit, and trigger truth without cross-domain mutation. |
| Schema and plans | All 20 tables, 10 named indexes, eight triggers, 14 version/checksum rows, foreign keys, `quick_check`, and `foreign_key_check` match the selected schema. Remote primary-key reads and accepted/terminal audit scans use their expected indexes. |
| Filesystem and lease | Config/state/runtime directories are `0700`; database and lease files are `0600`; a second lease fails while held and clean restart replaces only stale unlocked metadata. |
| Privacy | Unique pairing fragment/code, Tailscale key/credential, account/profile/node identity, raw CLI output, and foreign Serve sentinels are absent from rows, database/WAL/SHM/journal bytes, paths, and complete observed error/cause graphs. The approved canonical origin and comparison hash remain durable by design. |

## Validation

Passed on implementation `68d4fc9`:

- focused aggregate: 1 file/2 tests, plus five independent repeat processes with 2/2 passing each time;
- `pnpm vitest run packages/storage/src --maxWorkers=2`: 29 files/255 tests;
- `pnpm vitest run --maxWorkers=2`: 116 files/1,057 tests passed; 16 files/30 tests skipped by existing device/environment gates;
- `pnpm test:contract`: 26 files/223 tests;
- `pnpm test:integration`: 2 files/16 tests;
- `pnpm test:web`: 2 files/14 tests;
- root `pnpm typecheck` and all nine package typechecks;
- `pnpm lint`: 349 files and all nine package exports;
- `pnpm check:scaffold`: nine packages and 18 root scripts;
- `pnpm check:planning`: 212 tasks, 84 requirements, 649 dependencies, and 21 queued tasks before closure synchronization;
- `git diff --check`;
- independent migration SQL, repository transaction, chronology, schema inventory, query-plan, filesystem mode, raw-row, raw-byte, error graph, and downstream-boundary review.

The full unit run emitted the existing `adb: no devices/emulators found` path. This headless storage gate makes no physical-device claim; `IFC-V1-079` remains the remote-phone acceptance owner.

## Manual Review

- The aggregate uses production constructors and one physical database; deterministic clocks and synthetic identities enter only through existing test ports.
- Direct SQL is limited to pre-migration historical fixtures, independent inspection, forced migration failure, and transaction-scoped semantic-corruption probes that roll back.
- State and audit repositories remain deliberately separate storage boundaries. The aggregate does not invent cross-repository atomicity that the future application service does not own.
- No hidden retry, automatic profile switch, Serve repair, secret persistence, read-action audit, or historical LAN evidence is introduced.
- Passing this gate closes storage only. Tailscale observation/mutation, route/API/CLI orchestration, browser/UI, service/package, and device behavior remain downstream.

## Remaining Ownership

- `IFC-V1-075`: remove/isolate historical LAN/certificate routes and finalize remote route/audit ownership.
- `IFC-V1-071` to `IFC-V1-079`: production Tailscale observer, Serve manager, proxy/app trust, pairing, lifecycle, and physical phone path.
- `INT-V1-091`, `IFC-V1-091`, `FE-V1-090`, and `REL-*`: remaining module and release gates.
