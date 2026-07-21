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
| Typed app, SSE adapter, static boundary, and listener lifecycle | `IFC-V1-022` to `IFC-V1-025`, `IFC-V1-036`, `IFC-V1-037`, `IFC-V1-046`, `IFC-V1-078` | Complete through mutable health, application drain, exact selected route composition, and production remote lifecycle; typed app, bounded SSE, hardened static boundary, upfront runtime ownership, exact loopback listener, Node limit inventory, and bounded reverse cleanup pass. |
| Transport/Host/Origin/CORS security foundation | `IFC-V1-017` | Complete; mandatory strict policy/context, socket-derived transport, exact Host/Origin, proxy/preflight denial, native CORS guard, diagnostics, and raw-listener evidence pass. |
| Cookie auth, security audit executor, CSRF, pair/device/revoke/lock, and reusable security foundation | `IFC-V1-026` to `IFC-V1-032`, `IFC-V1-059`, `IFC-V1-074`, `IFC-V1-077`, `IFC-V1-079` | Complete through selected fragment-safe remote pairing and aggregate physical proof: admitted-source limits, one-time QR claim, device authority, CSRF, lock, revoke, generation currentness, hardened cookie publication, browser scrub/reload behavior, and real Android private Serve composition pass without identity authority, custom CA, LAN fallback, or ADB application tunnel. |
| Historical direct-LAN physical matrix | `IFC-V1-033` | Deferred; partial diagnostic evidence is retained but cannot satisfy remote V1 acceptance. |
| Tailscale contract spike and remote ingress path | `IFC-V1-070` to `IFC-V1-079` | Complete: exact 1.98.8 observation, ownership-safe Serve mutation, proxy/source trust, pairing/application authorization, route rebaseline, proof-gated controls, fragment-only browser pairing, listener-first lifecycle/SSE behavior, and aggregate hostile plus physical Android acceptance pass. The physical run proves cellular private HTTPS, saved-profile noninterference and observation-only return, self-revoke, sanitized screenshots, and exact cleanup without custom CA or LAN fallback. Evidence: `artifacts/ifc-v1-070-tailscale-remote-ingress-spike.md` through `artifacts/ifc-v1-079-remote-ingress-acceptance.md` and `artifacts/ifc-v1-079-device/evidence.json`. |
| Commit-only fanout foundation | `IFC-V1-018` | Done; exact committed-receipt validation, strict live order, bounded registration, rollback exclusion, lifecycle, and failure evidence recorded. |
| Replay/live, subscriber bounds, mutable health, shutdown, and aggregate stream matrix | `IFC-V1-034` to `IFC-V1-038`, `IFC-V1-046`, `IFC-V1-078`, `IFC-V1-079` | Headless replay-to-live continuity, sustained global/device/session-bounded selected SSE subscribers, independent seven-source local/remote health, shutdown, exact selected registration, production remote lifecycle, and aggregate physical acceptance are complete. |
| Exact route-manifest contract | `IFC-V1-019`, `IFC-V1-046`, `IFC-V1-075` | Complete for the current exact 35-route manifest: remote status/enable/disable replace selected direct-LAN/certificate routes, historical LAN factories are isolated from selected package roots and CLI, strict ownership remains reusable, and all handlers compose through the accepted production factory. |
| Reusable exact-target write gate | `IFC-V1-066` | Complete; exact parse/auth/lock/target/audit/at-most-once-dispatch/terminal-proof ordering passes and is reused by selected remote writes. |
| Host/session/event reads, start/resume/archive, prompt, per-control, approval, interrupt, and selected API/CLI aggregate | `IFC-V1-039` to `IFC-V1-046`, `IFC-V1-060` to `IFC-V1-065`, `IFC-V1-068`, `IFC-V1-069` | Complete: every selected route and CLI leaf composes through one accepted production loopback and admitted-remote factory with exact handler, authority, audit, and source-client evidence. |
| Legacy custom-listener and raw/tmux route disposition | `IFC-V1-067` | Complete: selected package roots and their 600-module source/emitted closure are loopback HTTP plus admitted remote only; direct-LAN/TLS/raw/tmux production interfaces and dependencies are absent, pair/lock/unlock are HTTP-only, and only exact historical audit/migration decoders plus bounded confirmed legacy-session reset remain. Evidence: `artifacts/ifc-v1-067-legacy-production-interface-isolation.md`. |
| HTTP/SSE/idempotency/deadline/CLI bounds and stress aggregate | `IFC-V1-047` to `IFC-V1-052` | Complete: the accepted HTTP, SSE, idempotency/concurrency, end-to-end deadline, and bounded source-CLI owners compose under one exact 22-registration/35-route real-listener budget with synchronized overload, response-loss, shutdown/restart, privacy, and zero-residue evidence. |
| Deterministic production-output foundation | `IFC-V1-021` | In progress: strict exact-closure, offline dependency, deterministic identity, permission, integrity, and unrelated-path read-only relocation criteria are frozen; implementation remains open. |
| Built assets, CLI binary, user units, lifecycle commands, uninstall, and clean parity | `IFC-V1-053` to `IFC-V1-058` | Dependency-ordered behind production outputs and frontend readiness. |
| Reopened interface hardening | `IFC-V1-091` | Blocked only by the package/service chain through `IFC-V1-058`; selected composition, resource aggregate, legacy-interface isolation, and remote acceptance pass, and direct-LAN evidence is not a gate. |

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
