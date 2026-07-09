# DAT-V1-014 Durable Audit Repository

Date: 2026-07-08

## Scope

- Added `@hostdeck/storage` audit event repository in `packages/storage/src/audit-repository.ts`.
- Repository appends, reads, requires, and lists durable `audit_events` rows.
- Payload summaries are serialized as JSON only after passing `@hostdeck/contracts` `auditEventRecordSchema`.
- Persisted rows are parsed back through the same contract so corrupt JSON or invalid rows fail visibly.
- Listing supports global and session-scoped reads with bounded limits.

## Failure Behavior Covered

- Duplicate audit ids return `audit_event_exists`.
- Missing events return `audit_event_not_found`.
- Sensitive payload keys, oversized payload strings, invalid actor identity, missing session references for session-scoped writes, and invalid persisted JSON return `invalid_audit_event`.

## Validation

- Required V1 action types covered by repository tests: `prompt`, `slash`, `stop`, `raw_input`, `pair`, `lock`, `unlock`, `lan_enable`, `lan_disable`, and `token_revoke`.
- `pnpm install --frozen-lockfile` passed.
- `pnpm --filter @hostdeck/storage typecheck` passed.
- `pnpm check:scaffold` passed.
- `pnpm typecheck` passed.
- `pnpm -r --if-present typecheck` passed.
- `pnpm lint` passed.
- `pnpm test` passed with 73 tests across 11 files.
- `pnpm test:unit -- packages/storage/src/audit-repository.test.ts packages/contracts/src/storage.contract.test.ts` passed with 73 tests across 11 files.
- `pnpm test:contract` passed with 37 tests across 4 files.
- `git diff --check` passed.

## Remaining Follow-Up

- `DAT-V1-016` can now add cross-repository restart-persistence coverage for registry, auth, settings, and audit state.
- `IFC-V1-004` still needs the API write pipeline to use audit preflight before tmux send.
- Retention pruning for audit rows remains owned by `DAT-V1-015`.
