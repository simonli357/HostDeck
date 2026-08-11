# DAT-V1-103 Native Storage Parity

Status: in progress

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
