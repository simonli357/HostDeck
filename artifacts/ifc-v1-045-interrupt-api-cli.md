# IFC-V1-045 Interrupt API And CLI

Date: 2026-07-16

Status: hardening criteria frozen before implementation.

## Scope

Implement the selected exact-turn interrupt boundary from strict session/turn-scoped HTTP input through host-resolved thread/runtime admission, event-proven active-turn validation, the existing structured interrupt service, durable accepted-to-authoritative-terminal audit, and laptop-local source CLI mappings. This leaf owns one confirmed decision to interrupt one exact process-live active turn and one bounded wait for its authoritative terminal result. Aggregate route/event-pipeline composition, reconnect generation reconciliation, installed packaging, frontend behavior, runtime supervision, and release acceptance remain downstream.

## Pre-Change Findings

- The selected manifest owns `POST /api/v1/sessions/:session_id/turns/:turn_id/interrupt`, with the common session-write gate, paired-device CSRF, unlocked-host policy, turn targeting, `interrupt` audit, and `IFC-V1-045` ownership.
- The manifest names the internal `interruptOperationIntentSchema`, which requires a caller-supplied session/thread/turn target. The URL already names the durable HostDeck session and exact turn; callers must not supply Codex thread identity.
- The manifest returns the broad `selectedOperationProgressSchema`. A successful interrupt response needs a dedicated refinement so accepted, running, completed, failed, incomplete, compact, or foreign-target progress cannot satisfy terminal interrupt success.
- `CodexInterruptControlService` already requires selected active projection plus matching normalized `turn/started`, serializes one attempt per session, sends one exact `turn/interrupt`, separates known-not-sent/remote rejection from possible-send ambiguity, retains early terminal/archive events, and recognizes only matching `turn/completed: interrupted` as success.
- The service validates partial selected mapping/projection records, accepts broad option objects, does not tie selected runtime version to the turn client, reads state ports without typed failure mapping, and has no route-safe active-turn admission or abort-aware terminal wait.
- Service tests and the exact-runtime smoke use partial selected-state casts that do not prove the production identity boundary.
- Public route, dedicated source CLI client, exact command grammar, terminal-safe rendering, and real route/audit vertical evidence do not exist.
- The selected write summary already requires `{ interrupted: true }`. Returning adapter acceptance as HTTP/audit success would contradict that contract and the explicit distinction between `{}` acceptance and terminal interrupt proof.

## Frozen Wire Contract

- `POST /api/v1/sessions/:session_id/turns/:turn_id/interrupt` accepts strict session/turn params, no query, and a strict target-free body containing only `operation_id`, `kind: "interrupt"`, and literal `confirm: true`.
- Callers cannot provide a Codex thread id, alternate session/turn target, runtime version/generation, progress state, expected status, force, retry, timeout, archive/delete policy, raw input, slash text, or extra field.
- The internal target-bearing `interruptOperationIntentSchema` remains service-only. The public body uses a separate exported `interruptRequestSchema` and selected manifest id.
- A successful response is HTTP 200 and one strict `interruptResponseSchema`: exact request operation id; `kind: "interrupt"`; exact host-resolved turn target; `state: "interrupted"`; `turn_id` equal to the target turn; null error; and event-derived update time.
- Adapter acceptance, accepted progress, elapsed time, projection state, response delivery, or audit acceptance cannot satisfy the public success schema.
- The route has no interrupt GET, implicit HEAD, alternate path, cancel, stop, archive, delete, raw terminal, or slash endpoint.
- Public errors contain only canonical bounded selected fields. Raw adapter causes, terminal error text, thread/event frames, credentials, cookies, CSRF values, paths, prompts, and command output never become response fields.

## Frozen Product Semantics

- Every interrupt requires literal API/CLI confirmation and targets one exact event-proven active turn. The browser owns the confirmation dialog; the API requires literal confirmation.
- The route writes accepted audit before dispatch, invokes `interrupt` exactly once, and then waits event-driven under the unchanged request signal for authoritative service progress. It does not poll, redispatch, archive, delete, send text, or infer from elapsed time.
- Exact empty `turn/interrupt` response proves only internal `accepted`. Public success and terminal succeeded audit require matching normalized `turn/completed` with status `interrupted` for the same selected session/thread/turn.
- Matching `completed` or `failed` is authoritative non-interrupt terminal failure, never success. Archive before exact interrupt proof is incomplete and never substitutes for interruption.
- A known not-sent or remote-rejected response produces failed audit. A possible send remains one incomplete in-flight attempt with no retry; matching later interrupted evidence may still prove success before the request deadline, otherwise audit and HTTP outcome are incomplete.
- Missing active event, projection-only activity, idle/completed/wrong turn, already interrupted/attempted turn, stale target, and a second concurrent request reject without a second turn-client call.
- Terminal progress remains bounded process-live service truth. Restart and reconnect generation reconciliation remain downstream and cannot be inferred in this leaf.

