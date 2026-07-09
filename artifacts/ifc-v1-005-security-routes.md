# IFC-V1-005 Security Routes

Date: 2026-07-08

## Scope

- Added headless `@hostdeck/server` security route handlers for pairing-code claim, pair/security state, network state, dashboard lock, remote unlock rejection, and dashboard LAN mutation rejection.
- Wired server dependencies on shared contracts, core error envelopes, and storage repositories.
- Exported the `NetworkStateResponse` contract type for server consumers.
- Extended pairing-code storage records with `revoked_at`, migration `202607080005_pairing_code_revoked_at`, and repository revocation so the route can reject revoked pairing codes explicitly.
- Preserved `HttpOnly` cookie transport: the raw device token is set only as a cookie value, while response bodies expose the non-secret CSRF token only when writes are trusted and unlocked.

## Strict Criteria

- Pairing claims reject malformed, invalid, revoked, expired, and already-used codes with typed error envelopes.
- Pairing success creates a durable auth device from a one-time code, stores only hashed secrets, returns trusted write state, and does not include the raw device token in the JSON body.
- Writable dashboard state is not granted from a cookie alone; write-capable security state requires a valid CSRF token unless the host is locked.
- Read-only clients can be recognized as trusted read-only without write CSRF exposure.
- Dashboard lock requires cookie auth plus CSRF validation and moves the host into locked state.
- Dashboard unlock and LAN mutation are rejected because unlock/LAN changes remain CLI/admin-only in V1.
- Network state reflects persisted localhost/LAN settings through the shared response schema.
- Later API/server startup work remains explicit; this task does not claim Fastify registration, daemon startup, CLI commands, session reads, streams, or write dispatch.

## Behavior Proven

- `createSecurityRouteHandlers().claimPairingCode` validates `pairClaimRequestSchema`, claims storage-backed one-time codes, honors client-label override, sets a `hostdeck_device` `HttpOnly` cookie, and returns schema-validated trust state.
- Storage now supports pairing-code revocation with durable `revoked_at` state and `pairing_code_revoked` repository errors.
- State handlers expose untrusted, trusted read-only, trusted write-with-CSRF, locked, LAN-disabled, and LAN-enabled states.
- Dashboard lock rejects missing or mismatched CSRF and succeeds with a trusted write client.
- Dashboard unlock and LAN mutation return explicit `permission_denied` errors.

## Validation

- `pnpm --filter @hostdeck/server typecheck` passed.
- `pnpm --filter @hostdeck/storage typecheck` passed.
- `pnpm --filter @hostdeck/contracts typecheck` passed.
- `pnpm test:unit -- packages/server/src/security-routes.test.ts packages/storage/src/auth-repository.test.ts packages/storage/src/migration-runner.test.ts packages/contracts/src/storage.contract.test.ts packages/contracts/src/api.contract.test.ts` passed with 102 tests across 17 files.
- `pnpm lint` passed.
- `pnpm typecheck` passed.
- `pnpm install --frozen-lockfile` passed.
- `pnpm check:scaffold` passed.
- `pnpm -r --if-present typecheck` passed.
- `pnpm test` passed with 102 tests across 17 files.
- `pnpm test:contract` passed with 37 tests across 4 files.
- `git diff --check` passed.

## Remaining Gaps

- Fastify route registration and daemon startup checks remain in `IFC-V1-001` and later API route tasks.
- Session read/output/stream routes remain in `IFC-V1-002` and `IFC-V1-003`.
- Prompt/slash/stop/raw write dispatch, audit preflight ordering, and session writability checks remain in `IFC-V1-004` and `IFC-V1-014`.
- CLI pairing, unlock, and LAN commands remain in `IFC-V1-008`.
