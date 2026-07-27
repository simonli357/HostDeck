# FE-V1-030 Read-Only Skills Utility

Date: 2026-07-27

Status: criteria frozen; implementation not started. `SKL-01` through `SKL-24` must pass before closure.

## Scope

Implement the selected Focus Rail `/skills` utility on Session Detail. One explicit open reads one exact selected session's structured, path-redacted skills snapshot. The surface presents deterministic skill metadata, explicit partial/error truth, and bounded local discovery without turning the phone into a filesystem, package manager, skill editor, or terminal.

Excluded: cwd/path display or input, filesystem discovery, arbitrary directory access, raw `SKILL.md` content, prompts, icons, commands, URLs, transports, dependency details, raw runtime errors, skill installation/removal/editing/enabling/disabling, runtime reload controls, model/goal/Plan/Usage/Compact mutation, prompt/turn start, literal slash text, terminal/event parsing, automatic polling/retry, browser persistence, cross-session aggregation, compatibility recovery, physical-phone release acceptance, and dead diagnostic/action placeholders.

## Pre-Change Findings

- `INT-V1-024` already owns one exact `skills/list` read with `{ cwds: [selectedCwd], forceReload: true }`, strict selected target/runtime/generation checks before and after the await, no retry, and no caller-controlled cwd. It validates and discards paths, prompts, icons, dependencies, commands, URLs, transports, values, and raw errors.
- `IFC-V1-065` already owns strict no-store `skills_read`. `GET /api/v1/sessions/:session_id/skills` accepts only one HostDeck session id, has no query/body/CSRF/lock/audit/write effect, resolves cwd/thread internally, and maps private causes to bounded public errors.
- `skillsSnapshotSchema` retains only target/runtime/capture identity, deterministic unique names, nullable descriptions, `user | repo | system | admin` scope, enabled truth, and a redacted error count. `content`, `empty`, `partial`, and `error` are contract-derived and cannot be merged or inferred by the browser.
- A snapshot may contain up to 1,024 skills, 256 redacted errors, 160-character names, and 4,096-character descriptions. Rendering every long row at once would be contract-bounded but not a usable or responsible phone surface.
- A current paired reader may call `skills_read` while writes are read-only or host-locked. Archived, stale, recovery, disconnected, target-mismatched, unsupported, malformed, and runtime-failure states remain explicit.
- `FE-V1-028` and `FE-V1-029` established one four-cell dock, one icon-only More entry, one shared Radix modal layer, one scroll owner, fixed utility footer, responsive Focus Rail mapping, and exact Usage/Compact read lifecycles. The current utility menu contains only live `/usage` then `/compact`; no Skills owner, row, view, filter, fixtures, or browser evidence exists.

## Frozen Design

### Authority And Request Ownership

- Add one strict headless Skills owner for one immutable HostDeck session id. It consumes only one current browser-connection snapshot and one injected read port; it owns open/dismiss, explicit refresh, one in-flight read, capture epoch/authority/target, bounded failure, subscriptions, and close.
- Opening `/skills` performs exactly one abortable `skills_read` through `requestSelectedSessionRead`, with only the selected HostDeck `session_id`. Refresh performs one new read. There is no request on Session Detail load or More-menu open, no interval/focus/visibility/event-driven refresh, no backoff, and no automatic retry.
- Every success is reparsed through `skillsSnapshotSchema` and matched to the immutable HostDeck session, current internal Codex thread, and runtime version before publication. The public view strips thread, connection-generation, device, origin, cwd, path, operation, protocol, and raw-error identity.
- One request owner coalesces duplicate activation. Back, Close, Escape, outside dismissal, unmount, target/read-authority replacement, or close aborts and suppresses late settlement. A stale read cannot update a replacement owner or generate an unhandled rejection.
- A capture records coordinator epoch, exact read-authority identity, and selected target identity. Later same-target epoch/noncurrent state makes retained data stale. Read-disclosure, principal, thread, runtime, or target replacement closes and clears it; write/CSRF/lock loss alone preserves authorized readable data.

