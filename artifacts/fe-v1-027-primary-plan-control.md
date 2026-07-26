# FE-V1-027 Primary Plan Control

Date: 2026-07-26

Status: criteria frozen; implementation and evidence pending.

## Scope

Implement the selected Focus Rail `/plan` control on Session Detail. The surface reads one exact selected session's structured Plan snapshot, keeps confirmed current mode, pending next-turn selection, and current-turn Plan execution separate, and stages or clears Plan/Default through the selected Plan route. This leaf converts the shared primary-action dock into the three human-selected live controls: `/model`, `/goal`, and `/plan`.

Excluded: prompt dispatch, model or goal mutation, utilities, approvals, interrupt, archive, runtime/API/CLI changes, restart persistence, polling, automatic reconciliation, literal slash text, starting a turn, changing or interrupting the current turn, physical-phone release acceptance, and a dead More/utility placeholder.

## Pre-Change Findings

- `IFC-V1-063` already owns authenticated `GET` and audited/CSRF-protected `POST /api/v1/sessions/:session_id/plan`. The browser catalog already exposes only `plan_read` and `plan_select` for this control.
- `INT-V1-021` owns the strict Plan/Default catalog, process-local revisioned next-turn selection, model-setting composition at later turn dispatch, runtime confirmation, and Plan execution evidence. Selection starts no turn and sends no settings update, prompt, or slash text.
- Exact Codex 0.144.0 exposes no read-only collaboration-mode query. Confirmed current mode may therefore be unknown after restart and must not be inferred from pending intent, execution evidence, plan text, model state, or a previous request.
- `planControlSnapshotSchema` exposes four independent sources: catalog observation, confirmed-or-unknown current settings, nullable pending next-turn selection, and current-turn execution. Internal catalog revision, pending revision, selection operation id, and turn id support validation/correlation but are not user-facing data.
- Pending phases have different authority. `pending` and `conflict` may be replaced with their exact observed revision. `dispatching`, `awaiting_confirmation`, and `unknown` may not be replaced. `unknown` must remain locked until a fresh read proves a different state.
- Selecting the confirmed current mode while another replaceable mode is pending clears the pending change. Selecting an already-confirmed mode with no pending state is a no-op. Re-selecting an identical `pending` choice is also a no-op in the UI, while re-staging an identical `conflict` is a valid reconciliation attempt.
- A Plan selection may be staged while a turn or Plan execution is active because it applies only to the next turn. The surface must state that the current turn is unchanged and must not expose interrupt behavior.
- The CLI's strict selection correlation is reusable browser policy: success is either one exact new pending selection correlated by operation id/mode/phase/revision, or null pending plus confirmed desired mode. All other `200` responses are invalid.
- The existing production Session Detail dock contains equal live `/model` and `/goal` controls. `primary-controls.png` and the approved Focus Rail design system require `/plan` as the third main control. Typed runtime and authority truth override illustrative sample values; no More or utility placeholder is implemented by this leaf.
- The generic mobile trace inventory names only broad current/loading/unsupported/conflict/accepted/success/failure states. This task requires a stricter component/browser matrix for every current, pending, execution, mutation, authority, and responsive state below.

## Frozen Design

### Authority And Requests

- Opening `/plan` performs one abortable `plan_read` through `requestSelectedSessionRead`. Refresh/check performs one fresh read. Closing, unmounting, selected-session loss, read-disclosure loss, or owner replacement aborts the controller and suppresses every late result.
- Submit creates one secure Plan-scoped operation id and one `plan_select` call through `requestProtected`. The request contains exactly `operation_id`, `kind: "plan"`, `action: "enter" | "exit"`, and the exact observed pending revision or null.
- The controller never sends catalog revision, session/thread/turn id, current mode, execution state, model/effort setting, prompt, slash command, force flag, retry marker, or raw server error. No mutation retries automatically.
- A successful read replaces the entire strict snapshot. No Plan state is inferred or retained in browser storage, URL state, event history, model state, goal state, or a cross-session cache. There is no polling or secondary client.

### Headless Plan Truth

