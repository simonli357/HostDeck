# IFC-V1-036 Mutable Host Health

Date: 2026-07-16
Status: hard criteria frozen; implementation not yet complete

## Selected Boundary

- Add one headless host-health service with exactly seven required local components: storage, runtime, compatibility, projector, fanout, listener, and daemon lease. It exposes one immutable local snapshot and one separately generated immutable remote-access snapshot.
- Local component observations use a fixed state and reason vocabulary plus a caller-owned positive source sequence. A newer source sequence may supersede an older in-flight check; a lower sequence rejects, an equal identical observation is idempotent, and an equal contradictory observation fails closed.
- Local health owns a monotonic aggregate generation. Only an explicit newer `ready` observation clears a component's prior reasons. Unknown, stale, degraded, or failed components close local mutation admission; no remote state participates in that calculation.
- A branded mutation proof captures one ready local generation. Callers can validate it immediately before dispatch; any intervening local observation invalidates it. Remote-only updates do not invalidate local mutation proofs.
- Remote health consumes only the existing bounded `RemoteIngressPublicState` contract or one explicit bounded observation failure. It never stores profile comparison keys, raw Tailscale output, account/node/peer identity, credentials, foreign Serve payloads, or thrown causes.
- Add one startup-maintenance coordinator that captures one validated startup cutoff, runs accepted-only audit orphan reconciliation before retention, then reduces both frozen results to the initial storage-health observation. Degraded/partial/unknown maintenance cannot initialize storage as ready.
- The service owns no poller, interval, timeout, process, listener, database, Tailscale command, retry, shutdown, route, or log. Overall startup, periodic observation, reconnect, and shutdown composition remain downstream.

## Hard Success Criteria

| Boundary | Required proof |
| --- | --- |
| Exact construction | Factory options, local/remote updates, startup ports, results, mutation proofs, clocks, source sequences, states, and reason arrays reject missing, extra, accessor, prototype-invalid, malformed, or contradictory values before state changes or port calls. Errors are stable, frozen, cause-free, and bounded. |
| Initial truth | Generation zero contains all seven components exactly once as `unknown/not_observed`, local readiness and mutation admission are closed, and remote availability is `unknown/not_observed`. No startup default claims healthy, disabled, or remotely ready. |
| Local reduction | The aggregate is ready only when all seven latest component observations are ready. Fixed precedence is failed, degraded, stale, unknown, then ready; every non-ready aggregate closes mutation admission and identifies only bounded component/reason codes. |
| Source ordering | Each component and remote health track an independent positive source sequence. Newer completion wins regardless of completion order; lower completion rejects without mutation; equal identical input returns the existing snapshot; equal different input rejects as a source conflict. Aggregate generations never regress, skip due to rejection/idempotence, or exceed safe integers. |
| Recovery truth | A ready observation with a newer source sequence clears the component's prior reasons in both internal and public state. Re-reading or advancing the clock cannot recover health. Failed, unknown, or stale updates cannot retain old ready fields, and successful recovery cannot retain a hidden error object/string. |
| Mutation race | Admission while non-ready rejects before dispatch. A proof admitted at ready validates only while the same local generation remains ready; any accepted local failure, stale/unknown transition, or even newer successful recheck invalidates the old proof. Invalid/copied/foreign proofs reject. |
| Remote independence | Disabled, stopped, signed-out, wrong-profile, missing/foreign/colliding/drifted/public Serve, stale, and failed remote observations update only remote generation/state. They never alter local generation, local component truth, local readiness, or a current local mutation proof. |
| Remote truth | Existing remote public schema invariants remain authoritative. Ready requires its current canonical origin and observation time; disabled/unavailable requires one bounded reason. An observer failure immediately clears ready origin/state-generation claims and remains unavailable until a later explicit successful observation. |
| Startup maintenance | One wall-clock value is captured as `eligible_before`, `reconciled_at`, and retention cutoff. Orphan reconciliation is invoked once before retention. Both are attempted only through exact injected ports; malformed results fail loudly. Storage is ready only when both scans report complete with no degraded reason/failure/actionable remainder. |
| Clock behavior | Initial and material updates use one injected wall clock. Throwing, invalid, or regressing time rejects atomically and cannot partially advance source or aggregate generation. Equal valid timestamps are permitted; snapshots expose ISO timestamps only. |
| Immutability/privacy | Service, proofs, aggregate snapshots, component entries, reason arrays, remote snapshots, and startup summaries are deeply frozen and detached from caller data. JSON/object-graph inspection finds no source payload, exception/cause, path, PID, session/device id, prompt/event data, profile key, raw origin on failure, or credential marker. |
| Exhaustion/failure | Source or aggregate generation exhaustion fails before mutation. Counter underflow, impossible state/reason pairs, clock failure, startup port contract failure, and mutation-proof mismatch have explicit errors; no fallback reports readiness or retries an observation/maintenance pass. |

## State Contract

- Local component states are `unknown`, `ready`, `degraded`, `stale`, and `failed`. `ready` has no reasons; every other reported state has one or more fixed reasons valid for that component. The factory-owned initial `unknown` reason is `not_observed`.
- Local aggregate state uses deterministic severity, but readiness and mutation admission are binary: only aggregate `ready` is ready/open.
- Remote availability is `unknown`, `disabled`, `ready`, or `unavailable`. Its public reason vocabulary reuses the selected remote-ingress contract plus only factory-owned `not_observed` for generation zero.
- Health aggregate generations and source sequences are process-memory concurrency controls. Durable remote state generation remains separately visible and is never rewritten by health.

## Validation Plan

- Direct table-driven state-machine tests for every component/state/reason pair, aggregate precedence, all-fresh recovery, repeated/idempotent updates, safe-integer exhaustion, deep freeze, and invalid/accessor/proxy inputs.
- Deterministic out-of-order completion tests with per-source sequences, equal-generation conflicts, fake wall-clock regression/failure/equality, and mutation proof invalidation before a fake dispatcher.
- Remote matrix using strict selected public states for disabled, ready, every stopped/profile/Serve/stale/failure reason, observer failure, recovery, and assertions that local snapshots/proofs remain byte-for-byte unchanged.
- Startup coordinator tests for exact cutoff reuse, orphan-before-retention call order, complete/degraded/partial/failure combinations, malformed port results, abort propagation, no retry, and storage-health reduction.
- Focused adjacent runtime reconciliation, compatibility, retention/orphan, fanout, listener, remote-ingress contract/control tests; full workspace suites; root/package typechecks; lint/exports; scaffold/planning; exact binding; install/supply-chain; diff/privacy/manual state review before closure.

## Explicit Non-Goals

- `IFC-V1-037` owns whole-application draining, pending outcome handling, cleanup deadlines, and shutdown order.
- `IFC-V1-039` owns liveness/readiness/status response schemas, authorization, HTTP status mapping, and routes.
- `IFC-V1-078` owns actual runtime/storage/listener/Tailscale polling and lifecycle composition, including observer scheduling and process cleanup.
- Existing route-level runtime/compatibility checks remain until downstream composition consumes the mutation-health proof; this leaf adds no parallel dispatch path and weakens no existing gate.
- Frontend state coordination and physical-phone/profile acceptance remain downstream.
