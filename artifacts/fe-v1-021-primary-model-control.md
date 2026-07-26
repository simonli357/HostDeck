# FE-V1-021 Primary Model Control

Date: 2026-07-25

Completed: 2026-07-26

Status: complete; `PMC-01` to `PMC-20` pass.

## Scope

Implement the selected Focus Rail `/model` control on Session Detail. The surface reads the installed runtime's strict model snapshot, distinguishes confirmed current settings from HostDeck's pending next-turn selection, and stages exactly one catalog model/effort through the selected model route. This leaf also adds the smallest reusable coordinator read boundary needed by the later `/goal`, `/plan`, and utility controls.

Excluded: goal, Plan, utility, approval, interrupt, archive, runtime, API, CLI, pairing, and release behavior; background catalog polling; literal slash or prompt dispatch; claiming that a staged selection has already changed the running thread; physical-phone release acceptance.

## Pre-Change Findings

- `IFC-V1-042` already owns authenticated `GET` and audited/CSRF-protected `POST /api/v1/sessions/:session_id/model`. Its response separates a live catalog, confirmed current state, and one revisioned pending next-turn selection. Selecting does not start a turn.
- `INT-V1-019` owns default-effort resolution, optimistic pending revisions, exact later turn composition, accepted-versus-confirmed reconciliation, and explicit `pending`, `dispatching`, `awaiting_confirmation`, `unknown`, and `conflict` phases.
- The browser route catalog already includes `model_read` and `model_select`, but the connection coordinator exposes only selected protected writes. A component must not bypass its selected-session authority by constructing a second HTTP client.
- Session Detail owns the exact selected session, disclosure state, write eligibility, and prompt composer. The model owner must consume those facts, abort on ownership loss, and suppress late cross-session results.
- Focus Rail `primary-controls.png` is the approved sheet target. Typed runtime copy and states override illustrative raster values. The complete three-control dock remains jointly owned by `FE-V1-021`, `FE-V1-026`, and `FE-V1-027`; this leaf renders only the live `/model` command and no dead placeholders.

## Frozen Design

### Authority And Requests

- Add one coordinator method limited to exact selected-session control GET routes. It requires current readable Session Detail authority, requires the request session id to equal the active target, captures the target epoch, uses the existing bounded HTTP client, and rejects a response after target/authority change.
- Opening `/model` performs one abortable `model_read`. Refresh/check performs one new read. Closing or unmounting aborts the owner. No catalog polling, browser persistence, cross-session cache, fallback client, or retained private error exists.
- Submit sends one `model_select` through `requestProtected` with an internally generated `model` operation id, catalog `model_id`, exact effort, and the currently observed pending revision or `null`. It never sends slash text, prompt text, runtime model identity, thread id, force, or retry fields.
- A successful POST is accepted only when the strict response correlates to the submitted choice and operation: a staged selection must return the same operation/model/effort in `pending`, while choosing the confirmed setting may truthfully clear pending. Contradictions fail closed.

### Headless State

- The controller owns closed, loading, ready, submitting, staged, confirmed/no-op, conflict, unsupported, known failure, and unknown-outcome states independently from React rendering.
- Confirmed current and pending next-turn settings remain separate. `pending` is editable with its exact revision; `dispatching`, `awaiting_confirmation`, and `unknown` are read-only; `conflict` is visible and replaceable only with its exact revision.
- Model choice comes only from the live catalog. Effort choices come only from the selected model. A model change resolves the model's declared default effort unless the confirmed/pending effort is valid for that same model.
- Selecting the already confirmed model/effort with no pending change is disabled as already current. Selecting the exact pending choice is disabled as already staged. Selecting confirmed current while pending exists is an explicit clear-pending action.
- Selected-session disclosure and write eligibility are reprojected continuously. Loss of read authority hides private model data; loss of write authority keeps readable truth visible but disables selection with the owning reason.
- A transport, timeout, malformed response, or unproven server outcome after submit is ambiguous. The controller locks resubmission and offers a read-only check; it never retries automatically. A typed pre-mutation rejection can remain retryable only when the server says it is safe.

### Focus Rail Surface

- Session Detail gains one stable primary-action dock immediately above the existing composer. Only `/model` is rendered in this leaf; `/goal` and `/plan` appear only when their owners are implemented.
- `/model` opens a Radix modal bottom sheet with a labelled title, exact session target, close control, confirmed-current rail, pending/operation rail, model radio group, model-specific effort segmented radio group, bounded descriptions, status region, refresh/check action, and one explicit footer command.
- The sheet uses Focus Rail tokens, continuous semantic rails, Lucide icons, 44 px targets, 6 px maximum radius, safe-area padding, trapped/restored focus, keyboard operation, reduced-motion behavior, wrapping for long model data, and no nested cards or desktop-only layout.
- Submission cannot be dismissed by ordinary sheet close/Escape while in flight. Route unmount still aborts the owner; a later open begins with a fresh read rather than assuming an outcome.

## Harsh Success Criteria