- The controller independently owns closed, loading, ready, submitting, succeeded, unsupported, known-failure, and unknown-outcome states. A local mode choice is page-memory form state, not runtime truth.
- The catalog renders exactly its bounded unique Plan and Default entries with runtime-owned names and optional preset model/reasoning effort. Null preset fields mean unchanged/current, not missing capability. Catalog timestamp may render; catalog revision never renders.
- Current mode is either one complete confirmed settings observation or wholly unknown. Confirmed mode, runtime model, nullable reasoning effort, and observation time remain together. Unknown renders no partial setting and does not preselect a mode unless pending next-turn intent supplies the local choice.
- Pending next-turn intent remains visually and semantically separate from current mode. The UI distinguishes `pending`, `dispatching`, `awaiting_confirmation`, `unknown`, and `conflict`, along with catalog availability, selected time, and bounded resolved settings where the schema permits them. It never renders revision, operation id, turn id, or raw error detail.
- Current-turn Plan execution remains a third independent rail. `idle`, `awaiting_evidence`, `active`, `complete`, `failed`, `interrupted`, and `unknown`, plus `none`, `plan_update`, `plan_item`, or `plan_delta` evidence, render without implying current collaboration mode or selection success. Bounded summary and observation time render only when present.
- Initial local choice is pending mode when pending exists, otherwise confirmed current mode, otherwise unset. Changing the local choice does not alter any snapshot rail and closing discards it.

### Selection Rules And Correlation

- With no pending change, selecting confirmed current mode is disabled as already confirmed. With a `pending` selection, choosing the same mode is disabled as already staged.
- Choosing confirmed current mode while a different replaceable pending selection exists means clear pending change. Choosing a different mode means stage or replace for the next turn. A `conflict` may be replaced, including with the same desired mode, using its exact revision.
- `dispatching`, `awaiting_confirmation`, and `unknown` lock all selection mutation. The UI does not offer replacement, clearing, cancellation, or retry while ownership may have crossed into turn dispatch.
- Active/non-idle execution does not disable otherwise valid staging. Copy explicitly says the selection applies to the next turn and leaves the current turn unchanged.
- One submit sends one action derived from desired mode (`enter` for Plan, `exit` for Default) and null revision only when no pending state exists. Every replace/clear/re-stage request uses the exact pending revision visible in the submitted snapshot.
- Staged success requires pending operation id equal to the submitted id, desired mode, available catalog, `pending` phase, null turn/resolved settings/error, and a new revision when replacing. Clear success requires null pending plus confirmed desired mode and a submitted non-null revision. Already-confirmed race/no-op success requires null pending plus confirmed desired mode and a submitted null revision.
- A correlated POST reports only `Plan staged for next turn`, `Default staged for next turn`, `Pending Plan change cleared`, or the equivalent already-confirmed result. It never reports entered, exited, applied, active, running, interrupted, or current-turn completion.

### Failure And Authority Truth

- Capability/incompatible read failure is unsupported. Safe typed validation, permission, lock, capacity/rate, and retry-safe operation conflict failures are known rejections. A conflict requires a fresh read before another mutation.
- Transport, abort after dispatch, timeout, malformed response, failed correlation, protocol/audit/unknown error, non-retryable conflict, or stale CSRF generation after an unproven attempt is outcome unknown. Mutation remains locked until one fresh GET establishes current state. No POST retry or success inference occurs.
- Read-authority loss removes catalog, current, pending, execution, local choice, result, and target disclosure immediately. Write-authority loss preserves only still-authorized read truth and disables mutation with the coordinator-owned reason.
- Read-only, locked, stale, incompatible, unpaired, revoked, expired, CSRF-unavailable, and non-writable states cannot dispatch. Pending and execution truth do not override the coordinator's current authority.

### Focus Rail Surface

- Session Detail owns one stable `PrimaryActionDock` immediately above the prompt composer. It contains equal live `/model`, `/goal`, and `/plan` controls, one toolbar name, one divider/padding band, and no duplicate dock, More button, or utility placeholder.
- `/plan` opens a labelled Radix modal bottom sheet with exact session target, close control, current mode rail, next-turn pending rail, current-turn execution rail, two catalog-backed mode choices, explicit status/result region, refresh/check control, and one context-specific footer command.
- Current, pending, and execution use continuous semantic rails rather than nested cards. Mode choice uses an accessible radio group; runtime preset settings use compact facts. State and disabled reasons remain visible in text, not color alone.
- The sheet follows Focus Rail tokens, Lucide icons, 44 px targets, 6 px maximum radius, safe-area padding, trapped/restored focus, keyboard operation, reduced motion, long-word wrapping, and one scroll owner. Submission cannot be dismissed through ordinary close, Escape, or outside interaction.

## Harsh Success Criteria

