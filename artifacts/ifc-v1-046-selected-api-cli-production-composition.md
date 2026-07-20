# IFC-V1-046 Selected API/CLI Production Composition

Date: 2026-07-20
Status: complete; all 16 criteria pass

## Objective

Compose the completed selected API, SSE, security, remote-ingress, and source-CLI leaves into one production-only Fastify registration boundary. The composition must make the immutable 35-route manifest executable exactly once over the selected loopback/Tailscale request boundary without reviving historical LAN, raw, tmux, test-driver, or direct-service paths.

Requirement refs: `FR-001` to `FR-018`, `NFR-006`, `PR-004`, `SFR-009`, `DEC-027`, and the HTTP/SSE/security matrix in `docs/planning/04b-test-plan.md`.

Depends on: `IFC-V1-038`, `IFC-V1-039` to `IFC-V1-045`, `IFC-V1-059` to `IFC-V1-065`, `IFC-V1-068`, `IFC-V1-069`, and `IFC-V1-076` to `IFC-V1-079`.

## Pre-Implementation Audit

- `selectedApiRouteManifest` owns 35 immutable GET/POST entries and their method, path, schema, authority, CSRF, lock, target, audit, credential, handler, and owner-task contracts.
- Twenty-two selected route-registration factories implement those entries: 21 API registrations and one SSE registration. Every factory already owns strict input validation, selected-manifest lookup, response schemas, one-registration guards, and its route-local behavior tests.
- `createHostDeckTailscaleServeFastifyApp` and `startHostDeckTailscaleServeFastifyLifecycle` own the selected proxy/application-auth and listener-first lifecycle boundaries, but callers still hand-assemble partial route arrays.
- No production selected-route composition module exists. Test harnesses assemble only task-local subsets, so a manifest addition, omitted registrar, mismatched shared policy instance, or accidental historical registrar has no aggregate production owner.
- Source CLI commands use bounded loopback HTTP clients for selected operations, but no aggregate gate proves their method/path inventory remains a subset of the production manifest.

## Implemented Boundary

- `createHostDeckSelectedApiRouteComposition` accepts one exact 16-key input, preflights every shared policy/service/port, and returns one frozen deterministic array of 22 registrations covering all 35 selected manifest rows.
- `hostDeckSelectedApiRouteCompositionDescriptor` is the single aggregate registration-to-manifest map. The canonical manifest remains the only owner of method, path, schema, authority, audit, handler, and task metadata.
- One branded request-authentication policy is accepted once and supplies the same active-device authority used by revoke and request/SSE authentication. Branded admission, audit, CSRF, lock, health, pairing, subscriber, and remote services are retained by identity.
- Broad root ports are narrowed into frozen exact-key route views while preserving their original function identities. Passing broad container objects into route-local contracts would widen authority and violate their exact-key validation; identity is therefore enforced at the branded policy or callable authority boundary.
- `hostDeckFastifyRouteInventory` exposes a frozen in-process method/path snapshot for validation. It contains no handler, policy, credential, target, or service reference.
- The selected SSE registration now sets `exposeHeadRoute: false`; this closes the unmanifested automatic `HEAD` route found by the ready-app inventory test.

## Proof Decomposition

The aggregate owns composition facts: exact registration, handler reachability, shared-policy traversal, real audit transitions, local/remote authority, and cleanup. Existing route-local SQLite/runtime verticals continue to own full success, failure, concurrency, and response-contract semantics for each operation. The aggregate deliberately does not duplicate all route-local fixtures inside one oversized success harness; it drives every registration family through the assembled Fastify handler and proves accepted/terminal audit rows where mutation gates are crossed.

Pre-closure export review also corrected one scope contradiction in the frozen wording. Root `@hostdeck/server` still intentionally exports historical `api-route-contracts` and `security-routes`; removing or isolating those package-root exports is the explicit downstream purpose of `IFC-V1-067`, which depends on this task. `COMP-05` therefore proves that the selected composition module, its import closure, returned registrations, and runtime inventory contain no historical path. It does not claim the downstream whole-package legacy disposition is already complete.

