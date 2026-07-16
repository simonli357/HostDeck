# IFC-V1-044 Approval API And CLI

Date: 2026-07-16

Status: hardening criteria frozen before implementation.

## Scope

Implement the selected one-session approval list and exact confirmed approval-response boundary from strict session/request-scoped HTTP input through host-resolved target/runtime admission, the existing structured approval service, durable accepted-to-authoritative-terminal audit, and laptop-local source CLI mappings. This leaf owns one bounded process-live approval view and one exact decision attempt. Aggregate route/event-pipeline composition, restart reconciliation, installed packaging, frontend behavior, runtime supervision, and release acceptance remain downstream.

## Pre-Change Findings

- The selected manifest owns `GET /api/v1/sessions/:session_id/approvals` and `POST /api/v1/sessions/:session_id/approvals/:request_id/respond`, with session-read authority for GET and the common session-write gate, paired-device CSRF, unlocked-host policy, approval targeting, `approval_response` audit, and `IFC-V1-044` ownership for POST.
- The POST manifest names the internal `approvalResponseOperationIntentSchema`, which requires a caller-supplied session/thread/request target. The URL already names the durable HostDeck session and normalized runtime request; callers must not supply runtime identity.
- Manifest ids for approval params/list/response have no dedicated public schemas. An empty list needs an exact target for correlation, while a response needs operation, requested-decision, target, and terminal-state correlation.
- `CodexApprovalControlService` already parses both reviewed callback kinds, owns connection-bound request identity and expiry, serializes per request, sends approve/deny exactly once, latches possible-send ambiguity, and finalizes a user decision only from exact request-resolution plus item-terminal evidence.
- The service validates only partial selected mapping/projection identity and does not provide a bounded event-driven terminal wait for the HTTP/audit boundary. Its current tests use partial selected-state fixtures that would not survive complete production identity validation.
- The selected write summary says `{ applied: true }` as soon as dispatch returns. The service intentionally returns `responding` after a known send, so that summary would claim terminal decision truth without the required events.
- Public routes, dedicated source CLI client, exact command grammar, terminal-safe rendering, and real route/audit vertical evidence do not exist.

## Frozen Wire Contract

- `GET /api/v1/sessions/:session_id/approvals` accepts one strict session id, no query, no body or body framing, and no implicit HEAD. It returns HTTP 200, `Cache-Control: no-store`, `Pragma: no-cache`, and one strict `{ target, approvals }` object.
- `target` is the exact host-resolved managed session target. `approvals` is a bounded, creation/request-id ordered list of strict `PendingApproval` values for that target, including pending/responding and retained approved/denied/expired/superseded process-live truth. An empty list is explicit and target-correlated.
- `POST /api/v1/sessions/:session_id/approvals/:request_id/respond` accepts strict session/request params, no query, and a strict target-free body containing only `operation_id`, `kind: "approval_response"`, `decision: "approve" | "deny"`, and literal `confirm: true`.
- Callers cannot provide a Codex thread/turn/item id, connection generation, runtime version, protocol request id, approval state, action/scope/reason/risk, force, retry, timeout, response policy, raw command, or extra field.
- The internal target-bearing `approvalResponseOperationIntentSchema` remains service-only. The public request uses a separate exported `approvalResponseRequestSchema` and selected manifest id.
- A successful POST returns HTTP 200 with strict `{ operation_id, requested_decision, approval }`. It requires exact request/target correlation and an authoritative terminal `approved`/`approve` or `denied`/`deny` pair. It never returns `responding` as terminal success.
- Public approval and API errors contain only bounded selected fields or canonical public messages. Raw generated payloads, protocol ids, adapter causes, cookies, credentials, runtime frames, and unbounded command output never become error fields.

## Frozen Product Semantics

- Every user decision requires literal API/CLI confirmation. The eventual browser confirmation dialog is risk-dependent, but its POST always carries literal confirmation.
- A decision response is exactly one-time `approve` or `deny`; no session grant, policy amendment, cancel, command edit, or fallback text input is exposed.
- The route writes accepted audit before dispatch, invokes `respond` exactly once, and then waits event-driven under the unchanged request signal for the service's authoritative terminal state. It does not poll, redispatch, or infer from elapsed time.
- `approved`/`denied` requires both exact `serverRequest/resolved` and matching command/file item terminal evidence in the same connection-bound service record. Adapter send completion, one event, projection attention, HTTP time, terminal text, and audit acceptance are not terminal proof.
- A known not-sent response resets service truth to pending and produces failed audit. A possible send remains responding with no retry; matching later terminal events may still prove success before the request deadline, otherwise audit and HTTP outcome are incomplete.
- Expired, superseded, responding, already approved/denied, wrong-target, and absent requests cannot dispatch another decision. Two operation ids racing one request still produce one app-server response.
- GET may cause the existing service to process a due expiry and one system decline; it never creates a user decision or user-mutation audit. Retained approval truth remains process-live and restart reconciliation stays downstream.

