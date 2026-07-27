# FE-V1-029 Confirmed Compact Utility

Date: 2026-07-27

Status: criteria frozen; implementation not started. `CCU-01` through `CCU-24` must pass before closure.

## Scope

Implement the selected Focus Rail `/compact` utility on Session Detail. One explicit open reads the exact selected session's process-live compact progress. A separate target-labelled confirmation may dispatch one exact compact start, after which HostDeck presents accepted, event-proven running/completed/interrupted/failed truth, or unresolved incomplete truth without claiming that the immediate response reduced context.

Excluded: automatic compaction, token thresholds or savings, inferred compaction need, prompt/turn start or steering, interrupt, archive, model/goal/Plan mutation, literal slash text, terminal or event-text parsing, automatic polling/retry, browser persistence, cross-session progress, caller-supplied runtime/thread/turn/item/operation identity, force, billing, compatibility recovery, physical-phone release acceptance, and dead Skills/action placeholders.

## Pre-Change Findings

- `INT-V1-023` already owns one exact confirmed `thread/compact/start`, accepted-only response truth, same-generation turn plus context-compaction-item binding, item-and-turn completion conjunction, interrupted/failed/incomplete outcomes, bounded process-live ownership, and no retry, timeout inference, deprecated notification, terminal, or slash fallback.
- `IFC-V1-064` already owns strict no-store `compact_read` and protected `compact_start`. GET returns exact `{ progress: null | compact progress }`; POST accepts only `{ operation_id, kind: "compact", confirm: true }`, resolves the runtime target server-side, returns only correlated accepted progress, and maps private causes to bounded public errors.
- Null progress means only that no operation is tracked. Accepted has no event-proven turn. Running requires the exact compaction item to start. Completed requires both that item and the same turn to complete. Interrupted, failed, and incomplete remain distinct.
- The selected route permits a new distinct operation after terminal progress and current admission. Accepted, running, and unresolved incomplete progress block duplicate dispatch. A failed progress record exposes a bounded retryable flag but no private cause.
- `compact_read` remains available to a current paired reader when writes are blocked. Starting requires current writer/CSRF/unlocked authority, a current active managed session, available capability, and a proven idle or terminal turn.
- `FE-V1-028` established the shared four-cell dock, icon-only More entry, same-layer utility sheet, one scroll owner, responsive utility layout, and strict selected-session read lifecycle. The current menu contains only `/usage`; no Compact owner, confirmation, mutation correlation, progress UI, fixtures, or browser evidence exists.

## Frozen Design

### Authority And Request Ownership

- Add one strict headless Compact owner for one immutable HostDeck session id. It consumes only one current browser-connection snapshot, injected read/start ports, and a secure operation-id factory; it owns open/dismiss, explicit progress check, confirmation, one in-flight request, capture epoch/authority, uncertainty, subscriptions, and close.
- Opening `/compact` performs exactly one abortable `compact_read` with only the selected HostDeck `session_id`. `Check progress` performs one new read. There is no request on Session Detail load or More-menu open, no interval/focus/visibility/event-driven polling, no backoff, and no automatic retry.
- Only the final confirmation action may create an operation id and call `compact_start`. Its body is exactly `{ operation_id, kind: "compact", confirm: true }`; CSRF stays inside the existing coordinator client. No target, query, force, retry, timeout, interrupt, prompt, text, slash, or extra field is caller controlled.
- Every GET and POST response is reparsed through `compactProgressResponseSchema` and matched to the immutable HostDeck session and current internal Codex thread before publication. POST additionally requires the exact generated operation id, accepted state, null turn id, and null error. The public view strips operation, thread, turn, device, origin, and runtime-generation identity.
- One request owner coalesces duplicate activation. Back, Close, eligible dismissal, unmount, target replacement, read-disclosure loss, or close aborts and suppresses late settlement. No stale request can update a replacement owner or generate an unhandled rejection.

### Progress And Confirmation Truth

