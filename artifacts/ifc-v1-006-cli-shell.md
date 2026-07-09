# IFC-V1-006 CLI Shell And API Client

Task: `IFC-V1-006` CLI command shell, API client, config loading, error rendering, and exit-code families.

Date: 2026-07-09

## Implementation

- Added the `@hostdeck/cli` core shell in `packages/cli/src/shell.ts`.
- Added a reusable HostDeck API client in `packages/cli/src/api-client.ts`.
- Added config loading in `packages/cli/src/config.ts` with safe localhost defaults, `--api-url`, `--host`, `--port`, `--config`, and `HOSTDECK_API_BASE_URL` / `HOSTDECK_HOST` / `HOSTDECK_PORT` support.
- Added strict config validation for URL protocol, credentials, path/query/fragment, host, and port bounds.
- Added argument parsing for `status`, `help`, `version`, `--json`, and daemon connection options.
- Added user-facing rendering for status output, JSON status output, usage errors, invalid config, daemon unavailable, typed API errors, and internal daemon contract mismatches.
- Added stable exit families in `packages/cli/src/exit-codes.ts`: success `0`, usage `64`, daemon unavailable `69`, typed API error `70`, invalid config `78`, and internal `1`.
- Added CLI unit tests for config loading and API client behavior plus CLI contract tests for shell parsing, daemon-unavailable behavior, error rendering, and typed API failures.
- Declared the `@hostdeck/cli` dependency on `@hostdeck/contracts`.

## Coverage

- Default config resolves to `http://127.0.0.1:3777`.
- Config file values load through an injected reader, with CLI flags taking precedence.
- Invalid API URL protocol and base URL path components fail before a request can be made.
- API client requests `GET /api/host/status` and validates `HostStatusResponse`.
- Fetch failures become `daemon_unavailable` CLI failures with retryable/actionable output.
- Typed API error responses become stable API-error exits while preserving HTTP status and field context.
- Malformed `status` arguments produce usage exit `64`.
- Invalid daemon port config produces config exit `78`.
- `status --json` keeps success exit `0` and emits parseable JSON.

## Validation

Environment:

```text
codex-cli 0.143.0
tmux 3.4
Ubuntu 24.04.4 LTS
2026-07-09T04:15:11-04:00
```

Commands:

```text
pnpm install --frozen-lockfile
pnpm --filter @hostdeck/cli typecheck
pnpm --filter @hostdeck/contracts typecheck
pnpm test:contract
pnpm lint
pnpm check:scaffold
pnpm -r --if-present typecheck
pnpm test
pnpm test:tmux
git diff --check
```

Results:

- `pnpm install --frozen-lockfile`: passed; lockfile was current after adding the internal CLI dependency.
- `pnpm --filter @hostdeck/cli typecheck`: passed.
- `pnpm --filter @hostdeck/contracts typecheck`: passed.
- `pnpm test:contract`: passed; 6 files and 49 tests.
- `pnpm lint`: passed; Biome checked 97 files and package exports passed.
- `pnpm check:scaffold`: passed; 8 packages and 12 root scripts.
- `pnpm -r --if-present typecheck`: passed for all 8 workspace packages with typecheck scripts.
- `pnpm test`: passed; 26 files and 157 tests.
- `pnpm test:tmux`: passed; 1 real tmux smoke test.
- `git diff --check`: passed.

## Remaining Gaps

- This task adds the tested CLI core, not a packaged runnable `codexdeck` binary.
- Session lifecycle commands remain in `IFC-V1-007`.
- Pairing, lock/unlock, and LAN commands remain in `IFC-V1-008`.
- Full per-command CLI contract coverage remains in `IFC-V1-013` after those command leaves are implemented.
- Command-reference updates remain in `REL-V1-003` after CLI commands are runnable and smoke-tested.
