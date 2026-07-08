# FND-V1-006 API And Stream Contract Schemas

Date: 2026-07-08

## Scope

- Added runtime Zod schemas in `packages/contracts/src/api.ts` for:
  - host status
  - session list/detail
  - output query and output response
  - stream events
  - prompt, slash, stop, raw input write requests
  - accepted/rejected write responses
  - pairing, trust/security, lock, and network state payloads
- Exported the contract schemas from `@hostdeck/contracts`.
- Replaced the `pnpm test:contract` placeholder with a Vitest contract-test config.
- Added `zod` and `@hostdeck/core` dependencies to `@hostdeck/contracts`.
- Tightened Vitest test discovery so repo unit tests do not pick up dependency package tests under nested `node_modules`.

## Contract Coverage

- `apiErrorEnvelopeSchema` accepts stable shared error codes, trims/bounds messages, defaults `retryable` to false, and rejects sensitive or nested detail payloads through the core error-envelope rules.
- Session read schemas validate stable session identity, lifecycle state, status, attention, timestamps, backend metadata, recent output, and cursors.
- Output and stream schemas validate output events, replay boundaries, stream status, and stream errors.
- Write schemas validate prompt input, V1 slash allowlist, explicit stop confirmation, explicit raw-input confirmation, and accepted/rejected write response shapes.
- Pairing/security/network schemas validate claim request, trust state, lock request, and bind/network state.

## Validation

Passed:

- `pnpm install --frozen-lockfile`
- `pnpm check:scaffold`
- `pnpm typecheck`
- `pnpm -r --if-present typecheck`
- `pnpm lint`
- `pnpm test`
- `pnpm test:unit`
- `pnpm test:contract`
- `git diff --check`

Observed results:

- Unit tests: 4 files, 31 tests passed.
- Contract tests: 1 file, 11 tests passed.

## Issues Found And Fixed

- Initial unit-test discovery included Zod's package source tests through `packages/contracts/node_modules`; fixed by excluding `**/node_modules/**` in the unit and contract Vitest configs.
- TypeScript `exactOptionalPropertyTypes` rejected explicitly passed `undefined` optionals when refining API error envelopes; fixed by conditionally building the core error-envelope input.
