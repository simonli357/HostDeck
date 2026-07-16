# IFC-V1-064 Compact API And CLI

Date: 2026-07-16

Status: complete.

## Scope

Implement the selected one-session compact progress read and confirmed compact-start boundary from strict session-scoped HTTP input through host-resolved target/runtime admission, the existing structured compact service, durable accepted-to-terminal dispatch audit, and laptop-local source CLI mappings. This leaf owns truthful process-live progress for one exact managed target. Aggregate route composition, normalized-event pipeline composition, restart reconciliation, installed packaging, frontend behavior, runtime supervision, and release acceptance remain downstream.

## Pre-Change Findings

- The selected manifest owns `GET /api/v1/sessions/:session_id/compact` and `POST /api/v1/sessions/:session_id/compact`, with session-read authority for GET and the common session-write gate, paired-device CSRF, unlocked-host policy, managed-session targeting, `compact` audit, and `IFC-V1-064` ownership for POST.
- The POST manifest names the internal `compactOperationIntentSchema`, which requires a caller-supplied Codex thread target. The URL already names the durable HostDeck session; callers must not supply runtime identity.
- The manifest names `compact_progress_response_v1`, but no dedicated public response schema exists. A nullable field is required so the read can distinguish no tracked operation from malformed or unavailable state without inventing idle progress.
- `CodexCompactControlService` already dispatches exactly once, returns accepted-only progress, serializes per session, latches possible-send ambiguity as incomplete, and advances state only from exact normalized turn/context-compaction lifecycle evidence.
- The service validates only part of selected mapping/projection identity. Its session and thread lookup paths can consume contradictory or malformed state without proving the complete selected identity and disposition.
- Public API routes, a dedicated source CLI client, exact command grammar, response correlation, canonical terminal-safe rendering, and real route/audit vertical evidence do not exist.
- Compact progress is process-live. `INT-V1-029` owns restart reconciliation; this leaf must not infer a prior operation from elapsed time, terminal text, projection status, token movement, or deprecated notifications.

## Frozen Wire Contract

- `GET /api/v1/sessions/:session_id/compact` accepts one strict session id, no query, no request body or body framing, and no implicit HEAD. It returns HTTP 200 with one strict `{ progress }` object, `Cache-Control: no-store`, and `Pragma: no-cache`.
- `progress` is either null, meaning no operation is currently tracked for the admitted exact target, or one strict compact `SelectedOperationProgress`. A null result is not success, completion, availability, or an idle operation.
- `POST /api/v1/sessions/:session_id/compact` accepts one strict session-id path, no query, and a strict target-free body containing only `operation_id`, `kind: "compact"`, and literal `confirm: true`.
- Callers cannot provide a target, Codex thread/turn/item id, runtime version/generation, progress state, force, retry, timeout, interrupt, slash text, prompt, or extra field.
- The internal target-bearing `compactOperationIntentSchema` remains service-only. The public request uses a separate exported `compactStartRequestSchema` and selected manifest id.
- Both successful routes return `compactProgressResponseSchema`. POST returns HTTP 202 and requires non-null progress correlated to the request, exact host-resolved target, `kind: "compact"`, `state: "accepted"`, null turn id, and null error.
- Public failed/incomplete progress retains only the stable error code, canonical public message, and retryable flag. Raw runtime/event/adapter causes are never response fields.

## Frozen Product Semantics

- Explicit confirmation is mandatory for every compact start. The browser owns its confirmation step; the API requires literal confirmation; the CLI requires `--confirm` on the mutating form.
- A successful POST proves only that one exact `thread/compact/start` was accepted. It never reports `running`, `completed`, `compacted`, context reduction, token savings, or terminal success.
- GET exposes the current tracked state for the exact target: accepted, running, completed, interrupted, failed, or incomplete. It never synthesizes a progress record when none exists.
- Accepted remains unbound to a turn. Running and normal terminal states require the service's exact event-proven turn identity. Failed or incomplete state preserves only a bounded canonical cause.
- A completed state remains historical process-live progress until bounded service eviction. A second compact may replace terminal progress only after all current admission checks pass and a distinct operation id is accepted.
- An accepted/running/unknown prior operation blocks another compact. A duplicate operation id is also rejected by durable audit before service dispatch.
- No API or CLI path polls automatically, retries a possible send, starts or steers a prompt turn, invokes interrupt, parses terminal output, sends `/compact`, or mutates another session.

## Target, Runtime, And Service Boundary