## Target, Runtime, And Service Boundary

- Both routes parse complete selected mapping/projection records and prove matching session id, Codex thread id, name, cwd, runtime source/version, creation time, archive time, and selected disposition.
- Missing, archived, stale, recovery-required, contradictory, malformed, or misplaced selected state fails before user-response dispatch. GET brackets one list with target/runtime revalidation.
- Runtime admission requires a connected `ready` or `degraded` exact-version binding and available `approvals` capability. GET may read while mutation policy or host writes are blocked; POST requires mutation policy `allowed`.
- POST target resolution snapshots the exact request and requires `pending` before accepted audit. It revalidates the same pending approval and target/runtime after accepted audit and before dispatch.
- The route invokes the approval service receiverlessly, passes the exact host-resolved approval target and decision, performs no adapter/list/storage fallback, and revalidates target/runtime continuity after authoritative terminal proof.
- The production approval service must perform complete selected-state parsing, cross-record identity/disposition/runtime checks, exact session/thread lookup validation, fail-closed state-port errors, and accessor-free option/state handling without weakening existing expiry, race, generation, capacity, response, event, or isolation rules.
- The service adds one bounded abort-aware event-driven terminal wait. It resolves only a closed approval state, cleans every waiter on settle/supersede/abort/close, creates no timer or polling loop, and never turns abort into permission to retry.

## Audit And Failure Truth

- The accepted summary is exactly `{ schema_version: 1, decision, confirmed: true }`.
- Terminal success is exactly `{ schema_version: 1, decision_finalized: true }` and is written only for the exact matching final decision.
- Validation, authentication, authority, CSRF, lock, target, request-state, runtime, and capability failures before accepted audit create no operation trail and never call `respond`.
- A typed proven-not-sent service failure produces failed audit. A possible-send failure that does not reach matching terminal proof, terminal-wait abort, disconnect/supersede after send, malformed result, untyped post-dispatch throw, or post-dispatch target/runtime drift produces incomplete audit.
- A possible-send adapter error followed by exact matching terminal proof before deadline may succeed because runtime evidence proves the decision despite transport uncertainty.
- Duplicate operation ids and raw response loss never cause a second decision. Terminal-audit failure suppresses public success without compensation, state deletion, alternate decision, or redispatch.
- The Codex thread and normalized request ids appear only in the repository-wide typed approval audit target. Summaries exclude action, scope, reason, risk, raw protocol id, turn/item ids, paths, command text, event text, and private payloads.

## Failure Matrix

| Case | Required result |
| --- | --- |
| Invalid path/query/body/decision/confirmation/CLI option | Reject before target, audit, service, or Codex access. |
| Missing/archived/stale/recovery/contradictory target | Stable bounded error; no list leak or user response. |
| Runtime disconnected/version drift/capability unavailable | Stable unavailable/incompatible error; no user response. |
| GET with writes blocked or host locked | Current exact list remains readable. |
| Empty list | HTTP 200 exact target plus empty approvals; no invented request. |
| Pending/responding/final/expired/superseded list | Exact bounded process-live truth in deterministic order. |
| Initial confirmed decision | Accepted audit, one response send, bounded wait for exact terminal events. |
| Exact terminal proof | HTTP 200 matching final decision and succeeded terminal audit. |
| Known response not sent | Failed audit/error; request remains pending and explicit later operation may try once. |
| Possible send without terminal proof | Incomplete audit/error; request remains responding; no retry. |
| Possible send then exact terminal proof | Succeeded response/audit; one response call. |
| Duplicate/racing decision | One winner; loser conflict; no second app-server response. |
| Expired/superseded/resolved request | Read-only state or conflict; no response call. |
| Malformed result or post-dispatch drift | Incomplete audit/error; service truth remains authoritative; no retry. |
| Duplicate operation id or response loss | Existing audit truth blocks another service response. |
| Terminal audit failure | Suppress response; preserve service truth; never compensate or redispatch. |

