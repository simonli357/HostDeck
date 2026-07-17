# IFC-V1-039 Health And Host-Status Routes

Date: 2026-07-16
Status: criteria frozen; implementation pending

## Selected Boundary

- Bind the three existing manifest entries exactly: public `GET /api/v1/health/live`, protected `GET /api/v1/health/ready`, and protected `GET /api/v1/host/status`. Add no alias, pagination, transcript, session, command, or diagnostic-dump surface.
- Liveness is independent of mutable health and returns only `{ "status": "alive" }` while the Fastify process can serve the request. It performs no authentication resolution, health read, storage read, runtime call, clock read, or remote observation.
- Readiness and host status require the manifest's `loopback_or_device_cookie` authority. Invalid, expired, revoked, unpaired remote/LAN, and storage-failed authentication reject before either health snapshot is read.
- Readiness is local process readiness only. It returns HTTP 200 when all seven local components are explicitly ready and HTTP 503 with the same typed body otherwise. Tailscale/profile/Serve state never changes that HTTP result.
- Host status returns HTTP 200 for every valid local and remote health state, including degraded/failed/unknown. It reports local and remote state independently so a healthy local host with unavailable remote ingress is not mislabeled unavailable.
- The route consumes the branded mutable host-health service. It snapshots, validates, detaches, schema-parses, and freezes public output; it owns no poller, retry, health mutation, process, listener, storage query, remote command, or shutdown action.

## Wire Contracts

| Contract | Exact public fields |
| --- | --- |
| Liveness | `status: "alive"` only. No version, timestamp, generation, component, origin, access, request, or host identity. |
| Readiness | `generation`, aggregate `state`, binary `readiness`, `updated_at`, and exactly seven ordered component entries. Each component contains only `component`, `state`, nullable `checked_at`, and bounded `causes`. |
| Host status | `local`, `remote`, and `access`. `local` adds `mutation_admission` to the readiness facts. `remote` contains health generation, nullable durable state generation, availability, one bounded cause, nullable canonical external origin, laptop-action flag, and observed/checked/updated timestamps. `access` contains request access mode, network mode, transport, and scoped write eligibility. |

The exact local component order is storage, runtime, compatibility, projector, fanout, listener, and lease. Public component states and causes reuse the host-health vocabulary; internal source generations are not exposed. `not_observed` is valid only for an initial unknown component with no check time. Ready components have no causes; every non-ready component has one to four unique component-valid causes.

Access mode is one of `local_admin`, `loopback_read`, `paired_read`, or `paired_write`. Write eligibility has literal scope `host_health_and_authority`, one boolean, and the ordered bounded causes `read_only_access` and `host_not_ready`. It is eligible only when the caller has local-admin or paired-write authority and local mutation admission is open. This is deliberately not final mutation authorization: durable lock, CSRF, exact target, capability, session state, audit, and request deadline remain with their existing owner contracts and gates.

## Hard Success Criteria

| Boundary | Required proof |
| --- | --- |
| Exact contracts | New selected Zod contracts reject missing/extra/symbol/accessor/prototype-invalid data, unsafe integers, invalid timestamps/origins, duplicate/out-of-order components or causes, contradictory aggregate/component state, and contradictory access/write fields. Public health constants become the shared owner consumed by the mutable reducer rather than a second drifting vocabulary. |
| Public liveness | The exact GET returns 200 and the one-literal body with no auth or health calls. Query keys, trailing slash, HEAD, wrong method, and oversized/resource-policy failures use existing stable errors and never become an alternate health surface. |
| Protected reads | Both protected routes enforce current loopback-local or paired-device read authority. Missing remote credentials, malformed/unknown/expired/revoked cookies, paired-authority invalidation, ingress-generation change, and auth storage failure produce no health body and invoke no health read where rejection precedes the handler. |
| Local readiness | Initial, unknown, stale, degraded, failed, and any single-component non-ready state return typed 503 and never serialize `ready`. Exactly all-seven ready returns typed 200. A later explicit failure changes the next response to 503; only a newer explicit successful observation restores 200 and advances generation. |
| Independent remote truth | Remote unknown, disabled, stopped, signed-out, wrong-profile, Serve absent/foreign/colliding/drifted/public, observer failure, and recovery change only the host-status remote object. They do not change readiness status, local generation/state, mutation admission, or a current local health proof. |
| Causal consistency | Aggregate severity is failed, degraded, stale, unknown, then ready. Ready implies every component ready, no causes, and open mutation admission. Unknown/stale/degraded/failed always imply not-ready and closed admission. Remote ready requires current origin/timestamps and no cause; remote unknown/failure cannot retain a ready origin. |
| Access/write truth | Loopback browser reads remain `loopback_read`, explicit local CLI provenance is `local_admin`, and paired read/write permission remains distinct. Write eligibility closes for read-only access and every non-ready local state, includes both causes when both apply, and does not depend on remote availability. No device id, cookie, CSRF generation, or raw origin header is returned. |
| Failure atomicity | Each protected handler reads one local snapshot and, for status, one remote snapshot without retry. Snapshot/shape/contract failure returns one bounded generic 500 with no partial body, stale fallback, private cause, or prior successful response. The health service is never mutated by a GET. |
| Response lifetime | All three routes are explicit no-store/no-cache GETs with generated request ids and disabled implicit HEAD. Protected 200 responses and typed readiness 503 responses revalidate current paired/ingress authority at response delivery so revocation cannot leak a body after handler admission. |
| Privacy/bounds | Object-graph, serialized-body, observer, and raw-listener inspection find no session/thread/device id, cwd/path, prompt/event/transcript, cookie/token/hash/CSRF value, profile key, raw Tailscale output, PID/socket, exception cause, or arbitrary component message. Bodies remain fixed-size apart from bounded cause arrays and one bounded external origin. |
| Ownership | The registration is immutable, consumes each exact manifest row once, rejects duplicate ownership, exports through the package boundary, and adds no lock/session/storage/runtime/Tailscale mutation or production composition claim. `IFC-V1-046` remains the aggregate route registry owner and `IFC-V1-078` remains live health-observer composition owner. |

## Validation Plan

- Contract tests cover every component/state/cause family, aggregate precedence, initial state, all-ready state, remote availability/failure matrix, access modes, write-eligibility combinations, exact data-object rejection, deep freeze, and privacy sentinels.
- Route injection tests cover exact paths/methods/query behavior, no-store headers, public zero-touch liveness, local browser/local-admin/paired read/paired write authority, rejected auth states, 200/503 mapping, revoke/ingress invalidation at delivery, malformed-boundary failure, and no health mutation.
- Health-transition tests drive the real mutable service through initial, partial-ready, all-ready, failure, remote-only degradation, local recovery, and remote recovery while checking exact generations and response bodies.
- Adjacent request-authentication, host-health, remote-ingress, Fastify error/resource, and selected-manifest suites; all workspace suites and typechecks; lint/exports, scaffold, planning, exact binding, frozen install, supply-chain, privacy, diff, and active-handle checks run before closure.

## Explicit Non-Goals

- No final write gate, durable lock merge, CSRF bootstrap, target/session eligibility, audit availability, or client-side state coordination.
- No live producer/poller/startup/shutdown composition; that remains `IFC-V1-078`.
- No selected-route aggregate composition or CLI health client; that remains `IFC-V1-046` and downstream packaging leaves.
- No React implementation, screenshot, visual approval, physical phone, Tailscale profile switch, or release-readiness claim.
