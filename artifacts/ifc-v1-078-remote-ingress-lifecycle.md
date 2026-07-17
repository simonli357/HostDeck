# IFC-V1-078 Remote Ingress Lifecycle

Date: 2026-07-16
Status: in progress

## Objective

Compose the selected loopback Fastify host, proof-gated remote control, Tailscale observation, mutable remote health, generation-current HTTP/SSE authority, and graceful shutdown into one production lifecycle. Local Codex, storage, loopback HTTP, and CLI readiness must remain independent from Tailscale availability, while every remote request fails closed when its exact observed profile/Serve generation stops being current.

Requirement refs: `FR-005`, `FR-012`, `FR-013`, `FR-014`, `FR-018`, `NFR-002`, `NFR-010`, `NFR-011`, `PR-007`, `SFR-015`, `SFR-017`, `DEC-027`.

## Ownership Audit

- `IFC-V1-071` owns bounded read-only Tailscale commands and returns one privacy-safe observation. It has no timer or health owner.
- `IFC-V1-072` owns the only Serve mutations. This lifecycle may call the remote-control service but cannot call the manager, switch profiles, log in/out, start/stop `tailscaled`, repair Serve, or remove ambiguous/foreign state.
- `IFC-V1-076` owns durable remote intent/proof, exact observation-to-state transitions, one-operation/no-queue control, and a process-local observation lease. It opens admission only for matching proof, ready durable state, and an unexpired exact-generation lease.
- `IFC-V1-073` and `IFC-V1-074` already bracket remote admission around proxy and application authorization. Their residual gap is proactive invalidation of an already admitted remote request when no later currentness check runs.
- `IFC-V1-036` owns independent local and remote health. Remote failure cannot alter local health or local mutation proof.
- `IFC-V1-034` and `IFC-V1-037` own bounded SSE subscribers and shutdown ordering. Client disconnect already cancels one request; application shutdown already closes admission, listener, SSE, runtime, storage, and lease in order.
- The generic host lifecycle still constructs the historical request-trust app. This leaf owns a selected Tailscale Serve lifecycle entrypoint that reuses its listener/resource/cleanup machinery without weakening the historical path.

## Frozen Production Composition

### Lifecycle Boundary

- One accepted remote-ingress lifecycle creates the control service through a factory that receives its root abort signal. The same signal must reach the bounded observer and Serve manager used by that service; construction performs no Tailscale command.
- The lifecycle exposes one wrapped control surface for status/enable/disable routes, one effective admission reader for the proxy policy, one generation-scoped request-authority policy for the selected Fastify app, startup/drain/close methods, and a bounded privacy-safe snapshot.
- The selected Fastify lifecycle requires IPv4 loopback HTTP, creates only `createHostDeckTailscaleServeFastifyApp`, derives its local origin from the verified bind, and accepts the remote lifecycle from the started runtime context through an exact selector.
- Route/auth/plugin composition and `app.ready()` complete before bind. The listener is bound and verified before remote lifecycle `start()` can schedule its first observation. Starting remote observation never gates or retracts local readiness.
- The wrapped control surface reconciles health, authority, and lease timing after every successful status/enable/disable result. After failure it re-reads effective admission: an operation that began and lost its lease publishes a bounded remote observation failure, while malformed input or a pre-ownership busy rejection cannot invent global degradation. No failure retries or compensates.

### Poll And Lease Timing

- The control service exposes its current admission lease to the lifecycle as an exact internal snapshot containing the public admission fields plus nullable monotonic `valid_until`. Public proxy admission remains the existing three-field contract.
- Each settled lifecycle poll waits `max(1, floor(remote_observer_poll_interval_ms / 3))` before the next poll. There is one loop, one in-flight lifecycle poll, no overlap, no queue, no automatic mutation, and no retry burst.
- A successful ready observation arms a guard at the control service's exact monotonic lease deadline. Renewing the same generation replaces only the guard; it does not replace or abort current request leases.
- If a refresh is still running when the prior lease expires, the guard closes generation authority and publishes `observation_failed`. A later successful exact observation may open the same durable generation again. The lifecycle never extends a stale lease to hide a slow or stalled observer.
- Disabled/unselected state performs no configured observation and remains on the same bounded cadence. Profile return and process restart only observe: matching persisted state plus durable proof can recover; missing proof, absent/drifted/foreign Serve, or a different profile remains closed until an explicit local enable succeeds.
- Poll/control collision uses the control service's existing coalescing/no-queue truth. A busy loser re-synchronizes authority but does not overwrite the active operation's eventual health result. Canceled, storage, clock, contract, and observer failures that close admission close remote authority and health; malformed pre-ownership input changes neither. No path affects local health or triggers a second operation.

