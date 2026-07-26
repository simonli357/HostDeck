# FE-V1-022 Inline Approval Decisions

Date: 2026-07-26

Status: criteria frozen; implementation pending.

## Scope

Implement the selected Focus Rail inline approval workflow in Session Detail. The surface reconciles retained approval events with the exact process-live approval list, shows the complete bounded action/scope/reason/risk/grant/expiry truth, and lets an authorized paired writer approve or deny exactly one still-pending one-time request through the selected approval route.

Excluded: a dedicated approval inbox, policy/session grants, terminal or slash-text fallback, raw Codex payloads or identifiers, automatic decision retry, polling, browser persistence, remote unlock, prompt/turn/interrupt/archive behavior, server/runtime/API changes, physical-phone release acceptance, and complete-dashboard hardening owned by downstream leaves.

## Pre-Change Findings

- `IFC-V1-044` already owns authenticated `GET /api/v1/sessions/:session_id/approvals` and audited, CSRF-protected `POST /api/v1/sessions/:session_id/approvals/:request_id/respond`. The browser route catalog already exposes only `approval_list` and `approval_respond` for this workflow.
- `INT-V1-025` owns exact Codex 0.144.0 command and file approval callbacks, connection-generation identity, one winning response, automatic expiry, and terminal proof. HostDeck V1 sends only one-time `accept` or `decline`; proposed session or policy choices are never selected.
- A list entry carries exact target, action, scope, reason, risk, grant scope, state, creation/expiry timestamps, and decision. A projected event intentionally omits grant scope, creation time, and the transient `responding` state. Neither source alone provides the complete browser workflow.
- The approval POST body is target-free and contains exactly operation id, `kind: "approval_response"`, decision, and literal confirmation. Session and request identity come only from the exact protected route path.
- The server brackets target/runtime/request identity before dispatch, serializes one winner, and returns `200` only after the exact terminal approved/denied state and terminal audit. The browser still must suppress stale owners, duplicate intent, and contradictory display state before a request reaches that gate.
- Existing Session Detail renders approval events read-only and gives every event cursor a separate timeline item. A pending event followed by its terminal event therefore duplicates one logical approval, and a process-live request omitted by event retention has no visible decision surface.
- The approved Focus Rail target attaches approval state to the continuous timeline rail. Normal one-time approval is direct; elevated or broad approval uses a confirmation sheet. Deny remains a distinct direct safe action. There is no separate inbox, nested card stack, or desktop action panel.
- The illustrative mockup's command field is not a second source. Production renders only typed action, scope, reason, risk, grant scope, and expiry fields; it does not invent a command, cwd, target, policy, or explanation absent from the contracts.

## Frozen Design

### Source And Reconciliation Ownership

- One headless approval controller owns list loading, event/list reconciliation, confirmation, mutation, result, failure, and lifecycle state for one exact selected session. Session Detail owns only its React lifecycle and inline rendering.
- Initial current authority performs one abortable `approval_list` read. A fresh approval-event fingerprint, explicit check, terminal response, or expiry deadline may request one fresh list read. In-flight reads coalesce or are superseded by one owned replacement; there is no polling, interval, background retry, secondary client, storage, or URL state.
- The process-live list is required for actionability. An event-only pending approval remains visible but read-only until a matching fresh pending list entry exists. A list entry missing from retained events is synthesized at the timeline end so required work cannot be hidden by retention.
- Timeline approval events coalesce by exact normalized request id at their first timeline position. Later event state replaces the logical item's display state; it does not create a second card. Non-approval ordering, cursor validation, message consolidation, replay boundaries, pinning, and new-activity counts remain unchanged.
- Matching event/list entries must agree on request id, action, scope, reason, risk, and expiry. Contradiction is visible and read-only and requires a fresh list; the browser never chooses a convenient source. Grant scope and creation time come only from the validated list.
- Any terminal source disables the request immediately. List `responding`, approved, denied, expired, or superseded is read-only. An event terminal while the list still says pending is read-only and triggers a fresh list. A terminal list entry while the retained event is pending renders the terminal list truth. No terminal state is inferred from turn state or neighboring activity.

### Authority, Expiry, And Lifecycle

