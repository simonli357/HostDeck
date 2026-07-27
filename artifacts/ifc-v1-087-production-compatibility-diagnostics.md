# IFC-V1-087 Production Compatibility Diagnostics

Date: 2026-07-27

Status: criteria frozen; implementation and evidence pending.

## Scope

Make selected production startup observe the configured Codex binary, reject an unsupported runtime before app-server admission, preserve truthful durable/session state, and keep the loopback/private-Serve dashboard reachable as a read-only diagnostic surface. Extend the existing protected host-status response with one strict public compatibility projection for `FE-V1-035`.

Excluded: changing the reviewed Codex 0.144.0 binding, accepting 0.145.x, regenerating bindings, updating Codex, executing shell commands from the browser, retry loops, terminal/raw-protocol fallback, public/LAN listeners, custom certificates, automatic Tailscale changes, new route paths, or compatibility UI implementation.

## Audit Findings

- Production passes `codexBindingDescriptor.codex_version` into the reconnect controller as `observed_version`. The only real `codex --version` checks are smoke-test setup, so production records the expected 0.144.0 value rather than the configured binary's observed value.
- The initialize `userAgent` is derived from HostDeck's client identity and cannot independently prove the app-server binary version. Treating it as corroboration can admit protocol-compatible version drift under a false 0.144.0 record.
- The application start owner waits for reconnect compatibility and reconciliation before it returns a Fastify runtime context. Initial incompatibility rejects that start, the listener is never created, and the required update-required mobile state cannot load.
- Incompatible compatibility is not persisted. The reconnect connection rejects before the reconciliation lifecycle reaches its `ready` callback, which is currently the only persistence owner.
- Skipping runtime reconciliation without another boundary would leave durable session projections looking current. A diagnostic listener must first seal active persisted projections as disconnected and reconcile accepted-only audit orphans.
- The selected host-status route exposes only coarse compatibility health. It has no observed/supported version, evidence currentness, aggregate capability cue, or check revision for truthful UI recovery.
- The approved Focus Rail assets already define the host/access owner rail and recovery grammar. The executable UI inventory does not require a new structural compatibility mockup, so `FE-V1-035` can reuse that approved structure after this interface is proven.

## Frozen Boundary

### Binary Observation And Runtime Preparation

- Add one production-owned Codex version probe after guarded storage open and before app-server supervisor start or socket wait.
- Invoke only the validated canonical absolute executable with exact argv `--version`, cwd `/`, no shell, ignored stdin, captured stdout/stderr, a 10-second-or-narrower startup bound, and a 4 KiB aggregate output bound.
- Abort, timeout, spawn failure, signal, nonzero exit, output overflow, invalid UTF-8, extra output, or malformed version text terminates the child, awaits closure, fails startup loudly, and reverse-cleans storage and lease ownership. No output or environment value enters a public error, issue, log, artifact, or retained resource.
- Parse successful output only through `parseCodexCliVersionOutput`. Carry that real semver as immutable `codex_version` production-resource truth; never substitute the reviewed binding version.
- Exact reviewed version continues through the existing foreground-child or service-owned supervisor and socket readiness path unchanged.
- A syntactically valid version different from the reviewed exact version returns an explicit `version_incompatible` runtime-preparation result. HostDeck does not spawn a foreground app-server, wait for or attach to a service-owned socket, claim runtime readiness, or create a process-exit observer for that result.
- The diagnostic result retains only mode, canonical socket identity, observed version, and explicit non-ready preparation state needed by the composition root. It cannot masquerade as a started runtime.

### Diagnostic-Ready Startup

