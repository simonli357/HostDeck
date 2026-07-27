# FE-V1-028 Read-Only Usage Utility

Date: 2026-07-27

Status: criteria frozen; implementation in progress. `UUS-01` through `UUS-24` must pass before closure.

## Scope

Implement the selected Focus Rail `/usage` utility on Session Detail. One explicit user action reads one exact selected session's structured usage snapshot and presents bounded capture, account, thread/context, and runtime rate-limit truth. The primary dock gains the approved icon-only More entry; `/usage` remains a secondary read-only utility inside the shared rail-backed bottom-sheet system.

Excluded: account identity, billing or monetary estimates, subscription management, inferred remaining quota, usage mutation, automatic refresh or polling, background prefetch, browser persistence, history reconstruction, cross-session aggregation, starting or steering a turn, compacting context, changing skills/model/goal/plan, sending slash text, terminal/shell output, raw Codex protocol, compatibility recovery, physical-phone release acceptance, and dead Compact/Skills placeholders.

## Pre-Change Findings

- `INT-V1-022` already owns one exact read-only `account/usage/read`, same-generation account/thread/rate observations, explicit absent observations, bounded event memory, and no retry or mutation. Account totals cannot be allocated to the selected thread or converted into money.
- `IFC-V1-043` already owns authenticated `GET /api/v1/sessions/:session_id/usage`, exact HostDeck-session-to-Codex-thread resolution, strict response validation, and bounded public failures. The browser route catalog exposes this operation only as `usage_read`, with no body, query, CSRF, lock, audit, or credential effect.
- `usageSnapshotSchema` separates account summary/history, optional selected-thread token/context observation, and optional runtime rate-limit observation. Null, empty, zero, and not-observed values have different meanings and must remain different in the UI.
- Thread `total` and `last` breakdowns are independently valid. After context compaction, `last` may exceed the reset cumulative `total`; the UI cannot derive deltas, remaining context, or monotonic progress from their relationship.
- A model context window is a reported capacity, not a proven remaining balance. A null rate window is not unlimited, and a rate percentage is not an account balance. Reached-type values are bounded runtime observations, not billing diagnoses.
- The existing Session Detail dock implements only the three approved main controls. The selected Focus Rail asset requires a fourth icon-only More entry, while supporting utilities use a dark rail-backed sheet. Adding `/usage` as a fourth text command would incorrectly promote a secondary utility.
- The selected state contract requires `usage_loading`, `usage_content`, `usage_empty`, `usage_stale`, `usage_unsupported`, and `usage_failure`. Current implementation has no usage owner, overflow navigation, component, fixture, browser scenario, or screenshot evidence.

## Frozen Design

### Authority And Request Ownership

- Add one strict headless usage owner for one immutable HostDeck session id. It consumes only the current browser-connection snapshot and one injected `read` port; it owns open/dismiss, explicit refresh, one in-flight read, capture epoch, bounded failure state, cancellation, subscriptions, and close.
- Opening `/usage` performs exactly one abortable `usage_read` through `requestSelectedSessionRead`, with only the selected HostDeck `session_id`. Refresh performs exactly one new read. There is no prefetch when Session Detail loads or More opens, no interval/focus/visibility refresh, no backoff, and no automatic retry.
- Duplicate touch/click/Enter, rerender, StrictMode remount, and repeated refresh while busy coalesce to one owned request. Dismiss, unmount, owner replacement, target loss, read-disclosure loss, or close aborts the active request and suppresses every late result.
- Every successful response is reparsed through `usageSnapshotSchema`, must match the immutable HostDeck session id, and replaces the complete prior usage snapshot. It is never merged with feed events, previous captures, another session, browser storage, URL state, account history, or another control.
- A capture records the coordinator epoch at settlement. Any later coordinator epoch or retained loading/failed target state makes that capture explicitly stale. It may remain visible only while the same selected session is still authorized for retained disclosure; a fresh explicit read is required to make it current again.
- Read-authority or selected-target loss immediately closes the utility and removes target, account, thread, rate, capture, and failure data. Write-authority loss alone does not hide or disable an otherwise current read because `/usage` is read-only and independent of host lock, CSRF, or session mutation eligibility.