| ID | Requirement |
| --- | --- |
| `PPC-01` | Open and refresh use only exact selected-session `plan_read`; mutation uses only protected `plan_select`; wrong target, unreadable authority, closed coordinator, malformed input, and late target/authority epoch return no data. |
| `PPC-02` | Open, refresh/check, close, unmount, StrictMode remount, and session/authority changes own exact abortable lifecycles; stale or aborted reads/writes cannot update another owner. |
| `PPC-03` | One strict Plan snapshot is the sole catalog/current/pending/execution source; there is no hard-coded truth, inference, browser persistence, URL state, polling, second client, or cross-control preflight. |
| `PPC-04` | Catalog entries, nullable preset model/effort, observation time, complete confirmed current settings, and wholly unknown current state render exactly; catalog revision and internal identifiers never render. |
| `PPC-05` | Null pending and all five pending phases render distinct next-turn truth with correct replaceability, catalog availability, selected time, and allowed resolved settings; current and pending are never collapsed. |
| `PPC-06` | All seven execution states and four evidence states render independently with bounded summary/time; execution never proves collaboration mode, selection success, or interruption by this control. |
| `PPC-07` | Local mode choice is initialized only from pending then confirmed current, remains separate from server truth, covers current-unknown behavior, and is discarded on close/owner loss. |
| `PPC-08` | Already-confirmed and already-staged choices are no-ops; selecting confirmed current clears a different replaceable pending change; selecting another mode stages/replaces it with the exact expected revision. |
| `PPC-09` | Conflict is explicitly replaceable, including same-mode restage; dispatching, awaiting-confirmation, and unknown are locked; active execution still permits next-turn staging without changing or interrupting the current turn. |
| `PPC-10` | One submit creates one secure Plan-scoped operation id and one exact action/revision POST; double click, Enter, rerender, selection churn, and StrictMode cannot duplicate it. |
| `PPC-11` | Every `200` response passes action-specific staged, cleared, or already-confirmed correlation, including operation id, desired mode, phase/fields, and revision advancement where required, before success. |
| `PPC-12` | Result copy says only staged for next turn, pending change cleared, or already confirmed; it never claims turn start, enter/exit application, active execution, interruption, progress, or completion. |
| `PPC-13` | Unsupported/read failure, known rejection/conflict, and ambiguous transport/abort/timeout/protocol/audit/malformed/correlation outcomes are bounded and distinct; ambiguous state locks mutation until fresh GET without automatic POST retry. |
| `PPC-14` | Unpaired/revoked/expired/read-only/locked/CSRF/stale/incompatible/non-writable states cannot dispatch; read loss removes private Plan/target data and write loss preserves only authorized read truth. |
| `PPC-15` | Session Detail renders one shared equal-width live `/model`, `/goal`, `/plan` dock with one toolbar boundary; no duplicate dock, dead More/utility placeholder, or model/goal/prompt regression exists. |
| `PPC-16` | Production code sends no literal `/plan`, prompt, turn start, terminal/tmux/shell input, thread/turn id, model/goal mutation, settings update, interrupt, raw runtime action, or hidden retry through any route. |
| `PPC-17` | Dialog, radio group, form, status/live region, focus trap/restore, Escape/outside protection, keyboard order, visible focus, labels/descriptions, 44 px targets, and non-color semantics pass accessibility tests. |
| `PPC-18` | 320, 360, 390, 412, 768, 1280, short-height/keyboard proxy, long target/mode/model/summary, and actual 200 percent reflow have no overlap, clipping, horizontal overflow, hidden action, or obscured composer target. |
| `PPC-19` | Deterministic screenshots cover loading; current confirmed/unknown; null and every pending phase; idle and non-idle execution; staged/cleared/no-op result; unsupported; known/unknown failure; read-only; active-turn staging; long content; and dock regressions against Focus Rail with drift recorded. |
| `PPC-20` | Focused state/component/API/browser suites, model/goal/prompt/Session Detail regressions, full unit/contract/integration/static/build/package/planning/privacy checks, manual visual inspection, clean residue, and owner-doc evidence pass before closure. |

## Planned Evidence

- Direct headless tests for every snapshot projection, local-choice transition, replacement lock, request body, response-correlation branch, authority transition, cancellation race, and known-versus-unknown failure class.
- Component tests for the exact three-rail surface, catalog radio group, footer commands, live status, focus/dismissal ownership, write/read authority loss, and the shared three-control dock.
- Production coordinator and selected Fastify integration proof that one user action uses `plan_read`/`plan_select` only, with protected one-attempt mutation and no model/goal/prompt/turn side effect.
- Deterministic Chromium screenshots and layout measurements at every required state and viewport, including adjacent `/model`, `/goal`, prompt, and Session Detail captures changed by the third dock control.
- Focused and aggregate web tests; full repository static, unit, contract, integration, build, package, offline-install, dependency-audit, privacy, runtime-boundary, planning, diff, and residue gates; manual source and visual inspection.
- On closure, replace this section with exact commands/results, screenshot inventory, inspected drift, implementation commit, remaining approved deferrals, and `PPC-01` to `PPC-20` disposition.
