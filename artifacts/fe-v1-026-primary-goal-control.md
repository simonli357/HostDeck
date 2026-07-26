# FE-V1-026 Primary Goal Control

Date: 2026-07-26

Status: criteria frozen; implementation pending.

## Scope

Implement the selected Focus Rail `/goal` control on Session Detail. The surface reads one exact selected session's structured goal snapshot, preserves runtime objective/status/usage truth, and supports paused create/replace, pause, confirmed agentic resume, confirmed complete, and confirmed clear through the selected goal route. This leaf also converts the partial primary-action surface into one shared dock containing the two implemented live controls, `/model` and `/goal`.

Excluded: `/plan`, utilities, approval, interrupt, archive, runtime, API, CLI, pairing, service/package, and release behavior; goal polling or browser persistence; literal slash/prompt dispatch; model/Plan preflight reads; claiming that accepted resume proves a turn started; physical-phone release acceptance.

## Pre-Change Findings

- `IFC-V1-062` already owns authenticated `GET` and audited/CSRF-protected `POST /api/v1/sessions/:session_id/goal`. The strict response contains one nullable full goal and one nullable uncertain mutation; internal action, dispatch, target, thread, and audit fields are intentionally absent.
- `INT-V1-020` owns exact optimistic revision, paused set/edit, pause without interrupt, idle-only set/resume/complete/clear, active-goal replacement protection, pending model/Plan guard on resume, passive read-back, accepted agentic resume, and bounded unknown/conflict reconciliation.
- A runtime goal objective may be 4,000 characters, while HostDeck's mutation objective is trimmed, nonempty, and capped at 512. The UI must render a longer observed objective intact and must never truncate it into a mutation draft.
- `active`, `paused`, `blocked`, `usage_limited`, `budget_limited`, and `complete` are runtime-owned states. Only paused or blocked may resume. Pause is legal during an active turn but does not interrupt it. Set, resume, complete, and clear require a proven non-active turn.
- The generic production coordinator already admits `goal_read` only for the exact current selected Session Detail target, and `goal_mutate` already uses the protected one-attempt write path. The browser needs a goal-scoped operation id and no second client or coordinator method.
- The implemented `/model` trigger currently owns its dock wrapper. Adding `/goal` that way would create two stacked dock bands. Session Detail must own one equal-width toolbar while each structured control keeps its own independent controller and modal owner.
- `primary-controls.png` is the approved Focus Rail target. Typed runtime and authority truth override its illustrative sample objective/state. This leaf renders `/model` and `/goal` only; `/plan`, More, and utility placeholders remain absent until their owners exist.

## Frozen Design

### Authority And Requests

- Opening `/goal` performs one abortable `goal_read` through `requestSelectedSessionRead`. Refresh/check performs one fresh read. Closing, unmounting, selected-session loss, or disclosure loss aborts the owner and suppresses every late result.
- Submit creates one secure `goal` operation id and one `goal_mutate` call through `requestProtected`. The body contains exactly `operation_id`, `kind: "goal"`, one action, nullable objective, and the exact observed goal revision or null for create.
- No request carries a Codex thread/turn id, target, token budget, counters, status override, model/Plan setting, prompt, slash command, force, retry, reconciliation marker, or internal result field. No mutation retries automatically.
- A new read replaces the entire strict snapshot. The controller retains no cross-session cache, storage, URL state, polling timer, private exception, or raw response outside the active owner.

### Headless Goal Truth