### Snapshot And Skill Truth

- `content`, `empty`, `partial`, and `error` map one-to-one from the strict snapshot. Empty means zero skills and zero reported errors. Partial means at least one skill plus at least one redacted error. Error means zero skills plus at least one redacted error. None is rewritten as unsupported, transport failure, or success.
- The capture rail shows only current/stale state, observed time, and bounded runtime version provenance. Summary counts are exact derivations from the complete current snapshot: total, enabled, disabled, and reported error count. An error count is never called a failed-skill count and no hidden error detail is invented.
- Rows preserve strict API name order and show exact name, locally mapped scope (`User`, `Project`, `System`, `Admin`), and explicit `Enabled` or `Disabled` text plus icon. The UI never reorders by scope/status, invents priority, or hides disabled rows by default.
- Description null renders `Description not reported`; an exact empty string renders `No description provided`; non-empty text renders exactly. Long descriptions remain available to assistive technology, use a bounded collapsed visual treatment with an explicit per-row expansion, wrap anywhere, and are never destructively shortened or interpreted as commands/paths.
- Local discovery uses one labelled, maximum-160-character search field over name and non-null description. It preserves contract order, never changes the request, URL, history, or storage, and distinguishes `No skills match this search` from a runtime `empty` snapshot.
- The UI initially renders at most 24 matching rows and exposes one `Show 24 more` action until all matches are reachable. Search, new capture, dismissal, and owner replacement reset the visible bound. No hidden 1,024-row DOM, list virtualization dependency, unbounded render loop, or server pagination claim is introduced.

### Failure And Freshness Semantics

- Typed `capability_unavailable` or proven incompatible-runtime rejection is `skills_unsupported`. It offers no terminal, slash, filesystem, CLI, or alternate-API fallback.
- Every other HTTP, transport, timeout, overload, target, storage, malformed-response, protocol, abort-after-dispatch, or unexpected failure is `skills_failure` with bounded local copy. Raw API messages, causes, paths, thread ids, response bodies, retryability, and runtime details never render.
- Refresh is always a new explicit eligible read. During refresh or failure, an authorized prior capture may remain only as visibly stale; it is never merged with a new result or called current. Unsupported remains non-refreshable inside that open capture, while close/reopen may probe after external runtime change.
- Read authority is independent from write eligibility. Read-only, locked, and active/waiting/unknown-turn states may inspect current Skills data; archived, stale/recovery, unreadable, disconnected, incompatible, or replaced targets cannot fabricate availability.

### Focus Rail Utility Surface

- Session Detail retains one equal four-cell `/model`, `/goal`, `/plan`, More dock. More opens one `Session utilities` sheet containing exactly live `/usage`, `/compact`, and `/skills` rows in that order. No direct fourth text command, second dock, or dead diagnostics/action row appears.
- Usage, Compact, and Skills transition within the same labelled Radix modal. Back restores focus to the selected utility row; Close/Escape/outside restores More. Compact's submitted-POST dismissal lock remains authoritative and cannot be bypassed by utility navigation.
- Skills uses flat Focus Rail capture, summary, discovery, partial/error, and list rails with selected tokens, typography, dividers, Lucide icons, six-pixel maximum radius, safe areas, one body scroll owner, and one fixed nonoverlapping status/refresh footer. It adds no nested cards, decorative asset, chart, file-tree, terminal motif, or desktop inspector.
- Loading, current, stale, empty, partial, error, unsupported, failure, enabled, disabled, search-empty, and progressive-list meaning uses icon plus text. Search, row disclosure, refresh, Back, Close, and Show-more controls have stable dimensions, visible focus, accessible labels, reduced-motion behavior, and at least 44 px targets where interactive.

## Harsh Success Criteria

