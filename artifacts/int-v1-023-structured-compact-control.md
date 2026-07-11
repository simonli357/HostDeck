# INT-V1-023 Structured Compact Control

Date: 2026-07-11

## Outcome

- `createCodexCompactClient` requires the available exact `compact` capability and one positive stable connection generation. It validates one exact operation/thread input, sends exactly one `thread/compact/start` mutation with only `{ threadId }`, accepts only the exact empty response, and never retries.
- A valid response produces one frozen accepted result with no turn id. Malformed post-send response/time, connection-generation change, or other possible-send ambiguity is an unknown outcome rather than permission to retry.
- `createCodexCompactControlService` requires literal confirmation, one current writable exact-version managed target, a proven terminal turn state, per-session serialization, and the frozen `control_compact_max_tracked_operations` bound.
- Progress remains `accepted` through a candidate `turn/started`. It becomes `running` only after the same-generation matching `contextCompaction` item starts, remains running after item completion alone, and becomes `completed` only when that exact item and turn both complete.
- Matching turn interruption/failure, archive, generation loss, missing lifecycle evidence, malformed order, or contradiction remains explicit `interrupted`, `failed`, or `incomplete`. Deprecated `thread/compacted`, elapsed time, terminal text, and slash injection never advance progress.
- Exact runtime discovery corrected one false usage invariant: during compaction, bounded `last` usage is independent of the post-compaction `total`. One cumulative baseline reset is allowed only on the exact ordered turn after its compaction item starts; ordinary, repeated, pre-item, stale-generation, and post-terminal regressions still fail.

Criteria: `7de375e`. Runtime-discovery correction: `5c625be`. Implementation: `415f2bc`.

## Hard Success Criteria

| Criterion | Evidence |
| --- | --- |
| Exact capability/request | Unsupported or disconnected compatibility and invalid generation reject before wire. The valid request is one mutation `thread/compact/start`, exact `{ threadId }`, selected timeout/signal, and no operation-id leakage. |
| Exact response | Only a plain empty object is accepted. Extra/missing/non-object response, invalid post-send clock, target drift, or generation drift is an unknown outcome with one wire attempt. |
| Target policy | Missing, mismatched, archived, recovery, stale, wrong-version, active/unknown-turn, malformed confirmation, and invalid signal reject before wire. |
| Accepted-only truth | The response returns `accepted`, `turn_id: null`, and no context-reduction claim even when all lifecycle notifications race the response. |
| Running proof | Ordered same-generation `turn/started` plus exact `item/started: contextCompaction` binds one turn/item. A turn start alone remains accepted-only. |
| Completion proof | Exact item completion alone remains running. Only the same `turn/completed: completed` after item completion produces `completed`. |
| Terminal honesty | Interrupted and failed turns remain distinct. Completed turns with missing item completion, archive, generation loss, or missing/contradictory identity remain incomplete. |
| Unknown outcome | Possible-send timeout or malformed acceptance latches incomplete and blocks duplicate dispatch. Later exact lifecycle events may reconcile it; known not-sent/remote rejection leaves no accepted record. |
| Ordering/isolation | Duplicate/backward sequence/time, pre-turn item, changed item/turn, second turn, stale generation, and same-turn post-terminal events reject. Two threads never cross-progress. |
| Resource bound | `control_compact_max_tracked_operations` defaults to 128 with a reviewed 4,096 ceiling. Active/unknown records are not evicted; terminal records alone are capacity-evictable. |
| Usage reset scope | `last` and `total` breakdowns remain individually safe and internally consistent. Independent last values and one cumulative reset require exact compaction-item evidence on the same active turn. |
| No fallback | No automatic retry, auto-interrupt timer, deprecated notification, slash injection, terminal parsing, arbitrary filesystem scan, or inferred success exists. |
| Privacy/cleanup | Synthetic tests use invented ids/totals. Real evidence retains only version/hash, method/state/count relations, and cleanup result; no prompt, raw frame, account value, credential, id, or path is retained. |

## Runtime Evidence

- Exact reviewed runtime: `codex-cli 0.144.0`; generated binding SHA-256 `e1a1a5cff3ab91862f9215dd06538eae1ea0b00bae48cbb7d87061faaee27e24` across 671 files.
- Repeated authenticated smokes used one owner-private temporary Codex home/socket and two isolated temporary Git repositories/managed threads.
- Each passing run observed one immediate empty compact response, one new turn, one context-compaction item start/completion, one independent compact token-usage update, and authoritative `turn/completed: completed` for thread A. Thread B emitted no turn lifecycle.
- The first implementation smoke failed closed on the old `last <= total` invariant after the real compact token update. No value was retained. The invariant was narrowed to exact compaction scope, direct reset/repetition/ordinary-turn tests were added, and repeated unchanged real smokes then passed.
- The final smoke routed the same normalized sequence through compact, interrupt, and usage controls, read a valid structured usage snapshot, observed no protocol issue or server request, archived both temporary threads, closed the connection/process, and removed all temporary state.
- The bounded unresolved branch remains exercised deterministically: once a compact item exposes its exact turn, the separate interrupt control may issue one exact interrupt; timeout itself never claims success or triggers an automatic interrupt.

## Validation

- Direct focused matrix: 71 tests across compact adapter/control, event normalizer, usage control, resource mapping, projection, and interrupt controls.
- Direct compact/usage/resource contract matrix: 16 tests; compact-specific contract: 4, adapter: 6, control state/race: 12.
- Exact authenticated 0.144.0 compact plus usage-control smoke: 1 passed repeatedly after the scoped runtime correction.
- Unit: 724 passed; 27 explicit external tests skipped.
- Contract: 125 passed; integration: 16 passed; web: 14 passed.
- Root and all 9 package typechecks passed. Lint/package exports checked 257 files and 9 packages.
- Scaffold reported 9 packages and 18 required root scripts. Planning reported 196 tasks, 84 requirements, 630 dependencies, and 5 queued tasks before closure; the owner-doc closure recheck passed with 4 queued tasks.
- Frozen offline install, exact binding regeneration check, production audit with no known vulnerabilities, manual state/order/privacy/fallback inspection, and `git diff --check`: passed.

## Remaining Ownership

- `INT-V1-024` owns the remaining structured skills utility.
- `INT-V1-027` wires compact, usage-reset markers, normalized events, audit, and the other proven controls into the production callback vertical.
- `IFC-V1-064` owns the authenticated confirmed compact API/CLI route and public progress/error mapping.
- `FE-V1-029` owns the approved mobile accepted/running/completed/interrupted/failed/incomplete compact surface.
- `INT-V1-029` owns restart reconciliation for unresolved compact progress; no restart inference is added here.
- `INT-V1-091` re-runs aggregate runtime hardening after skills, assembly, supervision, reconnect, restart, and legacy disposition.