## Target, Runtime, And Service Boundary

- Route and service parse complete selected mapping/projection records and prove matching session id, Codex thread id, name, cwd, runtime source/version, creation time, archive time, and selected disposition.
- Missing, archived, stale, recovery-required, contradictory, malformed, misplaced, or state-port-failed selected state rejects before interrupt wire dispatch.
- Runtime admission requires a connected `ready` or `degraded` exact-version binding, mutation policy `allowed`, and available `turn_interrupt` capability.
- Target resolution derives the thread only from selected state, requires an active projection state, and asks the production interrupt service to prove matching normalized `turn/started` identity and no unresolved/existing attempt before accepted audit.
- The route repeats that exact active-turn admission after accepted audit and before dispatch. The service repeats it under its per-session serialization immediately before the only turn-client call.
- The route calls service ports receiverlessly, passes the original request signal, validates accepted/early-terminal result correlation, waits receiverlessly when needed, and revalidates only stable selected target/runtime continuity after terminal proof; it does not require the turn to remain active after interruption.
- The production service adds exact accessor-free option/state parsing, turn-client runtime-version validation, fail-closed state-port errors, and one abort-aware event-driven terminal waiter without weakening existing race, early-event, archive, capacity, concurrency, or isolation rules.
- The waiter resolves only terminal `interrupted`, `failed`, or `incomplete` progress for the exact target, removes every listener on settle or abort, and creates no timer or polling loop. Request abort does not make retry safe.

## Audit And Failure Truth

- Accepted summary is exactly `{ schema_version: 1, confirmed: true }`.
- Terminal success is exactly `{ schema_version: 1, interrupted: true }` and is written only after exact event-proven interrupt terminal truth.
- Validation, authentication, authority, CSRF, lock, target/runtime/capability, and initial active-turn failures before accepted audit create no operation trail and never call the turn client.
- A typed proven-not-sent or remote-rejected service failure produces failed audit. Exact completed/failed terminal truth also produces failed audit because the requested interrupt did not occur.
- Possible-send ambiguity without matching proof, terminal-wait abort, archive, malformed result, untyped post-dispatch throw, or post-dispatch target/runtime drift produces incomplete audit.
- A possible-send error followed by exact matching interrupted proof before deadline may succeed because normalized terminal evidence is authoritative over transport uncertainty.
- Duplicate operation ids and raw response loss never cause a second interrupt. Terminal-audit failure suppresses public success without compensation, archive, deletion, state clearing, or redispatch.
- Audit target contains only repository-wide typed session/thread/turn ids. Summaries exclude projection text, prompt, paths, terminal error text, event payloads, runtime frames, and private causes.

## Failure Matrix

| Case | Required result |
| --- | --- |
| Invalid path/query/body/confirmation/CLI option | Reject before target, audit, service mutation, or Codex access. |
| Missing/archived/stale/recovery/contradictory target | Stable bounded error; no interrupt call. |
| Runtime disconnected/version drift/capability unavailable | Stable unavailable/incompatible error; no interrupt call. |
| Locked host, read-only device, absent/invalid CSRF | Stable authority error before target/service/audit dispatch. |
| Projection active without matching start event | Conflict before accepted audit; no interrupt call. |
| Idle/completed/wrong/foreign/already-attempted turn | Conflict; no interrupt call. |
| Initial confirmed exact interrupt | Accepted audit, one turn-client call, bounded event-driven terminal wait. |
| Exact interrupted terminal proof | HTTP 200 exact terminal response and succeeded terminal audit. |
| Exact completed/failed terminal proof | Failed audit and bounded conflict; never interrupted success. |
| Archive before terminal proof | Incomplete audit/error; never archive-as-interrupt. |
| Known not sent or remote rejected | Failed audit/error; explicit later operation is possible only if exact active evidence still permits it. |
| Possible send without terminal proof | Incomplete audit/error; no retry. |
| Possible send then exact interrupted proof | Succeeded response/audit; one interrupt call. |
| Malformed result or post-dispatch drift | Incomplete audit/error; service truth remains authoritative; no retry. |
| Concurrent/duplicate operation or response loss | One winner; no second turn-client call. |
| Terminal audit failure | Suppress response; preserve service truth; never compensate or redispatch. |

