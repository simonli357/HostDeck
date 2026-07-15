# IFC-V1-061 Managed-Thread Archive

Date: 2026-07-15

Status: hardening criteria frozen before implementation.

## Scope

Implement the selected managed-thread archive boundary from exact wire intent through host-resolved target admission, durable accepted-to-terminal audit, the existing Codex archive saga, strict `/api/v1` response, and laptop-local source CLI command. This leaf may narrowly extend the common selected write gate so a URL-scoped mutation can resolve its immutable Codex thread identity after authorization and so a dispatch response can carry the real durable accepted-audit receipt. It does not own selected session list/detail routes, aggregate production registration, cross-route response replay, frontend behavior, package installation, runtime supervision, or release acceptance.

## Pre-Change Findings

- The selected manifest owns `POST /api/v1/sessions/:session_id/archive`, selected session-write authority, device CSRF, unlocked-host policy, exact managed-session targeting, `archive` audit, and `IFC-V1-061` ownership.
- The manifest currently points its body at the internal `archiveOperationIntentSchema`. That schema requires a caller-supplied Codex thread id even though the URL names the durable HostDeck session. The selected session detail route is not implemented and is not a dependency of this leaf, so a safe source CLI cannot obtain that id through the selected API.
- The common write gate currently requires the audit target to be parsed before authorization and forbids target materialization during the target-resolution stage. That is correct for caller-known approval/turn identities but unnecessarily couples a URL-scoped lifecycle mutation to a caller-provided runtime identity.
- The selected archive response is the strict selected-operation dispatch receipt. It requires the accepted audit record id and time, but the selected audit executor currently passes only `audit_state: accepted` to the gate and discards that proven receipt.
- `ManagedCodexThreadService.archive` already serializes per session, verifies one runtime thread, dispatches one `thread/archive`, persists archived mapping/projection state, latches uncertain outcomes, and reconciles a remote-success/local-failure case. It currently treats an already archived session as success and does not reject every stale, active, contradictory, or runtime-version-drift state required by the selected write contract.
- The historical `codexdeck stop` command targets tmux-shaped behavior. It is not archive evidence and must not be reused, aliased, or described as the selected lifecycle operation.

## Frozen Wire Contract

- `POST /api/v1/sessions/:session_id/archive` accepts one strict session-id path and a strict body containing only `operation_id`, `kind: "archive"`, and `confirm: true`. It accepts no Codex thread id, alias, import source, delete flag, interrupt flag, prompt, query, or extra field.
- The path session id is a selector, not yet the audit target. After authentication, lock, and deadline checks, the host loads one strict selected mapping/projection and derives the immutable managed-session audit target from its durable Codex thread id.
- The route returns HTTP `202` with the exact selected-operation dispatch schema: matching operation id, `kind: "archive"`, the host-resolved target, `state: "accepted"`, and the actual durable accepted-audit id/time. It sets `no-store`, disables implicit `HEAD`, and returns no mapping row, cwd, transcript, adapter error, or legacy backend field.
- `accepted` is not delete, interrupt, event completion, or a claim that the client received later projection state. The service and terminal audit must already have a truthful outcome before the response is released, while the generic receipt remains compatible with the selected operation contract.
- The CLI surface is `codexdeck archive SESSION_ID [--json]`. The explicit verb plus one exact session id is the CLI confirmation; the shell emits literal `kind: archive` and `confirm: true`. It generates the operation id internally and exposes no operation-id, thread-id, alias, force, delete, interrupt, remote-URL, or retry option.

## Common-Boundary Extensions

