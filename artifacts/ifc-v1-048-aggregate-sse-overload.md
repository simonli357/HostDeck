# IFC-V1-048 Aggregate SSE Overload Hardening

Date: 2026-07-16
Status: criteria frozen; implementation in progress

## Objective

Harden the selected projection SSE path so subscriber admission, replay and live retention, heartbeat writes, burst publication, reconnect attempts, revocation, and shutdown remain bounded as one resource system. One stalled client must not block publication or consume another admitted client's slot except through the explicit global, device, or session admission policy.

Requirement refs: `NFR-010`, `NFR-011`, `SFR-013`, `SFR-017`.

## Ownership Audit

- The resolved resource policy already defines global, paired-device, and session subscriber caps; per-subscriber replay event/byte caps; per-subscriber live queue event/byte caps; one event cap; heartbeat cadence; and disconnect/shutdown deadlines.
- `createProjectionSubscriberStreamService` already reserves admission before source work, keeps fanout delivery synchronous, closes only an overflowing subscriber, and releases queue, device, session, source, and abort ownership on terminal paths.
- The replay/live handoff bounds its replay snapshot, but the returned live handoff and subscriber stream both retain the full replay array after activation. Consuming replay advances an index without releasing either reference. Existing aggregate snapshots count live queues only, so a replay-heavy reconnect storm can retain memory that inspection reports as zero.
- The pinned `@fastify/sse` event pipeline uses Node stream backpressure. Its heartbeat interval writes directly to the raw response and ignores a `false` return, however, so a stalled idle response can accumulate heartbeat writes and per-tick pressure outside the bounded projection queue.
- Browser reconnect timing and offline UX are frontend owners. This leaf owns server-side admission and cleanup for every attempted connection, including rejected attempts; it does not add automatic retry, fairness scheduling, or client eviction.

## Derived Resource Ceilings

For one resolved policy, let `S` be `sse_max_subscribers`, `D` the per-device cap, `P` the per-session cap, `Qe/Qb` the live queue event/byte caps, and `Re/Rb` the replay event/byte caps.

| Scope | Maximum retained projection events | Maximum retained framed bytes |
| --- | ---: | ---: |
| One subscriber | `Re + Qe` | `Rb + Qb` |
| One paired device | `D * (Re + Qe)` | `D * (Rb + Qb)` |
| One session | `P * (Re + Qe)` | `P * (Rb + Qb)` |
| Whole service | `S * (Re + Qe)` | `S * (Rb + Qb)` |

All products must remain safe integers under the accepted resource policy. Live events delivered directly to one pending read are not retained. The transport may have only the existing stream pipeline buffering plus at most one blocked heartbeat write per response; timer ticks while that heartbeat is blocked must not enqueue another heartbeat or listener.

## Hard Success Criteria

| Boundary | Required proof |
| --- | --- |
| Replay ownership | Replay transfers exactly once from the paused handoff to the subscriber stream before live activation. The handoff drops its event-array reference immediately; repeated claims fail. Each yielded replay event decrements retained event/byte totals, the final yield drops the stream's array reference, and close/failure drops any unconsumed suffix. |
| Exact accounting | Frozen stream inspection exposes initial replay count plus current remaining replay and live queue counts/bytes. Frozen service snapshots expose current and peak replay, live queue, and combined retained totals without payload, identity, or cause. Every add/remove is exact, nonnegative, safe-integer, and checked against the derived service ceiling. |
| Admission | Unique-id, global, paired-device, and session caps remain synchronous and deterministic. Rejected reconnect attempts perform no handoff open and retain no subscriber, bucket, queue, replay claim, timer, authority lease, or abort listener. Released capacity is immediately reusable without evicting an admitted peer. |
| Burst isolation | A burst that overflows stalled readers remains synchronous at fanout, closes only those readers once, and clears their complete replay/live accounting. Healthy readers across the same and different sessions continue receiving the exact contiguous sequence; the fanout remains healthy. |
| Heartbeat backpressure | The pinned SSE heartbeat writes once when writable. After a `false` write it permits no further heartbeat write or additional drain/error/close listener until the exact blocked write drains or the response closes. Drain permits one later heartbeat; disconnect, source close, revoke, and shutdown remove the timer and blocked-write listeners once. |
| Reconnect storm | Repeated replay-heavy opens, over-cap rejections, partial replay consumption, disconnects, and replacements never exceed the global/device/session or derived retained-memory ceilings. After every cycle, current replay/live/combined totals and active buckets return to the expected baseline while monotonic peaks/counters remain truthful. |
| Revoke and shutdown | Revoking one paired device closes all of its active streams without touching unrelated local/paired streams. Service/application close settles pending reads, closes every handoff/response, clears replay/live totals and authority registrations, and leaves zero active subscriber/device/session buckets even when clients are stalled. |
| Failure containment | Malformed replay claims, count/byte contradictions, oversized events, counter inconsistency, source failure, observer failure, and cleanup throw fail closed. No private event content, token, cookie, source, device id, session id, request id, or raw cause enters snapshots, bounded failure observations, or the artifact. |
| Dependency control | Any heartbeat correction is an explicit pnpm patch against exact `@fastify/sse` 0.5.0, covered by a regression test and frozen-lockfile reinstall. No unreviewed dependency upgrade or alternate streaming stack is introduced. |

## Validation Plan

- Deterministic service matrix: exact replay claim, full/partial/zero replay consumption, queue boundary/overflow, derived ceiling arithmetic, malformed claim/accounting, repeated close, and frozen privacy-safe snapshots.
- Multi-client stress: healthy and stalled readers across device/session buckets, burst publication, exact sequence isolation, over-cap reconnect attempts, capacity reuse, peak counters, and zero current retained totals after each teardown cycle.
- Real transport matrix: paused raw client, simulated blocked heartbeat with no per-tick write/listener growth, drain recovery, disconnect, multi-stream paired-device revoke, and active service/application shutdown.
- Leak inspection: exact handoff claim/ref release, remaining replay/live/combined counters, subscriber/device/session/source/authority registrations, abort/drain listeners, timers, in-flight requests, sockets, active handles, and process/temp residue.
- Focused and adjacent tests, all workspace suites, root/package typechecks, lint/exports, scaffold/planning/runtime-boundary, exact Codex 0.144.0 binding, frozen offline install, production audit/license inventory, diff/privacy inspection, commit, and push.

## Explicit Non-Goals

- No frontend EventSource retry cadence, offline banner, reconnect cursor UX, mobile screen, or physical-phone acceptance is implemented here.
- No production route assembly, Tailscale profile/Serve lifecycle, health route, static build, package/service unit, or release claim is added.
- `IFC-V1-038` remains the aggregate fanout/health/reconnect/shutdown acceptance owner; `IFC-V1-052` remains the aggregate HTTP/SSE/mutation/CLI stress owner; `IFC-V1-078` and `IFC-V1-079` remain remote lifecycle and physical Android owners.