## Frozen CLI Contract

- `codexdeck interrupt SESSION_ID TURN_ID --confirm [--json]` is the only source CLI form.
- Confirmation is mandatory, literal, non-repeatable, and has no value. There is no session-only implicit-current-turn form.
- The source CLI generates an internal `op_interrupt_<uuid>` operation id. It exposes no operation-id, thread id, runtime/generation, expected state, force, retry, timeout, archive/delete, raw text, slash, remote-runtime, or option-terminator surface.
- A dedicated direct-loopback client sends one exact POST, enforces byte/time/status/schema/result-correlation bounds, sanitizes typed and untyped failures, and never retries. The shell uses it receiverlessly without list/alias/storage/legacy API access.
- JSON output is the exact strict terminal interrupt response. Text output escapes terminal controls and reports interruption as final only from the exact HTTP 200 event-proven response; accepted/incomplete progress cannot render as success.

## Hard Success Criteria

| Area | Required evidence |
| --- | --- |
| Contract/manifest | Strict target-free request, literal confirmation, interrupt-only terminal response, exact schema ids/exports, internal intent retained service-only, exact POST manifest assertions. |
| Write gate | Parse -> authority/CSRF -> lock -> target/runtime/active-event admission -> accepted audit -> active admission recheck -> one interrupt -> event-driven terminal wait -> result correlation -> continuity recheck -> terminal proof. |
| Interrupt service | Complete selected identity/disposition/runtime validation, exact active-event admission, waiter cleanup, plus existing response/event race, ambiguity, archive, capacity, concurrency, terminal contradiction, and isolation behavior. |
| Audit/failure | Exact summaries, failed versus incomplete boundary, possible-send eventual proof, completed/failed/archive distinction, duplicate/response loss, terminal-audit failure, raw SQLite privacy. |
| CLI | Exact parser/help/form, explicit confirmation, internal operation id, dedicated loopback request, terminal correlation/rendering, bounds, no retry/legacy/list/storage path. |
| Vertical | Real CLI -> HTTP -> gate/audit -> production interrupt service -> SQLite with accepted in-flight snapshot, exact terminal event, final response, one interrupt call, second-session isolation, duplicate rejection, and audit/privacy inspection. |
| Ownership | No aggregate registration, event-pipeline wiring, reconnect/restart reconciliation, installed binary, UI, package/service, phone, or release claim. No dependency change. |

## Validation Plan

- Focused selected contracts, turn adapter/interrupt service, write gate/audit, interrupt route, client, parser/shell/render, and package-export tests.
- Local-admin and paired private-HTTPS route tests covering writer/read-only authority, CSRF, lock, malformed wire input, complete target/runtime/active-event matrices, known/unknown outcomes, exact interrupted/completed/failed/archive terminal states, wait abort, duplicate, response loss, terminal-audit failure, and bounded privacy-safe errors.
- Real SQLite vertical and raw audit inspection proving one accepted interrupt, accepted progress while HTTP is in flight, event-proven final response, second-session isolation, no same/distinct-operation replay, and no archive/delete/prompt/slash calls.
- Full unit, contract, integration, web, root/all-package typecheck, lint/exports, scaffold, planning, frozen install, exact reviewed binding, production dependency gates, and diff checks.
- Exact authenticated Codex 0.144.0 interrupt smoke. No physical phone is required for this headless leaf.

## Downstream Ownership

- `INT-V1-027` owns aggregate normalized-event delivery into interrupt observation and production callback composition.
- `INT-V1-028` and `INT-V1-029` own reconnect generation and restart reconciliation of unresolved interrupt truth.
- `IFC-V1-049` owns cross-route replayable operation responses and aggregate concurrency policy.
- `IFC-V1-046` owns aggregate selected production registration.
- `FE-V1-036` owns the approved mobile confirmation, pending, terminal, accessibility, and visual acceptance surface.
- `IFC-V1-067` owns historical raw/slash/tmux surface disposition.
- Packaging/release leaves own an installed `codexdeck` executable and clean-install command smoke.