- Add a branded unresolved selected-write request form containing exact operation/action/summary, one bounded route selector, and canonical value but no audit target. Existing caller-resolved mutations remain unchanged.
- The gate authenticates and checks the host lock before invoking the unresolved target resolver. The resolver must return one branded exact target with the manifest-required type/capability. The gate then materializes the ordinary immutable mutation and uses only that exact target for audit and dispatch.
- Existing caller-resolved mode retains its strict deep-equality rule. Unresolved mode cannot change operation id, action, summary, selector, or value; cannot resolve a target of another manifest type; and cannot read target state before authorization.
- After durable accepted proof, the selected audit executor passes one frozen receipt containing only `audit_state`, accepted record id, and accepted time. The gate validates the exact shape and makes the receipt available to dispatch. A selected-write audit port that omits, invents, mutates, or duplicates the receipt fails closed.
- Security-executor callers retain their existing accepted/deferred context and receive no invented selected receipt. Existing selected session-start and device-revoke behavior must remain unchanged.

## Target And Dispatch Invariants

- Target resolution parses the complete mapping and projection and proves matching session id, Codex thread id, name, cwd, runtime source/version, creation time, archive time, and selected disposition.
- A target is archivable only when mapping and projection are unarchived, selected, active, current, and idle with no active/waiting/unknown turn. Missing, archived, recovery-required, stale, contradictory, or non-idle state rejects before accepted audit.
- Runtime admission requires one strict ready or safely degraded compatibility snapshot, mutation policy `allowed`, non-null reviewed binding/version, exact mapping-version agreement, and available `thread_lifecycle` capability. Disconnected, malformed, blocked, unknown, unavailable, or version-drift state rejects before audit.
- The service re-reads and revalidates durable state, current adapter runtime version, exact returned thread id/cwd/source, and idle runtime status immediately before dispatch. A race between route resolution and service dispatch cannot archive a changed, stale, active, or already archived target.
- Exactly one `thread/archive` is sent for one accepted operation. Archive never calls interrupt, delete, prompt, turn start/steer, arbitrary import, shell, tmux, or filesystem removal.
- Remote success is persisted with one optimistic replacement. The mapping remains present, retains its immutable identity and history, gains one archive time, and the projection becomes archived/idle/current without deleting retained events. No state marks the row archived before remote success is known.

## Outcome Rules

| Condition | Required truth |
| --- | --- |
| Invalid path/body, false/missing confirmation, or invented field | Reject before target state, audit, service, or Codex access. |
| Unauthorized, read-only, stale CSRF/device authority, insecure, or locked request | Reject through the common gate before target resolution or dispatch. |
| Missing managed session | `session_not_found`; no accepted audit or runtime request. |
| Already archived or non-idle target | `session_not_writable`; no accepted audit or runtime archive. |
| Stale, recovery-required, contradictory, or changed target | `stale_session` or bounded internal storage failure according to proven state; no premature dispatch. |
| Disconnected runtime | `runtime_unavailable`; no accepted audit or archive request. |
| Incompatible, mutation-blocked, capability-unavailable, or version-drift runtime | `incompatible_runtime`; no accepted audit or archive request. |
| Audit preflight unavailable, duplicate, conflicting, or unproven | No Codex archive and no state change. |
| Concurrent different operation against the same session | At most one runtime archive; the loser records a failed conflict only if its accepted audit already exists. |
| Known not-sent or remote-rejected archive | Failed terminal outcome with bounded public cause; mapping remains unarchived and visible. |
| Timeout, disconnect, abort, send ambiguity, or malformed archive acknowledgement after possible send | Incomplete terminal outcome; mapping remains visible, the session is latched for reconciliation, and no automatic retry occurs. |
| Codex archive succeeds but local optimistic persistence fails | Incomplete terminal with strongest `remote_succeeded` truth; mapping remains visible and reconciliation is required. |
| Archive and local persistence both succeed | One succeeded terminal audit; strict accepted receipt may be returned only after terminal proof. |
| Response preparation or HTTP delivery fails after success | Durable archive and succeeded audit remain authoritative; repeating the same operation id cannot dispatch again. |
| Terminal audit cannot be proven | Suppress success response, preserve pending/unproven audit plus service truth, and do not compensate or redispatch. |
| Process dies after accepted audit | Startup orphan reconciliation appends one explicit incomplete outcome; service reconciliation separately repairs runtime/local archive truth. |
| Same operation id is retried | Existing audit truth blocks a second dispatch. Replay of the prior response remains `IFC-V1-049`. |