## Composition Contract

1. One exported production factory accepts shared selected policies and ports once, then derives all route-factory inputs. Callers cannot supply separate admission, selected-write audit, security audit, CSRF, lock, selected-state, managed-thread, or device-authority instances per route.
2. The factory emits one frozen deterministic array of 22 registrations: 21 `api` and one `sse`. Registration ids are unique, stable, bounded, and selected-only.
3. One frozen composition descriptor maps every registration id to its exact selected manifest ids and expected surface. Flattening the descriptor equals all 35 manifest ids exactly once; method/path/handler/owner metadata remains owned by the canonical manifest.
4. Factory construction fails before Fastify creation for null/array/prototype-bearing/unknown/missing input, malformed shared policy or port, duplicate/unknown/missing manifest mapping, duplicate registrar id, wrong surface, or any historical/test registration.
5. Route factories retain their existing one-owner and schema checks. Composition adds no wrapper handler, alternate authorization branch, broad catch, retry, fallback, route alias, direct storage/runtime dispatch, or copied schema.
6. The selected app/lifecycle receives only the returned registrations. It remains exact IPv4 loopback HTTP behind private Tailscale Serve HTTPS; generic proxy trust, backend TLS, public/LAN bind, custom CA, Funnel, profile switching, and automatic Serve repair remain impossible.

## Harsh Success Criteria

| ID | Required proof |
| --- | --- |
| `COMP-01` | The descriptor contains exactly 22 unique selected registration ids and all 35 canonical manifest ids once. Every descriptor surface matches the registrar surface; metadata and returned collections are frozen. |
| `COMP-02` | The production factory accepts one exact data object and rejects missing, extra, accessor, symbol, inherited, null, array, and malformed fields without constructing a partial registration set. |
| `COMP-03` | Shared admission, selected-write audit, security audit, CSRF, host lock, selected state, managed-thread service, active-device authority, and clock are passed by identity to every applicable registrar. No route can silently receive a weaker sibling policy. |
| `COMP-04` | All 35 method/path pairs are present in a ready selected Fastify app exactly once. Automatic HEAD behavior is not mistaken for a selected route, and no unmanifested `/api/v1` route is present. |
| `COMP-05` | Historical `/api/v1/network*`, certificate, raw listener, tmux, legacy session-control, acceptance sentinel/driver, arbitrary proxy, and static test routes are absent from the selected composition module, its import closure, returned registrations, and runtime route inventory. Whole-package historical export disposition remains `IFC-V1-067`. |
| `COMP-06` | Public liveness is the only unpaired public route. Unpaired remote access reveals only the bounded selected access/pair surfaces; protected host/session/event/control/device/lock/remote data rejects before service/storage/dispatch side effects. |
| `COMP-07` | Loopback local-admin and paired remote authority remain distinct across the aggregate. Remote enable/disable and unlock reject remotely; remote status is paired read-only; paired writes require writer permission, current CSRF, unlocked host, current admission, and the common selected write/audit gate. |
| `COMP-08` | One real SQLite-backed local composition proves host/session/event reads, start, stream, prompt, model, goal, plan, usage, compact, skills, approvals, interrupt, archive, resume metadata, pairing/device/security, lock, and remote status through their selected handlers without a direct-service bypass. |
| `COMP-09` | One admitted Tailscale-shaped loopback composition proves the same registered route inventory under canonical external HTTPS provenance, hardened cookie/application auth, no wildcard CORS, and no Host/Origin/proxy fallback. Aggregate external proof may use bounded deterministic service ports; it may not fabricate a public authentication context after the trust boundary. |
| `COMP-10` | The selected SSE route is the real projection subscriber/Readable-backed transport. Replay/live, cursor, heartbeat, request abort, authority revoke, profile generation closure, archive, slow-client, and shutdown ownership remain the existing bounded services; no empty or test-only live source is accepted. |
| `COMP-11` | Every source CLI operation under this task issues only its exact selected loopback method/path and validates the selected response contract. No command opens SQLite, invokes Tailscale, reaches a route absent from the production manifest, retries mutation, or dispatches a service directly. |
| `COMP-12` | Duplicate composition, duplicate registrar use, manifest drift, one registrar construction failure, registration/schema failure, app-ready failure, and listener-start failure are loud and leave no listener, request/SSE authority, timer, database handle, or partial success claim. |
| `COMP-13` | Invalid, boundary, repeated, concurrent, stale-target, response-loss, disconnect, revoke, lock, profile-away, and shutdown cases retain the already-proven route-local truth when assembled; rejected requests create no protected bytes, dispatch, credential, or success audit. |
| `COMP-14` | Logs, errors, snapshots, object graphs, route descriptors, CLI output, raw SQLite, and evidence contain no pairing fragment/code, cookie, CSRF, source/identity/profile/DNS value, prompt/objective, transcript, or raw upstream error. Canonical public route metadata is the only retained aggregate inventory. |
| `COMP-15` | Focused composition/manifest/CLI tests, adjacent route/security/SSE/lifecycle suites, unit/contract/integration/web/browser gates, typecheck, lint/exports, scaffold, planning, runtime-boundary, exact Codex binding, frozen install, production audit/license inventory, diff/privacy review, and zero-residue inspection pass. |
| `COMP-16` | Implementation, task evidence, and owner-doc state are committed and pushed before `IFC-V1-046` becomes `done`; packaging, built assets, services, full resource stress, frontend behavior, and release readiness remain downstream. |

