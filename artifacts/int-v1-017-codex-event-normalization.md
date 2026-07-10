# INT-V1-017 Codex Event Normalization And Ordered Projection

Date: 2026-07-10

## Outcome

- Added strict, generated-type-private parsing for all 17 reviewed Codex 0.144.0 notifications. The 612-frame evidence observes 16; `turn/plan/updated` is generated-only and covered by an exact fixture.
- Added full lifecycle normalization for all six observed item kinds: user message, agent message, plan, reasoning, command execution, and context compaction. Generated file/tool/review variants are shape-validated and content-redacted behind the same normalized item contract.
- Added a connection-generation state machine with monotonic sequence and clock, bounded thread/turn/item/request identity retention, duplicate/order/archive enforcement, and latched fatal failure.
- Added an early managed-identity gate. Valid unmanaged or already archived TUI threads produce only bounded thread-id/method/count observations; their payloads are neither deeply parsed nor retained.
- Added one bounded server pipeline that serializes raw notification admission, identity gating, managed normalization, durable mapping, production append, and post-commit publication. Later raw frames cannot normalize ahead of an earlier publisher.
- Added projection reduction for thread status/settings/name/archive, goal, plan, token usage, turns, messages, item activity, and request resolution. Runtime rate limits remain unscoped, and request resolution carries no invented decision.
- Extended the central resource policy to 60 fields with `protocol_max_pending_notifications`, owned by the Codex event pipeline and mapped through `codexResourceOptionsFromBudget`.

## Ordering Contract

1. Admit one decoded notification under the registry-owned pending-notification ceiling.
2. Reject unknown or spoofed-selected methods; count generated optional methods in bounded content-free diagnostics.
3. Extract only the selected method's bounded thread identity. Return an identity-only observation for an unmanaged or archived thread.
4. For a managed thread, strictly parse the exact required payload and advance the connection-local lifecycle state.
5. Re-resolve durable mapping. A classification/mapping disagreement is fatal and requires reconciliation.
6. Reduce exactly one bounded event and next session projection from the current full selected-state revision.
7. Append through `ProductionProjectionAppendPort`, which commits event and projection atomically and owns the next cursor.
8. Await post-commit publication before admitting the next normalization operation.
9. Capacity, managed parse/order/clock, projection, storage, or publication failure latches the pipeline stopped for that connection generation.

## Privacy And Truthfulness

- Command text/output/actions, file paths/diffs, reasoning, tool arguments/results/prompts/paths, internal hook/review content, and non-text user inputs are never emitted in normalized projection input.
- Conversation, goal, and plan text are bounded; truncation or omission sets an explicit content state and notice.
- Goal duplicate identity retains only a SHA-256-derived signature, not an extra objective copy.
- Optional diagnostics retain method/count only. Unmanaged observations retain method, bounded thread id, and count only.
- `account/rateLimits/updated` remains runtime scoped because it has no thread identity. Temporal proximity never assigns it to a session.
- `serverRequest/resolved` proves resolution only. Approval/denial and command outcome remain owned by `INT-V1-025` item/request correlation.
- Deprecated generated `thread/compacted` remains optional diagnostic noise. Compact proof requires the generated `contextCompaction` item variant and authoritative turn lifecycle; immediate request acceptance is not completion.
- A failed or interrupted terminal turn closes still-active item lifecycles without inventing item success. A successful terminal turn with active items is rejected. This matches the captured interrupt sequence where a command had no later `item/completed`.

## Hardening Findings

