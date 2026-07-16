# INT-V1-029 Runtime Crash Reconciliation

Date: 2026-07-16

Status: complete. Criteria `5ddde3e`; implementation `7f829cc`.

## Scope

Implement one headless lifecycle composition for the `INT-V1-028` reconnect controller. It must persist honest disconnect truth, reconcile every durable managed mapping through read-only exact-runtime calls, replace an unrecoverable retained-event interval with one explicit continuity boundary, resubscribe exact surviving threads, read back model state, rehydrate only provable committed collaboration settings, and publish mutation readiness only after local event work drains. It must never create, fork, import, archive, start, steer, interrupt, approve, retry, or otherwise mutate a Codex thread.

Service-owned app-server/HostDeck multi-process restart proof remains `INT-V1-030`; laptop TUI coexistence remains `INT-V1-031`; aggregate lifecycle acceptance remains `INT-V1-032`; startup/Fastify health and shutdown composition remain `IFC-V1-036` to `IFC-V1-038`.

## Pre-Change Findings

- `ManagedCodexThreadService.reconcile()` is not a valid reconnect lifecycle input. It can resume incomplete session-start recovery through materialization mutations, has no connection-generation contract, does not persist an event-gap boundary, and admits partial per-session issues without a final readiness barrier.
- The reconnect controller now provides strict generation-scoped `reconcile`, `resubscribe`, and `ready` leases, but no production lifecycle implementation consumes them.
- Selected projections persist `model` but not the exact committed collaboration mode, reasoning effort, or settings observation time. The current projected settings event retains those values only in display text. Parsing that text would violate the structured-boundary rule and cannot survive retention safely.
- `ProductionProjectionAppendPort` can append a replay boundary only to an empty retained window. It cannot represent a disconnect after existing events without violating the rule that the one visible boundary must be the first retained event.
- Runtime thread list/read and model read-back are strict separately, but there is no bounded latest-turn reader or reconnect-only composition that proves thread/cwd/source/archive/status/turn/model identity without exposing mutation methods.
- Accepted-only audit reconciliation is durable and append-only under `DAT-V1-030`, but reconnect/startup lifecycle does not invoke it at the point where the write gate has closed and a remote outcome became unknowable.
- Approval, projection, model, Plan, and event-pipeline process state have independent observers. No owner currently orders approval supersession, durable disconnected publication, orphan-audit completion, boundary replacement, thread inspection, resume, held-event drain, settings rehydration, and final ready publication.

## Frozen Architecture

- Add a server-owned runtime reconciliation lifecycle that implements the exact `CodexReconnectLifecyclePort`. It retains only bounded plain cycle facts; generation-scoped runtime ports never escape their callback.
- Add a reconnect-only adapter read client over the controller's restricted runtime lease. It exposes bounded active/archived thread listing, exact thread read, latest-turn read, goal read, and exact `thread/resume` state. Generated protocol types and raw payload parsing remain adapter-private.
- Add a durable structured settings snapshot to each selected session projection: exact `collaboration_mode`, `runtime_model`, nullable `reasoning_effort`, and `observed_at`. A forward-only migration adds nullable JSON storage, preserves every existing row byte-for-byte outside the new column, and maps historical absence to unknown.
- Normalized `thread/settings/updated` projection commits the structured settings snapshot in the same event/projection transaction as the existing model cue. Projection validation requires its runtime model to equal the public model cue and its observation time not to exceed the projection revision.
- Add a production continuity-boundary port backed by one immediate SQLite transaction. It computes the next monotonic cursor, deletes the prior retained window, inserts one `replay_boundary` with `after` equal to the prior durable cursor floor, commits the supplied reconciled session state, and resets retained aggregates to exactly that boundary. Post-commit publication retains the existing committed-but-publication-unknown contract.
- Add a Plan control rehydration port that reads only the current durable structured settings snapshot for the exact selected target. It publishes confirmed mode only when reconciliation preserved a matching model/effort read-back; missing, historical, stale, contradictory, archived, or mismatched state clears to explicit unknown.