- Both routes parse complete selected mapping/projection records and prove matching session id, Codex thread id, name, cwd, runtime source/version, creation time, archive time, and selected disposition.
- Missing, archived, stale, recovery-required, contradictory, malformed, or misplaced selected state fails before compact service access. GET brackets one service snapshot with target/runtime revalidation.
- Runtime admission requires a connected `ready` or `degraded` exact-version binding and available `compact` capability. GET may read while runtime mutation policy or host writes are blocked; POST requires mutation policy `allowed`.
- POST additionally requires session-write authority, current paired-device CSRF where applicable, an unlocked host, and a proven idle or terminal selected turn before accepted audit.
- POST revalidates target/runtime/turn policy after accepted audit and before service dispatch, calls `CodexCompactControlService.compact` exactly once receiverlessly, validates the accepted result, then revalidates target/runtime continuity before terminal audit proof.
- The production compact service must perform complete selected-state parsing, cross-record identity/disposition checks, and exact session/thread lookup validation for compact, snapshot, and event observation without weakening its existing lifecycle, generation, capacity, or ambiguity rules.

## Audit And Failure Truth

- The accepted summary is exactly `{ schema_version: 1, confirmed: true }`.
- Dispatch terminal success is exactly `{ schema_version: 1, accepted: true }`. It records that compact start was accepted, not that context compaction completed.
- Validation, authentication, authority, CSRF, lock, target, active-turn, runtime, and capability failures before accepted audit create no operation trail and never call the compact service.
- A typed compact service outcome of `not_sent` or `remote_rejected` produces a failed audit. A possible-send `unknown` outcome produces an incomplete audit and leaves the service's incomplete latch readable.
- An untyped throw, malformed or contradictory post-dispatch result, or post-dispatch target/runtime drift is incomplete because the compact request may have been accepted.
- Duplicate operation ids and raw response loss never cause a second compact. Terminal-audit failure suppresses public success without compensation, interruption, state deletion, or redispatch.
- The Codex thread id appears only in the repository-wide typed managed-session audit target. Summaries and errors exclude thread/item ids, raw causes, credentials, paths, event text, token counts, and private payloads.

## Failure Matrix

| Case | Required result |
| --- | --- |
| Invalid path/query/body/confirmation/CLI option | Reject before target, audit, service, or Codex access. |
| Missing/archived/stale/recovery/contradictory target | Stable bounded error; no snapshot leak or dispatch. |
| Runtime disconnected/version drift/capability unavailable | Stable unavailable/incompatible error; no dispatch. |
| GET with writes blocked or active compact turn | Current exact progress remains readable. |
| No tracked operation | HTTP 200 exact `{ progress: null }`; no invented state. |
| Initial confirmed compact | HTTP 202 exact accepted progress and succeeded dispatch audit; no completion claim. |
| Accepted/running/unknown prior compact | Conflict; no second service or Codex call. |
| Event-proven terminal progress | GET returns exact completed/interrupted/failed/incomplete truth with canonical error. |
| Known service rejection | Failed audit and bounded error; no retained accepted progress. |
| Possible-send timeout/disconnect/protocol ambiguity | Incomplete audit/error; later GET exposes incomplete latch; no retry. |
| Malformed result or post-dispatch drift | Incomplete audit/error; service truth remains authoritative; no retry. |
| Duplicate operation id or response loss | Existing audit truth blocks a second service call; replay remains `IFC-V1-049`. |
| Terminal audit failure | Suppress response; preserve service truth; never compensate or redispatch. |

## Frozen CLI Contract

- `codexdeck compact SESSION_ID [--json]` reads one managed session's exact compact progress response.
- `codexdeck compact SESSION_ID --confirm [--json]` starts one compact operation. `--confirm` is mandatory, literal, non-repeatable, and has no value.
- The source CLI generates an internal `op_compact_<uuid>` operation id. It exposes no operation-id, target/thread/turn/item, runtime, force, retry, timeout, interrupt, prompt, text, slash, remote-runtime, or option-terminator surface.
- A dedicated direct-loopback client sends one exact GET or POST, enforces byte/time/status/schema/result-correlation bounds, sanitizes typed and untyped failures, and never retries. The shell uses it receiverlessly without list/alias/storage/legacy API access.
- JSON output is the exact strict `{ progress }` response. Text output escapes terminal controls, distinguishes absent/accepted/running/completed/interrupted/failed/incomplete, includes no raw error message, and says completion is not proven for accepted or running state.

## Hard Success Criteria

