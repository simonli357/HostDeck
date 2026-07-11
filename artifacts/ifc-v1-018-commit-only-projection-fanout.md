# IFC-V1-018 Commit-Only Projection Fanout

Date: 2026-07-10

## Outcome

- `createProjectionFanoutHub` is a headless synchronous publisher that can be passed directly to the production projection append port.
- The hub accepts only an exact deeply frozen committed append whose event bytes, session identity, cursor, projection, and revision agree.
- Live subscribers are registered by exact session and unique subscriber id under the existing global/per-session SSE policy limits.
- The hub stores no events or queues. It retains only one observed cursor per session while that session has at least one subscriber, and removes the session state with the last unsubscribe.
- Fatal publication or sink-contract failure latches one bounded failure snapshot, clears every registration, and rejects later work without retry.

## Hard Success Criteria

| Criterion | Evidence |
| --- | --- |
| Commit-only composition | The real `createProductionProjectionAppendPort` accepts `hub.publish` directly. Its callback observes the event already present in SQLite. |
| Rollback exclusion | A forced SQLite `AFTER INSERT` abort leaves no durable event and invokes no fanout subscriber; the following valid append uses the unconsumed next cursor. |
| Exact committed shape | Deep freeze, exact top-level fields, strict event/projection schemas, recomputed UTF-8 byte length, session identity, retained range, projection cursor, revision cursor, and projection timestamp must agree. |
| No hidden idle state | A valid publication with no subscribers returns without creating a tracked session or retaining event/cursor history. |
| Live order | The first publication after session registration establishes the observed baseline. Every later publication while tracked must be exactly cursor +1. Duplicate, backward, and gap cases stop the hub. |
| Session isolation | Interleaved publications for two sessions preserve each cursor sequence and never cross-deliver. |
| Bounded registry | Defaults and overrides come from `sse_max_subscribers` and `sse_max_subscribers_per_session`; invalid, null, out-of-range, or contradictory limits reject at composition. |
| Exact subscription lifecycle | Invalid/extra fields, duplicate ids, global/per-session overflow, id reuse, stale unsubscribe handles, explicit unsubscribe, and idempotent close are deterministic and nonfatal where appropriate. |
| Dispatch snapshot | Subscribers removed before their turn do not receive the current event; subscribers added during delivery begin with the next event and receive the pre-publication observed high-water snapshot. |
| Sink contract | Every sink in the dispatch snapshot is attempted. Throwing, non-void, or thenable sinks stop the hub with a bounded failed-subscriber count and no automatic retry. |
| Reentrancy and close | Reentrant publication latches fatal degradation even when the sink catches the nested error. Close during delivery clears the registry and stops the remaining snapshot immediately. |
| Immutable delivery | Every delivered committed wrapper and nested event is frozen, so one subscriber cannot alter another subscriber's view. |

## Failure And Lifecycle Model

Nonfatal registration errors are `invalid_subscription`, `subscriber_exists`, `subscriber_limit`, and `subscriber_session_limit`. They do not alter existing subscriptions or poison the hub.

Fatal errors are malformed/contradictory publication, duplicate/backward/gapped live cursor, reentrant publish, and subscriber delivery contract failure. The hub records only code, session, cursor, and failed subscriber count; it retains no raw payload or thrown subscriber error. Fatal state clears subscriber/session maps and makes later publish/subscribe return `fanout_stopped`. Explicit close is separate, idempotent, and returns the number of registrations removed.

## Ownership Boundaries

- Storage remains the only durable commit, cursor assignment, retention, and replay-boundary owner.
- The hub does not import or call a repository, perform authorization, query high-water state, buffer events, frame SSE, create timers, or infer continuity after its last subscriber leaves.
- A synchronous subscriber return proves only handoff/queue admission, not browser delivery. The queue owner must prevent silent dropping and expose overflow/closure.
- No-subscriber publications are intentionally not remembered. `IFC-V1-034` registers before querying durable high-water so concurrent committed events enter its queue while replay is assembled.

## Validation

- Direct fanout matrix: 12 passed.
- Fanout plus production append and projection service: 38 passed.
- Full server suite: 27 files and 221 passed; 4 explicit external smokes skipped.
- Root and all 9 package typechecks: passed.
- Lint and package exports: 238 files and 9 packages passed.
- Unit: 636 passed, 25 explicit external tests skipped.
- Contract: 115 passed; integration: 16 passed; web: 14 passed.
- Scaffold: 9 packages and 18 root scripts.
- Planning: 196 tasks, 84 requirements, 626 dependencies, 8 queued.
- Exact Codex 0.144.0 binding: 671 files; SHA-256 `e1a1a5cff3ab91862f9215dd06538eae1ea0b00bae48cbb7d87061faaee27e24`.
- Frozen offline install, production dependency audit, manual import/state/failure review, and `git diff --check`: passed; no known vulnerabilities.

## Remaining Ownership

- `IFC-V1-034`: authenticate, register paused, query durable high-water, replay, drain, and switch live without gap or duplicate.
- `IFC-V1-035`: bounded event/byte queues, per-device limits, overflow/disconnect/revoke/archive cleanup.
- `IFC-V1-036`: mutable health projection consumes fanout/storage/runtime failures.
- `IFC-V1-037`: complete application drain and fanout/SSE shutdown deadlines.
- `IFC-V1-038`: aggregate replay/live/backpressure/recovery stream proof.
- `IFC-V1-091`: aggregate interface module hardening.