## Lifecycle Order

### Disconnect Or Initial Restart Gap

1. The reconnect controller has already synchronously closed request admission.
2. Validate the lost generation/deadline and supersede exactly that generation's pending approvals without sending a response.
3. Freeze an audit cutoff strictly after the last possible admitted write and reconcile all accepted-only selected operation trails before that cutoff to `incomplete/runtime_unavailable`. A degraded, partial, aborted, timed-out, or failed orphan pass prevents runtime readmission.
4. Append one durable `runtime: disconnected` event per unarchived selected session, preserving prior active-turn evidence while setting freshness/attention/reason truth that blocks writes. Publication failure is not relabeled as no commit.
5. Initial HostDeck startup with existing unarchived mappings runs the same gap preparation with reason `restart`; an empty or archived-only state has no synthetic gap.

### Read-Only Reconcile

1. Construct fresh read-only thread/goal/latest-turn clients from the current generation lease and enumerate both active and archived bounded pages.
2. Re-read every durable managed thread exactly; never use operation-marker discovery to import or create a mapping. Unmanaged runtime threads are counted and ignored without content exposure.
3. Resolve each mapping through the frozen state matrix below. A mapping/storage/protocol/capacity failure is explicit; one stale session may remain isolated while other exact mappings reconcile.
4. Replace each affected unarchived session's retained window with one `disconnect` or `restart` boundary before any resume call. A crash after a committed boundary but before ready cannot silently claim continuity or duplicate retained pre-gap events.
5. Return global `boundary_required` whenever any unarchived durable mapping crossed an unobservable interval; otherwise return `continuous`.

### Resubscribe And Ready

1. Resume each recoverable unarchived exact thread once with `thread/resume { threadId, excludeTurns: true }`; no model/cwd/config override is sent. Validate returned thread id, cwd, empty turns, model, effort, and fixed response shape.
2. Persist returned model/effort. Preserve the prior committed collaboration mode only when its structured settings model and effort agree exactly; otherwise clear the structured settings snapshot and expose mode as unknown.
3. Resume does not prove a turn result. Held notifications/server requests remain generation-gated by the reconnect controller and flow through the selected pipeline/approval service.
4. The ready callback waits for an injected same-generation event-pipeline barrier, re-reads durable session truth, rehydrates Plan state from the surviving structured settings projection, and appends one runtime-ready event only for exact recoverable mappings.
5. Only after every required local persistence/publication/barrier/rehydration step succeeds may the reconnect controller publish its admitted generation.

## Reconciliation State Matrix

| Durable/runtime observation | Required durable result |
| --- | --- |
| Exact active thread plus latest `inProgress` turn | Preserve active work and exact waiting flag; remain non-current until resume and ready complete. |
| Exact idle thread after a previously active/waiting projection, with no matching terminal notification | Persist `interrupted` with explicit gap reason; never invent completed or failed. |
| Exact idle thread plus latest completed/interrupted/failed turn | Persist that terminal category; a failed turn keeps only bounded safe failure truth available from the strict adapter. |
| Exact idle thread with no turn history | Persist idle. |
| Runtime-active thread with missing/terminal latest turn, or runtime-idle thread with contradictory identity | Mark stale/unknown and block that session; do not guess or retry. |
| Runtime reports archived for an active durable mapping | Persist archived identity and terminal/non-active projection; never issue resume. |
| Durable archived mapping appears active again | Keep durable archive immutable and mark the contradiction explicit; never unarchive. |
| Missing thread, wrong cwd, unsupported source, duplicate list identity, or changed thread id | Mark recovery required/stale where identity is safely attributable; malformed or duplicate runtime truth fails the cycle. |
| `notLoaded`, `systemError`, unavailable read, or generation change | Stay stale/unknown or fail the cycle according to whether exact per-session truth was obtained; never report ready from persistence alone. |
| Structured settings absent or runtime model/effort contradicts it | Current collaboration mode is unknown. |
| Structured settings match exact resumed model/effort | Rehydrate that committed `default`/`plan` mode with its original observation time. |

