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
| Fastify app | Schema routes, errors, hooks, HTTPS, static assets, readiness/liveness, and the one parsed resource policy. | Separate header/receive/handler/body/URL/parameter/idle/connection/in-flight limits, one request signal/deadline, and graceful close. |
| SSE plugin/hub adapter | Cursor replay and live projection stream through the selected Readable-backed SSE transport. | Global/device/session subscribers, queue/replay bytes/events, heartbeat, abort/source cleanup, handler settlement, shutdown deadline; no direct plugin AsyncIterable path. |
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
| HTTPS enrollment decision and phone proof | `IFC-V1-015` | Complete; selected X.509 profile and dependency pass host validation plus Android 16/Chrome trust, renewal, rejection, removal, recovery, and cleanup. |
| Fastify stack/API contract spike | `IFC-V1-016` | Complete; exact Fastify/Zod/SSE/static dependencies and constrained validation/stream/asset/lifecycle boundaries are proven. |
| Resource budgets and monotonic deadline contract | `IFC-V1-020` | Complete; 59 strict resource definitions, Fastify/Codex mappings, public breach codes, and owner/view fake-clock evidence precede enforcement. |
| Typed app, SSE adapter, static boundary, and listener lifecycle | `IFC-V1-022` to `IFC-V1-025` | Complete; typed unbound app, bounded SSE with real finite completion, hardened static boundary, upfront runtime ownership, exact loopback listener, Node limit inventory, and bounded reverse cleanup pass. HTTPS, selected route composition, mutable health, and complete application drain remain downstream. |
| Transport/Host/Origin/CORS security foundation | `IFC-V1-017` | Complete; mandatory strict policy/context, socket-derived transport, exact Host/Origin, proxy/preflight denial, native CORS guard, diagnostics, and raw-listener evidence pass. |
| Cookie auth, security audit executor, CSRF, pair/device/revoke/lock/LAN routes, and security matrix | `IFC-V1-026` to `IFC-V1-033`, `IFC-V1-059` | Cookie auth and the exact ten-action accepted-to-terminal security executor are complete with real storage, failure, contention, restart, and privacy evidence. Device-list route hardening is active; CSRF and pair/claim routes are newly ready while later security leaves remain dependency-ordered. |
| Commit-only fanout foundation | `IFC-V1-018` | Done; exact committed-receipt validation, strict live order, bounded registration, rollback exclusion, lifecycle, and failure evidence recorded. |
| Replay/live, subscriber bounds, mutable health, shutdown, and aggregate stream matrix | `IFC-V1-034` to `IFC-V1-038` | Headless replay-to-live high-water continuity is complete with retention-race and failure evidence; sustained queues, authenticated SSE composition, mutable health, shutdown, and aggregate acceptance remain. |
| Exact route-manifest contract | `IFC-V1-019` | Done; one strict immutable 36-route selected `/api/v1` inventory owns schemas, security policy, targets, audit/credential effects, and downstream handler leaves while the historical 17-route surface remains deprecated. |
| Reusable exact-target write gate | `IFC-V1-066` | Blocked by trust, CSRF, lock, audit, and the real structured vertical. |
| Host/session/event reads, start/resume/archive, prompt, per-control, approval, interrupt, and selected API/CLI aggregate | `IFC-V1-039` to `IFC-V1-046`, `IFC-V1-060` to `IFC-V1-065`, `IFC-V1-068`, `IFC-V1-069` | Each route is dependency-ordered behind its exact owning runtime, repository, or read port. |
| Legacy custom-listener and raw/tmux route disposition | `IFC-V1-067` | Blocked by selected API/CLI acceptance; precedes production packaging. |
| HTTP/SSE/idempotency/deadline/CLI bounds and stress aggregate | `IFC-V1-047` to `IFC-V1-052` | HTTP parser/application/socket/shutdown limits complete in `IFC-V1-047`; SSE, idempotency, propagated deadline, CLI, and aggregate leaves remain dependency-ordered. |
| Deterministic production-output foundation | `IFC-V1-021` | Blocked by accepted runtime, stream, resource, and static boundaries. |
| Built assets, CLI binary, user units, lifecycle commands, uninstall, and clean parity | `IFC-V1-053` to `IFC-V1-058` | Dependency-ordered behind production outputs and frontend readiness. |
| Reopened interface hardening | `IFC-V1-091` | Blocked by `IFC-V1-015` to `IFC-V1-069`. |

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
