# IFC-V1-062 Goal API And CLI

Date: 2026-07-16

Status: hardening criteria frozen before implementation.

## Scope

Implement the selected one-session goal read and lifecycle boundary from strict session-scoped HTTP input through host-resolved target/runtime admission, the existing structured goal service, durable accepted-to-terminal audit, and laptop-local source CLI mappings. This leaf owns read, paused set/replace, pause, agentic resume, complete, and clear. Aggregate route composition, installed packaging, event-pipeline composition, frontend behavior, runtime supervision, and release acceptance remain downstream.

## Pre-Change Findings

- The selected manifest owns `GET /api/v1/sessions/:session_id/goal` and `POST /api/v1/sessions/:session_id/goal`, with session-read authority for GET and the selected session-write gate, device CSRF, unlocked-host policy, managed-session targeting, `goal` audit, and `IFC-V1-062` ownership for POST.
- The POST manifest currently names internal `goalOperationIntentSchema`, which requires a caller-supplied Codex thread target. The URL already names the durable HostDeck session; callers must not supply runtime identity.
- `goalControlSnapshotSchema` exposes one nullable full goal and one nullable uncertain mutation. Goal revision covers objective, status, token budget, and creation identity, but excludes volatile use counters.
- `createCodexGoalControlService` already serializes per session, reads before mutation, enforces exact observed revisions and lifecycle/turn guards, blocks resume when model/Plan settings are pending, verifies passive mutation read-back, treats resume as accepted, and latches bounded unknown/conflict state without retry.
- Goal mutation results contain internal `action`, `state`, and `dispatched` materialization fields. The selected wire response is a goal snapshot; those fields may drive validation/audit wording but must not become public response fields.
- The service target check does not yet parse complete selected mapping/projection records, reject every identity contradiction/recovery disposition, or return a validated state clone.

## Frozen Wire Contract

- `GET /api/v1/sessions/:session_id/goal` accepts one strict session-id path, no query, no body framing, and no implicit `HEAD`. Success is `200` with one strict `goalControlSnapshotSchema` and `no-store`/`no-cache` headers.
- `POST /api/v1/sessions/:session_id/goal` accepts one strict session-id path, no query, and a strict target-free body containing only `operation_id`, `kind: "goal"`, `action`, nullable `objective`, and nullable `expected_goal_revision`.
- `set` requires one trimmed nonempty bounded objective and permits a null revision only to create a missing goal; replacing an existing goal requires its exact revision. `pause`, `resume`, `complete`, and `clear` forbid an objective and require the exact observed revision.
- The request accepts no target, Codex thread/turn id, token budget, counters, runtime status, prompt, slash command, force, retry, reconcile marker, internal result state, or extra field.
- POST success is `200` with exactly `{ goal, uncertain_mutation: null }` parsed by `goalControlSnapshotSchema`. Internal `action`, `state`, and `dispatched` fields are validated and hidden.

## Goal Truth

- Read preserves exact objective, normalized status, token budget/use, time use, revision, and timestamps. It does not infer activity, completion, budget, or usage beyond the structured runtime result.
- Set always requests paused state. Setting the same paused objective with the exact revision is a proven no-op. A different objective cannot replace an active goal and requires a proven idle thread.
- Pause may run while a turn is active but does not interrupt that turn. Pausing an already paused goal is a no-op; a complete goal cannot be paused.
- Resume requires a paused or blocked goal, exact revision, proven idle turn, and no pending model or Plan settings. Success means the agentic goal activation was accepted, not that a turn is running or the goal is complete.
- Complete and clear require exact revision, a non-active goal, and a proven idle turn. Complete may be a no-op only when already complete. Clear returns no goal.
- Unsupported runtime statuses remain read-only normalized states. The public mutation surface cannot set blocked, usage-limited, budget-limited, counters, time, budget, or timestamps.
- A service success result must match the requested action, exact state (`accepted` only for resume; `succeeded` otherwise), dispatch truth, desired public status/objective/null state, and revision continuity. Dispatched changes must not return the expected baseline revision; no-ops must preserve it.