## Validation Design

- Add direct descriptor/factory tests for exact keys, frozen metadata, route/registration set equality, surface/handler ownership, shared-object identity, duplicate/repeat failure, and hostile input.
- Register the complete result through the selected Fastify factory and inspect actual Fastify method/path inventory after `ready`; exercise representative public, unpaired, paired-read, paired-write, local-admin-only, and SSE paths with side-effect counters.
- Add an L2 aggregate over real migrated SQLite and selected repositories/policies. Use deterministic application/runtime ports only where the owning exact-Codex leaf is already proven; the aggregate must invoke every selected handler family and inspect audit, authority, and cleanup truth.
- Add an admitted external-origin aggregate through `createHostDeckTailscaleServeFastifyApp` or the selected lifecycle with raw Serve-shaped loopback requests. Reuse the canonical proxy/application-auth policies; do not inject post-trust auth contexts.
- Add a source-CLI inventory test that records each supported selected client request and proves its method/path against `selectedApiRouteManifest`; legacy-only commands stay explicitly isolated and cannot enter production composition.
- Finish with real loopback listener startup/close, route inventory, process/listener/temporary-resource inspection, privacy scan, and full required repository gates.

## Criterion Results

| Criterion | Result | Evidence |
| --- | --- | --- |
| `COMP-01` | Pass | Frozen 22-registration descriptor covers 21 API registrations, one SSE registration, and all 35 manifest ids exactly once. |
| `COMP-02` | Pass | Exact input and nested-port readers reject null, arrays, inherited/accessor/unknown/missing fields before registration construction. |
| `COMP-03` | Pass | One root input owns every shared authority; branded policies retain object identity and least-authority views retain callable identity. Direct handler probes reach the supplied ports. |
| `COMP-04` | Pass | A ready Fastify app exposes exactly the 35 canonical method/path pairs, with no `HEAD` or extra `/api/v1` route. |
| `COMP-05` | Pass | Selected composition source/import closure, returned inventory, and runtime scans contain no historical LAN/certificate/tmux/raw/test registration. Root-package historical export isolation remains explicitly unclaimed and queued as `IFC-V1-067`. |
| `COMP-06` | Pass | Liveness remains public; unpaired admitted-Serve session read, prompt mutation, and remote enable reject before any protected port call. |
| `COMP-07` | Pass | Local status/mutation and admitted-remote pair/CSRF/device paths traverse distinct existing authority policies; remote local-admin mutations remain denied. |
| `COMP-08` | Pass | The real migrated-SQLite aggregate drives every one of the 22 registration families through assembled handlers and verifies accepted/terminal audit rows for selected-write and security mutations; the 369-test adjacent matrix owns complete operation semantics. |
| `COMP-09` | Pass | The same full registration array reaches unpaired claim, paired CSRF, and paired device handlers through canonical admitted-Serve provenance; `IFC-V1-079` remains the physical external-origin acceptance owner. |
| `COMP-10` | Pass | The aggregate reaches the production projection-subscriber handoff and Readable SSE adapter; adjacent replay/live, revoke, overload, archive, and shutdown suites pass. |
| `COMP-11` | Pass | Recorded source clients issue 21 unique method/path operations, each matching exactly one selected production manifest row. |
| `COMP-12` | Pass | Duplicate composition/registration, hostile construction, schema/app/lifecycle failure, close, and residue matrices pass loudly. |
| `COMP-13` | Pass | The 44-file affected matrix plus full unit/contract/integration/browser suites preserve route-local invalid, repeat, concurrency, loss, revoke, lock, and shutdown truth. |
| `COMP-14` | Pass | Private probe text never reaches HTTP responses; descriptor/inventory retain public metadata only; source, SQLite, output, temp, process, and listener inspections are clean. |
| `COMP-15` | Pass | Focused, affected, full workspace, static, exact-binding, offline-install, supply-chain, privacy, and zero-residue gates pass. |
| `COMP-16` | Pass | Criteria `d93aded`, implementation `ad16aa0`, bounded stress gate `ee2e435`, and direct handler proof `90cb737` are pushed; packaging/UI/resource stress/release work remains downstream. |

