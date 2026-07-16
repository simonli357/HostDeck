# IFC-V1-063 Plan API And CLI

Date: 2026-07-16

Status: hardening criteria frozen before implementation.

## Scope

Implement the selected one-session Plan catalog/read/select boundary from strict session-scoped HTTP input through host-resolved target/runtime admission, the existing structured Plan service, durable accepted-to-terminal audit, and laptop-local source CLI mappings. This leaf owns truthful Plan/Default reads and revisioned next-turn enter/exit selection. Aggregate route composition, prompt-to-pending-Plan dispatch wiring, installed packaging, event-pipeline composition, frontend behavior, runtime supervision, and release acceptance remain downstream.

## Pre-Change Findings

- The selected manifest owns `GET /api/v1/sessions/:session_id/plan` and `POST /api/v1/sessions/:session_id/plan`, with session-read authority for GET and the selected session-write gate, device CSRF, unlocked-host policy, managed-session targeting, `plan` audit, and `IFC-V1-063` ownership for POST.
- The POST manifest currently names internal `planOperationIntentSchema`, which requires a caller-supplied Codex thread target. The URL already names the durable HostDeck session; callers must not supply runtime identity.
- `planControlSnapshotSchema` exposes the bounded live Plan/Default catalog, current observed mode, one process-local pending next-turn selection, and separately evidenced Plan execution state. The strict snapshot already distinguishes unknown current mode from confirmed settings.
- Exact Codex 0.144.0 has no read-only collaboration-mode endpoint. Current mode becomes confirmed only from normalized settings evidence; restart leaves it unknown until downstream reconciliation rehydrates committed settings.
- `CodexPlanControlService.select` is a process-local staged selection. It reads the live collaboration catalog, stores or replaces one revision, and never starts a turn. `dispatchPendingTurn` is a separate prompt-composition path and is outside this leaf.
- The service currently validates only partial selected-state identity in its target and pending-setting paths. Public API routes, a dedicated source CLI client, exact command grammar, response correlation, and terminal-safe rendering do not exist.
- The authenticated exact-0.144.0 Plan smoke already proves collaboration-only turn composition and explicit later Default selection through `INT-V1-021`; this leaf must preserve that behavior without exposing turn text or dispatch.

## Frozen Wire Contract

- `GET /api/v1/sessions/:session_id/plan` accepts one strict session id, no query, no request body or body framing, and no implicit HEAD. It returns one strict `PlanControlSnapshot` with `Cache-Control: no-store` and `Pragma: no-cache`.
- `POST /api/v1/sessions/:session_id/plan` accepts one strict session-id path, no query, and a strict target-free body containing only `operation_id`, `kind: "plan"`, `action`, and nullable `expected_pending_revision`.
- `action` is exactly `enter` or `exit`. Enter maps to catalog mode `plan`; exit maps to catalog mode `default`. Callers cannot provide a mode name, catalog name, model, effort, prompt, target, thread/turn id, dispatch flag, current state, execution state, force, retry, reconcile marker, or extra field.
- `expected_pending_revision` is null only when no pending selection was observed. Replacing, clearing, or resolving an observed pending selection requires its exact positive safe-integer revision.
- The internal target-bearing `planOperationIntentSchema` remains service-only. The public request uses a separate exported schema and selected manifest id.
- Successful GET and POST responses expose only the strict snapshot. Internal target, audit state, dispatch state, materialization markers, and service error causes are never response fields.

## Frozen Product Semantics

- Catalog reads expose only the runtime's strict bounded Plan and Default entries and exact catalog revision/time. They do not establish current collaboration mode.
- Current mode is `confirmed` only when structured settings evidence supplied mode, runtime model, effort, and observation time. Otherwise every current field remains exactly unknown/null.
- Enter stages Plan for the next prompt-driven turn. Exit stages Default for the next prompt-driven turn. Neither action starts, steers, interrupts, completes, or otherwise mutates a turn.
- A matching confirmed current mode with no pending selection is a proven no-op. If an exact pending revision exists and the requested mode is already confirmed current, selection clears that pending revision and reports a changed staged state without claiming runtime application.
- A staged or replaced selection returns one exact pending record owned by the current operation: desired mode, `available` catalog state, `pending` phase, no turn id, no resolved settings, no error, and a new revision. Replacement revision must be greater than the exact expected revision.
- Existing `dispatching`, `awaiting_confirmation`, or `unknown` pending state rejects replacement. Existing `pending` or `conflict` state may be replaced only with its exact revision.
- Pending and execution truth are independent. Selecting Plan/Default does not alter or reinterpret prior `execution` state. Active/complete Plan execution requires plan-specific normalized evidence; terminal turn state without such evidence remains unknown.
- Public success wording is limited to pending, replaced, cleared, or already-confirmed current state. It never says Plan/Default is applied, active, running, completed, or exited solely because selection succeeded.