| ID | Requirement |
| --- | --- |
| `PMC-01` | The reusable read port accepts only frozen selected-session GET routes and rejects wrong target, unreadable authority, closed coordinator, malformed input, and late target/epoch drift without returning data. |
| `PMC-02` | Open, refresh/check, close, unmount, StrictMode remount, and session change own exactly one request lifecycle each; stale/aborted results cannot update another owner. |
| `PMC-03` | The strict runtime snapshot is the sole catalog/current/pending source; no hard-coded model, effort, default, runtime-name selector, local storage, or query/fragment state exists. |
| `PMC-04` | Confirmed current model/effort and pending next-turn model/effort are simultaneously visible and never collapsed into one applied value. |
| `PMC-05` | `pending`, `dispatching`, `awaiting_confirmation`, `unknown`, and `conflict` each project truthful copy, tone, editability, and next action; accepted is never called confirmed. |
| `PMC-06` | Unknown current catalog identity remains visible as runtime-observed unknown and does not invent a catalog id or selected radio choice. |
| `PMC-07` | Every catalog model and only its offered efforts are selectable; model changes choose the exact declared default unless a valid same-model observed choice exists. |
| `PMC-08` | Already-current and already-staged choices cannot submit; choosing confirmed current over an existing pending selection explicitly clears it with the exact revision. |
| `PMC-09` | One user submit creates one secure model operation id and one `model_select` call with exact session/model/effort/revision; double click, Enter, rerender, and StrictMode cannot duplicate it. |
| `PMC-10` | POST success is accepted only after exact response correlation. A staged result says next turn; a cleared/no-op result says current retained; neither claims a turn or runtime settings change. |
| `PMC-11` | Known API rejection, unsupported capability/runtime, active conflict, stale authority, and ambiguous transport/response outcomes remain distinct and expose only bounded actionable copy. |
| `PMC-12` | Ambiguous submit outcome disables resubmission and supports one fresh GET check without POST retry; private exception, id, path, model fixture, or protocol material is not reflected. |
| `PMC-13` | Loading, read failure, empty/unsupported catalog, read-only access, locked host, stale session, incompatible runtime, and non-writable session cannot dispatch. |
| `PMC-14` | Read authority loss removes model/catalog/target disclosure; write authority loss preserves allowed read truth while disabling mutation, with no stale enabled frame. |
| `PMC-15` | The production Session Detail integration sends no literal `/model`, prompt, terminal, tmux, shell, thread id, or raw runtime action through any route. |
| `PMC-16` | The partial primary dock contains one live `/model` control and no dead `/goal`, `/plan`, More, or utility placeholders; later leaves can compose equal controls without replacing the controller. |
| `PMC-17` | The modal sheet has labelled dialog semantics, focus trap/restore, visible focus, keyboard radio behavior, live status, non-color state labels, and submission-close protection. |
| `PMC-18` | 320, 360, 390, 412, 768, 1280, short-height/keyboard proxy, and 200 percent zoom evidence has no overlap, clipping, horizontal overflow, hidden command, or obscured composer target. |
| `PMC-19` | Deterministic screenshots cover loading, ready/current, staged pending, awaiting confirmation, conflict, unsupported/read-only, known failure, unknown outcome, and long-content states against Focus Rail with recorded drift. |
| `PMC-20` | Focused state/component/API/browser suites, adjacent web regressions, full unit/contract/integration/static/build/package/planning/privacy checks, manual inspection, clean residue, and owner-doc evidence pass before closure. |

## Completion Evidence

- Implementation: `59cfd5a`. The production coordinator now owns the exact selected-session model read, the headless controller owns live catalog/current/pending and one-attempt mutation truth, and Session Detail composes the single live Focus Rail `/model` dock action and modal sheet.
- Focused validation: 22 headless model tests, 37 model/session component tests, and 32 shell/startup integration tests pass. The full web aggregate passes 243 tests across 18 files; the web package passes 240 tests across 17 files.
- Browser validation: all 22 production-shell Chromium scenarios pass, including loading, ready, pending phases, staged, conflict, read-only, unsupported, known failure, ambiguous outcome, keyboard/focus, responsive, and adjacent prompt/Session Detail/Mission Control coverage.
- Repository validation: root and all eight workspace typechecks, lint over 607 files/exports, 2,098 unit tests with 28 explicit skips, 244 contract tests, 36 integration tests, scaffold, planning, runtime-boundary, deterministic package, frozen offline install, production audit, privacy scan, diff checks, and zero-listener residue pass.
- Visual evidence: 22 PNG captures plus machine layout measurements live under `artifacts/fe-v1-021-primary-model-control/`. Manual review against `assets/ui-concepts/option-b/primary-controls.png` covered 320/360/390/412/768/1280, short height, long content/scrolled content, and actual 200 percent reflow. A discovered sheet-grid overlap and duplicate disabled copy were corrected; no unapproved structural drift remains.
- Privacy and authority review found no browser persistence, direct fetch, timer, prompt/slash dispatch, thread id, terminal/tmux/shell path, private exception reflection, or duplicate mutation path in the owned production modules.

## Criteria Result

- `PMC-01` to `PMC-03`: selected-target read authority, lifecycle cancellation, and strict live snapshot sourcing pass.
- `PMC-04` to `PMC-08`: current-versus-pending truth, every pending phase, unknown identity, catalog/default effort rules, no-op, staged, and clear-pending behavior pass.
- `PMC-09` to `PMC-12`: one secure operation/one POST, strict correlation, separated failure classes, and ambiguous-outcome read-only reconciliation pass.
- `PMC-13` to `PMC-16`: all dispatch gates, authority transitions, no slash/raw path, and one-live-control partial dock pass.
- `PMC-17` to `PMC-19`: modal semantics, focus/keyboard/close behavior, responsive/reflow bounds, deterministic state captures, and Focus Rail fidelity pass.
- `PMC-20`: focused, adjacent, repository, visual, privacy, and residue closure gates pass.

The installed default Codex CLI is now 0.145.0 while the reviewed production binding remains 0.144.0. `pnpm check:codex-bindings` therefore fails by design in this environment; no binding was regenerated or runtime contract changed in this UI leaf. This remains a downstream runtime/release-environment blocker and does not alter the accepted `/model` API contract.