## Hard Success Criteria

| Area | Required evidence |
| --- | --- |
| Construction | Exact plain options, required repository/boundary/audit/approval/Plan/barrier ports, strict clock, reviewed adapter limits, no accessors/extra keys, and no mutation-capable lifecycle port. |
| Settings durability | Migration fresh/upgrade/reopen/rollback/corruption tests; structured event-to-projection atomicity; historical null; model/effort/mode/time agreement; no display-text parsing. |
| Boundary durability | Empty/nonempty/retained/pruned windows; exact cursor floor and `after`; one first retained boundary; aggregate reset; later append/replay; rollback; publication unknown; restart idempotency; cursor exhaustion. |
| Disconnect | Admission is already closed; approval supersession, audit incompletion, and durable disconnected events occur in fixed order; active evidence is not prematurely relabeled terminal. |
| Audit | Strict-after cutoff includes every pre-gap accepted write and no post-gap write; incomplete is append-only; partial/degraded result blocks ready; repeated/reopened pass is idempotent. |
| Identity | Active/archived pagination, exact read, cwd/source/id/version/archive checks, unmanaged ignore, missing/duplicate/malformed/capacity/race handling, and no thread creation/import/mutation. |
| Turn truth | Active, idle, waiting, completed, interrupted, failed, missing history, stale in-progress history, contradictory runtime status, and two-thread isolation follow the state matrix. |
| Resubscribe | Exactly one no-override resume per recoverable unarchived thread; strict response/cwd/model/effort checks; archived/stale/missing threads are not resumed; generation loss prevents later steps. |
| Settings rehydration | Matching structured projection rehydrates mode; missing/historical/pruned/archived/stale/model/effort/target contradictions remain unknown; pending process-only intent is never recreated or dispatched. |
| Ready barrier | Held event work drains before local ready state; callback/storage/publication/barrier/rehydration failure blocks controller admission; repeated and stale callbacks conflict explicitly. |
| Cancellation | Deadline/abort before and during audit, list/read/goal/turn/resume, publication, and barrier stops remaining work without extending the controller deadline or retaining runtime leases. |
| Observability/privacy | Frozen bounded cycle result/snapshot includes generation, continuity, counts, and reason codes only; no cwd, thread/session/turn/request id, goal text, model value, raw payload, error cause, audit target, or approval content. |
| Ownership | No process restart, service-mode continuity proof, TUI coexistence, Fastify readiness, SSE recovery, UI, phone, package, or release claim. No dependency change. |

## Validation Plan

- Contract/storage tests cover the structured settings migration/projection and atomic continuity-boundary transaction against real SQLite, including upgrade, rollback, retention, reopen, corruption, and publication uncertainty.
- Adapter tests cover exact generated-shape pagination/read/latest-turn/goal/resume parsing, all status combinations, malformed/oversized/duplicate/cursor/identity responses, deadline signals, and structural absence of mutation methods.
- Direct fake-clock lifecycle tests cover disconnect/startup, every state-matrix row, two sessions plus unmanaged threads, audit ordering, one boundary, resume/ready order, barrier races, generation changes, cancellation, partial failure, repeated callbacks, and privacy.
- A headless integration composes the real reconnect controller, request broker, selected SQLite repository/append/boundary ports, approval service, Plan service, and scripted transport. It proves accepted audit incompletion, running/idle interruption truth, pending approval supersession/re-registration, boundary replay, exact resume, model/mode reconciliation, held-event drain, and final write admission without a model call.
- Run focused adapter/server/storage/contract tests; full unit/contract/integration/web suites; root and all-package typechecks; lint/exports; scaffold/planning; migration checksums; frozen offline install; exact 0.144.0 binding, no-model compatibility, Unix IPC and bounded restart smoke where feasible; production license/audit checks; diff/secret/active-handle inspection; and manual order/no-mutation/privacy review.