| ID | Requirement |
| --- | --- |
| `SKL-01` | One strict immutable-session headless owner validates exact construction, context, read port, subscriptions, and close; malformed or foreign input fails loudly without React, direct HTTP, persistence, timers, hidden adapters, or write ports. |
| `SKL-02` | Open and explicit refresh use only one abortable selected-session `skills_read` with one session id and no body/query/CSRF; duplicate activation, rerender, StrictMode, dismiss, unmount, target change, and close own exact cancellation with no prefetch, polling, retry, or late publication. |
| `SKL-03` | Every `200` response passes the complete strict skills schema and exact HostDeck/Codex target plus runtime-version match; snapshots replace rather than merge and cannot cross sessions, epochs, controls, routes, or browser lifetimes. |
| `SKL-04` | Capture epoch/read-authority/target identity makes retained same-target data current or stale explicitly; read-disclosure/principal/thread/runtime/target replacement closes and clears it, while write/CSRF/lock downgrade alone preserves authorized readable data. |
| `SKL-05` | Loading, content, empty, partial, authoritative error, stale, unsupported, and read failure are deterministic distinct states; snapshot state/count contradictions fail closed and old current data never substitutes for a failed read. |
| `SKL-06` | Exact total/enabled/disabled/error summary counts derive only from the complete strict snapshot; redacted error count is never equated with failed skills or expanded into cause/path/dependency detail. |
| `SKL-07` | Every row preserves strict name order and exact name, scope, enabled truth, and nullable description; known scopes map to stable public labels, disabled remains visible, and no ranking, support, priority, or capability inference is added. |
| `SKL-08` | Null, empty, short, multiline, control-like, non-ASCII, maximum-name, and maximum-description values remain distinct, wrapped, safe, and fully accessible; long descriptions use explicit expansion without destructive truncation or layout instability. |
| `SKL-09` | One bounded local search preserves API order, matches only retained name/description, never causes network/URL/storage effects, and distinguishes no matches from runtime empty; clearing search restores the same immutable snapshot. |
| `SKL-10` | Initial and incremental rendering never exceeds 24 additional matching rows per explicit action; all 1,024 contract-valid rows remain reachable, counts stay exact, and search/capture/dismiss reset the bound without an unbounded DOM or new dependency. |
| `SKL-11` | Unsupported is limited to proven capability/incompatibility rejection; authoritative snapshot error, partial content, malformed response, target change, transport failure, overload, timeout, and generic failure remain separately truthful where contract evidence permits. |
| `SKL-12` | Refresh is one explicit current-authority read; retained data is visibly stale while loading/failing, unsupported cannot loop refresh, and no automatic retry, backoff, focus refresh, event inference, or success fallback exists. |
| `SKL-13` | Current readers may inspect Skills while read-only, locked, or any turn state; archived/stale/recovery/unreadable/disconnected/replaced targets remain disabled or closed without consulting generic write eligibility. |
| `SKL-14` | Public controller views, React keys/attributes, status copy, logs, history, screenshots, and browser storage contain no server-derived device/account identity, cookie/CSRF, origin, cwd/path, operation id, Codex thread/generation, raw API/runtime error, prompt, icon, dependency, command, URL, or transport detail; visibly transient user-entered search text is bounded and never persisted or requested. |
| `SKL-15` | Production code cannot discover/read arbitrary files, accept cwd/path/thread/reload input, install/edit/enable skills, start/steer/interrupt/archive/compact a turn, mutate another control, send literal `/skills`, invoke shell/tmux/terminal, or call any selected route except `skills_read`. |
| `SKL-16` | Session Detail keeps one equal four-cell live dock and one More trigger; the utility list contains exactly `/usage`, `/compact`, `/skills` in order, all live and authority-correct, with no duplicate dock/dialog, direct Skills command, or dead placeholder. |
| `SKL-17` | All three utilities use one labelled modal layer; Back restores the selected row, Close/Escape/outside restores More, Compact submission cannot be bypassed, and no hidden interactive sheet, nested modal, or focus loss remains. |
| `SKL-18` | List/search semantics, keyboard order/activation, description disclosure, visible focus, accessible names/descriptions, restrained status/busy announcements, non-color meaning, reduced motion, tooltip titles, and 44 px interactive targets pass. |
| `SKL-19` | The sheet uses approved Focus Rail flat rails/tokens/type/dividers/icons/radii/safe areas, one scroll owner, fixed nonoverlapping footer, stable controls, and no nested cards, decoration, Signal Ledger borrowing, file-tree/terminal motif, or desktop-led structure. |
| `SKL-20` | 320/360/390/412/768/1280, 390 x 420, 200 percent reflow, 1/24/25/1,024 rows, all scopes/states, long target/name/description/error/search, expanded description, filtered-empty, and scrolled states have no overlap, clipping, horizontal overflow, hidden controls/status, composer obstruction, or dynamic-label shift. |
| `SKL-21` | Headless tests cover strict construction/projection, all snapshot states/scopes/description forms, exact target/runtime validation, immutable order/counts, duplicate activation, cancellation, epoch/authority/target races, sanitized failures, and private-free views. |
| `SKL-22` | Component/API tests prove exact GET shape/count/order, no prefetch/poll/retry/storage/fallback, shared three-row navigation, search/progressive/disclosure behavior, read-only/lock/turn independence, dismissal/focus, and adjacent Usage/Compact/Model/Goal/Plan/Prompt continuity. |
| `SKL-23` | Deterministic browser captures and layout measurements cover menu, loading, content, empty, partial, authoritative error, stale, unsupported, malformed/failure, read-only/locked, search matches/no-match, show-more, long/expanded, responsive/short-height/zoom states; manual comparison records only approved Focus Rail drift. |
| `SKL-24` | Focused and aggregate web/browser suites plus full unit/contract/integration/type/lint/scaffold/planning/runtime-boundary/build/package/install/audit/privacy/diff/residue checks, owner-doc evidence, clean commits, and pushes pass before closure. |