## Read And Admission Truth

- Both routes parse complete selected mapping/projection records and prove matching session id, Codex thread id, name, cwd, runtime source/version, creation time, archive time, and selected disposition.
- GET requires an unarchived selected active/current session and a connected compatible ready or safely degraded runtime with non-null reviewed binding/version, exact mapping-version agreement, and available goal capability. Read permits mutation policy `blocked`; incompatible/disconnected/malformed/stale/recovery states reject without partial output.
- GET authenticates before state access, invokes `snapshot` once with the host-resolved target and original signal, validates and sanitizes the complete snapshot, then rechecks target/runtime admission before returning.
- POST additionally requires session-write authority, current paired-device CSRF where applicable, an unlocked host, goal capability, and mutation policy `allowed` before accepted audit.
- Immediately before mutation, POST rechecks exact target/runtime admission. The goal service independently rechecks complete selected state before and after its runtime read and around passive read-back.

## Mutation And Audit Truth

- The accepted summary is exactly `{ schema_version: 1, goal_action, objective_length, expected_revision_present }`; it stores objective length, never objective text.
- The terminal success summary is exactly `{ schema_version: 1, changed }`, where `changed` equals the validated internal `dispatched` truth. State-proven no-ops are false; accepted or verified dispatched mutations are true.
- The route calls `CodexGoalControlService.mutate` exactly once after accepted audit. It never retries, sends prompt/slash/raw input, invokes a model/Plan selection, interrupts a turn, reads local storage through the CLI, or mutates another session.
- A typed service error with `not_sent` or `remote_rejected` outcome terminalizes failed. A typed `unknown` outcome, malformed result after dispatch may have occurred, target/runtime drift after mutation, or response-materialization contradiction terminalizes incomplete.
- Successful resume records a succeeded mutation audit because activation acceptance is proven, while public text says accepted and does not claim running/completed. Goal completion is a separate explicit `complete` action.
- Unknown/conflict latch details remain visible through the strict snapshot, but public error messages are canonicalized by code. The Codex thread id appears only in the repository-wide typed managed-session audit target; it never appears in summaries or errors. Raw adapter causes, paths, credentials, and objective text never enter audit or terminal error output.

## Outcome Rules

| Condition | Required truth |
| --- | --- |
| Invalid path/query/body/action/objective/revision/CLI option | Reject before target, audit, service, or Codex access. |
| Unauthorized, read-only, stale CSRF/device, insecure, or locked POST | Common gate rejection before target resolution/mutation. |
| Missing, archived, recovery, stale, contradictory, or changed target | Stable bounded target/storage error; no cross-session state. |
| Disconnected/incompatible runtime or unavailable goal capability | Explicit runtime/capability failure; no partial snapshot or mutation. |
| Missing goal for non-set action or stale revision | Validation/conflict failure; no mutation. |
| Set/complete/clear during active turn, active-goal replacement, invalid pause/resume, or pending settings on resume | Explicit conflict; no mutation or hidden interrupt. |
| Proven set/pause/complete no-op | `200`, unchanged goal snapshot, succeeded audit with `changed: false`, no Codex mutation. |
| Verified set/pause/complete/clear | `200`, exact snapshot, succeeded audit with `changed: true`. |
| Accepted resume | `200`, active goal snapshot, succeeded audit with `changed: true`; no running/completion claim. |
| Known remote rejection/not-sent failure | Failed audit and bounded error; no uncertain success claim. |
| Possible send, malformed post-send result, failed read-back, or post-mutation drift | Incomplete audit/error; uncertain service state remains authoritative; no retry. |
| Duplicate operation id or response loss | Existing audit truth blocks a second service call; replay remains `IFC-V1-049`. |
| Terminal audit failure | Suppress response; preserve runtime/service truth; never compensate or redispatch. |

## CLI Contract

