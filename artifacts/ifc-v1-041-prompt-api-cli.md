# IFC-V1-041 Prompt API And CLI

Date: 2026-07-15

Status: hardening criteria frozen before implementation.

## Scope

Implement the selected one-session prompt boundary from strict session-scoped wire intent through host-resolved target admission, durable accepted-to-terminal dispatch audit, the existing exact Codex prompt service, one truthful `202` response, and the laptop-local source CLI `send` command. This leaf owns only prompt dispatch acceptance. Structured event projection owns later running/completed/interrupted/failed truth; aggregate route composition, installed packaging, frontend behavior, runtime supervision, and release acceptance remain downstream.

## Pre-Change Findings

- The selected manifest owns `POST /api/v1/sessions/:session_id/prompts`, selected session-write authority, device CSRF, unlocked-host policy, managed-session targeting, `prompt` audit, and `IFC-V1-041` ownership.
- Its body currently names the internal `promptOperationIntentSchema`, which requires a caller-supplied Codex thread id. The URL already names the durable HostDeck session, the selected detail route is not implemented, and callers must not choose or discover a runtime target before host authorization.
- The manifest names `prompt_dispatch_response_v1`, but no executable public response schema owns that id. The generic dispatch receipt omits the accepted Codex turn and whether the service started or steered, while the internal prompt snapshot includes pending-control and race state that must not become a public dispatch response.
- `createCodexPromptControlService` already serializes each session; composes pending model/Plan settings into one `turn/start`; tracks accepted/start/terminal event races; permits event-proven exact-turn steer; latches ambiguous outcomes; and isolates threads. Its direct target check does not yet reject every mapping/projection identity contradiction or non-selected disposition required at the selected API boundary.
- The existing shell `send` branch resolves an alias through the historical session list and calls `/api/sessions/:id/input` through the deprecated generic client. It is not selected-route evidence and must not be reused, retried, or described as the V1 prompt command.
- `IFC-V1-061` now provides the required unresolved-target gate mode and exact durable accepted-audit receipt without weakening existing caller-resolved mutations.

## Frozen Wire Contract

- `POST /api/v1/sessions/:session_id/prompts` accepts one strict session-id path and a strict body containing only `operation_id`, `kind: "prompt"`, and one canonical trimmed nonempty `text` of at most 20,000 characters. It accepts no target, Codex thread/turn id, action, model/Plan setting, alias, retry flag, query, or extra field.
- The path session id is an authorization-delayed selector. After write authentication, CSRF, lock, and deadline checks, the host loads one exact selected mapping/projection and derives the immutable managed-session audit target from its durable Codex thread id.
- HTTP success is `202` with one strict prompt dispatch response: matching operation id, literal prompt kind, host-resolved target, `state: "accepted"`, actual durable accepted-audit id/time, exact accepted Codex turn id, and `action: "start" | "steer"`. It sets `no-store`, disables implicit `HEAD`, and returns no prompt text, cwd, mapping row, pending model/Plan revision, steerability flag, raw adapter state, or legacy backend field.
- `accepted` means the one Codex start/steer request returned its exact acceptance and the HostDeck terminal audit proved dispatch success. It is not running or terminal turn truth. A matching structured event/projection alone may later establish running, completed, interrupted, or failed.
- Public request and response schemas remain distinct from `promptOperationIntentSchema` and `PromptTurnControlSnapshot`. The route alone materializes the internal exact-target intent.

## Target And Runtime Admission

- Target resolution parses complete mapping and projection records and proves matching session id, Codex thread id, name, cwd, runtime source/version, creation time, archive time, and selected disposition.
- Prompt admission requires an unarchived selected active session with current freshness and a turn state that the prompt service can safely start or steer. Archived, stale, recovery, incompatible, unknown, waiting-for-input, waiting-for-approval, contradictory, or otherwise non-writable state rejects before accepted audit.
- Runtime admission requires strict ready or safely degraded compatibility, mutation policy `allowed`, non-null reviewed binding/version, exact mapping-version agreement, and available required prompt/steer capabilities. Disconnected, malformed, blocked, unknown, unavailable, or version-drift runtime rejects before audit.
- Immediately before the service call, the route re-reads target and runtime admission and requires exact agreement with the gate resolution. The prompt service independently re-reads selected state and rejects target/thread drift, mapping/projection identity contradiction, non-selected disposition, archive, stale freshness, and unsafe turn state.