## Target, Runtime, And Service Boundary

- Both routes parse complete selected mapping/projection records and prove matching session id, Codex thread id, name, cwd, runtime source/version, creation time, archive time, and selected disposition.
- Missing, archived, stale, recovery-required, contradictory, or misplaced selected state fails before Plan service access. GET brackets one signaled service snapshot with target/runtime revalidation.
- Runtime admission requires a connected `ready` or `degraded` exact-version binding and available `plan` capability. GET may read while mutation policy is blocked; POST requires mutation policy `allowed`.
- POST additionally requires session-write authority, current paired-device CSRF where applicable, and an unlocked host before accepted audit.
- POST revalidates target/runtime after accepted audit and before service selection, calls `CodexPlanControlService.select` exactly once receiverlessly, validates the returned snapshot and selection correlation, then revalidates target/runtime before terminal proof.
- The route never calls `dispatchPendingTurn`, a prompt service, Plan/model turn settings preparation, `turn/start`, a raw input path, a slash parser, local storage through the CLI, or another session.
- Plan service target and pending-setting reads must fail closed on malformed, contradictory, recovery, stale, archived, or mismatched selected records while preserving existing dispatch/event/reconciliation semantics.

## Audit And Failure Truth

- The accepted summary is exactly `{ schema_version: 1, plan_action, expected_revision_present }`.
- Terminal success is exactly `{ schema_version: 1, changed }`. Pending creation/replacement and exact pending clear are changed; already-confirmed current with no pending selection is unchanged.
- Validation, authentication, authority, CSRF, lock, target, runtime, and capability failures before accepted audit create no operation trail and never call the Plan service.
- A typed Plan service rejection during selection is a failed audit. An untyped throw, malformed/contradictory post-selection snapshot, or post-selection target/runtime drift is incomplete because process-local selection may already have changed.
- Duplicate operation ids and raw response loss never cause a second selection. A terminal-audit write failure suppresses the public success response without compensating, clearing, or redispatching the service state.
- Pending error messages in successful reads are canonicalized by stable error code. The Codex thread id appears only in the repository-wide typed managed-session audit target; it never appears in summaries or errors. Raw adapter causes, paths, credentials, catalog preset internals beyond the public snapshot, and private errors never enter audit or terminal failure output.

## Failure Matrix

| Case | Required result |
| --- | --- |
| Invalid path/query/body/action/revision/CLI option | Reject before target, audit, service, or Codex access. |
| Missing/archived/stale/recovery/contradictory target | Stable bounded error; no selection. |
| Runtime disconnected/version drift/capability unavailable | Stable unavailable/incompatible error; no selection. |
| GET with mutation blocked | Read remains available and truthful. |
| Current mode unknown | `200` exact unknown current; no inference from catalog, pending, execution, or last request. |
| Initial or replacement enter/exit | `200` exact pending snapshot and succeeded audit with `changed: true`; zero turn/model/prompt calls. |
| Already-confirmed current with no pending | `200` no pending and succeeded audit with `changed: false`. |
| Exact pending clear to confirmed current | `200` no pending and succeeded audit with `changed: true`. |
| Stale expected revision or nonreplaceable phase | Failed audit and bounded conflict; no second state change. |
| Malformed result or post-selection drift | Incomplete audit/error; service state remains authoritative; no retry. |
| Duplicate operation id or response loss | Existing audit truth blocks a second service call; replay remains `IFC-V1-049`. |
| Terminal audit failure | Suppress response; preserve service truth; never compensate or redispatch. |

