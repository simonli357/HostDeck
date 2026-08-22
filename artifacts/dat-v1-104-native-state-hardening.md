# DAT-V1-104 Native State/Security Hardening

Date: 2026-08-11

Status: complete and validated.

Implementation: `c7a50f3`.

Accepted native run: `31518677087`.

## Scope

This gate hardens the completed cross-platform state slice: migration catalog handling, guarded SQLite open, daemon lease authority, retained backup/restore, secure state paths, crash recovery, and privacy. Native package/lifecycle uninstall implementation remains owned by `IFC-V1-107`; this task proves that state inputs and retained snapshots are independently identifiable and preservable.

## Hard Criteria

| ID | Required result |
| --- | --- |
| `ST-01` | Every backup/restore operation requires a live, genuine HostDeck daemon lease whose canonical path is the selected state directory's exact `hostdeck.lock`; fake, released, mismatched, and contended authority fails before SQLite or output mutation. |
| `ST-02` | Database, backup, partial, and destination paths remain canonical descendants of one selected secure state root. Linux evidence uses UID, `0700` directories, `0600` files, no symlink, and one link; Windows evidence uses native current-user owner/DACL, NTFS, no reparse point/ADS, one file link, and descriptor/path identity. POSIX mode is not Windows evidence. |
| `ST-03` | Existing source and destination files are held through secure descriptor guards and reverified after asynchronous transfer. New output is secured before validation/publication. Type, link, owner/ACL or mode, canonical-path, and substitution failures are explicit and leave no trusted result. |
| `ST-04` | Backup publication is exclusive and restore is SQLite-atomic. Abort, process death, invalid/corrupt/foreign-key-invalid backup, existing destination, and cleanup failure preserve the pre-operation live state or fail unmistakably; owned partial/WAL/SHM/journal residue is absent after recovery. |
| `ST-05` | Migration catalogs are snapshotted before database mutation, finite and bounded, canonically versioned, strictly ordered, unique, and composed of bounded nonempty SQL. Mutation of caller-owned arrays/records during a run cannot change applied work. |
| `ST-06` | Migration timestamps are valid ISO instants; result objects and arrays are immutable. Unknown database-controlled versions, private absolute paths, SQL, tokens, account names, and sentinel values are not reflected in public migration/recovery messages or native evidence. |
| `ST-07` | Fresh/current/prior upgrade, failed migration rollback, retained-release restore, re-upgrade, concurrent lease denial, stale-lock crash recovery, permission/ACL repair, tamper rejection, and repeated validation pass without a permissive fallback. |
| `ST-08` | One dedicated native hardening check passes on Ubuntu 24.04 x64 and Windows Server 2022 x64 with exact Node 22.22.2/ABI 127. Machine records bind the same source and lockfile; manual platform inspection records the actual security primitive. |

## Explicit Limits

- HostDeck protects against accidental exposure, unsafe inheritance, links/reparse points, path substitution, and competing HostDeck owners. It does not claim isolation from arbitrary malicious code already running as the same OS user.
- Retained database snapshots are integrity-validated and access-controlled, not encrypted exports.
- Recovery paths are internal state-root paths, not arbitrary user-selected backup locations.
- Passing this gate does not complete native package install, upgrade, rollback, uninstall, signing, remote-phone, or clean-host release acceptance.

## Outcome

- Recovery now requires a genuine live daemon lease, binds it to one secure state root, revalidates the still-open lease descriptor across asynchronous transfer/publication, and rejects forged, released, mismatched, contended, or substituted authority.
- Source, backup, partial, and destination files use the selected secure-path adapters and descriptor identity guards. Linux proves UID/`0700`/`0600`/single-link truth; Windows proves native current-user owner/DACL, NTFS, no reparse point/ADS, and single-link truth.
- Migration catalogs are immutable bounded snapshots with canonical ordered versions and bounded SQL. Stored history has a bounded exact table/timestamp/checksum contract with no trigger, and database-controlled values or private paths are not reflected in public messages.
- Existing process-death migration/restore, prior-release restore/re-upgrade, corruption, abort, contention, repair, tamper, privacy, and residue cases remain green. Repeated removal of a separate native release tree preserves database and retained-backup bytes on both hosts; installer/lifecycle behavior remains downstream. No fallback, dependency, setup, or command was added.

## Evidence

- Native run `31518677087` binds commit `c7a50f37237ed6074b36fcc5d40fadfee1277002` and lockfile SHA-256 `18ff003698c457578ba3e041074e522cd4fcfdf73e1e7d60ece7354cb43b7458` on both hosts.
- Ubuntu 24.04: 18/18 checks; `native_storage` 2,016 ms, `state_hardening` 1,049 ms, `windows_paths` contract 902 ms; evidence SHA-256 `273104beae3637647f09c4bd55a0786c7aa3d7dcc8956e213771bf9551541d5c`.
- Windows Server 2022: 17/17 checks; `native_storage` 6,222 ms, `state_hardening` 2,111 ms, native `windows_paths` 1,561 ms; evidence SHA-256 `3a930e04b56cdf809449d0520c7af70b5b7c91f4babf45a743d4521e4733d27c`.
- Local: storage 34 files/277 tests, contract 41/279, integration 21/36, and bounded-worker unit 277 passed files/3,162 tests with 27 files/29 intentional skips. The initial unconstrained unit run hit eight unrelated five-second scheduler timeouts; all six affected files passed 50/50 in isolation before the bounded aggregate passed.
- Typecheck, lint/export (881 files/eight packages), runtime boundary (633 production/23 external modules), planning (268 tasks/91 requirements/757 dependencies), native-CI policy 8/8, supply-chain 6/6, and package 43 tests plus two deterministic 6,293-entry builds pass.
