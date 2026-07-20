# IFC-V1-046 Selected API/CLI Production Composition

Date: 2026-07-20
Status: strict criteria frozen; implementation pending

## Objective

Compose the completed selected API, SSE, security, remote-ingress, and source-CLI leaves into one production-only Fastify registration boundary. The composition must make the immutable 35-route manifest executable exactly once over the selected loopback/Tailscale request boundary without reviving historical LAN, raw, tmux, test-driver, or direct-service paths.

Requirement refs: `FR-001` to `FR-018`, `NFR-006`, `PR-004`, `SFR-009`, `DEC-027`, and the HTTP/SSE/security matrix in `docs/planning/04b-test-plan.md`.

Depends on: `IFC-V1-038`, `IFC-V1-039` to `IFC-V1-045`, `IFC-V1-059` to `IFC-V1-065`, `IFC-V1-068`, `IFC-V1-069`, and `IFC-V1-076` to `IFC-V1-079`.

## Current Audit

- `selectedApiRouteManifest` owns 35 immutable GET/POST entries and their method, path, schema, authority, CSRF, lock, target, audit, credential, handler, and owner-task contracts.
- Twenty-two selected route-registration factories implement those entries: 21 API registrations and one SSE registration. Every factory already owns strict input validation, selected-manifest lookup, response schemas, one-registration guards, and its route-local behavior tests.
- `createHostDeckTailscaleServeFastifyApp` and `startHostDeckTailscaleServeFastifyLifecycle` own the selected proxy/application-auth and listener-first lifecycle boundaries, but callers still hand-assemble partial route arrays.
- No production selected-route composition module exists. Test harnesses assemble only task-local subsets, so a manifest addition, omitted registrar, mismatched shared policy instance, or accidental historical registrar has no aggregate production owner.
- Source CLI commands use bounded loopback HTTP clients for selected operations, but no aggregate gate proves their method/path inventory remains a subset of the production manifest.

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
| `COMP-05` | Historical `/api/v1/network*`, certificate, raw listener, tmux, legacy session-control, acceptance sentinel/driver, arbitrary proxy, and static test routes are absent from the composition, source imports, package exports, and runtime route inventory. |
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

## Explicit Non-Goals

- No built web assets, final static registration, executable packaging, user-service files, install/uninstall flow, or clean-machine release claim.
- No new product route, schema, authority, audit action, CLI feature, runtime operation, Tailscale command, profile behavior, or fallback transport.
- No direct-LAN/custom-CA restoration, public listener, Funnel, cloud relay, automatic profile switch, automatic Serve repair, or browser identity authorization.
- No replacement for route-local tests, `IFC-V1-052` stress acceptance, `IFC-V1-067` legacy disposition, `IFC-V1-091` module hardening, frontend/device UI evidence, or release acceptance.
