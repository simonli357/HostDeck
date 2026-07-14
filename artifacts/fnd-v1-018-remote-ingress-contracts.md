# FND-V1-018 Remote-Ingress Contracts And Fixtures

Status: complete

Implementation: `aa5583a`

## Outcome

The selected foundation now exposes one normalized remote-access language derived from the exact Tailscale 1.98.8 spike. Raw CLI/status/profile/Serve shapes remain outside core, contracts, fixtures, storage, API, and UI consumers.

The implementation adds:

- a pure fail-closed availability classifier in `@hostdeck/core`;
- strict public contracts for canonical private HTTPS origin, profile comparison, expected Serve ownership, ingress health, proxy provenance, pairing-link intent, and remote audit summaries;
- deterministic redacted fixture inventories for every required profile, Serve, failure, trust, and phone state;
- a selected mobile/access rebaseline that removes direct-LAN and custom-certificate assumptions;
- a package-boundary guard against raw/generated Tailscale imports in normalized consumers.

## Contract Matrix

| Area | Proven normalized states/invariants |
| --- | --- |
| Availability | `disabled`, `ready`, and `unavailable`; only current dedicated-profile plus exact private Serve evidence opens admission. |
| Client/profile | Client available/not-installed/unsupported/error; profile absent/stopped/signed-out/dedicated/other/unknown; comparison uses only bounded SHA-256 keys. |
| Serve | Absent, exact, foreign, colliding, drifted, and public/Funnel conflict; expected ownership is HTTPS 443, root path, canonical external origin, and one IPv4 loopback HTTP target. |
| Failure | Consent required, permission denied, command failure/timeout, oversized output, schema invalid, profile changed, stale/failed observation, and incomplete cleanup remain distinct bounded reasons. |
| Disable | Admission remains closed even when exact Serve state remains after incomplete cleanup; public projection preserves the cleanup problem. |
| Origin | Only canonical `https://<node>.<tailnet>.ts.net` origin form passes; paths, query, fragment, user info, explicit default port, non-HTTPS, IP, and non-Tailscale DNS forms reject. |
| Proxy trust | Local loopback and admitted remote provenance are distinct. Exact standard identity names are separate from the reserved untrusted `x-tailscale-` prefix and tested lookalikes. |
| Authorization | Provenance always states that app authorization is not evaluated. Tailscale identity presence never produces device identity, permission, read access, or write access. |
| Pairing | Intent fixes `/pair`, fragment-only `code` placement, fragment removal before a request, and no code-bearing referrer; no raw code exists in fixtures or audit summaries. |
| Audit | Remote enable/disable have accepted/terminal summaries, fail-closed admission, exact success read-back, persisted-intent truth, bounded Serve result, and no raw identity/output. |
| Mobile | Client reachability, global laptop ingress health, app authority, runtime compatibility, and stream state are separate. Pre-load unreachable state has no invented HostDeck diagnosis or runtime data. |

## Rejected Contradictions

- ready with stale/failed observation, non-dedicated profile, non-exact Serve, missing origin, or closed admission;
- disabled cleanup failure that reopens admission;
- active profile keys that contradict match/different/unknown comparison state;
- unsupported/failed client observation that claims a trusted profile;
- stale observation carrying a newer operation failure as current truth;
- admitted remote provenance with missing/invalid forwarding, invalid identity cardinality, or any untrusted lookalike;
- proxy rejection whose normalized header assessment contradicts its reason;
- unpaired or otherwise unauthenticated access exposing runtime compatibility or paired-device identity;
- loaded phone state deriving app authority from Tailscale identity;
- successful enable without dedicated-profile exact Serve read-back;
- failed enable claiming open admission;
- pairing intent containing a query code, raw code, or complete secret-bearing URL;
- raw Tailscale keys, unknown required fields, secret-bearing extensions, and non-canonical origins.

## Fixture Coverage

- 6 exact profile fixtures.
- 25 ingress fixtures, including disabled cleanup conflict and every frozen observer/mutation failure category.
- 14 proxy fixtures, including local/remote admission, optional identity presence, missing/duplicate/invalid forwarding, host/origin/source/generation failures, standard identity failure, untrusted lookalikes, direct non-loopback, and unknown context.
- 4 remote audit fixtures.
- Selected phone inventories replace certificate-error states with generic origin-unreachable and laptop-observed remote-unavailable states for both Mission Control and Session Detail.
- Every shared ingress fixture parses concurrently 32 times without mutation.

## Privacy Inspection

- Fixture keys exclude raw status/profile fields, account/nickname, node keys, address lists, command output, pairing code, cookie, and token fields.
- Fixture values contain no login-style identity or raw Tailscale source address.
- Comparison and source identity are fixed-format SHA-256 keys only.
- External origin is the only runtime-sensitive connection value intentionally represented; repository fixtures use synthetic values.
- Standard Tailscale identity is represented only by a boolean presence signal. It is not persisted as login, display name, profile image, or authority.

## Validation

Passed:

- `pnpm check:scaffold`: 9 packages and 18 root scripts.
- `pnpm typecheck`.
- `pnpm -r --if-present typecheck`: all 9 package scripts.
- `pnpm lint`: 342 files and all package exports.
- `pnpm vitest run --maxWorkers=2`: 113 files/1,038 tests passed; 16 files/30 tests skipped by existing environment gates.
- `pnpm test:contract`: 24 files/204 tests.
- `pnpm test:integration`: 2 files/16 tests.
- `pnpm test:web`: 2 files/14 tests.
- focused remote core/contracts/fixtures/mobile tests: 70 tests.
- isolated `packages/server/src/lan-network-routes.test.ts`: 10 tests.
- `git diff --check`.
- manual contract, fixture, contradiction, privacy, and selected-mobile review.

The first unbounded-worker `pnpm test:unit` rerun encountered one 5-second timeout in the unrelated historical LAN route suite while another workspace was consuming the laptop heavily. The exact file passed in isolation, and the complete unit suite passed with two workers. No product fallback or test-timeout increase was added.

## Explicit Downstream Ownership

- `FND-V1-092`: hostile/boundary production-hardening pass over these contracts and fixtures.
- `DAT-V1-031`: durable remote configuration/observation schema and repository.
- `DAT-V1-032`: selected remote audit catalog migration while preserving historical LAN rows.
- `IFC-V1-071`: strict raw Tailscale 1.98.8 observer adapter.
- `IFC-V1-073`: real loopback/Serve proxy trust evaluator.
- `IFC-V1-075`: selected route/audit isolation from historical LAN controls.
- `IFC-V1-077`: transient raw pairing-code URL/QR composition and browser fragment consumption.
- `FE-V1-004`: complete mobile information-architecture/state trace over the normalized fixtures.

No adapter, storage migration, route, Serve mutation, QR generation, production UI, or release claim is made by this task.
