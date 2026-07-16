# IFC-V1-042 Model API And CLI

Date: 2026-07-16

Status: complete.

## Scope

Implement the selected one-session model catalog/read/select boundary from strict session-scoped HTTP input through host-resolved target and runtime admission, the existing revisioned pending-model service, durable accepted-to-terminal selection audit, and laptop-local source CLI mappings. This leaf owns reading current/catalog/pending model state and staging one model/effort choice for the selected thread's next turn. Prompt composition owns later dispatch and settings confirmation; aggregate route composition, installed packaging, frontend behavior, runtime supervision, and release acceptance remain downstream.

## Pre-Change Findings

- The selected manifest owns `GET /api/v1/sessions/:session_id/model` and `POST /api/v1/sessions/:session_id/model`, with session-read authority for GET and the selected session-write gate, device CSRF, unlocked-host policy, managed-session targeting, `model` audit, and `IFC-V1-042` ownership for POST.
- The POST manifest currently names internal `modelOperationIntentSchema`, which requires a caller-supplied Codex thread target. The URL already names the durable HostDeck session; callers must not choose or discover a runtime target before host authorization.
- `modelControlSnapshotSchema` already separates a bounded live catalog, confirmed current runtime state, and one revisioned pending next-turn selection. It explicitly preserves unknown current/catalog state and pending conflict/unknown phases.
- `createCodexModelControlService` already serializes each session, resolves default effort from the live catalog, reserves bounded pending capacity, uses optimistic pending revisions, reconciles catalog/read-back/settings drift, and composes the pending selection into a later exact `turn/start`. Selection itself performs no Codex mutation and starts no turn.
- The service's direct target check currently proves only session/thread identity, archive, active state, and freshness. It does not reject every mapping/projection identity contradiction or non-selected recovery disposition required by the selected boundary.
- The source CLI has no selected model command. Historical generic API/list/alias behavior must not be used to invent one.

## Frozen Wire Contract

- `GET /api/v1/sessions/:session_id/model` accepts one strict session-id path, no query, no body, and no implicit `HEAD`. Success is `200` with one strict `modelControlSnapshotSchema` and `no-store`/`no-cache` headers.
- `POST /api/v1/sessions/:session_id/model` accepts one strict session-id path, no query, and a strict body containing only `operation_id`, `kind: "model"`, `model_id`, nullable `reasoning_effort`, and nullable positive `expected_pending_revision`. It accepts no target, Codex thread/turn id, prompt, action, alias, runtime model name, force, retry, or extra field.
- POST success is `200` with the strict model snapshot returned by the service after terminal audit proof. Success means the HostDeck next-turn selection was truthfully staged, replaced, cleared by choosing confirmed current state, or was already current. It does not mean Codex settings changed, a turn started, or a later settings event confirmed the choice.
- Public request state remains distinct from internal target-bearing `modelOperationIntentSchema`. The route alone materializes the exact managed-session target after authorization.
- Catalog model ids are the only selectable wire identities. Runtime model names remain read-only snapshot data and cannot be submitted as an alternate selector.

## Read And Admission Truth

- Both routes parse complete selected mapping/projection records and prove matching session id, Codex thread id, name, cwd, runtime source/version, creation time, archive time, and selected disposition.
- GET requires an unarchived selected active/current session and a connected compatible ready or safely degraded runtime with non-null reviewed binding/version, exact mapping-version agreement, and available model capability. Read does not require mutation policy `allowed`, but disconnected, malformed, incompatible, unknown-capability, stale, recovery, archived, or identity-contradictory state rejects without a partial snapshot.
- GET authenticates before state access, calls `snapshot` once with the host-resolved target and original request signal, validates the complete result, then re-reads target/runtime identity before returning it. A changed target suppresses the snapshot.
- POST additionally requires mutation policy `allowed`, session-write authority, current device authority and CSRF where applicable, and an unlocked host. Structural input, authority, lock, target, runtime, and capability checks occur before accepted audit.
- Immediately before selection, POST re-reads target/runtime admission and requires exact agreement with the gate resolution. The model service independently re-reads full selected state before and after live catalog/current reads.
- An active Codex turn does not by itself block passive next-turn selection. An existing pending selection must satisfy the exact optimistic revision; dispatching, awaiting-confirmation, unknown, or otherwise non-replaceable state remains an explicit conflict.

## Selection And Audit Truth