| Area | Required evidence |
| --- | --- |
| Contract/manifest | Strict target-free request, literal confirmation, explicit nullable response wrapper, compact-only progress refinement, exact schema ids/exports, internal intent retained service-only, exact GET/POST manifest assertions. |
| Read route | Once-only registration, no body/query/HEAD, auth-before-state, local/paired parity, one snapshot, canonical error, target/runtime post-read bracket, no-store exact HTTP 200. |
| Write gate | Parse -> authority/CSRF -> lock -> target/runtime/turn policy -> accepted audit -> admission recheck -> one compact -> result correlation -> admission recheck -> terminal proof. |
| Compact service | Complete selected identity/disposition validation plus existing confirmation, capability, terminal-turn, generation, race, event, ambiguity, capacity, concurrency, archive, and isolation behavior. |
| Audit/failure | Exact summaries, failed versus incomplete boundary, duplicate, response loss, terminal-audit failure, raw SQLite privacy, no private error leakage. |
| CLI | Exact parser/help/forms, explicit confirmation, internal operation id, dedicated loopback requests, response correlation, safe full rendering, bounds, no retry/legacy/list/storage path. |
| Vertical | Real CLI -> HTTP -> gate/audit -> production compact service -> SQLite with absent read, accepted start, event-proven running/completed reads, second-session isolation, duplicate rejection, and one fake compact transport call. |
| Ownership | No aggregate registration, event-pipeline wiring, restart rehydration, installed binary, UI, package/service, phone, or release claim. No dependency or planning change. |

## Validation Plan

- Focused selected contracts, compact adapter/service, write gate/audit, compact route, client, parser/shell/render, and package-export tests.
- Local-admin and paired private-HTTPS route tests covering reader/writer authority, CSRF, lock, malformed wire input, complete target/runtime/turn matrices, progress states, pre/post-dispatch drift, duplicate, response loss, terminal-audit failure, and bounded privacy-safe errors.
- Real SQLite vertical and raw audit inspection proving one accepted dispatch, event-proven running/completed reads, second-session isolation, no same-operation replay, and no prompt/interrupt/slash calls.
- Full unit, contract, integration, web, typecheck, lint/exports, scaffold, planning, frozen install, exact reviewed binding, and production dependency gates.
- Exact authenticated Codex 0.144.0 compact smoke. No physical phone is required for this headless leaf.

## Downstream Ownership

- `INT-V1-027` owns aggregate normalized-event delivery into compact observation and production callback composition.
- `INT-V1-029` owns restart reconciliation and honest unresolved progress after process/runtime restart.
- `IFC-V1-049` owns replayable cross-route operation responses and aggregate concurrency policy.
- `IFC-V1-046` owns aggregate selected production registration.
- `FE-V1-029` owns the approved mobile confirmation and absent/accepted/running/completed/interrupted/failed/incomplete surface.
- `IFC-V1-067` owns historical raw/slash/tmux surface disposition.
- Packaging/release leaves own an installed `codexdeck` executable and clean-install command smoke.

## Completion Evidence

- Implemented the strict target-free compact-start request, nullable compact-only progress response, and exact selected manifest ownership. The production compact service now parses complete selected mapping/projection records and rejects malformed, contradictory, misplaced, or recovery-state identity before dispatch or event observation.
- Added authenticated no-store GET and common-gate audited POST routes. Reads bracket one process-live snapshot with full target/runtime revalidation; starts require literal confirmation, idle/terminal turn admission, accepted audit, one receiverless service dispatch, accepted-only correlation, continuity recheck, and terminal audit proof.
- Added the dedicated bounded direct-loopback compact client and exact `compact SESSION_ID [--json]` plus `compact SESSION_ID --confirm [--json]` parser, shell, help, JSON, and terminal-safe text mappings. The CLI generates operation ids internally, never retries, and distinguishes absent, accepted, running, completed, interrupted, failed, and incomplete truth without slash, target, thread, force, or retry input.
- Route and service evidence covers local and paired private HTTPS authority, CSRF/lock ordering, malformed wire and selected state, capability/turn/runtime conflicts, pre/post-dispatch drift, every progress state, known rejection versus possible-send uncertainty, duplicate ids, raw response loss, terminal-audit failure, capacity, generation, archive, cross-session isolation, and bounded SQLite privacy.
- Focused validation passes for 70 compact adapter/service/route/write-gate/client/CLI tests, 58 selected contract/manifest tests, 12 fixtures, and one real CLI -> loopback HTTP -> selected gate/audit -> production compact service -> SQLite vertical. The vertical proves explicit absence, accepted-only start, event-proven running/completed reads, duplicate rejection, one runtime call, and second-session isolation.
- Workspace validation passes: unit 1,540 with 36 intentional external/device skips; contract 267; integration 23; web 33; root and all-package typechecks; lint/exports; scaffold; planning; frozen offline install; and diff checks. The reviewed Codex 0.144.0 binding verifies all 671 generated files, and the authenticated exact-runtime compact smoke passes twice after correcting its empty-thread usage assertion to require only actually observed token evidence.
- `pnpm audit --prod --audit-level=high` could not produce advisory evidence because npm's retired audit endpoint returned HTTP 410. No dependency or lockfile changed in this leaf.
- Criteria commit `73b2fc4`; implementation `163a129`.
