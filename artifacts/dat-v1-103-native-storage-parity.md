# DAT-V1-103 Native Storage Parity

Status: complete

## Frozen Acceptance

- Native Ubuntu and Windows load exact `better-sqlite3` 12.11.1 for Node ABI 127 from the frozen package graph; the loaded `.node` file has the target-native format and no global/source fallback.
- Fresh and prior-version databases reach the same checksummed schema and required indexed query plans on both targets.
- Durable working directories accept local POSIX and Windows drive-absolute paths, reject relative/drive-relative/UNC/NUL forms, and preserve existing rows during migration.
- SQL failure and process termination during the real pending migration leave the prior schema, migration ledger, and user rows atomic and recoverable.
- Backup writes a new validated SQLite snapshot, refuses ambiguous paths or overwrite, cleans partial output, and preserves selected durable state.
- Offline restore validates the source before mutation; failure or process termination leaves the destination atomic. A retained prior-release backup remains readable by that release and can be re-upgraded without data loss.
- Native reports contain bounded counts and package identities only. Temporary databases, journals, workers, and backup files are removed.

## Completion Authority

One no-skip native suite must pass on both pinned CI targets from the same clean commit. The accepted run and implementation commit are recorded here before closure.

## Accepted Evidence

- Implementation: `649e794`; Windows corrections: `200f4c1`, `42fd03c`.
- Native CI run `31509712124` passed all no-skip checks and sanitized-evidence verification on pinned `linux-x64` and `windows-x64` jobs from `42fd03c`.
- The storage gate passed 25 tests on each target, covering exact native SQLite provenance, schema/query-plan identity, cross-platform cwd migration, process-death migration recovery, validated backup/restore, retained-release re-upgrade, and process-death restore atomicity.
- Local closure passed the same 25 storage tests, full typecheck, lint/package exports, runtime boundary (633 production modules, 23 externals), and native-CI policy verification.
