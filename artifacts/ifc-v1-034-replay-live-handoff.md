# IFC-V1-034 Replay-To-Live High-Water Handoff

Date: 2026-07-11

## Outcome

- `createProjectionReplayLiveHandoffService` is the strict headless owner for synchronous read authorization, paused fanout registration, durable replay capture, and the atomic switch to direct live delivery.
- Open validates exact input before registration, registers before reading durable high-water, and removes its token on denial, abort, malformed state, replay failure, fanout loss, or capacity failure.
- Replay is immutable and bounded by the selected SSE event, event-count, and exact framed UTF-8 wire-byte limits. The wire-byte calculation is shared with the selected Fastify SSE source.
- A retention boundary may replace an invalidated replay prefix. A final durable-position check detects boundaries that advanced behind the current page and retries from the client cursor; only the newest boundary survives. Thirty-two changing snapshots are the explicit livelock ceiling and fail as `replay_limit`.
- Committed events captured during open stay under queue event/wire-byte limits. Events at or below captured high-water are removed only when they exactly match durable replay or are superseded by its boundary; events above high-water must be exact cursor +1.
- The frozen paused handle exposes immutable replay/high-water diagnostics, idempotent close, and one `activate` call. Activation drains dynamically arriving committed events once before direct live mode. A throwing, non-void, or thenable sink fails only that handoff and never throws through the shared fanout callback.

Implementation: `cf7b88a`.

## Hard Success Criteria

| Criterion | Evidence |
| --- | --- |
| Admission order | Exact service/open keys, session/cursor/subscriber id, real `AbortSignal`, and synchronous authorization validate before `subscribe`; denial and pre-open abort perform no fanout or storage read. |
| Register before high-water | Deterministic hooks publish one committed event during `require` and another during replay. The first is matched and removed from replay duplication; the second remains queued above the fixed high-water. |
| Durable state rejection | Missing, archived, future-cursor, malformed projection, malformed replay, storage failure, and fanout-ahead-of-storage paths reject explicitly and leave no handoff token. |
| Replay bounds | Every event uses the same exact SSE framing byte count as transport. Per-event, aggregate event-count, and aggregate wire-byte overflow each reject before a handle is returned. |
| Retention race | Two retention advances, including one hidden behind the current page cursor, force a restart and yield exactly one newest boundary followed by contiguous events through captured high-water. |
| Validated de-duplication | A captured committed event must deep-equal its durable replay event unless the newest boundary supersedes that cursor. Contradictory content rejects instead of being silently dropped. |
| Temporary queue | Event-count, aggregate wire-byte, and per-event overflow self-unsubscribe from inside the callback while the real shared hub remains healthy and receives only a `void` return. |
| Live continuity | Events queued after high-water, events arriving before activation, and an event published synchronously from a drain sink are delivered exactly once in cursor order before direct live delivery. |
| Sink isolation | Throwing, non-void, and rejected-Promise sinks fail with cursor diagnostics. Direct-live failure removes only that handoff; a peer subscriber receives the same publication and the hub does not fail. |
| Lifecycle | Abort before registration, during registration, during paged replay, and after open all clean up. Invalid, repeated, reentrant, close-during, close-after, and fanout-loss activation states are deterministic. |
| Multi-client isolation | Two same-session clients and one second-session client receive only their committed session events. A third same-session client rejects at the real fanout cap without disturbing existing handles. |
| Real storage path | A migrated SQLite repository replays cursor 2 after cursor 1, activates, commits cursor 3, and delivers cursor 3 directly through the real fanout. |

## State And Failure Inspection

- Open owns one temporary subscription token. Cleanup is attempted even when abort occurs inside `subscribe` before the returned token is assigned.
- Callback parsing, wire sizing, queue admission, duplicate validation, sink delivery, unsubscribe, and failure capture cannot throw into `ProjectionFanoutHub.publish`.
- The handle is `paused`, `live`, `failed`, or `closed`; internal `opening` and `activating` states are never exposed as false live readiness.
- Failure snapshots contain only code and cursor. Authorization values, event content, storage errors, and sink errors are not retained in public diagnostics.
- Manual raw-order review confirmed: authorize -> subscribe -> durable high-water -> replay -> duplicate normalization -> paused handle -> dynamic drain -> direct live.

## Validation

- Direct handoff state/race/property matrix: 17 passed.
- Adjacent fanout, SSE transport, selected-state repository, and production append matrix: 53 passed.
- Unit: 686 passed; 25 explicit external tests skipped.
- Contract: 115 passed; integration: 16 passed; web: 14 passed.
- Root/server typechecks and lint/package exports: 245 files and 9 packages passed.
- Scaffold: 9 packages and 18 root scripts.
- Planning: 196 tasks, 84 requirements, 626 dependencies, 6 queued after closure.
- Exact Codex 0.144.0 binding: 671 files; SHA-256 `e1a1a5cff3ab91862f9215dd06538eae1ea0b00bae48cbb7d87061faaee27e24`.
- Frozen offline install, production audit with no known vulnerabilities, manual token/state/failure/order review, and `git diff --check`: passed.

## Remaining Ownership

- `IFC-V1-035` owns sustained subscriber queues, per-device limits, revoke/archive-after-open checks, SSE route/source composition, and slow-client closure policy.
- `IFC-V1-036` owns startup/runtime health composition around storage, projector, fanout, retention, and orphan reconciliation.
- `IFC-V1-037` owns complete application drain and stream/fanout shutdown deadlines.
- `IFC-V1-038` owns aggregate replay/live/backpressure/recovery acceptance.
- `IFC-V1-091` re-runs production interface hardening after the remaining security, route, resource, package, and service leaves.