- A successful null read is `compact_ready` and says `No tracked compaction`; it does not claim that compaction is needed, supported forever, or previously completed.
- Accepted, running, completed, interrupted, failed, and incomplete map one-to-one from strict progress. Acceptance never says compacted or reduced. Running never says complete. Only exact API `completed` state renders `Compaction completed`.
- Progress shows only bounded state, observed update time, freshness, and locally mapped public detail. It never renders raw API message/code, operation id, Codex thread/turn/item id, token movement, savings, context percentage, terminal text, or event payload.
- `Check progress` is the only post-acceptance progress read. Accepted, running, incomplete, an unknown start outcome, and a nonretryable failed record never enable another start. A fresh current absent, completed, interrupted, or retryable-failed read may expose a new target-labelled confirmation.
- Selecting `Compact context` opens an inline confirmation in the same utility layer. It names the exact session, states that one Codex compaction operation may start, distinguishes acceptance from completion, says the request will not be resent if uncertain, and distinguishes compaction from archive/delete. Cancel dispatches nothing.
- Confirmation is invalidated by any progress replacement, capture staleness, target/authority epoch change, write loss, active/nonterminal turn, or dismissal. Double click/tap/Enter creates at most one operation id and one protected request.

### Failure, Race, And Freshness Semantics

- Capability-unavailable or proven incompatible-runtime reads are `compact_unsupported`. Other read failures are bounded `compact_read_failure`; explicit retry is one new read only when current read authority remains.
- A known local/pre-dispatch start rejection is `compact_start_failure`. Any post-call malformed response, response loss, timeout, cancellation after dispatch could begin, target/runtime/authority drift, unknown/incomplete API outcome, or unclassified throw is `compact_outcome_unknown`; it blocks another start until an explicit exact read proves a startable state.
- A server `operation_conflict` never causes a second POST. The UI checks current progress explicitly and distinguishes an active prior compaction, active session turn, changed target, and bounded generic conflict only when that distinction is actually proven.
- A capture records coordinator epoch and read-authority identity. Later epoch/noncurrent target state makes retained same-target progress stale. Read-disclosure or target/principal replacement closes and clears it immediately. Write/CSRF/lock loss alone preserves authorized readable progress but removes confirmation/start authority.
- If write authority changes while POST is in flight, the action becomes uncertain even when the browser aborts. A later exact GET may reconcile to null or strict progress; local elapsed time, Session Detail events, token values, and previous captures never settle it.

### Focus Rail Utility Surface

- The existing four-cell `/model`, `/goal`, `/plan`, More dock remains unchanged. More opens one `Session utilities` sheet containing exactly live `/usage` and `/compact` rows in that order. `/skills` remains absent until `FE-V1-030`; no dead diagnostics/action placeholder appears.
- Selecting either utility transitions inside the same Radix modal layer. Back returns to the utility list and restores focus to the corresponding row. Close/Escape/outside dismissal restores focus to More; dismissal is temporarily blocked only during one submitted POST and is announced visibly.
- Compact uses flat owner-labelled Focus Rail rails for current progress, lifecycle, confirmation, and status. It reuses the selected tokens, typography, dividers, Lucide icons, six-pixel maximum radius, safe-area handling, fixed action/status footer, and one body scroll owner. It adds no nested cards, second dialog, chart, decorative asset, terminal motif, or desktop-only inspector.
- Loading, ready, confirming, submitting, accepted, running, completed, interrupted, failed, incomplete, stale, unsupported, conflict, and read/start-failure meaning uses icon plus text. Controls have stable dimensions, visible focus, tooltip-backed familiar icon actions, and at least 44 px targets.

## Harsh Success Criteria