- A null effort resolves to the selected live catalog entry's single explicit default. Unknown model id and unsupported effort remain distinct and never become runtime-name fallback, default-model fallback, slash input, or prompt text.
- A null expected revision is valid only when no pending selection exists. Replacing or clearing an existing replaceable pending selection requires its exact positive revision. Stale, absent, future, or mismatched revisions reject without replacement.
- Selecting the confirmed model/effort with no pending selection is a truthful no-op. Selecting confirmed current state with the exact pending revision clears that pending selection. Any new/replaced pending response must carry the request operation id, selected catalog id, resolved effort, a new positive revision, `phase: "pending"`, and no accepted turn id.
- The accepted audit summary is exactly `{ schema_version: 1, model_id, reasoning_effort, expected_revision_present }`. The terminal success summary is exactly `{ schema_version: 1, changed }`, where clearing/replacing/staging is changed and an already-current no-op is not.
- The route calls `CodexModelControlService.select` exactly once after accepted audit. Selection performs bounded reads plus one process-local pending-state transition; it never invokes `turn/start`, `thread/resume.model`, raw input, filesystem, tmux, or another session.
- Known service validation/capability/conflict/read failures terminalize as failed because selection has not performed an external Codex mutation. An untyped contradiction after possible local pending-state change terminalizes incomplete. Terminal audit or response preparation failure suppresses success without compensating, dispatching a turn, or retrying selection.

## Outcome Rules

| Condition | Required truth |
| --- | --- |
| Invalid path/body/query, unknown field, oversized identity, zero revision, effort without model, or malformed CLI option | Reject before target state, audit, model service, or Codex access. |
| Unauthorized, read-only, stale device/CSRF authority, insecure, or locked POST | Reject through the common gate before target resolution or selection. |
| Missing managed session | `session_not_found`; no accepted audit or model read/select. |
| Archived or non-active session | `session_not_writable`; no selected snapshot or selection. |
| Stale, recovery, contradictory, changed target, or mapping/runtime-version drift | `stale_session` or bounded storage failure; no cross-target state. |
| Disconnected runtime | `runtime_unavailable`; no partial catalog/snapshot or accepted selection audit. |
| Incompatible, unknown/unavailable model capability, mutation-blocked POST, or invalid binding | `incompatible_runtime`/`capability_unavailable`; no selection. |
| Empty/malformed/oversized/cyclic live catalog or malformed current read-back | Bounded protocol/capacity failure; no partial catalog or pending change. |
| Unknown catalog model or unsupported model effort | Distinct bounded failure; no fallback and no pending change. |
| Missing/stale expected revision or non-replaceable pending phase | `operation_conflict`; existing pending state remains unchanged. |
| Already-confirmed requested model/effort with no pending | Succeeded audit with `changed: false`; snapshot has no pending selection. |
| Valid new, replacement, or clear selection | Succeeded audit with `changed: true`; response is exact staged/current snapshot only. |
| Duplicate operation id | Existing audit truth blocks another service call; replay remains `IFC-V1-049`. |
| Response preparation/delivery fails after selection | Local pending and durable audit remain authoritative; same-id retry cannot select again. |
| Terminal audit cannot be proven | Suppress success, retain pending/unproven audit truth, and never compensate or auto-retry. |
| Process dies after accepted audit | Startup orphan reconciliation records explicit incomplete; no pending selection or turn is replayed. |

## CLI Contract

- `codexdeck model SESSION_ID [--json]` performs one exact loopback GET and renders confirmed current state, pending state, catalog revision, and visible model/effort choices.
- `codexdeck model SESSION_ID MODEL_ID [--effort EFFORT] [--expected-revision REVISION] [--json]` generates the operation id internally and performs one exact loopback POST. Omitted effort sends null for live default resolution; omitted expected revision sends null.
- `--effort` and `--expected-revision` are legal only with a model id. Options are single-use, revisions are canonical positive safe integers, and no operation id, target, runtime model, prompt, turn, force, remote URL, or retry option is exposed.
- A dedicated loopback client validates strict request/response state and selection correlation, bounds URL/body/response/time, sanitizes typed and untyped failures, and never retries. The shell uses one receiverless dedicated client and does not list sessions, resolve aliases, read local storage, or call historical generic API methods.
- Text output distinguishes confirmed current, pending/conflict/unknown, catalog choices/defaults, and already-current versus staged selection without saying applied, running, or completed. JSON output is the exact strict snapshot. All terminal text is escaped and no raw adapter error is reflected.

## Hard Success Criteria

