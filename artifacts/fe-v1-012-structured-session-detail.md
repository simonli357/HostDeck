# FE-V1-012 Structured Session Detail

Date: 2026-07-22

## Scope

Implement the phone-first Session Detail route as a thin React projection of the selected session-detail response and one coordinator-owned SSE connection. This leaf owns bounded recent-history replay, live event reduction, semantic conversation/activity rendering, current/stale/failure/boundary presentation, explicit refresh, new-activity/autoscroll behavior, route header identity, responsive layout, accessibility, deterministic browser fixtures, and visual evidence against the approved Focus Rail targets.

This leaf does not own prompt submission, `/model`, `/goal`, `/plan`, utilities, approval decisions, event diagnostics, interrupt/archive/TUI-resume actions, host-access recovery, desktop list/detail composition, packaged web assets, or final real-phone acceptance. Those remain with `FE-V1-020` to `FE-V1-022`, `FE-V1-026` to `FE-V1-038`, `FE-V1-013`, `FE-V1-014`, `FE-V1-016`, `IFC-V1-053`, and `FE-V1-090`. Their controls must not appear as disabled or fake placeholders in this leaf.

## Pre-Change Findings

- The selected Focus Rail targets are complete for this screen group: `mobile-session-detail-active.png`, `mobile-approval-boundary-states.png`, `responsive-continuum.png`, `design-system.md`, and `theme.md` define the hierarchy, semantic treatments, tokens, and target widths. `DEC-028` permits no Signal Ledger borrowing or unrecorded structural drift.
- The shell validates and routes a session id, but production Session Detail is still a loading placeholder. The app runtime is currently created only when Mission Control needs it, so a direct detail route cannot yet acquire the production coordinator.
- `FE-V1-025` loads the selected session projection and event-window metadata but intentionally retains no event collection. Its existing `connectSessionStream` always starts after the detail projection's `last_event_cursor`, which is correct for live-only consumers but cannot populate recent history when a detail route first opens.
- The selected SSE source already provides an atomic durable-replay-to-live handoff. Starting a second HTTP event-page request would create a separate pagination/race owner and still require a handoff reconciliation rule. Session Detail therefore uses one explicit bounded replay start on the existing SSE owner.
- Durable selected events begin at cursor 1. A non-empty recent request may safely start at `max(0, detailLastCursor - 100)`; cursor 0 means "before the first event." An empty detail projection starts with `after = null`. The 100-cursor bound matches `selectedEventPageMaxSize`, fits the selected SSE replay byte/event defaults, and limits only history known at detail capture; race-time and later live events may still arrive and the browser feed remains capped at 100 retained raw events.
- A replay boundary is both an event and persistent continuity truth. The coordinator's detail metadata must keep a retention boundary visible even when the recent start cursor falls after it and the SSE source does not emit another boundary event.
- Agent message deltas are transport-level fragments. Rendering each delta as a separate row would be false UI. Deltas with the same non-null `item_id` concatenate; a completed message replaces accumulated deltas with its authoritative text. User messages are completed-only.
- Approval events may render a read-only semantic summary in this leaf. Approve/deny controls and race handling belong to `FE-V1-022`; raw diagnostic payloads and ids belong to `FE-V1-014`.
- No new dependency is required. React 19, React Router, Lucide, the existing clients/coordinator, Vitest/Testing Library, and Playwright cover the leaf.

## Frozen Design

### Recent Replay And Stream Ownership

- `BrowserConnectionStateCoordinator.connectSessionStream` gains one exact optional start mode: `live` (the backward-compatible default) or `recent`.
- `live` starts after the current detail projection's `last_event_cursor`, preserving every existing caller and `FE-V1-025` contract.
- `recent` derives its immutable start cursor once from the current detail response: `null` for an empty event window; otherwise `max(0, last_event_cursor - selectedEventPageMaxSize)`. It does not accept an arbitrary caller cursor or limit.
- The same selected SSE client owns durable replay, race-free high-water capture, paused live events, reconnect from its committed cursor, continuity validation, retry bounds, and cleanup. The UI performs no event-page request, polling, durable cursor storage, second stream, hidden retry, or cross-session reuse.
- A stream owner is valid only for the current route/session epoch and readable authority. Route change, refresh, access loss, unmount, or coordinator close cancels it exactly once. Refresh reloads detail truth, clears the local feed, and reconnects in `recent` mode only after the new detail response is current.
- Reentrant setup, React StrictMode effect replay, synchronous stream publication, consumer failure, failed connection construction, and stale callbacks cannot leave a request, listener, timer, or late event publication.

