# BLK-V1-04 Host API, Security, CLI, And Service

Owns the production browser/operator boundary: loopback Fastify/SSE, Tailscale Serve HTTPS, app authorization, runtime/remote-ingress orchestration and health, packaged CLI/build, and user services.

## Outcome

- One loopback-only Fastify HTTP service exposes typed HostDeck routes, SSE, and built dashboard assets; Tailscale Serve owns private remote HTTPS.
- Remote browser reads and mutations require HostDeck pairing plus exact origin/host/proxy checks, rate limits, and audit; tailnet membership alone grants no app access.
- A dedicated saved HostDeck Tailscale profile coexists with a saved company profile one at a time. HostDeck never switches profiles or mutates an unrecognized profile.
- SSE replay/live handoff, backpressure, heartbeat, disconnect, revocation, and shutdown are bounded.
- `codexdeck` is runnable after build/install and manages foreground plus unprivileged service mode.
- Runtime/storage/stream health changes after startup and blocks unsafe mutations.

Requirement refs: `FR-011`, `FR-012`, `FR-018`, `NFR-001`, `NFR-002`, `NFR-005`, `NFR-009` to `NFR-011`, `PR-002` to `PR-005`, `PR-007` to `PR-012`, `SFR-001` to `SFR-008`, `SFR-012` to `SFR-018`.

## Local Architecture

| Part | Responsibility | Required bounds |
| --- | --- | --- |
| Fastify app | Schema routes, errors, hooks, loopback HTTP, static assets, readiness/liveness, and the one parsed resource policy. | Separate header/receive/handler/body/URL/parameter/idle/connection/in-flight limits, one request signal/deadline, explicit loopback bind, and graceful close. |
| SSE plugin/hub adapter | Cursor replay and live projection stream through the selected Readable-backed SSE transport. | Global/device/session subscribers, queue/replay bytes/events, heartbeat, abort/source cleanup, handler settlement, shutdown deadline; no direct plugin AsyncIterable path. |
| Trust hooks | External Host/Origin, admitted Serve proxy context, device cookie, CSRF generation, permission, lock, and source/global rate/concurrency. | No wildcard credentialed CORS, spoofed-forwarded-header trust, unauthenticated remote read, or Tailscale-identity authorization shortcut. |
| Tailscale adapter | Observe exact selected/active profile and Serve state; apply/remove only an exactly owned HostDeck mapping after explicit CLI intent. | Never own `tailscaled`, switch profiles, access node keys, expose a public listener, or mutate company/unknown Serve state. |
| Orchestrator/health | Selected Codex adapter, projector, storage, loopback listener, remote ingress, shutdown. | Local and remote health update independently; no test-only live source. |
| CLI/package | Command parser/client, admin paths, build/bin, service units. | Request timeout, stable exit codes, verified install/uninstall. |

## Write Gate

Every browser/remote mutation follows this exact order:

1. Parse and validate method/path/content/body/target.
2. Validate ingress provenance and the configured local or external Host and Origin.
3. Authenticate device, permission, expiry/revocation, CSRF, and verified-source/global rate/concurrency limit.
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
| Historical direct-LAN/custom-CA spike | `IFC-V1-015` | Complete for its stated diagnostic scope; retained as historical evidence and not selected V1 transport or release proof. |
| Fastify stack/API contract spike | `IFC-V1-016` | Complete; exact Fastify/Zod/SSE/static dependencies and constrained validation/stream/asset/lifecycle boundaries are proven. |
| Resource budgets and monotonic deadline contract | `IFC-V1-020` | Complete; 84 strict resource definitions now include the bounded remote observer alongside Fastify/Codex mappings, public breach codes, and owner/view fake-clock evidence. |
| Typed app, SSE adapter, static boundary, and listener lifecycle | `IFC-V1-022` to `IFC-V1-025` | Complete; typed unbound app, bounded SSE with real finite completion, hardened static boundary, upfront runtime ownership, exact loopback listener, Node limit inventory, and bounded reverse cleanup pass. Selected remote ingress, route composition, mutable health, and complete application drain remain downstream. |
| Transport/Host/Origin/CORS security foundation | `IFC-V1-017` | Complete; mandatory strict policy/context, socket-derived transport, exact Host/Origin, proxy/preflight denial, native CORS guard, diagnostics, and raw-listener evidence pass. |
| Cookie auth, security audit executor, CSRF, pair/device/revoke/lock, and reusable security foundation | `IFC-V1-026` to `IFC-V1-032`, `IFC-V1-059`, `IFC-V1-074`, `IFC-V1-077` | Complete through selected fragment-safe remote pairing: admitted-source limits, one-time QR claim, device authority, CSRF, lock, revoke, generation currentness, hardened cookie publication, browser scrub/reload behavior, and real Android private Serve composition pass without identity authority, custom CA, or LAN fallback. Aggregate physical proof remains `IFC-V1-079`. |
| Historical direct-LAN physical matrix | `IFC-V1-033` | Deferred; partial diagnostic evidence is retained but cannot satisfy remote V1 acceptance. |
| Tailscale contract spike and remote ingress path | `IFC-V1-070` to `IFC-V1-079` | `IFC-V1-070` freezes exact 1.98.8 behavior; `IFC-V1-071` to `IFC-V1-073` complete observation, ownership-safe Serve mutation, and proxy/source trust; `IFC-V1-074` completes pairing and application authorization; `IFC-V1-075` completes the 35-route rebaseline; `IFC-V1-076` completes proof-gated remote controls, selected routes, local CLI, and a real exact-cleanup vertical; `IFC-V1-077` completes fragment-only QR/browser pairing with real Android claim/reload/client-authority-cleanup evidence. Lifecycle/SSE and aggregate hostile/production physical acceptance remain `IFC-V1-078` and `IFC-V1-079`. Evidence: `artifacts/ifc-v1-070-tailscale-remote-ingress-spike.md`, `artifacts/ifc-v1-071-tailscale-observer.md`, `artifacts/ifc-v1-072-tailscale-serve-manager.md`, `artifacts/ifc-v1-073-tailscale-serve-proxy-trust.md`, `artifacts/ifc-v1-074-tailscale-serve-authorization.md`, `artifacts/ifc-v1-076-remote-control.md`, `artifacts/ifc-v1-077-fragment-safe-pairing.md`. |
| Commit-only fanout foundation | `IFC-V1-018` | Done; exact committed-receipt validation, strict live order, bounded registration, rollback exclusion, lifecycle, and failure evidence recorded. |
| Replay/live, subscriber bounds, mutable health, shutdown, and aggregate stream matrix | `IFC-V1-034` to `IFC-V1-038` | Headless replay-to-live high-water continuity is complete with retention-race and failure evidence; sustained queues, authenticated SSE composition, mutable health, shutdown, and aggregate acceptance remain. |
| Exact route-manifest contract | `IFC-V1-019`, `IFC-V1-075` | Complete for the current exact 35-route manifest: remote status/enable/disable replace selected direct-LAN/certificate routes, historical LAN factories are isolated from the selected package root and CLI, and strict ownership remains reusable. Route-handler composition remains downstream. |
| Reusable exact-target write gate | `IFC-V1-066` | Complete; exact parse/auth/lock/target/audit/at-most-once-dispatch/terminal-proof ordering passes and is reused by selected remote writes. |
| Host/session/event reads, start/resume/archive, prompt, per-control, approval, interrupt, and selected API/CLI aggregate | `IFC-V1-039` to `IFC-V1-046`, `IFC-V1-060` to `IFC-V1-065`, `IFC-V1-068`, `IFC-V1-069` | Each route is dependency-ordered behind its exact owning runtime, repository, or read port. |
| Legacy custom-listener and raw/tmux route disposition | `IFC-V1-067` | Blocked by selected API/CLI acceptance; precedes production packaging. |
| HTTP/SSE/idempotency/deadline/CLI bounds and stress aggregate | `IFC-V1-047` to `IFC-V1-052` | HTTP parser/application/socket/shutdown limits complete in `IFC-V1-047`; SSE, idempotency, propagated deadline, CLI, and aggregate leaves remain dependency-ordered. |
| Deterministic production-output foundation | `IFC-V1-021` | Blocked by accepted runtime, stream, resource, and static boundaries. |
| Built assets, CLI binary, user units, lifecycle commands, uninstall, and clean parity | `IFC-V1-053` to `IFC-V1-058` | Dependency-ordered behind production outputs and frontend readiness. |
| Reopened interface hardening | `IFC-V1-091` | Blocked by remaining selected interface leaves and `IFC-V1-070` to `IFC-V1-079`; direct-LAN evidence is not a gate. |

Owning backlog: `docs/tracking/backlog/api-cli-control-plane.md`.

## Done Criteria

- Fastify production entrypoint owns every route, SSE stream, static asset, and lifecycle hook.
- No empty/test-only live source exists in the production composition root.
- No HostDeck listener is reachable through LAN/public interfaces; wrong profile, foreign Serve ownership, unknown/contradictory proxy context, foreign Host/Origin, unpaired remote read, invalid CSRF, revoked/expired device, overload, and duplicate write all reject or degrade without dispatch/leak.
- Browser reload regains CSRF posture without exposing bearer token in durable JS storage.
- Active SSE cannot leak subscribers or hang shutdown.
- Runtime/storage/projector failures update readiness and visible health after startup.
- Tailscale stop/profile switch/Serve drift updates remote state without stopping local HostDeck or changing the active company profile.
- Built `codexdeck` and user-service install/restart/uninstall pass on clean Ubuntu.
- `IFC-V1-079` and `IFC-V1-091` pass and the block matrix links current L2-L4 remote-path evidence.