- The reconnect controller receives the resource's observed version. A valid mismatch must fail its compatibility preflight before transport connect, initialize, reconciliation reads, resubscription, or runtime admission.
- Only an owned reconnect error with code `incompatible`, a terminal reconnect snapshot of `incompatible`, and a schema-valid incompatible compatibility record may enter diagnostic startup. Any transport, timeout, abort, storage, maintenance, projection, listener, configuration, malformed probe, or contradictory state remains fatal and reverse-cleans startup.
- Persist the exact incompatible compatibility result before publication. Recording failure or timestamp regression is fatal; stale durable compatibility cannot stand in for the current check.
- Run a dedicated local-only startup-unavailable reconciliation step before routes listen. It uses the accepted restart-gap machinery to mark every non-archived durable projection disconnected, publish bounded runtime boundary events, and reconcile accepted-only audit orphans without issuing a Codex request.
- Run normal bounded startup maintenance after that boundary. Degraded or failed maintenance cannot publish the diagnostic listener.
- Publish application phase `diagnostic_ready`, compatibility health `failed/runtime_incompatible`, runtime health `failed/runtime_failed`, listener health `ready`, and mutation admission `closed`. The ordinary supported path still publishes `runtime_ready` and full local readiness.
- Fastify registers the same selected routes and static assets and binds only validated IPv4 loopback HTTP. Readiness remains 503. Protected host/access reads, pairing needed to reach them, and static navigation remain available; every runtime/session mutation still fails through existing compatibility/health/admission gates without dispatch or audit success.
- Remote observation may start after listen exactly as today, allowing an already configured private Tailscale Serve origin to reach the diagnostic page. This introduces no Serve repair, profile switch, Funnel, public listener, LAN fallback, custom CA, or browser-side local-admin authority.
- No subscriber, approval, runtime request, or projection can be admitted as live. Existing durable sessions may be read only with their newly persisted disconnected boundary.
- Shutdown closes the terminal reconnect owner, idle/skipped or started supervisor as applicable, listener, storage, and lease in the existing bounded order. Repeated close and same-port/lease restart remain clean.

### Public Compatibility Projection

- Extend the existing protected no-store `GET /api/v1/host/status` response. Add no route and do not alter liveness disclosure.
- The public compatibility object contains exactly: `state`, `evidence`, `observed_version`, `supported_version`, `capability_state`, `checked_at`, and `recorded_at`.
- Public states are `supported`, `degraded`, `incompatible`, `unknown`, `disconnected`, and `version_drift`. Evidence is `current`, `last_known`, or `unobserved`. Capability state is `verified`, `limited`, `blocked`, or `unverified`.
- `supported` requires current ready compatibility health plus a current persisted ready/allowed record at the exact supported version; its capability cue is `verified`.
- `version_drift` requires current `runtime_incompatible` health and a current persisted incompatible record whose non-null observed version differs from the supported version; its capability cue is `blocked`.
- `incompatible` requires current `runtime_incompatible` health and a current persisted incompatible record that is not version drift; its capability cue is `blocked`.
- `degraded` may be current only from a matching current degraded record and degraded health; otherwise retained evidence is labelled `last_known`. It never verifies mutation capability.
- `disconnected` is never current capability evidence. It requires disconnected runtime/compatibility health and a prior record, exposes that record only as `last_known`, and uses `unverified` capability state.
- `unknown` is `unobserved` when no record exists and may be `last_known` when startup health has not established a current check. It never looks supported.
- `unobserved` requires null observed/check/record times. `current` and `last_known` require non-null check/record times with `recorded_at >= checked_at`. Current supported/degraded observations require a non-null observed version.
- The projection fails the route contract on impossible health/record combinations instead of selecting a favorable state. It exposes no binding id, capability names, raw reason, executable/socket/path, process identity, command output, user agent, environment, Tailscale identity, or session data.
- `recorded_at` is the compatibility-check revision for the later UI owner. Re-reading the same record cannot prove recovery; `FE-V1-035` must require a newer current supported record after an explicit check.

## Strict Success Criteria

