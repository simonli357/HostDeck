# IFC-V1-066 Exact-Target Write Gate

Date: 2026-07-13

Status: complete. Implementation: `0e41378`. Real POST deadline fix: `b922b65`.

## Scope

Implement one reusable server boundary for selected mutation routes. The gate owns exact configuration, parse/authentication/CSRF/lock/target ordering, accepted-before-dispatch audit composition, at-most-once dispatch and response preparation, deadline truth, terminal-proof validation, bounded diagnostics, and privacy. Concrete mutation routes and services remain downstream work.

## Result

- Added a frozen gate requiring an identity-matched selected POST/JSON manifest row, matching branded audit port, and branded CSRF and lock policies.
- Added exact descriptor-first execution, mutation, target-resolution, transition, audit-result, and phase-specific summary contracts. Accessors, copies of branded values, unsupported prototypes, cycles, excessive depth/fields/keys/values, and policy drift fail closed.
- Fixed the order to parse -> request trust/write authentication/current CSRF -> conditional one-time durable lock read -> exact target/capability resolution with the original request deadline -> accepted audit -> one dispatch -> one success-only response preparation -> matching terminal proof.
- Added exact secret-free accepted/success summaries for session start, prompt, model, goal, plan, compact, approval response, interrupt, archive, and the existing device-revoke security contract.
- Closed audit callbacks when the audit promise settles. Duplicate, late, malformed, or contradictory audit behavior cannot redispatch or prepare a response after settlement.
- Sanitized callback-owned HTTP messages/details. Public gate errors and snapshots retain no request body, prompt, cookie, bearer, CSRF value, private cause, or target identifier.
- Added saturating count-only diagnostics for attempts, stage failures, dispatches, response preparations, timeouts, and terminal outcomes.
- Patched Fastify 5.10.0 with the upstream POST request-signal correction so a completed request body does not abort HostDeck's live deadline signal. A real loopback listener regression covers the patched behavior, and frozen offline install reproduces it.

## Truth Rules

| Boundary | Enforced result |
| --- | --- |
| Parse | Produces one branded canonical operation/action/target/accepted summary before request authority or storage access. |
| Authority | Admitted Host/Origin plus local admin, or paired HTTPS writer plus current CSRF; receipts contain no raw credential. |
| Lock | Read exactly once only for manifest rows requiring an unlocked host; device revoke performs no lock read. |
| Target | Returns one branded resolution whose target equals the parsed target and whose capability equals the manifest operation capability. |
| Accepted audit | Must complete before transition; duplicate/conflicting/unavailable or malformed proof dispatches nothing. |
| Dispatch | Runs at most once. Timeout before dispatch records failed/not-sent; timeout after dispatch begins is incomplete unless the dispatcher returns authoritative truth. |
| Response | Runs exactly once only after authoritative success and before terminal proof. Failure never retries dispatch. |
| Terminal audit | Returned outcome/error/response must exactly match the observed transition and prepared response. No result is returned without proof. |

## Failure And Concurrency Evidence

- Malformed configuration and execution envelopes reject before callback invocation; accessor properties are never evaluated.
- Parse, authorization, lock, target, accepted-audit, dispatch, response, and terminal-proof failures stop at the first owning boundary.
- Plaintext paired writes, read-only, expired, revoked, stale CSRF, locked host, stale target, incompatible runtime, target drift, and capability drift reject before audit or dispatch as applicable.
- Hostile duplicate and post-settlement transition/response callbacks are blocked; malformed/accessor/forged stage results expose no private value.
- Real SQLite contention on one operation id produces one accepted owner, one dispatch, one terminal trail, and one conflict. Independent operation ids and targets retain separate trails.
- Real security-executor evidence preserves succeeded mutation truth across response-preparation failure, pending truth across terminal-audit failure, and no redispatch on duplicate retry.

## Validation

- Focused gate: 17 tests passed.
- Gate plus adjacent Fastify/trust/authentication/CSRF/lock/audit/storage: 96 tests passed.
- Unit: 982 passed, 29 explicitly skipped external tests.
- Contract: 176 passed.
- Integration: 16 passed.
- Web: 14 passed.
- All nine package typechecks passed.
- `pnpm lint`, package exports, scaffold, planning, and exact Codex 0.144.0 binding checks passed.
- `pnpm install --frozen-lockfile --offline` passed.
- `pnpm audit --prod` reported no known vulnerabilities.
- Manual order, side-effect, callback-lifetime, deadline, audit-truth, target-isolation, public-error, snapshot, and raw-response privacy inspection passed.
- Staged scope and whitespace checks passed; only the gate contracts, implementation, tests, and server export were committed.

## Remaining Ownership

- `IFC-V1-059` owns the exact paired-device revoke route and active authority invalidation.
- `IFC-V1-033` owns the aggregate browser/LAN/security matrix and physical Android evidence.
- `IFC-V1-040` to `IFC-V1-045` and `IFC-V1-061` to `IFC-V1-064` own concrete selected mutation routes.
- `IFC-V1-049` owns cross-route idempotency and concurrency limits beyond the accepted-audit operation-id protection proven here.