### Headless Feed Model

- One pure reducer accepts only exact `SelectedProjectionEvent` values for the target session, orders and deduplicates by cursor, and retains at most 100 raw events. A duplicate cursor with unequal content is a contract failure, not a replacement.
- The reducer exposes a semantic timeline rather than wire records. Message items consolidate agent deltas by `item_id`; completion replaces partial text; null item ids remain distinct cursor-addressed items. Empty deltas do not create visible cards.
- Turn, activity, approval, control, runtime, replay-boundary, and unknown-optional events each map to bounded type/state labels, icons, tones, titles, summaries, and timestamps. Failure, interrupted, waiting, progress, and completed states are textually distinct and never color-only.
- `content_state` is always honored. Redacted, truncated, and redacted-and-truncated events show their bounded `content_notice`; the UI never reconstructs hidden content or labels incomplete content as complete.
- Main-feed projection excludes `session_id`, cursors, Codex event ids/types, thread/turn/item/request ids, full cwd, raw payloads, and raw errors. Bounded public event text supplied by the selected contract may render; diagnostics remain downstream.
- The feed preserves cursor chronology after message consolidation. Completion does not move an item to the end, and eviction removes the oldest raw history without violating the remaining semantic order.

### Disclosure, Freshness, And Failure

- Current readable access is the disclosure gate. Before it exists, and after denial/revocation/expiry/permission loss, no session name, project, branch, summary, event, retained count, or locally retained feed content renders. Local event memory is also purged after the render-time suppression takes effect.
- Same-session detail retained during loading or failure may render only with explicit stale wording and its observation time where available. A stale projection, disconnected/incompatible freshness, reconnecting/failed stream, and retained continuity boundary remain independently visible; one does not erase another.
- The screen distinguishes initial detail loading, initial replay, current/live, empty history, reconnecting with retained feed, terminal stream failure with retained feed, detail-not-found/archived, access-limited, and generic origin failure.
- Generic origin failure remains generic. It cannot invent Tailscale, Serve, profile, runtime, or laptop diagnosis. Bounded source-aware copy contains no route id, status body, origin, device identity, cookie/CSRF state, cwd, thread id, cursor, or thrown cause.
- Initial replay is pending while a non-empty detail baseline has not yet been observed by the stream. The baseline is satisfied when the committed stream cursor reaches or exceeds the detail response's `last_event_cursor`; an empty baseline completes when the stream connects. This state never claims the session itself is running.

### Session Identity And Timeline UI

- The app bar shows the readable session name as title and a bounded project/status cue as subtitle. Loading, denied, missing, and failed states use generic non-disclosing title text. Back behavior remains history-safe and direct-link safe.
- A compact context rail below the app bar exposes only approved route-backed cues: status, project, optional branch, and stream/freshness state. The feed remains the dominant scroll content; there is no terminal, code editor, file tree, raw transcript, decorative hero, nested card surface, or unsupported desktop inspector.
- Timeline markup uses one ordered list and a continuous rail. Conversation messages, activity/progress, approvals, failures, runtime/control changes, and boundaries have distinct icon/shape plus text treatments. Approval rows are read-only and contain no decision action.
- Event timestamps use deterministic injected formatting in tests and accessible machine-readable `dateTime` values. Long text, paths, commands, unbroken tokens, and translated-length labels wrap or clamp without horizontal document scrolling or unstable controls.
- Empty history says no activity has been recorded; it does not imply failure, completion, or a healthy stream. Loading skeletons contain no fabricated session or event data.

### Scroll And New Activity

- The document remains the phone scroll owner; the timeline does not create a nested primary scroll region. A bottom sentinel and viewport measurements classify the user as pinned when the feed end is within a small fixed threshold.
- Initial history settles at the feed end. Later events may keep the end visible only while pinned. When the user has moved away, no event calls forced scrolling; an accessible `New activity` control appears with a bounded count.
- Activating `New activity` scrolls the sentinel into view, clears the count, and returns to live position. Focus is not stolen on event arrival. Reduced-motion preference removes smooth scrolling and all nonessential animation.
- Event consolidation updates and reconnect duplicates do not inflate the unread count. Only newly accepted cursors received while unpinned count as new activity; the count saturates at the 100-event local bound.

### Responsive And Visual Contract

