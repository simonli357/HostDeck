# INT-V1-022 Structured Usage Control

Date: 2026-07-11

## Outcome

- `createCodexUsageClient` requires the connected exact `usage` capability and one positive stable connection generation, sends one read-only `account/usage/read` with no params, and performs no automatic retry.
- The adapter validates exact response/summary/bucket keys, nullable versus empty daily history, non-negative safe integers, real unique ascending calendar dates, internal summary consistency, one selected capture time, and a configured daily-bucket ceiling.
- `createCodexUsageControlService` validates one exact current selected session/thread before and after the account read. It returns one frozen account/thread/runtime snapshot or an explicit target/runtime/protocol/capacity error; no partial snapshot escapes a race or failure.
- Thread token/turn/context and runtime rate-limit observations are deep-frozen process-memory data from normalized events. They are isolated per thread, cumulative and ordered, bounded to 128 threads by default, evicted on archive, and cleared on connection-generation change.
- Account totals remain account-scoped. They are never allocated to a thread, converted into money, or combined with a null rate window to claim an unlimited quota.
- The exact no-model 0.144.0 smoke proves account usage read without `turn/started`, `thread/tokenUsage/updated`, or agent-message work. A no-model read does not itself trigger a rate notification; optional thread/rate fields therefore remain `not_observed` until same-generation runtime events arrive.

Implementation: `96d2ba5`. Recovery-target regression: `151c7f2`.

## Hard Success Criteria

| Criterion | Evidence |
| --- | --- |
| Exact capability/request | Unavailable usage capability rejects before request; disconnected/unknown compatibility rejects; the valid call is exactly `account/usage/read`, `params: undefined`, `kind: read`, selected timeout, and unchanged signal. |
| Stable generation | Generation validates before dispatch and after response. A changed or invalid generation rejects without retry or a snapshot. |
| Account payload | Top-level, summary, and bucket keys are exact. Null and empty bucket collections remain distinct; overflow rejects before normalization. |
| Numeric integrity | Every counter must be a non-negative safe integer, so JSON-rounded large totals fail instead of being reported approximately. Summary streak/peak/lifetime and daily-peak contradictions reject. |
| Calendar/order | Dates require exact `YYYY-MM-DD` round-trip calendar validity; duplicates, descending order, and impossible dates reject. |
| Resource bounds | `protocol_usage_max_daily_buckets` defaults to 2,000 with a reviewed 10,000 ceiling; `control_usage_max_tracked_threads` defaults to 128 with a 4,096 ceiling. Both are part of the frozen selected policy and mapped explicitly. |
| Target integrity | Missing, mismatched, recovery, archived, stale, runtime-version-changed, and archive-during-read targets reject. Initial target failures perform no runtime call. |
| Observation ownership | Only normalized token/rate/archive events affect usage memory. Unknown/unmanaged token events store nothing; two threads never cross-read. |
| Ordering/capacity | Repeated/backward sequence/time or any cumulative token component regression rejects. Capacity rejects a new thread without evicting accepted state. |
| Reconnect/archive | Active generation change clears every thread and rate observation before rejecting a stale callback. Archive deletes only the exact thread. Restart/read with no current observations is explicit `not_observed`. |
| Failure mapping | Unsupported, malformed protocol, overload, timeout/unavailable, invalid generation, and selected-state failure map to stable bounded control errors without partial data. |
| Read-only behavior | Repeated reads are deterministic, issue one account read each, and never start/steer/interrupt a turn, mutate selected state, write audit success, scan history/files, or parse terminal text. |
| Privacy | Synthetic tests use invented totals. The exact smoke checks only types/count bounds and method names; no account values, account identity, credential, path, or monetary estimate is retained. |

## Runtime Evidence

- Exact reviewed runtime: `codex-cli 0.144.0`; generated binding SHA-256 `e1a1a5cff3ab91862f9215dd06538eae1ea0b00bae48cbb7d87061faaee27e24`.
- The no-model smoke opened one private Unix socket, completed compatibility, read account usage, observed no model/thread work, closed the connection/process, and removed the temporary socket directory.
- The first live probe established that account read does not emit a rate update by itself. The test/criteria were corrected to preserve `not_observed`, then the exact smoke passed repeatedly.
- Existing redacted `INT-V1-006` captures remain the real-turn source for `thread/tokenUsage/updated` and `account/rateLimits/updated`: 612 bounded frames total, with values, ids, account identity, prompts, and paths excluded from retained evidence.

## Validation

- Direct usage contract: 6 passed; adapter: 7 passed; control state/race: 10 passed.
- Adjacent resource mapping, event normalization, and redacted semantic-evidence matrix: 23 passed.
- Exact no-model 0.144.0 usage smoke: 1 passed repeatedly.
- Unit: 703 passed; 26 explicit external tests skipped.
- Contract: 121 passed; integration: 16 passed; web: 14 passed.
- Root/all-package typecheck and lint/package exports: 251 files and 9 packages passed.
- Scaffold: 9 packages and 18 root scripts.
- Planning: 196 tasks, 84 requirements, 628 dependencies, and 5 queued tasks.
- Frozen offline install, production audit with no known vulnerabilities, exact binding check, manual scope/generation/privacy review, and `git diff --check`: passed.

## Remaining Ownership

- `IFC-V1-043` owns authenticated read-only API/CLI mapping and public unsupported/stale/error envelopes.
- `FE-V1-028` owns the approved mobile usage surface and loading/empty/not-observed/stale/failure presentation.
- `INT-V1-027` wires normalized generation-tagged token/rate/archive events and the account client into the structured production vertical.
- `INT-V1-029` owns selected projection/runtime reconciliation after restart; usage observations intentionally restart empty rather than being inferred.
- `INT-V1-091` re-runs aggregate runtime hardening after compact, skills, assembly, supervision, reconnect, and restart leaves.
