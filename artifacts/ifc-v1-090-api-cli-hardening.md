# IFC-V1-090 API/CLI Hardening

Task: `IFC-V1-090` harden API/CLI startup, write path, service controls, LAN behavior, and failure surfaces.

Date: 2026-07-09

## Pre-Implementation Criteria

- The foreground HTTP service must register the V1 route families that already have headless handlers: host status, session start/list/detail/output, prompt input, stop, pairing/status, security state, dashboard lock rejection paths, and network state.
- The registered HTTP routes must reuse the headless route handlers and shared schemas. The HTTP layer must only translate method/path/query/body/cookie/header/remote-address details.
- CLI normal operations must work against the real local service for `status`, `start`, `list`, `send`, and `stop`, or fail with typed errors that preserve the true cause.
- Local-admin HTTP privileges must be limited to loopback callers. A LAN-enabled listener must not turn unauthenticated remote writes into local-admin writes.
- Dashboard/browser writes must still require the paired-device cookie plus CSRF header. Cookie-only writes must not become ambient write permission.
- Unknown routes, wrong methods, malformed JSON, malformed params, malformed query, stale sessions, unsupported slash commands, audit failures, and daemon-unavailable CLI paths must return typed failures and no fake success.
- Startup must still refuse broken state, failed migration, duplicate bind, tmux discovery failure, and output-reader startup failure before claiming ready.
- Bind behavior must remain localhost by default; explicit LAN settings must be visible through status/network responses.

## Known Gaps Before Changes

- `startHostHttpService` only exposed `GET /api/host/status`.
- CLI `start`, `list`, `send`, and `stop` already called daemon API routes that the foreground service did not register.
- The HTTP adapter had no local-admin boundary for CLI write routes, so naïvely wiring writes as local admin would have violated the LAN/security contract.

## Planned Validation

- Focused service tests for HTTP route registration, CLI service workflow, loopback-only local-admin writes, browser CSRF enforcement, malformed JSON, unsupported methods, and unknown routes.
- Existing write rejection integration suite to guard handler-level failure ordering.
- Full relevant workspace checks before closure: `git diff --check`, focused Vitest tests, `pnpm test:integration`, `pnpm typecheck`, `pnpm lint`, `pnpm test:unit`, `pnpm test:contract`, and `pnpm check:scaffold`.

## Implementation

- Registered the existing headless route handlers in `startHostHttpService` for host status, session start/list/detail/output, session stream SSE replay, prompt/slash/stop/raw writes, pairing claim/status, security state, dashboard lock/unlock rejection, and network state/LAN mutation rejection.
- Kept the HTTP service adapter thin: it owns method/path/query/body/cookie/header/remote-address translation, while route semantics still live in the headless handlers.
- Added loopback local-admin detection for CLI-style requests and prevented browser-origin requests from using that path.
- Added same-host `Origin` enforcement for browser write/pair/lock requests.
- Preserved browser write trust: cookie-only requests are rejected; successful dashboard writes require the `hostdeck_device` cookie plus `X-HostDeck-CSRF`.
- Seeded the real tmux adapter with startup-reconciled live targets so restarted services can reuse known HostDeck targets instead of treating them as missing.
- Split security route handlers into `packages/server/src/security-routes.ts` so `host-service.ts` can reuse them without importing back through the package barrel.

## Coverage Added

- `packages/server/src/host-service.test.ts` now proves the foreground HTTP service registers session, output, write, pairing, security, and network route families.
- HTTP route tests cover local-admin session start, browser write rejection without trust, mismatched-origin rejection, pairing claim cookie issuance, cookie-only write rejection, cookie+CSRF write acceptance, security/network state reads, dashboard unlock rejection, unsupported method, unknown route, and malformed JSON.
- `tests/service-mode-smoke.test.ts` now proves `runCli start`, `list`, `send`, and `stop` work through the real foreground HTTP service with the fake tmux adapter.
- `pnpm test:tmux` still passes after the real tmux adapter restart-seeding change.

## Validation

Commands:

```text
pnpm exec vitest run packages/server/src/host-service.test.ts tests/service-mode-smoke.test.ts
git diff --check
pnpm test:integration
pnpm typecheck
pnpm lint
pnpm test:unit
pnpm test:contract
pnpm check:scaffold
pnpm test:tmux
```

Results:

- Focused service/CLI route tests: passed; Vitest reported 2 files and 5 tests.
- `git diff --check`: passed.
- `pnpm test:integration`: passed; Vitest reported 1 file and 15 tests.
- `pnpm typecheck`: passed.
- `pnpm lint`: passed; Biome checked 109 files and package exports passed.
- `pnpm test:unit`: passed; Vitest reported 31 passed files and 1 skipped file, with 177 passed tests and 1 skipped test.
- `pnpm test:contract`: passed; Vitest reported 6 files and 68 tests.
- `pnpm check:scaffold`: passed; 8 packages and 12 root scripts.
- `pnpm test:tmux`: passed; Vitest reported 1 real tmux smoke file and 1 test.

## Remaining Gaps

- Dashboard static serving remains in `IFC-V1-009` and depends on later web dashboard work.
- This does not add a packaged runnable `codexdeck` binary or OS service wrapper; release docs and clean setup smoke remain in `BLK-V1-06`.
- Browser UI implementation, visual mockups, screenshots, and UI-fidelity evidence remain in `BLK-V1-05`.