## Dispatch And Audit Truth

- The accepted audit summary is exactly `{ schema_version: 1, text_length }`; prompt content is never audited. The terminal success summary is exactly `{ schema_version: 1, accepted: true }` and means dispatch acceptance only.
- The route invokes `CodexPromptControlService.dispatch` exactly once with the canonical text, internal operation id, host-resolved target, and original request signal. It never calls raw input, slash injection, another session, filesystem, tmux, or the historical API client.
- Idle/completed/interrupted/failed terminal turn truth may start one new turn. An in-progress turn may steer only when the service already owns matching accepted plus `turn/started` evidence. Event-unproven, stale, waiting, unknown, or foreign active turns reject; steer never falls back to a second start.
- Pending model and Plan revisions remain one atomic prompt transaction. Conflict/unknown revisions reject before wire; matching revisions settle through the one accepted turn; contradictory accepted revisions latch unknown without retry.
- The response action, thread target, and turn id must equal the service result. The response uses the durable accepted-audit id/time, not an invented route timestamp. Response preparation and terminal audit occur after dispatch and cannot cause redispatch.

## Outcome Rules

| Condition | Required truth |
| --- | --- |
| Invalid path/body, whitespace-only/oversized text, or invented field | Reject before target state, audit, prompt service, or Codex access. |
| Unauthorized, read-only, stale CSRF/device authority, insecure, or locked request | Reject through the common gate before target resolution or dispatch. |
| Missing managed session | `session_not_found`; no accepted audit or runtime request. |
| Archived or non-writable session/turn | `session_not_writable`; no accepted audit or runtime request. |
| Stale, recovery, contradictory, or changed target | `stale_session` or bounded storage failure; no cross-target dispatch. |
| Disconnected runtime | `runtime_unavailable`; no accepted audit or prompt request. |
| Incompatible, mutation-blocked, capability-unavailable, or version-drift runtime | `incompatible_runtime`; no accepted audit or prompt request. |
| Audit preflight unavailable, duplicate, conflicting, or unproven | No Codex request and no prompt state change. |
| Known not-sent or remote-rejected prompt | Failed terminal audit with bounded public cause; explicit retry only when the cause says safe. |
| Timeout, disconnect, abort, malformed acceptance, or contradictory accepted identity after possible send | Incomplete terminal audit; service latches unknown where applicable; no automatic retry. |
| Codex accepts exact start/steer | Succeeded dispatch audit and strict accepted response; no running/completed claim. |
| Response preparation or HTTP delivery fails after acceptance | Accepted Codex turn and durable audit remain authoritative; repeating the same operation id cannot dispatch again. |
| Terminal audit cannot be proven | Suppress success response, retain pending/unproven audit plus service truth, and never compensate or redispatch. |
| Process dies after accepted audit | Startup orphan reconciliation records one explicit incomplete terminal; no blind prompt replay. |
| Concurrent prompt operations for one session | Per-session serialization prevents two starts. Each operation dispatches at most once; a later steer is allowed only for the exact event-proven turn and keeps its own audit truth. |
| Same operation id is retried | Existing audit truth blocks another dispatch; response replay remains `IFC-V1-049`. |

## CLI Contract

- The selected source surface is `codexdeck send SESSION_ID TEXT... [--json]`. It accepts one exact managed session id, joins the explicit text arguments into the canonical prompt, and generates the operation id internally.
- A dedicated direct-loopback client performs one POST to the selected `/api/v1` path, validates strict request/response correlation, bounds URL/body/response/time, sanitizes typed and untyped failures, and never retries.
- The shell does not list sessions, resolve aliases, read local storage, call the historical generic API client, inspect a Codex thread id, or expose operation-id, target, turn, mode, force, remote-URL, or retry options.
- Text output says only that a start or steer was accepted for the named session/turn. JSON output is the strict prompt dispatch response. Neither mode echoes the prompt or labels acceptance as running/completed.
- Help exposes the exact selected syntax. Historical generic-client prompt methods may remain migration evidence until `IFC-V1-067`, but the selected shell path and tests must not import or invoke them.