### Usage Truth And Bounded Projection

- The first utility viewport identifies the exact Session Detail target, snapshot capture time, and current/stale/loading/failure state before detailed values. Runtime version may be shown as capture provenance; connection generation and Codex thread/turn ids remain internal.
- Account scope is labelled `Account`. Nullable summary fields render `Not reported`; actual zero renders `0`. Lifetime tokens, peak daily tokens, longest running turn, current streak, and longest streak remain independent facts and never become selected-session totals.
- Daily history preserves three states: null means `Daily history not reported`; an empty array means `No daily buckets reported`; populated history shows only the newest seven schema-ordered buckets plus an explicit older-bucket count when applicable. It never renders an unbounded list or invents missing dates/zeros.
- Thread scope is labelled `This thread`. Not-observed renders a complete bounded absence state. Observed data shows capture time, cumulative and last-update token breakdowns, and nullable model context window without exposing turn id.
- Total, input, cached input, output, and reasoning output values use locale-safe compact display with exact full values available to assistive/title text. The UI never subtracts `last` from `total`, compares them for progress, or assumes monotonicity across compaction.
- A reported model context window is labelled capacity. Null means `Not reported`. The UI does not calculate remaining tokens, percentage used, fit, warning thresholds, or compaction need because the contract does not prove those values.
- Runtime scope is labelled `Rate limits`. Not-observed is distinct from observed-with-null-windows. Primary and secondary windows independently show exact used percent, nullable duration, nullable reset time, and mapped reached state. Null means `Not reported`, never unlimited or available.
- The five reached types map to bounded user-facing limit/credit labels without raw enum leakage, account identity, remediation links, payment claims, or inference about which window caused the observation.
- `usage_empty` requires all account summary fields unreported, null daily history, and both thread and rate observations absent. Zero-valued account data, an explicit empty or populated daily history, any thread observation, or any rate observation is content rather than empty.

### State And Failure Semantics

- Initial read with no retained data is `usage_loading` and uses stable rail skeletons. Explicit refresh may retain the prior capture as visibly stale while a single busy status announces the new read; it does not blank useful authorized data or call it current.
- `usage_content`, `usage_empty`, and `usage_stale` are determined from the strict snapshot and coordinator epoch/authority, not wall-clock age thresholds. The capture and observation times remain visible, but HostDeck invents no expiry interval.
- Typed `capability_unavailable` or proven incompatible-runtime rejection is `usage_unsupported`. It offers no fallback to terminal text, `/usage`, event history, account web pages, or another API.
- All other HTTP, transport, abort-after-dispatch, timeout, capacity, stale-target, malformed-response, protocol, or unexpected failures become bounded `usage_failure` copy. Raw server message, API envelope, status body, route, target/thread id, and cause never render.
- Failure retry is always a new explicit read and is available only while selected read authority is current. Unsupported remains non-retryable inside the same capture; closing and reopening may probe again after external/runtime state changes.

### Focus Rail Utility Surface

- Session Detail keeps one stable four-cell `PrimaryActionDock`: equal live `/model`, `/goal`, `/plan`, and icon-only More controls immediately above the prompt composer. More uses the Lucide ellipsis icon, a target-specific accessible name, a tooltip/title, a 44 px target, and no visible text label.
- More opens one labelled `Session utilities` Focus Rail bottom sheet. This leaf exposes one live `/usage` row with a read-only description and current availability reason. It does not show dead `/compact`, `/skills`, diagnostic, interrupt, archive, or resume placeholders.
- Selecting `/usage` changes the same modal sheet to a target-labelled usage view; it does not stack dialogs or leave an interactive obscured sheet. Back returns to the utility list, Close/Escape/outside dismissal returns focus to More, and every exit cancels/discards the usage owner as specified.
- The usage view uses flat owner-labelled semantic rails for capture, Account, This thread, Daily history, and Rate limits. It reuses Focus Rail tokens, dividers, typography, Lucide icons, six-pixel maximum radius, safe-area padding, and one sheet scroll owner. It adds no nested cards, chart dependency, decorative art, desktop inspector, or terminal motif.
- Loading, current, stale, empty, unsupported, limit-reached, and failure meaning uses icon plus text, never color alone. The refresh control is icon-based with a tooltip; back/close use familiar icons; all values wrap safely and all dynamic controls keep stable dimensions.

