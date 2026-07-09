# IFC-V1-004 Write Route Contracts

Task: `IFC-V1-004` Prompt, slash, stop, and raw-input write pipeline ordering.

Date: 2026-07-09

## Implementation

- Added headless write route handlers in `packages/server/src/write-routes.ts`.
- Exported write route handlers from `@hostdeck/server`.
- Added route handlers for prompt input, slash command input, stop, and raw input.
- The pipeline validates path params, request body, and one-session target lists before auth and dispatch.
- Dashboard writes require a paired write device token plus matching CSRF token through the existing auth repository.
- The route loads host lock state and session lifecycle before write eligibility checks.
- The route uses `checkWriteEligibility` for one-session targeting, lock, lifecycle, slash allowlist, and raw-input confirmation gates.
- Accepted writes append an audit preflight event before tmux dispatch.
- Prompt and slash writes call `tmux.sendInput` with Enter; raw input sends exact text without appending Enter; stop calls `tmux.stopSession` and persists stopped lifecycle state.
- Tmux/storage dispatch failures return rejected write responses instead of accepted success; a failed audit event is attempted after dispatch failure.
- Auth, validation, lock, lifecycle, audit-unavailable, and tmux-dispatch failures return typed `WriteResponse` errors with no hidden command success.

## Coverage

- Accepted prompt dispatch with bounded prompt audit summary.
- Accepted slash dispatch with literal command and argument text.
- Accepted stop dispatch with storage lifecycle update.
- Accepted raw-input dispatch with confirmation and no automatic Enter.
- Malformed session id and malformed request bodies.
- Missing session.
- Missing token/CSRF, CSRF mismatch, expired token, revoked token, and read-only client.
- Locked host.
- Unsupported slash command.
- Multi-session target rejection.
- Raw input without confirmation.
- Stale, stopped, crashed, unknown, starting, and stopping session lifecycle rejection.
- Audit unavailable before tmux dispatch.
- Tmux missing-target dispatch failure after audit preflight without accepted success.

## Validation

Environment:

```text
codex-cli 0.143.0
tmux 3.4
Ubuntu 24.04.4 LTS
2026-07-09T03:50:25-04:00
```

Commands:

```text
pnpm install --frozen-lockfile
pnpm --filter @hostdeck/server typecheck
pnpm test:unit -- packages/server/src/write-routes.test.ts
pnpm lint
pnpm check:scaffold
pnpm -r --if-present typecheck
pnpm test
pnpm test:contract
pnpm test:tmux
git diff --check
```

Results:

- `pnpm install --frozen-lockfile`: passed; lockfile was current.
- `pnpm --filter @hostdeck/server typecheck`: passed.
- `pnpm test:unit -- packages/server/src/write-routes.test.ts`: passed; root Vitest invocation reported 24 files and 150 tests.
- `pnpm lint`: passed; Biome and package export checks passed.
- `pnpm check:scaffold`: passed; 8 packages and 12 root scripts.
- `pnpm -r --if-present typecheck`: passed for all 8 workspace packages with typecheck scripts.
- `pnpm test`: passed; 24 files and 150 tests.
- `pnpm test:contract`: passed; 4 files and 37 tests.
- `pnpm test:tmux`: passed; 1 real tmux smoke test.
- `git diff --check`: passed.

## Remaining Gaps

- These are headless write route handlers, not mounted Fastify routes.
- `IFC-V1-010` owns aggregate API route and stream contract coverage now that read, stream, write, and security route families exist.
- `IFC-V1-014` owns broader failure-path integration hardening after aggregate route/CLI contracts.
- CLI and dashboard consumers remain later tasks.
