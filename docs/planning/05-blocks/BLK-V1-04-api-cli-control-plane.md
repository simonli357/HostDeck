# BLK-V1-04 Host API, Security, CLI, And Service

Owns the production browser/operator boundary: Fastify, SSE, HTTPS, authorization, runtime orchestration/health, packaged CLI/build, and user services.

## Outcome

- One same-origin Fastify HTTP/HTTPS service exposes typed HostDeck routes, SSE, and built dashboard assets.
- LAN is explicit HTTPS-only; all LAN reads and mutations are paired, origin/host checked, rate-limited, and auditable.
- SSE replay/live handoff, backpressure, heartbeat, disconnect, revocation, and shutdown are bounded.
- `codexdeck` is runnable after build/install and manages foreground plus unprivileged service mode.
- Runtime/storage/stream health changes after startup and blocks unsafe mutations.

Requirement refs: `FR-011`, `FR-012`, `FR-018`, `NFR-001`, `NFR-009` to `NFR-011`, `PR-002` to `PR-004`, `PR-007` to `PR-012`, `SFR-001` to `SFR-008`, `SFR-012` to `SFR-018`.

## Local Architecture

| Part | Responsibility | Required bounds |
| --- | --- | --- |
| Fastify app | Schema routes, errors, hooks, HTTPS, static assets, readiness/liveness. | Headers/body/request/idle/connection limits and graceful close. |
| SSE plugin/hub adapter | Cursor replay and live projection stream. | Subscribers, queue bytes/events, heartbeat, abort cleanup, shutdown deadline. |
| Trust hooks | Host/Origin, device cookie, CSRF generation, permission, lock, rate/concurrency. | No wildcard credentialed CORS or unauthenticated LAN read. |
| Certificate manager | LAN certificate enrollment/inspection/renewal and origin allowlist input. | Owner-only keys, SAN/expiry validation, no plaintext fallback. |
| Orchestrator/health | Selected Codex adapter, projector, storage, listener, shutdown. | Runtime health updates and one owner; no test-only live source. |
| CLI/package | Command parser/client, admin paths, build/bin, service units. | Request timeout, stable exit codes, verified install/uninstall. |

## Write Gate

Every browser/remote mutation follows this exact order:

1. Parse and validate method/path/content/body/target.
2. Validate configured Host and Origin.
3. Authenticate device, permission, expiry/revocation, CSRF, and rate/concurrency limit.
4. Check host lock.
5. Load exact target and current runtime/capability/write state.
6. Write bounded audit `accepted`.
7. Dispatch once through application service.
8. Write terminal `succeeded`, `failed`, or `incomplete` outcome.
9. Return a response consistent with proven state.

Local-admin CLI calls use an explicit loopback/admin authority, not a magic missing-auth branch.

## Task Map

| Work | Tasks | Status |
| --- | --- | --- |
| Historical headless routes/custom listener/source CLI | `IFC-V1-001` to `IFC-V1-014`, `IFC-V1-090` | Retained reusable evidence; production block reopened. |
| HTTPS enrollment decision and phone proof | `IFC-V1-015` | Ready after planning rebaseline. |
| Fastify API/SSE/static runtime | `IFC-V1-016` | Blocked by normalized contracts. |
| Authorization, CSRF, Host/Origin, rate/device hardening | `IFC-V1-017` | Blocked by HTTPS decision and auth storage. |
| Projection fanout, live health, graceful shutdown | `IFC-V1-018` | Blocked by Fastify and Codex event path. |
| Selected adapter API/CLI operation integration | `IFC-V1-019` | Blocked by real Codex vertical. |
| Timeouts, overload, backpressure, concurrency | `IFC-V1-020` | Blocked by runtime integration. |
| Build, runnable CLI, static assets, user services | `IFC-V1-021` | Blocked by production runtime. |
| Reopened interface hardening | `IFC-V1-091` | Blocked by all new interface tasks. |

Owning backlog: `docs/tracking/backlog/api-cli-control-plane.md`.

## Done Criteria

- Fastify production entrypoint owns every route, SSE stream, static asset, and lifecycle hook.
- No empty/test-only live source exists in the production composition root.
- LAN plaintext, foreign Host/Origin, unpaired read, invalid CSRF, revoked/expired device, overload, and duplicate write all reject without dispatch/leak.
- Browser reload regains CSRF posture without exposing bearer token in durable JS storage.
- Active SSE cannot leak subscribers or hang shutdown.
- Runtime/storage/projector failures update readiness and visible health after startup.
- Built `codexdeck` and user-service install/restart/uninstall pass on clean Ubuntu.
- `IFC-V1-091` passes and block matrix links L2-L4 evidence.