- The controller independently owns closed, loading, ready, confirming, submitting, succeeded, accepted, unsupported, known-failure, unknown-outcome, uncertain-unknown, and uncertain-conflict states.
- Current objective/status, token budget/use, time use, timestamps, and uncertainty come only from `goalControlSnapshotSchema`. Revision and internal uncertainty markers are used for correlation but never rendered.
- The observed objective always renders in a wrapping read-only current-state rail. A 512-character-or-shorter objective initializes the local edit draft exactly. A longer observed objective initializes an empty replacement draft with an explicit limit notice; it is never silently clipped or submitted.
- Drafts are page-memory only, capped at 512 UTF-16 code units by the owning contract, trimmed only when composing the request, and discarded on close/owner loss. Empty, whitespace-only, unchanged-paused, over-limit, uncertain, unavailable, or non-writable drafts cannot submit.
- Set creates or replaces a paused goal and requires a proven non-active turn. Active goals must be paused first. Pause may submit while a turn is active, but visible copy states that it does not interrupt that turn. Already-paused and already-complete no-ops are disabled in the UI.
- Resume is available only for paused/blocked goal state and a proven non-active turn. It enters an explicit confirmation state warning that agentic work may start without another prompt. Success is labelled accepted; turn progress remains owned by structured timeline events.
- Complete and clear require a non-active goal and proven non-active turn. Each has a distinct confirmation with its exact consequence. Complete marks the goal terminal; clear removes it. Neither is presented as interrupt, archive, delete-thread, or history deletion.
- The UI applies every knowable status/turn rule before dispatch. The server remains authoritative for pending model/Plan conflicts because the goal snapshot does not expose those controls; a typed conflict is shown and requires a fresh read rather than a speculative cross-control request.
- Any snapshot `uncertain_mutation` locks every goal mutation. `unknown` and `conflict` remain distinct, preserve allowed current goal truth, identify the attempted action without exposing revision/error internals, and offer read-only refresh/check until the server returns a snapshot with no uncertainty.

### Correlation And Failure Truth

- A successful set requires no uncertainty plus the exact submitted objective, paused status, and a new revision when replacing. Pause, resume, and complete require the same baseline objective, their exact requested status, no uncertainty, and a changed revision. Clear requires both goal and uncertainty to be null.
- Correlation failure or any untyped/transport/abort/malformed response after submit is ambiguous, locks resubmission, and offers one fresh GET check. Codes that may occur after dispatch or terminal proof failure are treated conservatively as unknown unless the wire proves a safe rejection.
- Capability/incompatible read failure is unsupported. Typed pre-mutation validation, permission, lock, rate, capacity, and safe retryable conflict failures remain distinct and bounded. A stale revision or known conflict requires refresh before another action.
- Read-authority loss removes objective, metrics, draft, and target disclosure immediately. Write-authority loss preserves allowed current read truth while disabling the draft and actions with the coordinator-owned reason.

### Focus Rail Surface

- Session Detail owns one stable `PrimaryActionDock` immediately above the prompt composer. It contains equal live `/model` and `/goal` controls, one toolbar name, one divider/padding band, and no duplicate dock, `/plan`, More, or utility placeholder.
- `/goal` opens a labelled Radix modal bottom sheet with exact session target, close control, current objective/state rail, bounded usage facts, editable objective, execution actions, explicit uncertainty/result/status region, refresh/check control, confirmations, and one Save goal footer command.
- Active-goal risk, pause-without-interrupt, accepted-versus-running truth, destructive clear consequence, and every disabled reason remain visible in text, not color alone.
- The sheet follows Focus Rail tokens, continuous semantic rails, Lucide icons, 44 px targets, 6 px maximum radius, safe-area padding, trapped/restored focus, keyboard operation, reduced motion, long-content wrapping, and one scroll owner. Submission cannot be dismissed by ordinary close/Escape/outside interaction.

## Harsh Success Criteria

