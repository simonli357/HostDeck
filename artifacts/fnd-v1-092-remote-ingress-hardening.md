# FND-V1-092 Remote Ingress Contract Hardening

Date: 2026-07-13

Task: `FND-V1-092`

Implementation: `2ea7b07`

## Scope

This pass hardens the normalized remote-ingress, proxy provenance, selected-mobile access, audit, and fixture boundaries created by `FND-V1-018`. It proves only the headless contract layer. Storage, Tailscale observation and mutation, proxy evaluation, routes, UI, and physical-phone acceptance remain downstream.

## Hardening Matrix

| Boundary | Proof |
| --- | --- |
| Availability | The complete 18,144-case classifier input product admits exactly one tuple: enabled intent, current observation, available client, dedicated profile, exact private Serve mapping, valid external origin, and no operation failure. |
| External origin | Canonical private Serve origins require exactly `device.tailnet.ts.net`, HTTPS, no explicit port/path/query/fragment, valid 63-byte labels, and the 134-byte DNS maximum. Loopback origins require canonical `127.0.0.1` HTTP plus a valid explicit port. |
| Profile and Serve ownership | All 30 profile-state/comparison-relation pairs are tested; only the reviewed nine pairs parse. Serve classification is accepted only for the selected dedicated profile, including the stopped-but-matching observation case, and is rejected for absent, foreign, unknown, unsupported, or failed client truth. |
| Observation and generation | Current, stale, and failed observations retain distinct truth. A failed observer may preserve one bounded operation cause without inventing profile state. Full state, public state, and admitted provenance share one non-negative safe-integer generation, and stale generation cannot authorize selected-mobile access. |
| Proxy provenance | Every rejection reason is bound to coherent normalized forwarding, standard identity, and lookalike evidence. Admitted remote provenance requires exact forwarding, canonical origin, bounded generation, and a source hash; optional tailnet identity remains explicitly non-authorizing. |
| Application authority | Remote ingress cannot acquire loopback-local authority. Disconnected clients cannot retain admitted provenance or connected streams, unreachable clients cannot invent laptop ingress state, and inaccessible Session Detail states expose no session data or not-found disclosure. |
| Audit outcomes | Idempotent exact-Serve enable is valid. Rejection is closed, unpersisted, and unattempted; unknown external outcome is incomplete; successful enable and disable require exact post-operation Serve readback; disable cannot report an applied mapping. |
| Schema input | Security-sensitive object contracts accept only ordinary or null-prototype enumerable data objects. Arrays, custom prototypes, accessors, symbols, hidden properties, and hostile reflection proxies reject without invoking getters or escaping `safeParse`. Public projection reparses full ingress evidence before exposing readiness. |
| Fixtures and boundaries | Six profile, 25 ingress, 14 proxy, and 11 audit fixtures are deeply frozen. Privacy inspection permits only synthetic comparison/source hashes and rejects credential, raw-output, node, account, and pairing-secret keys. Normalized core/contracts/fixtures/web consumers cannot import any Tailscale-specific module. |

## Defects Closed

- Replaced the inconsistent full-state `revision` field with the contract-wide monotonic `generation`.
- Closed stale-generation and remote-to-loopback authority confusion in selected mobile state.
- Prevented foreign-profile, unsupported-client, and failed-client observations from exposing trusted Serve state.
- Corrected idempotent enable and verified-disable audit semantics.
- Bound proxy rejection fixtures and contracts to coherent header evidence.
- Tightened the external DNS shape from a broad suffix match to the exact private Serve hostname form.
- Removed mutable fixture graphs and protected schema parsing from accessor/proxy input ambiguity.

## Validation

Passed on implementation `2ea7b07`:

- `pnpm check:scaffold`: 9 packages and 18 root scripts.
- `pnpm typecheck`.
- `pnpm -r --if-present typecheck`: all 9 package scripts.
- `pnpm lint`: 345 files and all 9 package exports.
- `pnpm vitest run --maxWorkers=2`: 113 files/1,039 tests passed; 16 files/30 tests skipped by existing environment gates.
- `pnpm test:contract`: 26 files/222 tests.
- `pnpm test:integration`: 2 files/16 tests.
- `pnpm test:web`: 2 files/14 tests.
- `pnpm check:planning`: 212 tasks, 84 requirements, 649 dependencies, and 22 queued tasks before closure synchronization.
- `git diff --check`.
- Manual contract, contradiction, privacy, hostile-input, fixture, and cross-package review.

The unit run emitted the existing device-aware `adb: no devices/emulators found` skip path. This task makes no physical-device acceptance claim.

## External Contract Check

The canonical hostname rule was checked against the official Tailscale [MagicDNS](https://tailscale.com/docs/features/magicdns) and [Serve](https://tailscale.com/docs/features/tailscale-serve) documentation: a private Serve hostname is the device name plus tailnet name under `ts.net`.

## Downstream Ownership

- `DAT-V1-031`, `DAT-V1-032`, and `DAT-V1-092`: durable remote configuration, audit migration, and storage hardening.
- `IFC-V1-071` to `IFC-V1-079`: observation, Serve ownership, proxy trust, route composition, pairing-link handling, and physical remote-phone acceptance.
- `FE-V1-004` and later frontend tasks: phone-first state mapping, selected mockups, implementation, and visual evidence.
- `REL-V1-005`, `REL-V1-007`, and `REL-V1-008`: aggregate security, deployment, and release gates.

No adapter, migration, route, Serve mutation, pairing-code transport, production UI, package, or release claim is made here.
