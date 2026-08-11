# DAT-V1-104 Native State/Security Hardening

Date: 2026-08-11

Status: criteria frozen; implementation and native evidence pending.

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

## Planned Evidence

- Focused migration/recovery/lease tests plus one native state-hardening matrix.
- Existing native storage process-death tests retained and strengthened to use real lease and secure-state authority.
- Native Linux UID/mode/link inspection and native Windows owner/DACL/reparse/ADS/link inspection.
- Full storage, typecheck, lint/export, runtime-boundary, package, planning, and native CI gates.
