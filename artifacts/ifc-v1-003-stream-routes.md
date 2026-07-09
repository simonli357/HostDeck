# IFC-V1-003 Stream Route Contracts

Task: `IFC-V1-003` One-session stream endpoint with reconnect and replay boundary behavior.

Date: 2026-07-09

## Implementation

- Added headless stream route handlers in `packages/server/src/stream-routes.ts`.
- Exported stream route handlers from `@hostdeck/server`.
- Extended read authorization route names with `session_stream`.
- The stream route validates session params and output cursor query through shared contract schemas before opening a stream.
- Read authorization is an explicit injectable gate and receives the exact `session_stream` route plus one session id.
- Stale and missing sessions fail before stream open with typed route errors.
- Open streams emit schema-validated `stream_status`, replay output, replay-boundary, and error events.
- Retained output is replayed through the existing output reader before live subscription starts.
- Retention boundaries remain `retention` for fresh replay; stale reconnect cursors are reported as `stale_cursor`.
- The live source is required by the handler input, so the route cannot fake live-stream availability.
- Live events are rejected if they identify a different session or move cursors backward.
- Replay and live-source failures are reported as typed stream error events before the stream closes.

## Coverage

- Ordered replay after cursor.
- Reconnect replay without duplicate acknowledged output.
- Retention boundary on fresh replay.
- Stale-cursor boundary on reconnect.
- Read authorization for the stream route.
- Malformed session id.
- Missing session.
- Invalid output cursor.
- Stale-session rejection before stream open.
- Reader unavailable as a typed stream error event.
- Live event crossing session boundaries as a typed stream error event.

## Validation

Environment:

```text
codex-cli 0.143.0
tmux 3.4
Ubuntu 24.04.4 LTS
2026-07-09T03:34:13-04:00
```

Commands:

```text
pnpm install --frozen-lockfile
pnpm --filter @hostdeck/server typecheck
pnpm test:unit -- packages/server/src/stream-routes.test.ts
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
- `pnpm test:unit -- packages/server/src/stream-routes.test.ts`: passed; root Vitest invocation reported 23 files and 141 tests.
- `pnpm lint`: passed; Biome and package export checks passed.
- `pnpm check:scaffold`: passed; 8 packages and 12 root scripts.
- `pnpm -r --if-present typecheck`: passed for all 8 workspace packages with typecheck scripts.
- `pnpm test`: passed; 23 files and 141 tests.
- `pnpm test:contract`: passed; 4 files and 37 tests.
- `pnpm test:tmux`: passed; 1 real tmux smoke test.
- `git diff --check`: passed.

## Remaining Gaps

- These are headless stream route handlers, not mounted Fastify/SSE/WebSocket routes.
- `IFC-V1-004` owns prompt, slash, stop, and raw-input write pipeline ordering.
- `IFC-V1-010` owns aggregate API/stream contract coverage after write routes exist.
- CLI and dashboard consumers remain later tasks.