| ID | Requirement |
| --- | --- |
| `PGC-01` | Open and refresh use only exact selected-session `goal_read`; mutation uses only protected `goal_mutate`; wrong target, unreadable authority, closed coordinator, malformed input, and late epoch/authority drift return no data. |
| `PGC-02` | Open, refresh/check, close, unmount, StrictMode remount, and session/authority change own exact abortable lifecycles; stale or aborted reads/writes cannot update another owner. |
| `PGC-03` | The strict goal snapshot is the sole current objective/status/usage/uncertainty source; no hard-coded state, event inference, browser storage, query/fragment state, polling, or second client exists. |
| `PGC-04` | Null goal and all six runtime statuses render distinct non-color truth with exact objective, nullable budget, token use, time use, and bounded timestamps; revision/internal markers never render. |
| `PGC-05` | Observed objectives through 4,000 characters wrap intact. Mutation drafts enforce the 512-character trimmed contract, never silently truncate an over-limit observed objective, and expose deterministic remaining/limit truth. |
| `PGC-06` | Set/create/replace eligibility mirrors exact known goal and turn rules, always requests paused state, uses null revision only for create, and disables empty, unchanged-paused, active-goal, active/unknown-turn, and invalid drafts before POST. |
| `PGC-07` | Pause uses the exact current revision, remains available during an active turn when otherwise writable, disables for already-paused/complete, and never calls or claims interrupt. |
| `PGC-08` | Resume is available only for paused/blocked plus proven non-active turn, requires explicit agentic-risk confirmation, and a correlated response says accepted without claiming running, progress, or completion. |
| `PGC-09` | Complete and clear have separate exact-consequence confirmations, require a non-active goal and proven non-active turn, cannot double submit, and never imply interrupt, archive, thread deletion, or history deletion. |
| `PGC-10` | One confirmed user action creates one secure goal-scoped operation id and one exact action/objective/revision POST; double click, Enter, rerender, confirmation churn, and StrictMode cannot duplicate it. |
| `PGC-11` | Every `200` response passes action-specific objective/status/null/uncertainty/revision correlation before success; set/pause/complete/clear are verified, while resume remains accepted-only. |
| `PGC-12` | Snapshot uncertainty and local ambiguous submit outcome are distinct from known conflict/failure, lock all mutation, preserve allowed current truth, and support fresh GET checks without POST retry or fabricated resolution. |
| `PGC-13` | Unsupported capability/runtime, read failure, known validation/conflict, pending-setting conflict, rate/capacity failure, stale target, and ambiguous transport/protocol/audit/response outcomes have bounded distinct copy and safe action availability. |
| `PGC-14` | Unpaired/revoked/expired/read-only/locked/CSRF/stale/incompatible/non-writable states cannot dispatch; read authority loss removes private goal/target data and write loss leaves only authorized read truth. |
| `PGC-15` | Session Detail renders one shared equal-width live `/model` plus `/goal` dock with one toolbar boundary; no second dock, dead `/plan`, More, utility placeholder, or model-controller regression exists. |
| `PGC-16` | Production code sends no literal `/goal`, prompt, terminal, tmux, shell, target/thread/turn id, model/Plan mutation, raw runtime action, or hidden retry through any route. |
| `PGC-17` | Dialog, form, confirmation, textarea, status/live region, focus trap/restore, Escape/outside protection, keyboard order, visible focus, labels/descriptions, 44 px targets, and non-color status semantics pass accessibility tests. |
| `PGC-18` | 320, 360, 390, 412, 768, 1280, short-height/keyboard proxy, long objective/status/target, and actual 200 percent reflow have no overlap, clipping, horizontal overflow, hidden confirmation/action, or obscured composer target. |
| `PGC-19` | Deterministic screenshots cover loading, no-goal create, active, paused, blocked/limited, complete, each confirmation, submitting, verified results, accepted resume, uncertainty, conflict, read-only, unsupported, known failure, and long-content states against Focus Rail with recorded drift. |
| `PGC-20` | Focused state/component/API/browser suites, model/prompt/Session Detail regressions, full unit/contract/integration/static/build/package/planning/privacy checks, manual visual inspection, clean residue, and owner-doc evidence pass before closure. |

## Planned Evidence

- Headless goal-controller tests for every snapshot status, null/current/uncertain combination, draft boundary, action/turn matrix, confirmation transition, correlation rule, authority change, cancellation race, failure class, and no-duplicate invariant.
- Browser coordinator and HTTP-contract tests for exact `goal_read`/`goal_mutate` composition and goal operation-id scope.
- React tests for the shared dock, Session Detail production wiring, goal rails/form/actions, all confirmations, modal semantics, focus/close protection, long objective, read-only/unsupported/failure states, and StrictMode ownership.
- Deterministic Playwright state/viewport captures and measurements, followed by manual comparison against `assets/ui-concepts/option-b/primary-controls.png` and `design-system.md` plus adjacent model/prompt/Session Detail inspection.
- Full repository validation and concise completion evidence in this artifact and the owning backlog row.