## Hard Success Criteria

| Area | Required evidence |
| --- | --- |
| Contracts/manifest | Strict target-free request and prompt-specific accepted response; exact keys, bounds, transforms, turn/action coherence, exports, schema ids, and manifest agreement. Internal target-bearing intent remains service-only. |
| Gate/order | Parse -> local-admin or paired HTTPS writer/CSRF -> one lock read -> target/runtime resolution -> accepted audit -> one service dispatch -> response preparation -> terminal proof. Original signal/deadline and actual audit receipt are preserved. |
| Target/runtime | Full mapping/projection identity, selected disposition, archive/freshness/session/turn state, runtime binding/version/mutation/capability, pre-dispatch re-read, and cross-session isolation. |
| Prompt service | Start, exact event-proven steer, fast/early/foreign event races, pending model/Plan composition, known rejection, possible-send ambiguity, capacity/concurrency, terminal reconciliation, and strengthened state-identity checks. |
| Route/authority | Exact manifest assertion, branded ports, once-only registration, local admin and paired private-HTTPS parity, auth before state, no-store `202`, adjacent method/path rejection, stable bounded errors, and no prompt/private-cause reflection. |
| Audit | Real accepted id/time in response; accepted text length only; terminal dispatch-accepted summary only; duplicate operation, response failure, terminal-audit failure, orphan reconciliation, and raw SQLite privacy. |
| CLI client | Exact loopback origin, one POST, canonical body, strict correlation, byte/time bounds, no retry, sanitized fetch/JSON/schema/API errors, and rejection of remote/basic-auth/query/fragment/path-confused bases. |
| CLI shell/render | Exact session/text parser, internal operation id, receiverless dedicated client, safe text/JSON output, help, and no selected list/detail/legacy client/storage dependency or prompt echo. |
| Ownership | No aggregate registration, installed binary, UI, package, service, phone, turn-terminal, or release claim. No new dependency or planning choice. |

## Validation Plan

- Focused selected contract/manifest, prompt service, write gate/audit executor, route, client, parser/shell/render, and package-export tests.
- Real SQLite audit tests for accepted/terminal identity, prompt-free summaries/raw bytes, duplicate operation, response preparation/delivery loss, terminal-audit failure, and orphan reconciliation.
- Local-admin and paired private-HTTPS route tests plus raw HTTP response-loss evidence proving same-operation retry does not redispatch.
- One exact CLI-to-HTTP-to-gate/audit-to-prompt-service/SQLite/fake-Codex vertical covering start acceptance, later event progress separation, cross-session isolation, and cleanup.
- Adjacent auth, CSRF, lock, deadline, runtime compatibility, selected-state, pending model/Plan, manifest, adapter turn, and historical-shell isolation regressions.
- Full unit, contract, integration, web, typecheck, lint/exports, scaffold, planning, frozen install, exact reviewed binding, and production supply-chain gates.
- Rerun the exact Codex 0.144.0 authenticated prompt smoke when the isolated reviewed binary is available. No physical phone is required for this headless leaf.
- Manual staged diff, target/order/deadline, acceptance-versus-completion, no-second-dispatch, audit/raw-storage/privacy, public output, selected/legacy import separation, cleanup, and owning-doc review.

## Downstream Ownership

- Structured projection/SSE and `FE-V1-020` own running/completed/interrupted/failed presentation after dispatch acceptance.
- `IFC-V1-049` owns replayable cross-route operation-id responses and aggregate concurrency policy.
- `IFC-V1-046` owns production registration with every selected route and remote ingress.
- `IFC-V1-067` owns removal or isolation of historical generic prompt/list/tmux/custom-listener surfaces.
- `IFC-V1-021` and packaging/release leaves own an installed `codexdeck` executable and clean-install command smoke.
