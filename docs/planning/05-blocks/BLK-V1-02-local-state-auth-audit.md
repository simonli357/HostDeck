# BLK-V1-02 Local State, Auth, Audit, And Config

Owns durable local truth for sessions, settings, trust state, lock/LAN state, audit records, and retention policy.

## Summary

- Goal: Provide the durable local state and safety foundation required before real writes, restart reconciliation, or release privacy claims.
- Required for V1: Yes.
- User/workflow value: HostDeck can restart honestly, preserve managed-session metadata, require trusted writes, and show who changed risky state.
- In scope: SQLite driver/migrations, repositories, settings, session registry records, pairing/token records, lock state, LAN setting, audit records, output/audit retention, config defaults and overrides.
- Out / deferred: Hosted relay, team accounts, cloud sync, long-term Codex history sync, remote dashboard unlock.
- Requirement refs: `DR-001` to `DR-010`, `SFR-001`, `SFR-002`, `SFR-004`, `SFR-006` to `SFR-008`, `PR-009`, `NFR-001`, `NFR-008`.
- UX refs: `IR-005`, `IR-008`, `UX-001`, `UX-008`, `UX-009`.
- Decision refs: `DEC-004`, `DEC-005`, `DEC-007`, `DEC-008`, `DEC-010`, `DEC-011`, `DEC-014`, `DEC-015`, `DEC-016`.

## Local Architecture

| Part | Responsibility | Inputs | Outputs | Failure states |
| --- | --- | --- | --- | --- |
| Migration runner | Initialize and upgrade local SQLite schema. | State directory, `better-sqlite3`, migration files. | Opened database at known schema version. | Corrupt database, failed migration, unknown future schema, read-only state dir. |
| Session registry repository | Persist managed-session identity and tmux metadata. | Session start/reconcile operations from server/tmux block. | Durable records for restart reconciliation and stale marking. | Duplicate name, missing required fields, invalid cwd, stale target metadata. |
| Auth and pairing repository | Store hashed tokens, pairing codes, permission mode, revocation, expiry, lock state, CSRF token binding metadata as needed. | CLI pair/unlock, dashboard claim, API trust checks. | Trusted/read-only/untrusted state with no raw token persistence and no cookie-only write grant. | Expired/used pairing code, revoked token, missing/invalid CSRF header, ambient write grant, raw token leakage. |
| Audit repository | Record bounded action events for writes and risky state changes. | Write pipeline, pairing, lock/unlock, LAN changes, stop/raw actions. | Durable audit events with bounded payload summaries. | Audit unavailable, unbounded payload, missing action type, failed preflight. |
| Retention cleanup | Enforce output and audit bounds. | `DEC-016` defaults: 10,000 output events or 10 MB per session; 5,000 audit events or 30 days globally. | Explicit truncation/replay boundary state and bounded local storage. | Silent data loss, unbounded growth, invisible replay boundary. |

## Contracts And Data

| Contract/data item | Owner | Rules | Validation |
| --- | --- | --- | --- |
| `schema_migrations` | `@hostdeck/contracts` schema; later storage package repository | Server cannot accept requests after failed or unknown migration. | Contract tests now; later migration tests and startup negative tests. |
| `sessions` and `session_metadata` | `@hostdeck/contracts` schemas and `@hostdeck/storage` repositories | Stable id, unique V1 name, absolute cwd, backend/tmux target, lifecycle, status, attention, summary. | Contract tests and repository tests now; later restart integration tests. |
| `auth_devices` and `pairing_codes` | `@hostdeck/contracts` schemas and `@hostdeck/storage` repositories | Store hashed secrets only, including device tokens, CSRF tokens, and pairing codes; pairing is time-bounded and one-time; revoked/expired/read-only/CSRF-mismatched devices cannot write. | Contract tests, auth lifecycle tests, and local state inspection now. |
| `settings` | `@hostdeck/contracts` schema and `@hostdeck/storage` repository | Defaults are localhost, LAN off, configured state dir and port, visible lock state. | Contract tests and settings repository tests now; later startup/network smoke. |
| `audit_events` | `@hostdeck/contracts` schema and `@hostdeck/storage` repository | Required before remote write dispatch except emergency lock; payload summary is bounded. | Contract tests and audit repository tests now; later write-pipeline tests. |

## Implementation Blueprint