- The implementation uses the approved Focus Rail canvas/surface/ink/muted/divider/connected/attention/danger/focus tokens, fixed 4/8/12/16/24 spacing, 0/4/6 px radius, 44 px minimum targets, stable typography, Lucide icons, and flat repeated timeline surfaces.
- At 360, 390, and 412 px widths, the hierarchy remains one column and the app bar, complete context rail, and beginning of the timeline are visible without overlap or horizontal overflow. Safe-area padding is reserved even though the composer is downstream.
- At 768 and 1280 px, the route widens into a bounded detail reading column. It does not fabricate the approved desktop list/detail split before `FE-V1-016` owns complete responsive composition.
- At 320 px reflow and 200 percent zoom, every label, notice, event, and action remains readable and operable. Focus order follows back, host/access, refresh/recovery, timeline links or controls, then new activity; focus indicators, contrast, semantics, live-region restraint, and reduced motion pass inspection.
- Deterministic screenshots cover active, approval/boundary, stale/reconnecting, access-limited, empty, failed, long-content, and reference widths. Every capture is manually compared with the approved Focus Rail assets and stored under `artifacts/fe-v1-012-session-detail/`; remaining structural drift requires explicit disposition.

## Acceptance Matrix

| ID | Criterion |
| --- | --- |
| `SDT-01` | Coordinator start options are exact and validated; omitted/`live` behavior is unchanged, while `recent` derives only the frozen 100-cursor start from current detail truth. |
| `SDT-02` | Recent history and live events use one selected SSE replay-to-live handoff with no event-page race, second stream, polling, storage, arbitrary cursor, or hidden retry. |
| `SDT-03` | Route, refresh, session, authority, unmount, close, reentrant, synchronous-publication, and failure paths release the stream once and reject stale callbacks or cross-session events. |
| `SDT-04` | One pure reducer validates target identity, preserves cursor order, deduplicates exact reconnect events, rejects contradictory duplicates, and retains at most 100 raw events. |
| `SDT-05` | Agent deltas consolidate by item id, completed text replaces partial text without reordering, user messages remain completed, and empty fragments do not create false rows. |
| `SDT-06` | Every selected event union member and every relevant state maps to bounded semantic text, icon/shape, tone, timestamp, and content limitation treatment without raw-wire rendering. |
| `SDT-07` | Current readable authority gates all protected identity/detail/feed output; loss suppresses immediately and purges local event memory without leaking retained values. |
| `SDT-08` | Loading, initial replay, current, empty, retained stale, reconnecting, terminal stream failure, not found/archived, access-limited, and generic origin failure remain distinct. |
| `SDT-09` | Projection freshness, stream continuity, retention boundary, reconnect/failure, and prior bounded failure remain independently visible and never collapse into false `Live` or healthy wording. |
| `SDT-10` | Generic transport loss stays generic; precise runtime/network causes appear only from current or explicitly retained selected response truth, with privacy-safe bounded copy. |
| `SDT-11` | The readable app bar and context rail expose approved session/status/project/branch/stream cues; denied/loading/error headers are non-disclosing and Back remains direct-link/history safe. |
| `SDT-12` | The main surface is one semantic ordered timeline with continuous Focus Rail treatments; no terminal/editor/raw transcript, nested cards, unsupported desktop pane, or fake downstream control appears. |
| `SDT-13` | Approval entries are truthful read-only summaries, boundaries are explicit chronology breaks, and diagnostics/control actions remain with their downstream leaves. |
| `SDT-14` | Initial history settles at the end; pinned live updates stay visible; unpinned updates never force scroll and produce an accurate bounded `New activity` affordance without stealing focus. |
| `SDT-15` | Explicit refresh is single-flight, clears/reloads the baseline, reconnects only after current detail truth, retains no prior-session feed, reports bounded failure, and never retries itself. |
| `SDT-16` | Active, waiting, approval, completed, interrupted, failed, unknown, stale, archived/not-found, reconnecting, boundary, empty, access-limited, and long-content component cases pass. |
| `SDT-17` | Focus Rail token/component mapping and hierarchy match all three approved detail/approval/responsive references without Signal Ledger borrowing or unapproved structural drift. |
| `SDT-18` | 320/360/390/412/768/1280, 200 percent zoom, long content, reduced motion, touch targets, contrast, keyboard/focus, semantic time/list/status, and safe-area behavior pass without overlap or horizontal scroll. |
| `SDT-19` | Pure reducer/projection, coordinator, component, router, and production-browser tests exercise replay/live races, message consolidation, authority loss, reconnect, scroll behavior, cleanup, privacy, and deterministic screenshots. |
| `SDT-20` | Focused/web/workspace/type/lint/planning/runtime/package/supply-chain/privacy/residue gates pass; owning docs and evidence match actual scope, with actions/device/release work left explicitly downstream. |