## Downstream Ownership

- `INT-V1-030` proves service-owned app-server work survives a HostDeck-only multi-process restart and foreground ownership behaves oppositely.
- `INT-V1-031` proves the laptop TUI and HostDeck remain concurrent clients of one exact managed thread.
- `INT-V1-032` combines reconnect, app-server crash, HostDeck restart, approvals, incomplete outcomes, TUI coexistence, and cleanup into selected-runtime acceptance.
- `IFC-V1-036` to `IFC-V1-038` compose this lifecycle with host health, startup, SSE/fanout, graceful drain, audit maintenance, and listener readiness.

## Implemented

- Added a strict reconnect-only adapter client for bounded active/archived enumeration, exact thread/goal/latest-turn reads, and one no-override resume. Raw protocol shapes, paths, identifiers, goals, and model values remain adapter-private.
- Added structured durable collaboration settings, migration `202607160017_selected_session_settings_projection`, exact projection validation, and current-target-only Plan rehydration. Historical or contradictory settings remain unknown.
- Added one atomic SQLite continuity replacement that preserves the durable cursor floor, replaces retained pre-gap events with one first `replay_boundary`, commits reconciled session truth, and reports post-commit publication uncertainty honestly.
- Added the server-owned reconciliation lifecycle in the required order: approval supersession, accepted-only audit reconciliation, durable disconnect truth, exact read-only reconciliation, boundary replacement, exact resume, model/settings persistence, event barriers, Plan rehydration, runtime-ready publication, then admission.
- Closed two admission races: work arriving while the ready callback is pending must drain before generation admission, and cwd/archive/runtime identity changes after initial reconciliation conflict before resume or ready.

## Evidence

- Direct contract, adapter, lifecycle, controller, Plan, approval, projection, migration, storage, and continuity matrices cover normal, invalid, boundary, repeated, rollback, publication-unknown, cancellation, identity-race, capacity, cursor-exhaustion, and privacy cases.
- The headless crash-reconciliation integration composes the real reconnect controller, scripted protocol transport, migrated SQLite repository, production append/continuity/audit ports, approval control, Plan control, and event pipeline. It proves running interruption, accepted-write audit incompletion, approval supersession/re-registration, one boundary, exact resume, model/mode reconciliation, a deliberately held ready-window event, no mutation replay, and final write admission.
- Final workspace results: unit 1,686 passed/37 external-device skipped; contract 277 passed; integration 33 passed; web 33 passed; root and all-package typechecks, lint/exports (491 files/9 packages), scaffold, planning, exact 0.144.0 binding, no-model compatibility, Unix IPC and supervisor smokes, frozen offline install, license inventory, and diff checks pass.
- The default Codex 0.144.3 remains ineligible for exact-runtime evidence; the isolated exact 0.144.0 binary passed. npm's retired audit endpoint returned HTTP 410, so no advisory result is claimed. No dependency or lockfile changed.

## Manual Inspection

- The lifecycle has no create/import/fork/archive/turn/control/approval mutation surface; the only runtime write exposed to it is exact reconnect-scoped `thread/resume`.
- Public results and snapshots contain bounded counts, continuity, generation, and reason codes only. They exclude cwd, ids, goals, model values, raw payloads, audit targets, approval content, and internal causes.
- Broken config, malformed runtime/storage truth, generation loss, partial audit, failed publication, barrier failure, and impossible state combinations fail closed before admission. No fallback parses display text or invents completion, mode, continuity, or mutation outcome.
- Service-process survival, foreground ownership, real multi-process HostDeck restart, TUI coexistence, host startup/health, SSE, UI, phone, packaging, and release readiness remain owned by the downstream tasks above.