- The initial design made an ordinary unmanaged TUI thread fatal after deep parsing. Identity gating now occurs first, while a true managed-mapping race remains fatal.
- Normalization and projection were independently ordered, allowing raw normalization to run ahead of a blocked publisher. The assembled pipeline now serializes the full path.
- The first normalizer evicted terminal identities at capacity, permitting old duplicates to return as new. It now preserves identities and fails explicitly at bounded capacity.
- A successful-turn item invariant was initially applied to interruption. The real capture proved interruption may terminate while a command item remains active; terminal failure/interruption now closes that state honestly.
- Thread system-error, not-loaded, and pre-reconciliation archive projections initially remained marked current. They now become stale with a bounded reason.
- A test fixture represented generated `TurnItemsView` as an object. Exact 0.144.0 defines a string enum; schemas and fixtures now match the generated binding.
- Required opaque fields using `z.unknown()` could accept a missing key. Required-value checks and exact generated command/action/memory/file/dynamic/collaboration shapes close that hole.
- Compatibility still treated deprecated `thread/compacted` as compact capability evidence. It now uses compile-time `ThreadItem` `contextCompaction` variant evidence plus selected item-start/terminal-turn methods.
- The pending raw queue was initially local-only. Its ceiling now belongs to the central resource registry and has fail-stop overload evidence.

## Evidence Matrix

| Case | Evidence |
| --- | --- |
| Exact catalog | Binding surface equals the 17 required methods; deprecated compact is absent; exact 671-file identity passes. |
| Captured shapes | All 16 observed methods match exact top-level parameter fields across 612 valid redacted frames; generated-only turn-plan update uses a strict fixture. |
| Item coverage | Six observed item kinds normalize; sensitive command/reasoning/tool content is absent; malformed and missing required opaque fields fail. |
| Lifecycle | Two managed threads isolate; duplicate/overlap/unknown delta/token regression/post-archive/success-with-active-item fail; interruption closes active items. |
| Bounds | Clock regression, thread/turn/item/request identity capacity, optional-method cardinality, text truncation, and pending raw-queue capacity fail or degrade explicitly. |
| Unmanaged/archived | Malformed payloads with a valid unmanaged or archived identity return content-free observations and do not append. |
| Mapping race | Managed classification followed by missing durable mapping stops for reconciliation and writes nothing. |
| Projection | Status/waiting/freshness, model, goal, usage, plan, item/message, request resolution, interruption, and archive reductions validate through SQLite contracts. |
| Runtime scope | Rate-limit events return runtime observations and write to no session. |
| Commit order | Concurrent raw calls wait through prior post-commit publication; diagnostic/unmanaged sequence gaps do not affect contiguous storage cursors. |
| Failure | Duplicate sequence, late time, storage throw, publication failure, and pipeline overload stop later work; publication failure preserves the already committed row. |

## Validation

- Focused adapter binding/protocol/connection/normalizer: 54 passed.
- Focused selected contracts/core/fixtures: 27 passed.
- Focused storage/repository/projection/pipeline: 40 passed.
- Full storage: 14 files, 95 passed.
- Root and all-package typechecks: passed.
- Lint and package exports: 204 files and 9 packages passed.
- Unit: 465 passed, 19 explicit external tests skipped.
- Contract: 111 passed; integration: 16 passed; web: 14 passed.
- Scaffold: 9 packages and 18 root scripts.
- Planning: 196 tasks, 84 requirements, 622 dependencies, 12 queued before task advancement.
- Exact Codex 0.144.0 binding: 671 files, reviewed SHA-256 identity passed.
- Frozen offline install, production dependency audit, production license inventory, manual capture/schema/privacy/state review, and `git diff --check`: passed.

## Remaining Ownership

- `INT-V1-018` owns exact prompt/steer dispatch and event-gated active-turn targeting.
- `INT-V1-025` owns pending approval registration, exact decision response, expiry, and request/item outcome correlation.
- `INT-V1-027` owns live connection callback composition, runtime-health observation, transient managed-start claims, policy-option injection, and a real two-thread assembled proof.
- `INT-V1-028` and `INT-V1-029` own reconnect generation replacement, state seeding, gaps, stale projections, and durable continuity boundaries. A fresh normalizer is not claimed to reconstruct a mid-turn stream by itself.
- `DAT-V1-022` owns retention inside the production append transaction. `IFC-V1-018` owns replay/live fanout and recovery after unknown publication.
- Codex archive notification marks an unarchived HostDeck mapping stale/unknown; managed lifecycle reconciliation still owns the durable archived identity transition.
- The default installed Codex 0.144.1 remains intentionally incompatible. Only the isolated exact 0.144.0 binary satisfies this evidence.