| ID | Requirement |
| --- | --- |
| `CCU-01` | One strict immutable-session headless owner validates exact construction, context, read/start ports, operation-id factory, subscriptions, and close; malformed or foreign input fails loudly without React, direct HTTP, persistence, timers, or hidden adapters. |
| `CCU-02` | Open and explicit check use only one abortable selected-session `compact_read` with one session id and no body/query/CSRF; duplicate activation, rerender, StrictMode, dismiss, unmount, target change, and close own exact cancellation with no prefetch, polling, retry, or late publication. |
| `CCU-03` | Start is impossible before a target-labelled confirmation; final confirm creates one valid operation id and exactly one `compact_start` body `{ operation_id, kind: "compact", confirm: true }` through the coordinator CSRF path with no caller target, force, slash, prompt, retry, or second dispatch. |
| `CCU-04` | Every response passes the complete strict compact schema and exact HostDeck/Codex target match; POST publication additionally requires the generated operation id, accepted state, null turn id, and null error, while malformed/foreign/contradictory success becomes uncertain rather than success. |
| `CCU-05` | Null progress remains `No tracked compaction`; accepted, running, completed, interrupted, failed, and incomplete render as distinct exact states with bounded timestamps/details and no invented idle, success, or prior-history claim. |
| `CCU-06` | Acceptance never claims running/completed/context reduction; running never claims completion; only strict event-proven API `completed` renders completion, with no elapsed-time, token-change, Usage, Session Detail event, deprecated notification, or terminal-text inference. |
| `CCU-07` | Accepted, running, incomplete, unknown-outcome, and nonretryable-failed states block another POST; only a fresh absent, completed, interrupted, or retryable-failed read under current admission may create a new confirmation and distinct operation id. |
| `CCU-08` | Confirmation names the exact session, explains one compaction operation, accepted-versus-completed truth, no uncertain resend, and non-archive/non-delete scope; Cancel, Back, Close, Escape, and authority invalidation dispatch nothing. |
| `CCU-09` | Read visibility is independent from write eligibility: current readers may inspect progress while read-only or locked, while starting requires current writer/CSRF/unlocked authority, active/current session identity, available capability, and idle/terminal turn truth. |
| `CCU-10` | Active/waiting/unknown turn, archived/stale/recovery target, read-only, lock, missing CSRF, disconnected/incompatible runtime, unavailable capability, and write-authority changes each produce truthful disabled or failure behavior without optimistic dispatch. |
| `CCU-11` | Capture epoch and read authority make retained same-target progress current or stale explicitly; read-disclosure/target/principal replacement closes and clears all progress, while write-only downgrade preserves authorized readable progress and cancels confirmation. |
| `CCU-12` | Any possible-send failure, cancellation, response loss, malformed result, timeout, post-dispatch drift, unknown API outcome, or unclassified throw latches `compact_outcome_unknown`, blocks resend, exposes one explicit progress check, and never rewrites uncertainty as known failure or success. |
| `CCU-13` | Known read/start failures, unsupported, active-operation conflict, active-turn conflict, authoritative failed progress, and incomplete progress remain distinct where contract evidence permits; raw server/runtime causes and retry claims never leak or exceed proven semantics. |
| `CCU-14` | Public controller views, React keys/attributes, status copy, logs, history, screenshots, and browser storage contain no operation/device/account identity, cookie/CSRF, private origin/path, Codex thread/turn/item id, raw API/runtime text, prompt, token estimate, or monetary detail. |
| `CCU-15` | Production code cannot start/steer/interrupt/archive a normal turn, mutate model/goal/Plan/Usage/Skills, send literal `/compact`, invoke shell/tmux/terminal, parse events/tokens for proof, open billing, or call any selected route except `compact_read` and `compact_start`. |
| `CCU-16` | Session Detail keeps one equal-width four-cell live dock and one More trigger; the utility list contains exactly `/usage` then `/compact`, both live and authority-correct, with no duplicate dock/dialog, direct fourth text command, or dead `/skills`/action placeholder. |
| `CCU-17` | Usage and Compact transition inside one labelled modal layer; Back restores focus to the selected utility row, Close/Escape/outside restores More, and no hidden interactive sheet, nested modal, or focus loss remains. |
| `CCU-18` | Keyboard order/activation, confirmation focus, visible focus, accessible names/descriptions, status/busy announcements, non-color meaning, reduced motion, tooltip titles, at least 44 px targets, and submit-time dismissal lock pass. |
| `CCU-19` | The sheet uses approved Focus Rail flat rails/tokens/type/dividers/icons/radii/safe areas, one scroll owner, fixed nonoverlapping footer, stable controls, and no nested cards, chart, generated decoration, Signal Ledger borrowing, terminal motif, or desktop-led structure. |
| `CCU-20` | 320/360/390/412/768/1280, 390 x 420, long target/copy/time/error, every lifecycle state, scrolled content, and actual 200 percent reflow have no overlap, clipping, horizontal overflow, hidden header/action/status, composer obstruction, or layout shift from dynamic labels. |
| `CCU-21` | Headless tests cover strict construction/projection, all progress values, confirmation, exact correlation, null/terminal restart eligibility, duplicate activation/submission, cancellation, epoch/authority/turn races, known-versus-unknown failures, and immutable private-free views. |
| `CCU-22` | Component/API tests prove exact GET/POST shape/count/order, no pre-confirm POST, no polling/retry/storage/fallback, shared menu navigation, confirmation/dismissal/focus, read-only progress, write/lock/turn gates, and adjacent Usage/Model/Goal/Plan/Prompt continuity. |
| `CCU-23` | Deterministic browser captures and layout measurements cover menu, loading, ready, confirmation, submitting, accepted, running, completed, interrupted, failed, incomplete, conflict, stale, unsupported, read-only/locked/active-turn, long/responsive/short-height/zoom states; manual comparison records only approved Focus Rail drift. |
| `CCU-24` | Focused and aggregate web/browser suites plus full unit/contract/integration/type/lint/scaffold/planning/runtime-boundary/build/package/install/audit/privacy/diff/residue checks, owner-doc evidence, clean commits, and pushes pass before closure. |

