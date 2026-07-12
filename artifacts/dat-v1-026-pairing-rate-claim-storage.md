# DAT-V1-026 Pairing Rate And Claim Storage

Date: 2026-07-11

Status: complete. Implementation: `a28c837`.

## Scope

Harden selected pairing-code issuance, durable per-source/global claim throttling, atomic one-winner claim ownership, and restart-safe cleanup. This leaf owns contracts, migration 011, SQLite transactions, credential generation at the storage boundary, and direct evidence. It does not own HTTP peer-source derivation, Host/Origin checks, in-flight request admission, cookies, response mapping, security audit orchestration, device revoke, or UI behavior.

## Pre-Implementation Gaps

- The historical repository accepts caller-supplied six-character codes and arbitrary expiry, so it does not prove high-entropy or short-lived selected issuance.
- Claim receives already-generated device/CSRF credentials before code validity is known and uses a deferred transaction with no durable rate state.
- Invalid, expired, revoked, and used attempts do not consume a rate budget; source churn and aggregate brute-force attempts have no global ceiling.
- The resource policy has per-source attempts and in-flight caps but no global attempt ceiling or pairing-code lifetime.
- A spent pairing row records only `used_at`; after restart it cannot identify the device created by the winning claim.
- Revoke is read/update/read outside one immediate transaction and is not proven against a concurrent claim.
- Pairing chronology, real two-connection races, commit rollback, bounded stale-rate cleanup, corruption, restart, and raw main/WAL/SHM inspection are incomplete.

## Implementation Result

- Added the exact 78-field resource policy, canonical pairing/rate contracts, and forward-only migration 011 with selected SHA-256 provenance, unique device ownership, and bounded indexed source/global rate state.
- Added selected CSPRNG issue, durable admission accounting, atomic claim, and immediate revoke transactions. Raw code, bearer, and CSRF values are returned only from frozen post-commit results.
- Renamed every historical pairing mutation explicitly, rejected selected provenance on legacy claim/revoke, and left current historical route/CLI consumers on that deprecated surface until their selected owners replace them.
- Added strict plain-data input snapshots, cause-free error normalization, canonical retry timestamps, selected owner revalidation, secret/metadata separation, pre-creation time rejection, and bounded cleanup under policy reduction.
- Added contract, migration, direct repository, real worker-held SQLite ordering, rollback, restart, corruption, read-only, and main/WAL/SHM privacy matrices.

## Frozen Selected Contracts

### Resource Policy

The single resource budget grows from 76 to 78 fields with:

| Field | Minimum | Default | Maximum | Rule |
| --- | ---: | ---: | ---: | --- |
| `pairing_code_lifetime_ms` | 60,000 | 300,000 | 600,000 | Must be at least the claim window and no greater than admission-state TTL. |
| `pair_claim_max_attempts_global` | 1 | 100 | 1,000 | Must be at least the per-source attempt ceiling. |

Existing defaults remain a 60-second fixed claim window, ten attempts per source, one/source and four global claims in flight, 1,024 tracked admission keys, and ten-minute state TTL. In-flight counters remain process-local interface admission state because durable leases would strand capacity after a crash. This leaf owns durable attempt budgets and atomic SQLite claim ownership only.

### Source Identity

Selected claim accepts one canonical `source_key` with exact `sha256:` plus 64 lowercase hex characters. `IFC-V1-028` owns deriving it from the admitted socket source and canonical request trust context before storage. SQLite never receives raw peer addresses, forwarded headers, Origin values, or caller-selected free text as a rate key.

### Pairing Issuance

- Selected `issue` generates 16 CSPRNG bytes and encodes exactly 22 unpadded base64url characters, providing 128 bits of code entropy.
- Storage derives expiry from the validated resource policy; selected callers cannot extend it.
- The raw code is returned only in one frozen ephemeral post-commit result. SQLite stores its SHA-256 hash and non-secret metadata.
- Generator failure, malformed injected output, duplicate id/hash, invalid label/time/policy, insert failure, or deferred commit failure returns no raw code and leaves no row.
- The historical caller-supplied create/claim surface is renamed and explicitly deprecated. Selected code cannot silently enter that path.

### Durable Claim State

Migration 011 rebuilds `pairing_codes` with nullable legacy provenance plus `claimed_device_id`:

- Migrated rows retain every historical field and JSON-free column value byte-for-byte and use `claim_contract_version = NULL` with no claimed-device assertion.
- Selected issuance uses `claim_contract_version = 1`.
- A version-1 row is either unused with no claimed device or used with exactly one non-secret claimed device id. The id references the created auth-device row and is unique.
- Version-1 expiry is strictly after creation, successful use is at or after creation and strictly before expiry, and used/revoked contradiction rejects.

Migration 011 also creates:

- `pairing_claim_rate_sources(source_key, window_started_at, attempt_count, last_attempt_at)` with canonical timestamps, positive-safe counts, and an indexed stale-cleanup path.
- One `pairing_claim_rate_global` singleton with the same fixed-window fields.

Published migrations 001 through 010 remain byte-identical. Fresh and migration-010 databases must pass; any migration failure rolls back the pairing rebuild, rate tables, copied rows, indexes, foreign keys, and migration history together.

## Attempt And Claim Semantics