## Hard Success Criteria

| Area | Required evidence |
| --- | --- |
| Wire contracts | Strict request/params/response schemas, target-kind coherence, confirmation, exact keys, bounds, and API schema-id/manifest agreement. Internal archive intent remains exact-target and is never accepted directly from this wire route. |
| Gate extension | Existing resolved mode plus unresolved mode ordering, branding, accessor/forgery rejection, auth/lock/deadline before target reads, manifest target/capability agreement, immutable materialization, and no regression to dispatch/audit semantics. |
| Audit receipt | The response id/time equals the accepted row returned by durable repository proof. Missing, malformed, wrong-operation, wrong-action, wrong-target, changed, late, or security-executor receipt cannot be published. Summaries remain exactly `confirmed` then `archived` and contain no identifiers or causes. |
| Service admission | Missing, archived, stale/recovery, active/waiting/unknown, mapping/projection contradiction, adapter version drift, wrong remote id/cwd/source, and runtime status error all reject before `thread/archive`. |
| Saga truth | Normal success, concurrent call, known rejection, timeout/disconnect ambiguity, malformed response, remote-success/local-failure, optimistic conflict, uncertain retry, restart/reconciliation, and already-archived retry each preserve at most one dispatch and strongest known outcome. |
| Persistence | Archive is one irreversible mapping/projection transition with immutable identity, monotonic timestamps, retained event metadata, no row deletion, no unarchive, and no early local archive before remote proof. |
| Route/authority | Exact manifest assertion, branded ports, once-only registration, auth before state, local admin and paired HTTPS writer parity, no-store `202`, adjacent method/path rejection, and stable bounded public status/code/message mapping. |
| CLI client | Exact loopback origin, one POST, strict request/response correlation, bounded bytes/time, no retry, sanitized typed/untyped/JSON/fetch errors, and rejection of remote/basic-auth/query/fragment/path-confused bases. |
| CLI shell/render | Exact session-id parser, internal operation id, receiverless dedicated client, text/JSON output, terminal-control safety, no selected detail/legacy client/local DB dependency, help exposes archive, and historical stop is neither invoked nor counted as archive. |
| Privacy and ownership | No cwd, thread id from input, transcript, raw protocol error, credential, audit summary secret, private cause, shell, tmux, delete, or UI behavior leaks into public errors/artifacts. No aggregate registration, packaging, frontend, or phone claim is made. |

## Validation Plan

- Focused contract, selected-write gate/executor, managed service, route, client, parser/shell/render, and exact vertical integration tests.
- Real SQLite audit/state tests for accepted/terminal identity, duplicate operation, optimistic conflict, orphan reconciliation, retained-row truth, and reopen/reconciliation.
- Local-admin and paired private-HTTPS authorization tests, plus raw HTTP disconnect/response-loss evidence without redispatch.
- Adjacent authentication, CSRF, lock, deadline, error-policy, retention, startup reconciliation, manifest, adapter archive, and source CLI regressions.
- Full unit, contract, integration, web, root/all-package typecheck, lint/exports, scaffold, planning, frozen install, exact binding, and production supply-chain gates.
- Rerun the existing exact Codex 0.144.0 thread lifecycle smoke when the isolated reviewed binary is available; it already owns real `thread/archive` protocol semantics. No physical phone is required for this headless leaf.
- Manual staged diff, selected/legacy import separation, audit/privacy, public output, no-row-delete, no-second-dispatch, and no-unowned-doc-churn inspection.

## Downstream Ownership

- `IFC-V1-049` owns replayable cross-route operation idempotency and aggregate concurrency policy.
- `IFC-V1-046` owns production composition of this route/client with every selected route and remote ingress.
- `IFC-V1-067` owns removal or isolation of historical `stop`, tmux, custom-listener, and other legacy selected-entrypoint surfaces.
- `IFC-V1-021`, packaging, and release leaves own an installed `codexdeck` executable.
- `FE-V1-019` and `FE-V1-037` own approved mobile consumption, confirmation UI, row visibility, screenshots, and physical-phone behavior.