## Harsh Success Criteria

| ID | Requirement |
| --- | --- |
| `UUS-01` | One strict immutable-session headless owner validates construction, snapshot context, read port, subscriptions, and close; malformed or foreign state fails loudly without React, direct HTTP, persistence, timers, or hidden adapters. |
| `UUS-02` | Open and explicit refresh use only exact selected-session `usage_read` with one session id and AbortSignal; no body, query, CSRF, write gate, audit, terminal, event, turn, slash, or second-client path exists. |
| `UUS-03` | Open, refresh, duplicate activation, rerender, StrictMode, dismiss, Back, close, unmount, target change, and authority change own one abortable lifecycle; stale/late settlement cannot update another owner or produce an unhandled rejection. |
| `UUS-04` | Every `200` response passes the complete strict usage schema and exact HostDeck target check before publication; snapshots replace rather than merge and cannot cross sessions, epochs, controls, routes, or browser lifetimes. |
| `UUS-05` | Capture epoch/currentness is explicit: a later coordinator epoch or retained noncurrent source makes retained same-target data stale until one explicit successful read; arbitrary wall-clock thresholds never fabricate staleness or freshness. |
| `UUS-06` | Disclosure loss clears and closes every private usage value immediately; write/CSRF/lock loss alone does not block a current authorized read; stale authorized data is visibly stale and never admitted as current. |
| `UUS-07` | Loading, refresh-with-retained-data, content, empty, stale, unsupported, and failure are deterministic distinct states with stable bounded copy, status semantics, and no old-current reuse. |
| `UUS-08` | Account scope renders all five nullable summary facts exactly, distinguishes null from zero, never assigns account totals to the thread/session/project, and makes no money, subscription, balance, or remaining-quota inference. |
| `UUS-09` | Daily history distinguishes null, empty, and populated; only the newest seven valid buckets render with explicit omitted count, exact dates/tokens, no invented zero dates, and no unbounded DOM. |
| `UUS-10` | Thread not-observed and observed states remain distinct; observed total and last breakdowns render independently without arithmetic/comparison, and Codex thread/turn ids never appear. |
| `UUS-11` | Nullable context capacity renders exactly without remaining/used percentage, fit, warning, or compaction inference; compaction-reset-compatible values do not trigger contradictory UI. |
| `UUS-12` | Rate not-observed, observed-null, primary, secondary, nullable duration/reset, decimal percentages, and all five reached types render distinctly; null is never called unlimited and raw enum/account/billing detail never appears. |
| `UUS-13` | Empty requires wholly absent account summary/history content plus unobserved thread/rate truth; actual zeros or any explicit account/thread/rate observation remain content. |
| `UUS-14` | Unsupported is limited to proven capability/incompatibility rejection; every other failure is sanitized and bounded, and any retry is a new explicit eligible read with no automatic retry, polling, fallback, or success inference. |
| `UUS-15` | Production code cannot start/steer/interrupt/archive/compact a turn, send literal `/usage`, mutate any control, invoke shell/tmux/terminal, open billing, or call any selected route other than `usage_read`. |
| `UUS-16` | Session Detail renders one equal-width four-cell live dock containing `/model`, `/goal`, `/plan`, and icon-only More, with no duplicate dock, direct fourth `/usage` text command, dead utility placeholder, composer regression, or desktop-led structure. |
| `UUS-17` | More opens one labelled Session utilities sheet with exactly one live `/usage` row and an authority-correct disabled reason; selecting it transitions within one modal layer to the exact target usage view. |
| `UUS-18` | Back, Close, Escape, outside dismissal, focus trap/restore, keyboard order/activation, accessible names/descriptions, tooltip titles, busy announcements, non-color meaning, visible focus, reduced motion, and 44 px targets pass. |
| `UUS-19` | The sheet uses Focus Rail flat semantic rails, approved tokens/type/dividers/icons/radii/safe areas, one scroll owner, stable controls, and no nested cards, chart dependency, decorative asset, terminal motif, or Signal Ledger borrowing. |
| `UUS-20` | 320/360/390/412/768/1280, 390 x 420, long target/numbers/dates/copy, populated seven-day history, scrolled state, and actual 200 percent reflow have no overlap, clipping, horizontal overflow, hidden back/close/refresh/content, or obscured composer. |
| `UUS-21` | Public controller views, DOM, logs, errors, screenshots, history, and browser storage contain no account/device identity, cookie/CSRF, operation id, Codex thread/turn id, raw API/runtime text, private origin, path, prompt, or monetary estimate. |
| `UUS-22` | Headless/component/API tests cover strict parsing/targeting, every state and value-nullability combination, epoch/authority races, cancellation, duplicate activation, request count/shape, no mutation/retry/storage, focus, and adjacent controls/composer. |
| `UUS-23` | Deterministic browser captures and layout measurements cover menu, loading, current content, empty, stale, unsupported, failure, unobserved/null/zero, limit reached, long/responsive/short-height/zoom states; manual comparison records only approved Focus Rail drift. |
| `UUS-24` | Focused and aggregate web/browser suites plus full unit/contract/integration/type/lint/scaffold/planning/runtime-boundary/build/package/install/audit/privacy/diff/residue checks, owner-doc evidence, clean commit, and push pass before closure. |