## Planned Evidence

- Headless tests own exact construction, target/runtime/schema correlation, state/count/description/scope projection, current/stale authority, read single-flight/cancellation, sanitized failures, and immutable private-free snapshots.
- Component tests own the shared three-row utility menu, same-layer navigation, capture/summary/list rails, bounded search and progressive rendering, long-description disclosure, state copy, refresh, focus restoration, and no dead controls.
- Production-shell Chromium owns exact bodyless/queryless/CSRF-free GET shape/count, no prefetch/poll/retry, response/authority races, strict DOM/storage/history privacy, adjacent controls/composer continuity, responsive containment, and effective 200 percent reflow.
- Deterministic screenshots and layout JSON own Focus Rail fidelity, one modal/scroll owner, equal four-cell dock, fixed footer, 44 px targets, 1,024-row bounded rendering, wrapped long content, and no viewport/document overflow.
- Repository validation owns contract/runtime/API regressions, dependency/asset stability, package/build truth, selected-runtime privacy boundary, no process/listener/device residue, and clean pushed history.

## Reuse And Ownership

Reuse `skillsSnapshotSchema`, `skills_read`, the browser coordinator, existing read-controller lifecycle and authority conventions, the completed `SessionUtilities` host, Radix Dialog, Focus Rail sheet/dock primitives, Lucide icons, selected Session Detail fixtures, and Playwright production shell. Add no production dependency or generated visual asset: `assets/ui-concepts/option-b/primary-controls.png`, `mobile-session-detail-active.png`, the Option B design system, and accepted `FE-V1-028`/`FE-V1-029` utility captures define this existing screen group's implementation target.

`FE-V1-030` owns only browser Skills read state, bounded public metadata projection, local discovery/render bounds, the third live utility row, and deterministic UI evidence. `INT-V1-024` and `IFC-V1-065` retain runtime/API truth; `FE-V1-014` owns event diagnostics; `FE-V1-036` to `FE-V1-038` own session actions; `FE-V1-039`, `FE-V1-016`, and release leaves own aggregate module, physical-device, packaged-asset, and release acceptance.
