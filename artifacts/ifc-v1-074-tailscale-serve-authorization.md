# IFC-V1-074 Tailscale Serve Authorization Evidence

## Outcome

- Added one selected Fastify composition that installs the existing request/resource policies, the exact Tailscale Serve proxy gate, and request authentication through one immutable ingress adapter. The selected factory accepts neither historical request trust nor backend TLS input.
- Added explicit `remote` authentication/access contracts. Public contexts retain only the approved canonical configured origin and effective HTTPS mode; source hashes, admission generations, forwarding values, and Tailscale identity remain private.
- Preserved the historical loopback/LAN factory only for existing tests and isolated code. Direct loopback local-admin behavior remains explicit, performs zero remote-admission reads, and cannot be reached by remote request form.

## Currentness And Failure Semantics

- Each remote currentness assertion performs two strict admission reads. Both must be valid, open, equal, and match the request's admitted canonical origin and generation.
- Assertions run at ingress installation, around device-token storage authentication, on cached authority reuse, immediately before selected mutation dispatch, around pairing/CSRF/lock credential transitions and response preparation, before successful response publication, and immediately before pairing or self-revoke cookie attachment.
- The first stale, closed, malformed, throwing, or split observation latches the request as rejected. Later state cannot resurrect that request. The public result is one generic `403 invalid_origin`, connection close, at most one stale-request counter increment, and no success body or cookie.
- Known concurrent device revocation remains `permission_denied`. An already committed mutation retains its truthful terminal audit outcome when a later currentness check withholds publication; no rollback, automatic retry, or false failure relabeling is invented.

## Pairing And Source Limits

- Remote pair claim requires effective HTTPS, exact same Origin, and the admitted domain-separated source hash. Missing or hostile source/proxy context rejects before authentication, limiter, audit, or storage.
- The same source hash owns process-local per-source concurrency and the durable SQLite source-attempt row. Existing global concurrency and durable global-attempt limits remain independent.
- Same-source reconnects share one source bucket, a changed valid source gets a distinct source bucket, and neither source nor optional identity changes evade the global bucket. Limiter leases release exactly once on success and every failure path.
- Successful claim publishes only a `Secure`, `HttpOnly`, host-only, `SameSite=Strict` device cookie. Storage, audit, generation, and response failures publish no credential.

## Application Authority

- Tailnet membership, optional standard identity, source, and generation grant no application authority. A remote unpaired access-state read is bounded, while protected reads require a current device cookie.
- Remote writes require a current writer device, matching CSRF generation/token, unlocked host, and a current admission immediately before dispatch. Read-only, invalid, expired, revoked, stale-CSRF, and locked cases fail before dispatch.
- Remote lock remains allowed for a valid writer. Remote unlock and local-admin authority are impossible. Local non-browser loopback unlock remains separate.
- Device revoke invalidates active authority. Other-device and self-revoke behavior remain exact; self-revoke cookie deletion is attached only after a final ingress check.

## Privacy And Data Integrity

- The admitted source hash appears only in the selected pairing-rate table and in-memory limiter key. Raw source addresses, Tailscale identity values, raw pairing codes, device tokens, and CSRF tokens are absent from audit rows and the SQLite main/WAL/shared-memory bytes inspected by the tests.
- Authentication and proxy snapshots expose only bounded counters. Public responses and errors contain no source hash, admission generation, identity/profile field, forwarding value, or raw credential.
- Manual inspection found no logging, CORS, `trustProxy`, public listener, historical LAN fallback, identity authorization, swallowed configuration failure, or automatic retry path in the selected composition.

## Automated Evidence

- Focused selected composition: 16 tests across request authorization, real-SQLite pairing/rate/concurrency, and application security passed. The affected historical and selected server matrix passed 118 tests across 11 files; the final CSRF/lock/revoke/currentness rerun passed 36 tests across 4 files.
- Contract: 230 passed. Unit: 1,161 passed and 34 explicit external/device skips; 0 failed. Integration: 16 passed. Web: 14 passed.
- Root and all-package typechecks passed. Lint and export validation passed for 364 files and 9 packages. Scaffold passed for 9 packages and 18 root scripts. Planning passed at 212 tasks, 84 requirements, 649 dependencies, and 19 queued before closure.
- Focused Biome, `git diff --check`, contract/schema inspection, route-order review, stale/error precedence review, SQLite raw-byte inspection, cookie inspection, limiter cleanup, audit-trail inspection, and privacy scans passed.

## Real Serve Evidence

- The opt-in smoke started one ephemeral loopback selected Fastify app, issued a pairing code only through direct local-admin form, and enabled only the owned private root Serve mapping under the already selected dedicated HostDeck profile.
- External private HTTPS proved identity-only denial, same-origin pair claim, hardened host-only device cookie, paired protected read, durable source-rate accounting, and generic denial after admission closure.
- Cleanup removed only the exact owned mapping, independently proved final absent state, closed the listener/database, removed temporary state, and left no child process.
- No account, profile, node, DNS, source, identity, credential, consent URL, or raw Tailscale output is retained in this artifact.

## Remaining Gates

- `IFC-V1-076` still owns durable remote enable/status/disable application service, selected API status, and local CLI controls.
- `IFC-V1-077` owns fragment-safe URL/QR and browser claim startup. `IFC-V1-078` owns lifecycle/SSE generation invalidation and active in-flight cancellation. `IFC-V1-079` owns aggregate hostile testing and physical Android acceptance from another network.
- The phone did not enumerate through ADB during the final unit gate. This task proves host-side real Serve authorization and exact cleanup; it does not claim deployable app packaging or final phone acceptance.