## Planned Evidence

- Headless tests own exact construction, immutable projections, current/stale epoch rules, null/empty/zero semantics, seven-bucket UI bound, read single-flight/cancellation, sanitized failures, and authority loss.
- Component tests own More/menu/usage navigation, all semantic rails, live/status behavior, Back/Close/Escape/focus restoration, disabled reasons, refresh, target disclosure, and no dead controls.
- Production-shell Chromium owns exact HTTP shape/count, no prefetch/mutation/retry, every state family, late settlement, target loss, strict DOM/storage/history privacy, adjacent Model/Goal/Plan/Prompt continuity, responsive containment, and effective 200 percent reflow.
- Deterministic screenshots and layout JSON own Focus Rail fidelity, one modal/scroll owner, equal four-cell dock, 44 px targets, stable loading dimensions, wrapped values, and no viewport/document overflow.
- Repository validation owns contract/runtime/API regressions, package/build truth, selected-runtime privacy boundary, no dependency change, no process/listener/device residue, and clean pushed history.

## Reuse And Ownership

Reuse `usageSnapshotSchema`, `usage_read`, the browser connection coordinator, existing controller lifecycle conventions, Radix Dialog, Focus Rail sheet/dock primitives, Lucide icons, selected Session Detail fixtures, and Playwright production shell. Add no production dependency and generate no new visual asset: the approved Session Detail, primary-controls, and responsive-continuum rasters already define this utility group's structure.

`FE-V1-028` owns only browser usage read state, bounded usage projection, the first live utility-overflow path, and deterministic UI evidence. `FE-V1-029` and `FE-V1-030` later add Compact and Skills to the same utility system; `FE-V1-014` owns event diagnostics; `FE-V1-036` to `FE-V1-038` own session actions; `FE-V1-035` owns compatibility UI; `FE-V1-039`, `FE-V1-016`, and release leaves own module, physical-device, packaged-asset, and release acceptance.