- Reads use only `requestSelectedSessionRead("approval_list", ...)` for the exact current Session Detail target. Read-disclosure loss, selected-target loss, owner replacement, unmount, coordinator close, or same-target authority epoch change aborts work and removes every approval, confirmation, result, and target label from the prior owner.
- Write availability additionally requires coordinator write eligibility, active/current selected-session truth, a connected stream with contiguous or explicit-boundary continuity, a fresh matching list, one-time grant scope, pending state, and a not-due expiry. Read-only, locked, stale, incompatible, unpaired, revoked, expired, CSRF-unready, disconnected, reconnecting, unproven, and non-writable states cannot dispatch.
- Write-authority or stream loss preserves only still-authorized read truth, closes confirmation, and disables every decision. Exact coordinator target/epoch checks run immediately before and after the protected POST so React publication lag cannot authorize a stale session.
- A finite expiry schedules only the earliest owned deadline. Reaching it disables the request as locally due and starts one fresh list read; the browser says status is being checked and never fabricates server `expired`, system decline, or decision truth. Timers are replaced/cleared on list, target, epoch, owner, and close changes.
- The controller has one global mutation owner. Opening confirmation reserves no response; submitting a direct action or confirmation atomically claims the mutation slot. Click, touch, Enter, rerender, StrictMode, another visible approval, and a late event cannot create a second local POST.

### Decision And Correlation Rules

- Deny is a direct, visually destructive action for every pending one-time request. Normal-risk approve is direct and labelled `Approve once`. Elevated or broad approve opens a labelled confirmation sheet and sends nothing until `Approve once` is submitted there.
- The confirmation names the exact session, action, scope, reason when present, risk, one-time grant, and expiry when present. Broad risk uses danger semantics; elevated risk uses attention semantics. Closing or cancelling sends nothing and restores focus to the originating approval.
- A schema-valid `grant_scope: "session"` is rendered as ongoing policy but is read-only and explicitly unsupported in V1. The browser never turns it into a one-time approval or exposes a session/policy grant action.
- One submission creates one secure approval-scoped operation id and one `approval_respond` request whose path carries the exact submitted session/request id and whose body is exactly operation id, approval-response kind, approve/deny, and `confirm: true`. It sends no thread id, action, scope, reason, risk, grant, timestamps, policy choice, runtime payload, slash text, or retry marker.
- A `200` is success only when operation id and requested decision match, the response target matches exact session/thread/request identity, immutable action/scope/reason/risk/grant/creation/expiry fields match the submitted list snapshot, and state/decision are the corresponding approved/approve or denied/deny terminal pair.
- Correlated success replaces that one request with terminal response truth, closes confirmation, reports `Approved once` or `Denied`, and requests a fresh list. It does not claim command/file success, side effects, turn progress, item completion, or approval of any other request.

### Failure Truth

- Unsupported capability/runtime and session-grant state are distinct from a known rejection. Typed permission, lock, stale target, not-pending, operation conflict, validation, origin, capacity/rate, and other proven-no-success failures are bounded known outcomes; state-changing conflicts require a fresh list before another decision.
- Transport failure, abort after dispatch, timeout, malformed response, failed correlation, protocol/audit/internal/unknown error, stale CSRF generation after an unproven attempt, or target/epoch change during POST is outcome unknown. The affected request and global mutation owner remain locked until one fresh list proves current truth.
- No approval POST retries automatically. Explicit retry is offered only after a fresh list proves the same exact immutable request is still pending and the prior failure was known not to have succeeded. Raw error bodies, actions, scopes, reasons, request ids, credentials, and server internals never enter diagnostics or live-region copy.

### Focus Rail Surface

- Each logical approval remains a `TimelineApprovalItem` attached to the existing continuous event rail, with exact typed facts, state, time/expiry cue, bounded status, and inline action row. It is not a nested card, separate route, floating page section, or dedicated inbox.
- Pending actionable rows expose two stable 44 px commands: `Deny` and either `Approve once` or `Review & approve`. Responding, due/checking, terminal, unsupported, conflicting, loading, unavailable, and unknown states retain the same dimensions and replace commands with explicit read-only status.
- The elevated/broad confirmation uses the existing Radix Focus Rail bottom-sheet pattern with one scroll owner, safe-area padding, labelled title/description, exact facts, cancel/close controls, and a fixed submit target. Submission cannot be dismissed through ordinary close, Escape, or outside interaction.
- Status and failures use restrained `status`/`alert` semantics. State, risk, grant, and disabled reason remain textual rather than color-only. Long action/scope/reason values wrap without obscuring the timeline, composer, three-command primary dock, or confirmation action.

## Harsh Success Criteria