### Remote Request Authority

- One authority policy tracks at most one open `{generation, external_origin}` scope and one lease per active remote request. Scope refresh brackets the effective admission reader; malformed, throwing, closed, changed, or permanently closed input invalidates all leases once.
- Proxy trust admits the exact request provenance first. Request authentication then acquires an authority lease for that exact remote generation/origin before route work. Local loopback requests acquire no remote lease and cannot be aborted by remote lifecycle changes.
- The authentication-owned cancellation signal composes request disconnect, request deadline, paired-device revocation, and remote-generation authority. Authority release occurs once on response or request abort; a phone/client disconnect releases only that request and never calls remote health or control.
- Currentness checks require both bracketed proxy admission and an active matching authority lease. Profile/Serve generation change, observer failure, lease expiry, disable, shutdown, or lifecycle failure signals active remote HTTP/SSE work and withholds a later successful response.
- An already irreversible mutation keeps its durable audit outcome and is never replayed or relabeled because authority closed. Cooperative work receives cancellation; noncooperative work remains bounded by the existing request/shutdown deadlines and cannot publish a stale success.
- SSE retains existing durable cursor/replay semantics. Authority loss closes the affected stream; reconnect is a new fully authorized request. No server-side reconnect loop is added, and one client network loss does not close sibling streams or Codex work.

### Health And Failure Truth

- The lifecycle initializes its positive source generation strictly after the host-health service's current remote source generation. Every settled control result calls `updateRemote`; every unavailable lifecycle operation or expired lease calls `failRemote` with a bounded supported cause.
- Ready remote health is published only when the same reconciliation observes open exact-generation admission. Closed admission cannot coexist with newly published ready health.
- Observer snapshots retain their precise public unavailable reason. Thrown/busy/canceled/internal lifecycle observation paths publish only the bounded `observation_failed` class; raw errors, commands, profile keys, DNS names, source addresses, and identities are not retained.
- A lifecycle clock/scheduler/authority contract failure permanently closes remote authority and marks the remote lifecycle failed. Local listener, Codex, storage, local health, and loopback CLI remain available until their own owner closes them.

### Shutdown Order

1. Selected lifecycle phase becomes draining; remote authority closes and the root signal aborts poll sleeps, observer commands, and in-flight remote control work synchronously before listener refusal.
2. Existing write admission closes, listener close begins, and active remote request signals are already aborted.
3. Existing SSE, approval/reconnect/write/audit/projection/supervisor and HTTP/Fastify cleanup continues in the accepted order.
4. The remote lifecycle settles its poll/guard tasks under the inherited deadline before application storage and daemon-lease closure.
5. Storage and daemon lease close last. Remote cleanup never invokes the manager independently and never changes `tailscaled`, profile selection, login state, or Serve configuration.

Repeated/concurrent drain and close calls reuse one transition and one promise. Timeout or noncooperation is retained as shutdown failure while later cleanup continues; late settlement cannot reopen authority, reschedule observation, update closed health ownership, or mutate Tailscale.

## Hard Success Criteria

