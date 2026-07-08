# DAT-V1-001 SQLite Driver And Migration Spike

Date: 2026-07-08

## Decision

- Use `better-sqlite3` for V1 storage implementation.
- Use a first-party migration runner in `@hostdeck/storage` instead of adopting a migration framework.
- Do not use `node:sqlite` for V1 while the pinned Node 22 runtime still treats it as experimental.
- Do not use `sqlite3` or the `sqlite` wrapper because `node-sqlite3` is deprecated/archived and `sqlite` is a wrapper around that driver.

## Current Facts Checked

| Candidate | Current facts | Result |
| --- | --- | --- |
| `node:sqlite` | Present in pinned Node `22.22.2`; local probe created a file DB, enabled WAL, created a strict `schema_migrations` table, inserted/read a row, and closed cleanly. The runtime emitted `ExperimentalWarning: SQLite is an experimental feature and might change at any time`. Node v22.6.0 docs mark SQLite as Stability 1.1 and behind `--experimental-sqlite`; current Node docs say it became a release candidate only in later Node lines. | Reject for V1 production path; keep as future revisit after pinned runtime promotes it past experimental. |
| `better-sqlite3` | `npm view` latest registry version: `12.11.1`; license MIT; engine supports `20.x || 22.x || 23.x || 24.x || 25.x || 26.x`; dependencies are `bindings` and `prebuild-install`. Project README documents synchronous API, transactions, WAL guidance, worker-thread support, and MIT license. | Choose. Native install friction is real but acceptable for Ubuntu V1 with a clean-install smoke gate. |
| `sqlite3` / `node-sqlite3` | `npm view` latest registry version: `6.0.1`; BSD-3-Clause; Node `>=20.17.0`; native prebuild dependencies. GitHub README marks the repository deprecated/unmaintained. | Reject. Not appropriate as a new V1 foundation dependency. |
| `sqlite` wrapper | `npm view` latest registry version: `5.1.1`; MIT; last modified 2023-11-01; GitHub README describes it as a promise/migration wrapper around `sqlite3`. | Reject with `sqlite3`; wrapper does not remove the deprecated base-driver concern. |

Sources:

- Node SQLite docs: https://nodejs.org/download/release/v22.6.0/docs/api/sqlite.html and https://nodejs.org/api/sqlite.html
- `better-sqlite3` README/API: https://github.com/WiseLibs/better-sqlite3 and https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md
- `node-sqlite3` README/npm metadata: https://github.com/TryGhost/node-sqlite3 and `npm view sqlite3`
- `sqlite` README/npm metadata: https://github.com/kriasoft/node-sqlite and `npm view sqlite`

## Commands Run

- `node -v && pnpm -v`
- `node -e "import('node:sqlite').then(...)"` verified `DatabaseSync`, `StatementSync`, `backup`, and `constants` exports, with an experimental warning.
- `node --input-type=module -e "<sqlite probe>"` created a temp DB, set WAL, created `schema_migrations`, inserted/read `0001_probe`, then removed the temp DB; emitted the experimental warning.
- `npm view better-sqlite3 version license engines dependencies optionalDependencies repository dist-tags time.modified --json`
- `npm view better-sqlite3 versions --json`
- `npm view sqlite3 version license engines dependencies optionalDependencies repository dist-tags time.modified --json`
- `npm view sqlite version license engines dependencies optionalDependencies repository dist-tags time.modified --json`

## Migration Approach

- Store migration files in `@hostdeck/storage` with ordered ids such as `0001_initial.sql`.
- Maintain a `schema_migrations` table with `version`, `applied_at`, and checksum.
- Open the DB, set required PRAGMAs, acquire a migration transaction, create the migration table if missing, read applied migrations, reject unknown future or checksum-mismatched migrations, apply pending migrations in order, and fail startup on any migration error.
- Use explicit repository tests with temp DB directories for fresh DB, no-op current DB, sequential upgrade, failed migration rollback, unknown future schema, checksum mismatch, corrupt DB, and read-only state dir.
- Do not silently recreate corrupt databases or downgrade schemas.

## Setup Implications

- `better-sqlite3` is a native dependency. V1 setup/release tasks must prove install on the supported Ubuntu/Node `22.22.2` path.
- If prebuilt install fails in clean Ubuntu smoke, record it as a blocker and either add documented build prerequisites or reopen the driver decision. Do not silently fall back to `node:sqlite`.
- Add the dependency during `DAT-V1-010`, not in this spike.

## Follow-On Task Updates

- `DAT-V1-010` can start once this spike is committed.
- Developer guide and command reference stay unchanged until the dependency is actually added and install/setup behavior is validated.