| Area | Required evidence |
| --- | --- |
| Contracts/manifest | Strict target-free public request, existing strict snapshot, exact keys/bounds/revisions/default correlation, exports, schema ids, and both manifest entries. Internal target-bearing intent remains service-only. |
| Read route | Exact manifest assertion, once-only registration, no implicit HEAD, local/paired read parity, auth before state, one signaled snapshot read, post-read identity bracket, no-store `200`, and no partial malformed output. |
| Write gate/order | Parse -> local-admin or paired HTTPS writer/CSRF -> one lock read -> target/runtime resolution -> accepted audit -> admission recheck -> one select -> response preparation -> terminal proof. Original signal/deadline is preserved. |
| Target/runtime | Full mapping/projection identity, selected disposition, archive/session/freshness, runtime binding/version/mutation/capability, pre/post rechecks, and cross-session isolation. |
| Model service | Default effort, current no-op, optimistic replacement/clear, capacity/concurrency, catalog/current/settings drift, known/unknown read failures, archive/identity races, and strengthened full state checks. No select-time turn dispatch. |
| Audit | Exact accepted fields and terminal changed truth; duplicate operation, response loss, terminal-audit failure, orphan reconciliation, and raw SQLite bounded/privacy evidence. |
| CLI client | Exact loopback GET/POST, canonical body, strict status/schema/selection correlation, byte/time bounds, no retry, sanitized failures, and rejection of remote/basic-auth/query/fragment/path-confused bases. |
| CLI shell/render | Exact parser/options/revisions, internal operation id, receiverless dedicated client, all snapshot phases/defaults/unknowns, safe text/JSON output, help, and no list/alias/legacy/storage dependency. |
| Ownership | No aggregate registration, installed binary, UI, package, service, phone, settings-confirmed, turn-start, or release claim. No new dependency or planning choice. |

## Validation Plan

- Focused selected contract/manifest, model adapter/service, write gate/audit executor, route, client, parser/shell/render, and package-export tests.
- Local-admin and paired private-HTTPS GET/POST tests covering reader/writer authority, CSRF, lock, malformed/method/path/query inputs, full target/runtime matrices, optimistic revisions, no-op/clear/stage, post-read and pre-select drift, duplicate operation, terminal-audit failure, and bounded errors.
- Real SQLite raw-audit inspection and raw HTTP response-loss evidence proving one process-local selection and no same-operation replay.
- One CLI-to-HTTP-to-gate/audit-to-model-service/SQLite/fake-Codex vertical covering read, stage, default effort, second-session isolation, duplicate rejection, and zero turn-start calls.
- Adjacent auth, CSRF, lock, deadline, runtime compatibility, selected-state, prompt/model/Plan composition, manifest, adapter, and historical-shell isolation regressions.
- Full unit, contract, integration, web, typecheck, lint/exports, scaffold, planning, frozen install, exact reviewed binding, and production supply-chain gates.
- Rerun the exact Codex 0.144.0 authenticated model smoke when the isolated reviewed binary is available. No physical phone is required for this headless leaf.
- Manual staged diff, target/order/deadline, pending-versus-applied wording, no-turn behavior, audit/raw-storage/privacy, public output, selected/legacy import separation, cleanup, and owner-doc review.

## Downstream Ownership

- `INT-V1-018` and the prompt boundary own atomic pending model/Plan composition into a later exact turn; structured settings/read-back events own confirmation.
- `IFC-V1-049` owns replayable cross-route operation-id responses and aggregate concurrency policy.
- `IFC-V1-046` owns production registration with every selected route and remote ingress.
- `FE-V1-021` owns the approved mobile `/model` surface and visual state acceptance.
- `IFC-V1-067` owns historical generic/tmux/raw surface disposition.
- `IFC-V1-021` and packaging/release leaves own an installed `codexdeck` executable and clean-install command smoke.

## Completion Evidence

- Implemented a strict target-free public selection contract, exact manifest schema ownership, complete selected-state validation in the model service, the authenticated no-store GET route, and the common-gate/audited POST route. Selection remains a process-local next-turn state transition and never starts a Codex turn.
- Added the dedicated bounded loopback model client plus exact `model` read/select parser, shell, help, JSON, and terminal-safe text mappings. The CLI exposes catalog model ids only and revalidates staged, replacement, clear, and already-current response correlation.
- Route evidence covers local and paired private-HTTPS reads/writes, read-only rejection, CSRF/lock/gate order, target/runtime drift brackets, capability and compatibility matrices, malformed wire state, duplicate operation ids, raw response loss, terminal-audit failure, monotonic replacement revisions, and raw SQLite audit privacy.
- Focused validation: 40 model service/route/client/CLI tests, 26 selected contract tests, and one real CLI -> loopback HTTP -> selected gate/audit -> production model service -> SQLite vertical pass. The vertical proves default-effort staging, second-session isolation, duplicate rejection, and zero `turn/start` calls.
- Workspace validation: unit 1,459 passed with 36 intentional external skips; contract 264; integration 20; web 33; typecheck, lint/exports, scaffold, planning (212 tasks/649 dependencies), frozen install, diff checks, and exact reviewed Codex 0.144.0 binding all pass. The authenticated exact-runtime model smoke passes.
- `pnpm audit --prod --audit-level=high` could not produce advisory evidence because npm's retired audit endpoint returned HTTP 410. No dependency or lockfile changed in this leaf.
- Criteria commit `8c057bf`; implementation `5174fb3`.
