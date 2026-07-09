# IFC-V1-010 API Route And Stream Contract Tests

Task: `IFC-V1-010` API route and stream contract tests.

Date: 2026-07-09

## Implementation

- Added `apiRouteErrorBodySchema` in `@hostdeck/contracts` so route-level failures validate the HTTP body shape `{ error }` around the shared bounded error envelope.
- Added `packages/server/src/api-route-contracts.ts` as the aggregate V1 route contract manifest.
- Exported the route contract manifest from `@hostdeck/server`.
- Covered the current headless V1 route families: host status, session read/detail/output, one-session stream, prompt/slash/stop/raw writes, pairing claim/status, security state, dashboard lock, rejected dashboard unlock, network state, and rejected dashboard LAN mutation.
- Each route contract declares stable id, family, operation, handler name, method, `/api/...` path, auth mode, request schemas where needed, success response or stream event schema, route error body schema, sample payloads, and typed errors.
- Pair routes use pair-specific response schemas while preserving the shared trust-state body shape.
- Error contracts validate every declared typed error sample against the shared API route error body schema.

## Coverage

- Stable route id order for 16 current V1 route contracts.
- Duplicate route id and duplicate method/path detection.
- Route families: `host`, `sessions`, `stream`, `writes`, `pairing`, `security`, and `network`.
- Valid method set: `GET` and `POST`.
- Auth modes for local reads, dashboard write cookie plus CSRF, pairing-code claim, optional device cookie, no-auth network state, and admin-only rejected operations.
- Params, query, and body schema validation for routes that carry request inputs.
- Success response schema validation for non-stream routes.
- Stream event schema validation for the one-session stream route.
- Explicit no-success contract for rejected dashboard unlock and dashboard LAN mutation routes.
- Bounded typed error envelopes for validation, permission, not found, stale session, storage, daemon-unavailable, audit-unavailable, session-not-writable, unsupported slash, and internal failure cases.

## Validation

Environment:

```text
codex-cli 0.143.0
tmux 3.4
Ubuntu 24.04.4 LTS
2026-07-09T04:00:23-04:00
```

Commands:

```text
pnpm install --frozen-lockfile
pnpm --filter @hostdeck/server typecheck
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

- `pnpm install --frozen-lockfile`: passed; lockfile was current.
- `pnpm --filter @hostdeck/server typecheck`: passed.
- `pnpm --filter @hostdeck/contracts typecheck`: passed.
- `pnpm test:contract`: passed; 5 files and 43 tests.
- `pnpm lint`: passed; Biome and package export checks passed.
- `pnpm check:scaffold`: passed; 8 packages and 12 root scripts.
- `pnpm -r --if-present typecheck`: passed for all 8 workspace packages with typecheck scripts.
- `pnpm test`: passed; 24 files and 150 tests.
- `pnpm test:tmux`: passed; 1 real tmux smoke test.
- `git diff --check`: passed.

## Remaining Gaps

- This is an aggregate contract manifest for the current headless route families, not Fastify route registration.
- CLI command contracts remain in `IFC-V1-013` after CLI command implementation tasks.
- Broader write rejection and daemon-unavailable integration coverage remains in `IFC-V1-014`.
- API/CLI module hardening remains in `IFC-V1-090`.
