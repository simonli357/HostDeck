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

Criteria are frozen before implementation. Implementation, validation results, screenshot hashes, measured layout evidence, drift disposition, and commit ids remain pending.