- `PCD-01`: production executes one exact bounded `codex --version` observation and parses only strict `codex-cli <semver>` output.
- `PCD-02`: the observed semver, not the binding's expected value, reaches production resources, reconnect compatibility, persistence, and public projection.
- `PCD-03`: timeout, abort, overflow, spawn/signal/nonzero, malformed/extra output, invalid UTF-8, and cleanup failure are bounded, private, fatal, and residue-free.
- `PCD-04`: exact 0.144.0 preserves existing supervisor, socket, handshake, reconciliation, listener, and mutation readiness behavior.
- `PCD-05`: a valid mismatched semver starts or attaches to no Codex runtime and sends no transport/protocol request.
- `PCD-06`: only proven terminal incompatibility may continue to diagnostic startup; all other initial failures remain fatal.
- `PCD-07`: the current incompatible result is durably recorded before diagnostic publication; stale or contradictory records fail closed.
- `PCD-08`: diagnostic startup marks all non-archived durable projections disconnected and reconciles startup audit truth without a runtime request.
- `PCD-09`: diagnostic startup completes bounded storage maintenance before listen and rejects degraded/failed maintenance.
- `PCD-10`: loopback static and authorized diagnostic reads are reachable while readiness remains 503 and local mutation admission remains closed.
- `PCD-11`: every session/control mutation sends zero runtime operations and cannot publish accepted/succeeded audit truth in diagnostic mode.
- `PCD-12`: no SSE subscriber, approval, session, or persisted projection appears current/live after diagnostic startup.
- `PCD-13`: private Serve observation remains post-listen and independent; no Tailscale/profile/Serve mutation or alternate transport is introduced.
- `PCD-14`: the six public states, three evidence states, four capability cues, versions, and timestamps satisfy strict cross-field invariants.
- `PCD-15`: version drift is distinguishable from exact-version binding/capability incompatibility without exposing private compatibility detail.
- `PCD-16`: unknown, disconnected, degraded, stale, malformed, or contradictory evidence never projects supported/verified truth.
- `PCD-17`: host-status authorization, response-lifetime currentness, no-store policy, bounded bytes, and failure atomicity remain unchanged.
- `PCD-18`: public API/browser/error/log/package output contains no raw reason, binding/capability inventory, path/socket/process data, command output, user agent, environment, credential, or identity value.
- `PCD-19`: diagnostic shutdown, repeated close, same-port restart, lease transfer, and skipped-supervisor cleanup leave zero owned process/socket/listener/temp residue.
- `PCD-20`: fake-port tests cover order, races, contradictions, hostile contracts, and every projection product; real listener tests cover exact and mismatched versions.
- `PCD-21`: a clean default Codex 0.145.x no-model smoke proves a reachable authenticated update-required host status with zero app-server admission; exact isolated 0.144.0 regression proves normal readiness.
- `PCD-22`: focused, unit, contract, integration, web compatibility, typecheck, lint/exports, scaffold, planning, runtime-boundary, build/package, frozen-install, supply-chain, privacy, diff, and residue gates pass.
- `PCD-23`: owner docs, bug/task status, command reference if commands change, evidence, coherent commits, and push state match actual behavior before closure.
- `PCD-24`: this task does not claim `FE-V1-035`, complete dashboard hardening, persistent install/parity, phone acceptance, or V1 release ready.

## Required Evidence

- Direct version-probe tests with controlled child fixtures and process-residue inspection.
- Foreground/service resource tests proving exact-version start, mismatch skip, ordering, rollback, abort, close, and strict resource snapshots.
- Reconnect/application tests proving pre-transport mismatch, current persistence, durable disconnected sealing, diagnostic listener publication, closed mutation admission, and generic-failure rejection.
- Contract/projector/real-listener tests covering every public state and contradiction, authentication currentness, no-store headers, bytes, and privacy.
- Exact isolated 0.144.0 no-model production regression and default 0.145.x no-model diagnostic smoke from clean committed code, with no Tailscale/profile/Serve/phone mutation.
- Deterministic package and emitted-runtime checks proving the same behavior from the selected production output.

## Completion Record

- Pending implementation, validation, owner-doc closure, commit ids, and push evidence.