## Planned Validation

```bash
pnpm --filter @hostdeck/web test
pnpm --filter @hostdeck/web typecheck
pnpm --filter @hostdeck/web build
pnpm test:browser:shell
pnpm test:web
pnpm test:unit
pnpm test:contract
pnpm test:integration
pnpm typecheck
pnpm lint
pnpm check:scaffold
pnpm check:runtime-boundary
pnpm check:planning
pnpm test:package
pnpm install --offline --frozen-lockfile
pnpm audit --prod
git diff --check
```

Manual inspection additionally covers approved-reference comparison, initial-replay and boundary truth, pinned/unpinned scrolling, 320 px reflow, 200 percent zoom, keyboard/focus order, reduced motion, contrast, long-content containment, browser console/network/storage privacy, and process/temporary-file residue. Real Android/Tailscale acceptance remains downstream and cannot be claimed by browser emulation.

## Evidence

Criteria were frozen before implementation in `015b99d`. Implementation and deterministic browser evidence are committed in `0d29a66`.

### Result

- `SDT-01` to `SDT-20` pass for this leaf. `connectSessionStream` keeps omitted/`live` behavior and adds one exact `recent` mode derived from current detail truth; no arbitrary cursor, event-page request, second stream, polling, or browser persistence exists.
- The exact, deep-frozen reducer rejects malformed targets, contradictory duplicates, gaps, out-of-order events, and inconsistent later boundaries; it retains 100 raw events while preserving accepted cursor/count truth.
- Agent deltas consolidate by item id and authoritative completion replaces partial text in place. Every selected event/state and content-limitation variant receives bounded semantic projection without raw wire identifiers.
- Readable authority gates app-bar identity, context, and feed content. Revocation suppresses and purges immediately; stale detail, unavailable cleared feed, reconnecting retained feed, terminal failure, continuity boundary, empty history, and not-found/archived rejection remain distinct.
- The production detail route owns one coordinator subscription and one recent SSE handoff. Refresh is single-flight, clears the baseline, reconnects only after current detail, and never self-retries.
- The ordered Focus Rail timeline, read-only approval facts, document-owned scrolling, pinned/unpinned behavior, centered bounded new-activity control, generic failures, and direct/history Back behavior match the frozen interface contract.

### Automated Validation

| Gate | Result |
| --- | --- |
| Web package | 10 files, 175 tests passed. |
| Web aggregate | 11 files, 178 tests passed. |
| Production Chromium | 11 scenarios passed: shell/direct route, active continuum, stale/revoked, empty, approval/boundary, terminal failure, reconnect, long/reflow, keyboard/focus, reduced motion, contrast, live update, and 2x zoom. |
| Unit | 202 files and 2,021 tests passed; 27 files/28 tests remained explicitly skipped by existing opt-in gates. |
| Contract / integration | 34 files/243 tests and 21 files/35 tests passed. |
| Static | Root/web typecheck, Biome/package exports over 584 files/8 packages, scaffold over 8 packages/21 scripts, runtime boundary over 612 production modules/22 externals, and planning over 219 tasks/84 requirements/675 dependencies passed. |
| Build / package | Vite built 2,013 modules; deterministic production package acceptance passed two builds with 6,433 entries, relocated read-only execution, and runtime/config/static/integrity rejection. |
| Supply chain / diff | Frozen offline install, zero-vulnerability production audit, privacy scan, process/result-marker cleanup, and final diff checks passed. |

The Vite entry is 626.79 kB minified and 173.02 kB gzip. Vite emits its advisory 500 kB uncompressed chunk warning; no V1 performance threshold fails, and route splitting remains with complete-dashboard/release hardening rather than being hidden in this leaf.

### Visual And Accessibility Evidence

`layout-measurements.json` (`9a6005aff7d061fd80c85735f4817c19c10278c1b402b8fa2d0858b70d12d2af`) records all five reference widths. Every document has `clientWidth == scrollWidth`; context bottoms precede first timeline tops; refresh remains 44 x 44; the route is 360/390/412/768 px wide on the phone/tablet references and is centered at exactly 820 px on 1280.