## Frozen CLI Contract

- `codexdeck plan SESSION_ID [--json]` reads one managed session's exact Plan snapshot.
- `codexdeck plan SESSION_ID enter|exit [--expected-revision REVISION] [--json]` stages the selected next-turn mode. Revision is a positive safe integer and is single-use.
- The source CLI generates an internal `op_plan_<uuid>` operation id. It exposes no operation-id, target/thread/turn, mode-name, model/effort, prompt/text, dispatch, reconcile, force, remote-runtime, slash, retry, or option-terminator surface.
- A dedicated direct-loopback client sends one exact GET/POST, enforces byte/time/status/schema/result correlation bounds, sanitizes typed/untyped failures, and never retries. The shell uses it receiverlessly without list/alias/storage/legacy API access.
- JSON output is the exact strict snapshot. Text output escapes terminal controls, shows catalog/current/pending/execution truth with canonical error code only, distinguishes pending/replaced/cleared/already-current selection, and makes no immediate application or turn-state claim.

## Hard Success Criteria

| Area | Required evidence |
| --- | --- |
| Contract/manifest | Strict target-free request, enter/exit/revision matrix, existing strict snapshot, exact schema id/export, internal intent retained service-only, exact GET/POST manifest assertions. |
| Read route | Once-only registration, no body/query/HEAD, auth-before-state, local/paired parity, one signaled snapshot, canonical pending error, post-read target/runtime bracket, no-store exact `200`. |
| Write gate | Parse -> authority/CSRF -> lock -> target/runtime -> accepted audit -> admission recheck -> one select -> result correlation -> admission recheck -> terminal proof. |
| Plan service | Complete selected identity/disposition validation plus existing catalog, revision, no-op, replacement, dispatch, model-composition, event, reconciliation, capacity, concurrency, archive, and drift behavior. |
| Audit/failure | Exact summaries, failed versus incomplete boundary, duplicate, response loss, terminal-audit failure, raw SQLite privacy, no private error leakage. |
| CLI | Exact parser/help/forms, internal operation id, dedicated loopback requests, selection correlation, safe full rendering, bounds, no retry/legacy/list/storage path. |
| Vertical | Real CLI -> HTTP -> gate/audit -> production Plan service -> SQLite with unknown/confirmed read, pending enter, replacement/clear or no-op, second-session isolation, duplicate rejection, and zero prompt/model/turn dispatch calls. |
| Ownership | No aggregate registration, prompt-dispatch composition, event-pipeline wiring, installed binary, UI, package/service, phone, or release claim. No dependency or planning change. |

## Validation Plan

- Focused selected contracts, Plan adapter/service, pending-setting combiner, write gate/audit, Plan route, client, parser/shell/render, and package-export tests.
- Local-admin and paired private-HTTPS route tests covering reader/writer authority, CSRF, lock, malformed wire input, complete target/runtime matrices, pending/replacement/clear/no-op/result states, post-read/pre/post-selection drift, duplicate, response loss, terminal-audit failure, and bounded privacy-safe errors.
- Real SQLite vertical and raw audit inspection proving one selection, replacement/clear or no-op, second-session isolation, no same-operation replay, and no prompt/model/turn dispatch.
- Full unit, contract, integration, web, typecheck, lint/exports, scaffold, planning, frozen install, exact reviewed binding, and production dependency gates.
- Exact authenticated Codex 0.144.0 Plan smoke. No physical phone is required for this headless leaf.

## Downstream Ownership

- Prompt composition owns calling `dispatchPendingTurn` when one pending Plan revision exists; the normalized event pipeline owns settings/Plan evidence delivery to `observeEvent`.
- Runtime supervision/reconciliation owns rehydrating committed settings and preserving explicit unknown current mode after restart.
- `IFC-V1-049` owns replayable cross-route operation responses and aggregate concurrency policy.
- `IFC-V1-046` owns aggregate selected production registration.
- `FE-V1-027` owns the approved mobile `/plan` surface and visual-state acceptance.
- `IFC-V1-067` owns historical raw/slash/tmux surface disposition.
- Packaging/release leaves own an installed `codexdeck` executable and clean-install command smoke.