| Boundary | Required proof |
| --- | --- |
| Local-first startup | Runtime, routes, app readiness, loopback bind, and exact listener verification precede the first observer call. Unavailable/slow Tailscale does not delay the returned local lifecycle. |
| Observation-only recovery | Restart, unavailable boot, profile-away, profile-return, exact Serve return, drift, absent proof, and delayed recovery preserve durable generation/proof rules with zero automatic mutation. |
| Lease exactness | Refresh starts early, but old authority closes at the exact prior lease deadline if refresh has not completed. Same-scope renewal preserves streams; generation/origin change aborts them once. |
| Request isolation | Remote HTTP/SSE leases cancel on generation closure; loopback requests and sibling client disconnects remain active. Release/abort/currentness races leak no lease or listener. |
| Mutation truth | Enable/disable and active selected mutation races preserve one dispatch/audit outcome, withhold stale success, and issue no automatic retry, rollback, repair, or compensation. |
| Health independence | Remote state/failure/recovery advances only remote health. Local readiness, local mutation proof, Codex work, storage, and loopback CLI remain unchanged. |
| Shutdown | Authority and observation close before SSE/storage; all tasks settle or time out within inherited bounds; no post-close poll, health write, listener, timer, request lease, or temporary root remains. |
| Privacy | Public/snapshot/evidence fields contain only phase, admission class, generations, counters, deadlines/durations, and bounded reasons. No origin, profile, identity, source, command output, credential, payload, path, PID, or raw cause is retained. |
| Real noninterference | Exact Tailscale 1.98.8 dedicated-profile observation, private Serve enable/read/disable, profile-away/return, shutdown, and final authoritative inspection leave the original saved profiles and final Serve state unchanged/absent as selected. |

## Deterministic Scenario Matrix

- Startup: disabled, exact persisted/proven, missing proof, absent client, stopped, signed out, other profile, exact Serve, absent Serve, drifted/foreign Serve, observer throw, and delayed first recovery.
- Timing: early refresh, slow refresh crossing expiry, same-generation renewal, generation replacement, wall/monotonic regression, canceled sleep, busy status/mutation collision, concurrent status coalescing, and counter saturation.
- Requests: local and remote finite HTTP, active selected mutation before/after irreversible dispatch, active SSE, multiple same-generation streams, device revoke, raw client disconnect, profile switch, Serve removal, disable, and recovery reconnect.
- Shutdown: before remote start, during first observation, during cadence sleep, during lease guard, during enable/disable, with active HTTP/SSE, repeated/concurrent close, noncooperative observer, startup failure, and same-port/process restart.
- Failure containment: every control-service error class, malformed admission/lease/authority contract, health source failure, scheduler failure, callback throw, late settlement, and cleanup timeout.

## Validation Plan

- Unit tests for the request-authority policy, remote lifecycle fake clock/sleep/control/health matrix, authentication signal composition, selected Fastify construction, and exact lifecycle startup/shutdown order.
- Real loopback Fastify/SQLite integration with active local and admitted remote HTTP/SSE, profile-generation invalidation, one irreversible selected mutation, shutdown, storage/lease reuse, and zero retained request authority.
- Exact Tailscale 1.98.8 smoke on the saved dedicated HostDeck profile: capture redacted before state, explicit local enable, private HTTPS status/SSE, profile-away/return observation only, explicit disable, process shutdown/restart, authoritative final profile/Serve/listener inspection, and zero test residue. Physical cellular Android acceptance remains `IFC-V1-079`.
- Focused and adjacent authorization/control/observer/health/SSE/lifecycle/shutdown tests; all workspace suites; typecheck; lint/exports; scaffold/planning/runtime-boundary; exact Codex 0.144.0 binding; frozen install; production audit/license inventory; diff/privacy/no-auto-mutation/process/listener/timer/temp inspection; commit; and push.

## Explicit Non-Goals

- No browser connection-state reducer, CSRF client lifecycle, UI recovery surface, static build, package/service unit, OS signal owner, or release claim is added.
- No public/LAN listener, custom CA, direct-LAN fallback, Funnel, public internet endpoint, Tailscale OAuth/API credential, profile switch, login/logout, `tailscaled` ownership, or automatic Serve repair is added.
- No physical-phone cellular acceptance is claimed here. `IFC-V1-079` remains the aggregate hostile and target-Android owner.
- No existing mutation is retried, replayed, compensated, or inferred failed solely from client loss, generation closure, observation failure, or shutdown.