| ID | Requirement |
| --- | --- |
| `IAD-01` | One exact-session headless owner uses only selected `approval_list` reads and protected `approval_respond` writes; wrong target, unreadable authority, malformed contract, closed owner, and late target/epoch results disclose or mutate nothing. |
| `IAD-02` | Initial/event/check/terminal/expiry reads, close/unmount/StrictMode, same-session epoch change, and owner replacement have exact abort/coalescing/timer cleanup; no polling, automatic retry, second client, storage, URL, or cross-session cache exists. |
| `IAD-03` | Event and list sources reconcile by exact request id and all shared immutable fields; contradiction is visible/read-only, terminal truth wins conservatively, and no neighboring turn/activity state is used as approval truth. |
| `IAD-04` | Repeated approval events coalesce at the first logical timeline position; list-only approvals remain visible after retention; event-only pending approvals remain visible but cannot act; unrelated timeline ordering/count/pinning/boundary behavior does not regress. |
| `IAD-05` | Exact action, scope, optional reason, normal/elevated/broad risk, one-time/ongoing grant, created/expiry cues, and all pending/responding/approved/denied/expired/superseded states render without invented command, cwd, policy, raw id, or hidden truncation. |
| `IAD-06` | Only fresh matching one-time pending entries are actionable; schema-valid session grants render read-only unsupported and cannot be silently downgraded or submitted. |
| `IAD-07` | Read loss removes every private approval/confirmation/result/target fact; write or stream loss preserves only authorized reads and disables actions across every canonical coordinator cause. |
| `IAD-08` | Disconnected/reconnecting/unproven stream, stale/archived/non-current session, locally due expiry, or server terminal state cannot dispatch; expiry triggers one check without fabricating expired/system-decline/decision truth. |
| `IAD-09` | Deny is direct and distinct; normal approve is direct `Approve once`; elevated/broad approve sends nothing until an exact-target confirmation; cancel/close restores focus and never responds. |
| `IAD-10` | One global mutation owner plus atomic local claiming prevents duplicate POSTs across click/touch/Enter/rerender/StrictMode, multiple approvals, confirmation churn, event races, and two rapid decisions. |
| `IAD-11` | Every submission creates one secure approval-scoped operation id and one exact path/body POST with `confirm: true`; no thread id, display field, policy choice, prompt, turn action, slash text, terminal input, or retry marker is sent. |
| `IAD-12` | Every `200` passes exact operation/decision/target and immutable snapshot correlation before success; wrong request, changed fields, mismatched decision/state, malformed response, and late owner are never accepted. |
| `IAD-13` | Correlated success updates only one request to `Approved once` or `Denied`, refreshes list truth, and never claims command/file side effect, turn/item progress, completion, or another request's result. |
| `IAD-14` | Known rejection, unsupported state, outcome unknown, reconciliation conflict, and read failure are bounded and distinct; unknown remains locked until fresh GET, and no approval POST retries automatically. |
| `IAD-15` | Exact duplicate, expired, resolved, two-client winner/loser, event-before-response, list-before-event, reconnect, target-switch, authority-epoch, abort, and response-loss races are read-only or reject truthfully with no second send or false success. |
| `IAD-16` | Production code and rendered diagnostics expose no normalized request/thread ids, operation ids, credentials, raw runtime/server payloads, unbounded error text, hidden policy controls, or alternate approval path. |
| `IAD-17` | Inline items, direct actions, confirmation dialog/form, status/live regions, focus trap/restore, Escape/outside protection, keyboard order, visible focus, names/descriptions, 44 px targets, and non-color semantics pass accessibility tests. |
| `IAD-18` | 320, 360, 390, 412, 768, 1280, short-height/keyboard proxy, long action/scope/reason/session, multiple approvals, and actual 200 percent reflow have no overlap, clipping, horizontal overflow, hidden action, or obscured composer/dock. |
| `IAD-19` | Deterministic screenshots cover list loading/failure/empty; normal/elevated/broad pending; confirmation; responding; approved/denied/expired/superseded; event-only/list-only/conflict; due check; read-only/locked/reconnecting; known/unknown failure; long/multiple content; and adjacent Session Detail/dock/composer states with drift recorded. |
| `IAD-20` | Focused controller/feed/component/API/concurrency/browser suites, adjacent prompt/model/goal/plan/Session Detail regressions, full unit/contract/integration/static/build/package/planning/privacy checks, manual source/visual inspection, clean residue, and owner-doc evidence pass before closure. |

## Planned Evidence

- Headless controller tests own every list, reconciliation, authority, expiry, confirmation, submission, correlation, failure, race, cancellation, and cleanup row.
- Feed and component tests own request-id coalescing, synthesized retained-gap items, action binding, confirmation behavior, semantics, keyboard/focus, and adjacent Session Detail behavior.
- Selected API integration proves one exact approved and denied terminal response plus duplicate/expired/resolved/authority and response-loss behavior through the production route/gate/service/audit boundary.
- Production-shell Chromium captures and layout measurements own Focus Rail fidelity, mobile/desktop/reflow/short-height containment, multi-request behavior, and model/goal/plan/prompt regressions.
- Repository-wide validation, privacy/source review, package/install/audit checks, evidence inventory, and clean worktree/push state close `IAD-01` to `IAD-20`.
