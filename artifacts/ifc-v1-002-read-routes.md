# IFC-V1-002 Read Route Contracts

Task: `IFC-V1-002` Host status, sessions list/detail, and output-read route contracts.

Date: 2026-07-09

## Implementation

- Added headless read route handlers in `packages/server/src/read-routes.ts`.
- Exported read route handlers from `@hostdeck/server`.
- Exported `SessionListResponse` and `SessionDetailResponse` contract types from `@hostdeck/contracts`.
- Route handlers validate successful responses through shared schemas for host status, session list, session detail, and session output.
- Session list/detail mapping exposes tmux backend metadata, lifecycle state, status, attention, branch, bounded recent-output summary, and stale state.
- Session list ordering uses attention priority first, then recent activity, then name.
- Stale sessions stay visible in list/detail as `lifecycle_state: "stale"` and are forced to visible non-healthy read state: `status: "disconnected"` and `attention: "unknown"`.
- Output reads validate params/query, reject stale sessions with `stale_session`, and return bounded replay responses through `sessionOutputResponseSchema`.
- Read authorization is an explicit injectable gate; default local read policy allows reads until a caller supplies stricter auth.

## Coverage

- Host status contract response.
- Attention-sorted session list with stale state visible.
- Session detail contract response with tmux metadata and recent output summary.
- Output-read replay after cursor.
- Permission-denied read route.
- Malformed session id.
- Missing session.
- Invalid output cursor.
- Stale output rejection.

## Validation

Environment:

```text
codex-cli 0.143.0
tmux 3.4
Ubuntu 24.04.4 LTS
2026-07-09T03:22:38-04:00
```

Commands:

```text
pnpm install --frozen-lockfile
pnpm --filter @hostdeck/server typecheck
pnpm test:unit -- packages/server/src/read-routes.test.ts
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
- `pnpm test:unit -- packages/server/src/read-routes.test.ts`: passed; root Vitest invocation reported 22 files and 135 tests.
- `pnpm lint`: passed; Biome and package export checks passed.
- `pnpm check:scaffold`: passed; 8 packages and 12 root scripts.
- `pnpm -r --if-present typecheck`: passed for all 8 workspace packages with typecheck scripts.
- `pnpm test`: passed; 22 files, 135 tests.
- `pnpm test:contract`: passed; 4 files, 37 tests.
- `pnpm test:tmux`: passed; 1 real tmux smoke test.
- `git diff --check`: passed.

## Remaining Gaps

- These are headless route handlers, not mounted Fastify routes.
- `IFC-V1-003` owns the one-session stream endpoint.
- `IFC-V1-004` owns write routes and audit/tmux write ordering.
- `IFC-V1-010` owns aggregate API/stream contract coverage after route families are complete.
