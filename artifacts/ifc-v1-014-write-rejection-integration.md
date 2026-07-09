# IFC-V1-014 Write Rejection Integration

Task: `IFC-V1-014` add write rejection and failure-path integration tests.

Date: 2026-07-09

## Coverage Added

- Replaced the `pnpm test:integration` placeholder with a Vitest integration runner.
- Added `tests/write-rejection.integration.test.ts`.
- The integration suite uses real SQLite repositories for settings, sessions, auth devices, and audit events.
- The suite uses the fake tmux adapter through a dispatch probe that counts attempted `sendInput` and `stopSession` calls.
- Rejection matrix coverage includes malformed session id, malformed body, untrusted write, read-only client, locked host, stale/stopped/crashed/unknown session lifecycles, unsupported slash command, multi-session target list, raw input without confirmation, audit-unavailable preflight, tmux dispatch failure, and daemon-unavailable write commands.

## Assertions

- Unsafe precondition failures return typed non-2xx write responses.
- Unsafe precondition failures record no tmux `sendInput` or `stopSession` dispatch.
- Eligibility rejections that occur after auth/session lookup append rejected audit events.
- Audit-unavailable failure rejects before tmux dispatch.
- Tmux dispatch failure returns `accepted: false`, records accepted-then-failed audit rows, and does not report fake success.
- CLI write commands return `daemon_unavailable` before any daemon-side write can run when the daemon cannot be reached.

## Validation

Commands:

```text
git diff --check
pnpm test:integration
pnpm typecheck
pnpm lint
pnpm test:unit
pnpm test:contract
pnpm check:scaffold
```

Results:

- `git diff --check`: passed.
- `pnpm test:integration`: passed; Vitest reported 1 file and 15 tests.
- `pnpm typecheck`: passed.
- `pnpm lint`: passed; Biome checked 108 files and package exports passed.
- `pnpm test:unit`: passed; Vitest reported 31 passed files and 1 skipped file, with 174 passed tests and 1 skipped test.
- `pnpm test:contract`: passed; Vitest reported 6 files and 68 tests.
- `pnpm check:scaffold`: passed; 8 packages and 12 root scripts.

## Remaining Gaps

- HTTP registration for all write route families is still a later API/service integration gap; this task proves the headless route integration layer and CLI daemon-unavailable behavior.
- API/CLI module hardening remains in `IFC-V1-090`.