## Frozen CLI Contract

- `codexdeck approvals SESSION_ID [--json]` reads one managed session's exact approval list.
- `codexdeck approvals SESSION_ID REQUEST_ID approve|deny --confirm [--json]` responds to one exact pending request. Confirmation is mandatory, literal, non-repeatable, and has no value.
- The source CLI generates an internal `op_approval_<uuid>` operation id. It exposes no operation-id, target/thread/turn/item, runtime/generation, force, retry, timeout, policy, grant-scope, raw-command, slash, or remote-runtime surface.
- A dedicated direct-loopback client sends one exact GET or POST, enforces byte/time/status/schema/result-correlation bounds, sanitizes typed and untyped failures, and never retries. The shell uses it receiverlessly without list/alias/storage/legacy API access.
- JSON output is the exact strict response. Text output escapes terminal controls, renders target-correlated empty and all approval states, includes bounded action/scope/reason/risk/grant/expiry detail, and reports a decision command as final only from the exact successful terminal response.

## Hard Success Criteria

| Area | Required evidence |
| --- | --- |
| Contract/manifest | Strict params, target-free request, literal confirmation, target-correlated list, operation/decision/final response, exact schema ids/exports, internal intent retained service-only, exact GET/POST manifest assertions. |
| Read route | Once-only registration, no body/query/HEAD, auth-before-state, local/paired parity, deterministic bounded list, canonical errors, target/runtime post-read bracket, no-store exact HTTP 200. |
| Write gate | Parse -> authority/CSRF -> lock -> exact pending target/runtime -> accepted audit -> pending recheck -> one respond -> event-driven terminal wait -> result correlation -> continuity recheck -> terminal proof. |
| Approval service | Complete selected identity/disposition/runtime validation and waiter cleanup plus existing callback, expiry, response, event, generation, race, capacity, concurrency, close, archive, and isolation behavior. |
| Audit/failure | Exact summaries, failed versus incomplete boundary, possible-send eventual proof, duplicate/race, response loss, terminal-audit failure, raw SQLite privacy, no payload/error leakage. |
| CLI | Exact parser/help/forms, explicit confirmation, internal operation id, dedicated loopback requests, request/decision/result correlation, safe full rendering, bounds, no retry/legacy/list/storage path. |
| Vertical | Real CLI -> HTTP -> gate/audit -> production approval service -> SQLite with empty/pending/responding/final reads, one response, exact events, second-session isolation, duplicate rejection, and audit/privacy inspection. |
| Ownership | No aggregate registration, callback/event-pipeline composition, restart rehydration, installed binary, UI, package/service, phone, or release claim. No dependency change. |

## Validation Plan

- Focused selected contracts, approval adapter/service, write gate/audit, approval route, client, parser/shell/render, and package-export tests.
- Local-admin and paired private-HTTPS route tests covering reader/writer authority, CSRF, lock, malformed wire input, complete target/runtime/request matrices, every approval state, expiry and two-client races, known/unknown response outcomes, terminal wait abort, duplicate, response loss, terminal-audit failure, and bounded privacy-safe errors.
- Real SQLite vertical and raw audit inspection proving one accepted response, responding visibility while the POST is in flight, event-proven final read/response, second-session isolation, no same-operation replay, and no policy/raw/slash calls.
- Full unit, contract, integration, web, typecheck, lint/exports, scaffold, planning, frozen install, exact reviewed binding, and production dependency gates.
- Exact authenticated Codex 0.144.0 approval smoke. No physical phone is required for this headless leaf.

## Downstream Ownership

- `INT-V1-027` owns aggregate callback/event delivery into approval observation and production callback composition.
- `INT-V1-029` owns restart reconciliation and honest unresolved approval state after process/runtime restart.
- `IFC-V1-049` owns cross-route idempotency/replay and aggregate concurrency policy beyond this exact request race.
- `IFC-V1-046` owns aggregate selected production registration.
- `FE-V1-022` owns the approved mobile inline approval, risk-dependent confirmation, duplicate-disable, final-state, accessibility, and visual acceptance surface.
- `IFC-V1-067` owns historical raw/tmux surface disposition.
- Packaging/release leaves own an installed `codexdeck` executable and clean-install command smoke.