| Capture | Dimensions | SHA-256 |
| --- | --- | --- |
| `active-360x800.png` | 360 x 800 | `263bbae4b67b44b43e1ab92403f68132d58d8e608ba8427baa576753b2e415f1` |
| `active-390x844.png` | 390 x 844 | `d84ad71395a9416945a19324e2b3ea6145f0c68ca54c8b8e06ee409acb76aac7` |
| `active-412x915.png` | 412 x 915 | `09bac8ba1f8ce9fae4389b656f79e08fefbac7d0c7ba426ffa189e766a939e19` |
| `active-768x1024.png` | 768 x 1024 | `8a29d19f863edf6f5915752ef58ffc376cb46223b9f5395f78d8560d063a2bd8` |
| `active-1280x800.png` | 1280 x 800 | `8b6ca9e66492ec067430279c2bbf154a1345db6315b33243cc977db8d4d0d117` |
| `active-full-390x844.png` | 390 x 1,141 | `689bc66f024c562deb6699b3f3db02351ebd3ba00ce9411f8c34a5ac23b59366` |
| `approval-boundary-390x844.png` | 390 x 844 | `dedb8ae425240d00a35d67024c372bd1dbc0497e48f5cafdf20337d2eaff35a6` |
| `reconnecting-390x844.png` | 390 x 844 | `5821a6401130c0a55cfba08c0e335125051184016f5e8eb9301aa47c7cacb9b9` |
| `stream-failed-390x844.png` | 390 x 844 | `161ee80c5a0ea9a25333aa06764e24f16400d5f06f93af8e88cd002e537a6d27` |
| `stale-390x844.png` | 390 x 844 | `5c7ea34e10603b0a628df46aa6da2e545cf1aaa6d3063eb890e9b4a2cfc92aba` |
| `access-limited-390x844.png` | 390 x 844 | `ca57a6d3210c957dde5c761c376466fb3760786fe49bf69a9a269fde48aa5525` |
| `empty-390x844.png` | 390 x 844 | `33416fe62a15002fc18877d65e0d9b6c53fa90775656ec4e2d4652c1f38deda8` |
| `new-activity-390x844.png` | 390 x 844 | `2c80bf162296cb801ceb7e7b2c8fd3eafdf4b985bb8f0c8278219a57e3be7786` |
| `long-reflow-320x800.png` | 320 x 2,669 | `848b69ae038a5804546407d7ccce2ff71f4bfc65bfd8aff997f30e4b6572c98f` |
| `zoom-200-1280x800.png` | 1280 x 800 at 2x layout zoom | `c78a845e3bcfc73901aa0452e34348b175a073eb056cc62534be6992ac06107c` |

All captures decode at their recorded dimensions with 1,630 to 6,158 colors. Automated checks prove no horizontal overflow, stable controls, unclipped long timeline items, 3 px visible focus, correct keyboard order, reduced-motion suppression, selected-token contrast, semantic list/time/status output, no downstream textbox/decision control, and empty browser storage.

Manual comparison against `mobile-session-detail-active.png`, `mobile-approval-boundary-states.png`, and `responsive-continuum.png` confirms the selected Focus Rail app-bar hierarchy, continuous timeline, semantic blue/teal/amber/red treatments, flat event rows, visible boundaries, and phone-first density without Signal Ledger borrowing. The shared shell menu/context rail use the already selected route architecture. The illustrative composer, `/model`/`/goal`/`/plan` dock, approval decisions, and 1280 list/detail split are intentionally absent because `FE-V1-020`, `FE-V1-021`, `FE-V1-026`, `FE-V1-027`, `FE-V1-022`, and `FE-V1-016` own them; this is frozen scope, not unresolved drift.

### Privacy, Residue, And Downstream Limits

Deterministic browser requests remain on `http://127.0.0.1:4175`; page errors, external requests, and local/session storage remain empty. The stale refresh produces one expected browser-generated 503 resource line without exposing its private response body. Source inspection found no storage, console logging, polling, event-page fetch, second stream, raw route/session/thread/item/request/event id, full cwd, credential state, or live Tailscale/profile/Serve mutation in the product projection. Test-owned port 4175 processes and Playwright result state are absent after validation.

This leaf does not claim pairing/access recovery, prompt submission, `/model`, `/goal`, `/plan`, utility actions, approval decisions, diagnostics, interrupt/archive/TUI resume, desktop split, packaged assets, complete-dashboard hardening, or real Android/Tailscale acceptance. Those remain with `FE-V1-013` to `FE-V1-016`, `FE-V1-020` to `FE-V1-022`, `FE-V1-026` to `FE-V1-040`, `IFC-V1-053`, and `FE-V1-090`.