| Slice | Goal | Epics/tasks | Dependencies | Exit evidence |
| --- | --- | --- | --- | --- |
| Foundation | Choose storage/token/retention approach and create migrations/repositories. | Backlog must create leaf tasks for `SPK-ARCH-002`, `SPK-ARCH-003`, `SPK-ARCH-004`, schema migrations, settings repository, session registry, auth repository, audit repository. | `BLK-V1-01`, architecture spikes. | Storage/auth/audit test outputs and spike decision artifacts. |
| Hardening | Prove state corruption, audit failures, token misuse, retention boundaries, and restart persistence fail visibly. | Backlog must create hardening tasks for migration failure, audit preflight, retention cleanup, token revocation/expiry, lock/LAN persistence, and restart reload. | Foundation storage tasks. | Negative-test artifact plus local state inspection. |
| Release readiness | Document local state directory defaults, privacy posture, backup/reset guidance, and known limits. | Backlog must create docs/release tasks owned by `BLK-V1-06` when setup commands exist. | Implemented storage/config paths. | Developer/user guide updates and release-readiness checklist. |

## Validation Plan

| Layer | What to prove | Evidence |
| --- | --- | --- |
| Unit | Payload bounds, retention math, token hashing/revocation/expiry, config parsing. | Planned `pnpm test:unit` output. |
| Integration | Migrations, repositories, restart persistence, audit preflight, lock/LAN state. | Planned `pnpm test:integration` output with temp-state cleanup notes. |
| System / E2E | API/CLI write path rejects writes when audit/auth/lock/session preconditions fail. | Later `BLK-V1-04` API/CLI evidence. |
| Manual / device | Local state inspection verifies no raw token storage and bounded audit payloads. | Security/privacy checklist artifact. |

## Backlog Links

| Epic | Leaf tasks | Status | Evidence |
| --- | --- | --- | --- |
| Architecture spikes | `DAT-V1-001` to `DAT-V1-003` | Done | `artifacts/dat-v1-001-sqlite-driver-spike.md`, `artifacts/dat-v1-002-token-transport-spike.md`, `artifacts/dat-v1-003-retention-caps-spike.md`, `docs/tracking/backlog/local-state-auth-audit.md` |
| Storage foundation | `DAT-V1-010` to `DAT-V1-017` | In progress: `DAT-V1-010` to `DAT-V1-015` done; `DAT-V1-016` and `DAT-V1-017` ready | `artifacts/dat-v1-010-sqlite-migration-runner.md`, `artifacts/dat-v1-011-settings-repository.md`, `artifacts/dat-v1-012-session-repositories.md`, `artifacts/dat-v1-013-auth-repositories.md`, `artifacts/dat-v1-014-audit-repository.md`, `artifacts/dat-v1-015-retention-repository.md`, `docs/tracking/backlog/local-state-auth-audit.md` |
| Storage hardening | `DAT-V1-090` | Planned | `docs/tracking/backlog/local-state-auth-audit.md` |

## Done Criteria

- SQLite driver and migration approach are selected and recorded.
- Durable session, auth, settings, audit, and retention records exist behind repositories.
- Raw tokens are never stored; revoked/expired tokens cannot write.
- Audit preflight blocks remote writes when audit storage is unavailable.
- Retention boundaries are explicit to output/API/UI consumers.
- Restart persistence supports tmux reconciliation without silently recreating sessions.
- Block evidence is recorded in this file, owning tasks, or artifacts.
- V1 completion matrix in `00-index.md` is updated.

## Open Questions / Spikes

| ID | Question | Owner | Exit evidence |
| --- | --- | --- | --- |
| `SPK-ARCH-002` | Which SQLite Node driver and migration approach should V1 use? | Resolved by `DEC-014` / `DAT-V1-001` | `artifacts/dat-v1-001-sqlite-driver-spike.md`. |
| `SPK-ARCH-003` | What token transport should dashboard pairing use? | Resolved by `DEC-015` / `DAT-V1-002` | `artifacts/dat-v1-002-token-transport-spike.md` and API contract update. |
| `SPK-ARCH-004` | What output and audit retention caps should V1 use? | Resolved by `DEC-016` / `DAT-V1-003` | `artifacts/dat-v1-003-retention-caps-spike.md` and `defaultRetentionPolicy`. |