## Planned Evidence

- Headless tests own exact construction, target/schema correlation, progress projection, current/stale capture rules, confirmation/start gating, single-flight/cancellation, uncertainty, and disclosure/write-authority transitions.
- Component tests own the shared utility list, same-layer Usage/Compact navigation, progress rails, confirmation copy/actions, Check progress, terminal restart eligibility, failure states, focus restoration, and no dead controls.
- Production-shell Chromium owns exact HTTP shape/count, CSRF-only POST, no prefetch/poll/retry, response/authority races, strict DOM/storage/history privacy, adjacent controls/composer continuity, responsive containment, and effective 200 percent reflow.
- Deterministic screenshots and layout JSON own Focus Rail fidelity, one modal/scroll owner, equal four-cell dock, fixed footer, stable confirmation/progress controls, 44 px targets, and no viewport/document overflow.
- Repository validation owns contract/runtime/API regressions, secure operation-id scope, package/build truth, selected-runtime privacy boundary, dependency/asset stability, no process/listener/device residue, and clean pushed history.

## Reuse And Ownership

Reuse `compactProgressResponseSchema`, `compactStartRequestSchema`, `compact_read`, `compact_start`, the browser coordinator/CSRF client, existing controller lifecycle and secure operation-id conventions, the completed Usage utility host, Radix Dialog, Focus Rail sheet/dock primitives, Lucide icons, selected Session Detail fixtures, and Playwright production shell. Add no production dependency or generated visual asset: `assets/ui-concepts/option-b/primary-controls.png`, `mobile-session-detail-active.png`, the Option B design system, and accepted `FE-V1-028` utility captures define this screen group's structure.

`FE-V1-029` owns only browser Compact read/start state, confirmation, bounded progress projection, the second live utility row, and deterministic UI evidence. `INT-V1-029` owns restart reconciliation; `FE-V1-030` owns Skills; `FE-V1-014` owns event diagnostics; `FE-V1-036` to `FE-V1-038` own session actions; `FE-V1-039`, `FE-V1-016`, and release leaves own aggregate module, physical-device, packaged-asset, and release acceptance.