## Validation Evidence

- Focused composition/CLI/SSE: 3 files, 17 tests passed.
- Affected selected routes, manifest, Fastify/SSE, remote security, and source clients: 44 files, 369 tests passed.
- Unit: 191 files passed, 25 intentionally skipped; 1,865 tests passed, 27 skipped.
- Contract: 35 files, 277 tests passed. Integration: 14 files, 18 tests passed. Web: 3 files, 33 tests passed. Pairing Playwright: 3 tests passed.
- Root typecheck, lint/exports (528 files, 8 packages), scaffold, runtime boundary, and planning (212 tasks, 84 requirements, 649 dependencies) passed.
- Exact isolated Codex 0.144.0 binding passed for 671 files at `e1a1a5cff3ab91862f9215dd06538eae1ea0b00bae48cbb7d87061faaee27e24`. The user's default 0.144.5 remains intentionally ineligible for exact-binding evidence.
- Frozen offline install passed. Production audit reported no known vulnerabilities. The production inventory contains 155 entries across eight accepted license expressions.
- The unchanged 4,096-row session-read stress workload passed after its explicit test timeout was bounded at 90 seconds; no workload or assertion changed.
- No composition temp directory, Vitest/Playwright/web process, or HostDeck test listener remained. Physical Android/Tailscale access was not needed for this leaf because `IFC-V1-079` already owns that acceptance.

## Explicit Non-Goals

- No built web assets, final static registration, executable packaging, user-service files, install/uninstall flow, or clean-machine release claim.
- No new product route, schema, authority, audit action, CLI feature, runtime operation, Tailscale command, profile behavior, or fallback transport.
- No direct-LAN/custom-CA restoration, public listener, Funnel, cloud relay, automatic profile switch, automatic Serve repair, or browser identity authorization.
- No replacement for route-local tests, `IFC-V1-052` stress acceptance, `IFC-V1-067` legacy disposition, `IFC-V1-091` module hardening, frontend/device UI evidence, or release acceptance.