1. Strict input, policy, source key, and canonical non-regressing time validate before mutation.
2. One immediate transaction prunes source rows whose age is at least the fixed TTL, while never exceeding the configured tracked-source bound.
3. Existing source/global windows reset only when elapsed time is at least `pair_claim_window_ms`; boundary-equal resets, earlier/regressing observations reject.
4. A new source at the tracked-key ceiling rejects as capacity-limited before counters, code lookup, or generators. Existing tracked sources remain serviceable.
5. A source or global counter already at its ceiling rejects as rate-limited with canonical retry time before code lookup or generators. Saturated counters do not overflow.
6. Every syntactically valid admitted attempt increments source and global counters before credential lookup.
7. Not-found, expired, revoked, or used code outcomes commit only the permitted counters, create no device, change no pairing row, and surface bounded cause-free internal classification for later generic public mapping.
8. A valid version-1 code generates the device id, bearer, and initial CSRF only after admission. Device insert, code `used_at`/owner transition, and both counters commit atomically.
9. The raw bearer and CSRF token appear only in one frozen post-commit claim result. The device row contains hashes, generation 1, and claim time as CSRF rotation time.
10. Generator, validation, collision, storage, update-count, or commit failure rolls back code, device, and rate changes and returns no credentials. No automatic retry hides uncertain generation or commit state.

## Hard Success Criteria

| Criterion | Required evidence |
| --- | --- |
| Complete policy | Exact 78-field resource catalog, reviewed defaults/min/max/owners, per-source <= global, claim-window <= code-lifetime <= state-TTL invariants, exact-key rejection, and no local fallback constants. |
| Forward-only migration | Migration 011 preserves prior pairing rows and migrations, adds strict selected claim provenance/owner linkage plus bounded source/global rate tables and indexes, enforces foreign-key/integrity constraints, and rolls back completely on forced failure. |
| High-entropy short-lived issue | Default 128-bit code generation, exact encoding, policy-derived expiry, post-commit-only raw result, hash-only rows, and invalid/duplicate/generator/insert/commit failure matrices pass. |
| Exact rate windows | Per-source and global exact/below/at/over limits, boundary reset, independent sources, global exhaustion, source-cap exhaustion, fixed retry time, safe saturation, time regression, TTL cleanup, and policy change are deterministic. |
| Failure accounting | Not-found/expired/revoked/used attempts consume exactly one source/global slot; malformed/capacity/rate/internal failures mutate only their explicitly allowed state. Rate rejection performs no code lookup or entropy generation. |
| One-winner claim | One immediate transaction creates one device and marks one selected code with the exact device owner. Same-code, same-source, different-source, duplicate id/hash, and claim-versus-revoke races have one durable winner and no partial credentials. |
| Secret absence | Raw code, bearer, CSRF, generator output from failed work, raw peer address, cookie/header values, and secret-bearing native causes are absent from rows, main/WAL/SHM bytes, errors, logs, artifacts, and durable/public records. |
| Restart and cleanup | Rate windows, selected owner linkage, spent/revoked truth, and current hashes survive reopen. Bounded indexed TTL cleanup frees only expired source state; active windows and global truth remain exact. |
| Corruption and unavailable storage | Invalid provenance/owner/chronology/count/timestamp/hash/foreign-key rows, closed/read-only storage, forced statement/update/commit failure, and malformed policy fail loudly without trusted or partial results. |
| Ownership boundaries | No HTTP source derivation, in-flight limiter, Host/Origin/CORS, cookie, response, audit, device-revoke, or UI behavior is implemented or claimed. Legacy APIs remain explicit and cannot satisfy selected route ownership. |

## Validation

- Focused selected repository plus migration: 34 tests passed, including exact/boundary/over windows, 64/128-key cleanup policy changes, failure accounting, safe saturation, deferred commit rollback, selected/legacy isolation, corruption, restart, raw-file privacy, and claim/revoke ordering under real worker-held SQLite writes.
- Storage: 21 files and 197 tests passed. Server passed 305 tests with seven gated external smokes skipped.
- Aggregate: 826 unit tests passed with 29 explicit external skips; 149 contract, 16 integration, and 14 web tests passed.
- Typecheck, Biome/package exports, scaffold, planning graph, and exact Codex 0.144.0 binding checks passed. Planning reported 196 tasks, 84 requirements, 632 dependencies, and five queued tasks after closure.
- Frozen offline install passed. Production audit reported zero known vulnerabilities across 140 production dependencies.
- Migration 011 checksum is `6491026ff2fd23c5346273dbda5b3f5f6927d7c8b953b403ba512b5af83db927`; all 11 published migration checksums are locked by test.
- Manual SQL review confirmed byte-preserved legacy copying, exact selected SHA-256/chronology/owner constraints, foreign-key and uniqueness enforcement, positive-safe counters, bounded indexed cleanup selection, singleton global state, and whole-migration rollback.
- Manual privacy/ownership review found no raw credential or peer-address persistence/error path and no HTTP, in-flight, cookie, audit, device-revoke, or UI ownership leak. Diff checks passed.
- No live listener, browser, Android, or Codex runtime evidence is claimed because this leaf changes only headless contracts and SQLite storage.

## Remaining Gaps

None within this leaf. Public source derivation, in-flight admission, cookie issuance, audit orchestration, revoke authority, and route/UI behavior remain with the downstream owners below.

## Reuse Assessment

Keep `better-sqlite3`, Node `crypto.randomBytes`, SHA-256 hashing, Zod, and the existing resource-budget contract. Generic in-memory rate-limit packages do not satisfy atomic claim ownership or restart-safe SQLite evidence and would add a second policy/state owner, so no dependency is added.

## Remaining Ownership

- `IFC-V1-028` derives the canonical source key, enforces in-flight admission, maps all public failures generically, issues the Secure HttpOnly cookie, and orchestrates security audit accepted/terminal outcomes.
- `IFC-V1-032` owns reusable security mutation audit ordering.
- `DAT-V1-028`/`IFC-V1-059` own device authority revocation after pairing.
- `IFC-V1-048` and `IFC-V1-049` own aggregate rate/concurrency enforcement and stress evidence.