- `codexdeck goal SESSION_ID [--json]` performs one exact loopback GET.
- `codexdeck goal SESSION_ID set --objective OBJECTIVE [--expected-revision REVISION] [--json]` creates or replaces a paused goal. Multiword objectives require normal shell quoting.
- `codexdeck goal SESSION_ID pause|resume|complete|clear --expected-revision REVISION [--json]` requires one canonical 64-character lowercase hexadecimal revision.
- `--objective` and `--expected-revision` are single-use. Objective is legal only for set; revision is optional only for set creation. No operation id, target, thread, token budget, internal state, reconcile, force, remote runtime, slash, or retry option is exposed.
- A dedicated direct-loopback client sends one exact GET/POST, enforces byte/time/status/schema/result correlation bounds, sanitizes typed/untyped failures, and never retries. The shell uses it receiverlessly without list/alias/storage/legacy API access.
- JSON output is the exact strict snapshot. Text output escapes terminal controls, shows full goal and uncertainty state with canonical error code only, distinguishes no-op/verified/accepted actions, and never prints raw private errors or says resume is running/completed.

## Hard Success Criteria

| Area | Required evidence |
| --- | --- |
| Contract/manifest | Strict target-free request, action/objective/revision matrix, existing strict snapshot, exact schema id/export, internal intent retained service-only, exact GET/POST manifest assertions. |
| Read route | Once-only registration, no body/query/HEAD, auth-before-state, local/paired parity, one signaled snapshot, canonical uncertain error, post-read target/runtime bracket, no-store exact `200`. |
| Write gate | Parse -> authority/CSRF -> lock -> target/runtime -> accepted audit -> admission recheck -> one mutate -> result materialization -> admission recheck -> terminal proof. |
| Goal service | Complete selected identity/disposition validation, revisions, all lifecycle/no-op/turn/pending-setting rules, read-back, unknown/conflict/event reconciliation, capacity/concurrency, archive/drift races. |
| Audit/failure | Exact summaries, failed versus incomplete by mutation outcome, duplicate, response loss, terminal-audit failure, raw SQLite privacy, no objective/error leakage. |
| CLI | Exact parser/help/forms, internal operation id, dedicated loopback requests, lifecycle correlation, safe full/empty/uncertain rendering, bounds, no retry/legacy/list/storage path. |
| Vertical | Real CLI -> HTTP -> gate/audit -> production goal service -> SQLite with read, paused set, no-op, accepted resume or passive transition, second-session isolation, duplicate rejection, and no prompt/slash/turn-client call. |
| Ownership | No aggregate registration, event-pipeline wiring, installed binary, UI, package/service, phone, or release claim. No dependency or planning change. |

## Validation Plan

- Focused selected contracts, goal adapter/service, pending-setting combiner, write gate/audit, goal route, client, parser/shell/render, and package-export tests.
- Local-admin and paired private-HTTPS route tests covering reader/writer authority, CSRF, lock, malformed wire input, complete target/runtime matrices, all action/no-op/result states, post-read/pre/post-mutation drift, duplicate, response loss, terminal-audit failure, and bounded privacy-safe errors.
- Real SQLite vertical and raw audit inspection proving one mutation, objective-free audit summaries, second-session isolation, and no same-operation replay.
- Full unit, contract, integration, web, typecheck, lint/exports, scaffold, planning, frozen install, exact reviewed binding, and production dependency gates.
- Exact authenticated Codex 0.144.0 goal smoke. No physical phone is required for this headless leaf.

## Downstream Ownership

- The normalized event pipeline owns delivery of goal update/clear events to `observeGoal`; runtime supervision owns reconnect/reconciliation scheduling.
- `IFC-V1-049` owns replayable cross-route operation responses and aggregate concurrency policy.
- `IFC-V1-046` owns aggregate selected production registration.
- `FE-V1-026` owns the approved mobile `/goal` surface and visual-state acceptance.
- `IFC-V1-067` owns historical raw/slash/tmux surface disposition.
- Packaging/release leaves own an installed `codexdeck` executable and clean-install command smoke.
