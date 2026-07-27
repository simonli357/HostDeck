# FE-V1-014 Bounded Event Diagnostics

Date: 2026-07-27

Status: complete. `EVD-01` through `EVD-24` pass with the production cursor-zero evidence correction recorded below.

## Scope

Implement the selected Focus Rail Event details sheet for one exact retained Session Detail timeline event. The surface lets an authorized phone user inspect the normalized projection identity, source, time, bounded type-specific payload, content limitation, and replay-boundary evidence without opening a transcript browser, terminal, raw protocol viewer, or second Session Detail route.

Excluded: arbitrary event/session/cursor input, history pagination, full-transcript browsing, raw app-server frames, raw JSON/object rendering, unprojected stdout/stderr/tool data, shell or terminal input, command execution, links/file navigation, event mutation, retry loops, polling, SSE replacement, stream repair, browser persistence, download/copy/export, cross-session aggregation, compatibility recovery, interrupt/archive controls, physical-phone release acceptance, and desktop-only diagnostics.

## Pre-Change Findings

- `IFC-V1-069` already owns strict `GET /api/v1/sessions/:session_id/events` behavior over retained normalized projections. The route requires current session-read authority, accepts only canonical optional `after` and `limit`, caps pages at 100, brackets repository identity/layout, exposes explicit retention boundaries, enforces response bytes, and returns no raw frame, transcript, shell, credential, storage row, or private cause.
- `selectedProjectionEventSchema` owns eight exact normalized variants: message, turn, activity, approval, control, runtime, replay boundary, and unknown optional. Every event has session/cursor/capture identity, optional bounded upstream identity/time, and exact `complete | redacted | truncated | redacted_and_truncated` truth. `selectedEventDiagnosticsSchema` owns read-only completeness/boundary/redaction/incomplete-reason semantics.
- The browser route table already types `session_events`, but the selected-session read coordinator does not admit it. Session Detail currently receives recent replay plus live SSE, retains at most 100 strict raw events, consolidates repeated message and approval events into timeline items, and can add a continuity-only boundary not backed by a retained raw event.
- The current timeline shows semantic content and a limitation notice, but it has no exact diagnostic selection cursor, no per-item details affordance, no event-page read owner, and no sheet for type/source/id/payload/boundary metadata. A consolidated row must select its latest contributing event while preserving its original timeline position.
- Current read-only and host-locked phones retain session-read authority; write and turn state are irrelevant. Same-reader stale/reconnecting Session Detail may retain already authorized events, while reader/target/access loss purges them. The selected page route cannot address cursor zero because its cursor is exclusive, and a continuity-only boundary may have no retained event row; neither case may be mislabeled as API-verified.
- `DEC-028` selects Focus Rail. `mobile-session-detail-active.png` and `mobile-approval-boundary-states.png` own the continuous event rail and replay-boundary hierarchy; `primary-controls.png` owns the rail-backed mobile sheet language. Event details was intentionally not a separate mockup-required route or screen group.

## Frozen Design

### Selection And Read Ownership

- Add one strict headless Event diagnostics owner for one immutable HostDeck session id. Its exact context contains only the current browser snapshot, the already validated bounded Session Detail event array, and optional stream continuity boundary; its injected port can perform only one event-page read.
- UI callers pass only a non-negative safe cursor. The owner resolves that cursor from its current exact event/boundary context, rejects missing, duplicate, foreign-session, malformed, contradictory, or caller-supplied payload identity, and snapshots the selected evidence before opening.
- For a retained raw event with a positive cursor and current selected-session read authority, opening performs exactly one abortable `session_events` GET with the selected session, `limit=1`, and no body/CSRF. An ordinary event uses canonical `after=cursor-1`; a replay boundary uses its exact nullable `after`; a null `after` is omitted. No arbitrary query, page traversal, widening, prefetch, poll, focus refresh, or automatic retry exists.
- A cursor-zero raw event and a continuity-only boundary are not addressable as exact retained rows by this API contract. They open from already authorized in-memory projection/continuity evidence, make the verification limitation explicit, and send no fabricated request. This observable bounded fallback is the only no-read details path.
- Every `200` is reparsed with `selectedEventPageResponseSchema` and must contain exactly one event for the selected session/cursor, exact expected event or boundary identity/content, `next_cursor` equal to that cursor, and coherent truncation truth. Empty, additional, advanced, pruned-replacement, mixed-session, malformed, or merely similar events never verify the selection.
- One request owner coalesces duplicate activation. Close, Escape, outside dismissal, unmount, owner replacement, reader/target replacement, or context invalidation aborts and suppresses late settlement. A different event cannot reuse an earlier request or capture.

### Authority, Freshness, And Failure Truth

- Current route-verified detail is `current`. The selected normalized event may remain visibly `stale` while verification is pending/fails, after a same-reader same-target epoch change, or when opened from retained stale Session Detail. It is explicitly identified as retained projection evidence and never called a fresh API result.
- Reader, disclosure, session, Codex thread/runtime target, or route replacement closes and clears the sheet. Write permission, CSRF, host lock, and turn-state changes alone do not revoke a current reader or erase authorized detail.
- A current read failure retains only the exact already visible normalized event as stale, pairs it with the sanitized verification failure, and never renders any unverified response data. A first failure without retained evidence cannot invent a diagnostic capture.
- One explicit Retry action may issue one new exact read while the same selection and current authority remain. It never changes the selected cursor, automatically retries, merges events, repairs the stream, or claims the event was restored.
- Session-not-found/stale/pruned/selection mismatch, authority loss, malformed response, transport/timeout/overload, and unexpected failures remain distinct where stable evidence permits. Raw API messages, bodies, causes, storage/runtime identity, and retryability never render.

### Diagnostic Projection

- The public view passes its derived completeness/boundary/redaction truth through `selectedEventDiagnosticsSchema`. It always states that this is one bounded normalized projection, not complete Codex history or raw runtime output.
- Identity exposes only the exact HostDeck cursor, normalized type label, captured time, optional upstream time, optional bounded Codex event id/type, and source label `HostDeck projection`. Null and absent identity remain `Not reported`; no thread, generation, cwd/path, device/account, cookie/CSRF, origin, operation, storage, or raw protocol identity appears.
- Payload is an explicit per-variant allowlist, never `Object.entries`, serialization, reflection, or unknown-key display: message role/phase/item/text; turn id/state/bounded error; activity kind/state/item/title/detail; approval request/state/action/scope/reason/risk/expiry/decision; control kind/state/value summary; runtime state/message; replay after/next/reason; unknown upstream type/summary.
- Every field has stable user-facing labels and source order. Null, exact empty string, zero, false, short, multiline, control-like, non-ASCII, and contract-maximum text stay distinct and React-escaped. Long values wrap anywhere and remain fully reachable through explicit per-field expansion without linkification, command semantics, destructive trimming, or layout shift.
- `complete`, `redacted`, `truncated`, and `redacted_and_truncated` map one-to-one to icon-plus-text limitation rails. Non-complete states show the exact bounded content notice; complete state shows a stable bounded-projection notice and no invented omission claim.
- Replay boundaries show exact prior cursor (including `Not reported`), boundary cursor/next cursor, and retention/disconnect/restart/schema-change reason. A continuity-only boundary is labeled as stream continuity evidence, not a persisted event or missing-history count. Unknown optional events remain `Unrecognized optional event`, show their bounded upstream type/summary, and do not become an error, control, or raw payload viewer.

### Focus Rail Surface

- Each timeline item backed by retained event evidence gets one icon-only 44 px `View event details` action. Consolidated messages and approvals target their latest contributing event; synthesized approval-list rows without an event and non-event UI statuses do not get a dead action.
- The action opens one labelled Radix modal sheet over the same Session Detail. It has a stable title/target, identity rail, limitation rail, allowlisted payload list, fixed nonoverlapping status/Retry footer, one body scroll owner, safe-area handling, and Close. Dismissal restores the exact originating event action.
- Event details does not enter the primary dock or More utility menu, embed interrupt/archive/approval decisions, alter pinned/new-activity behavior, or create a nested modal. Existing approval actions remain independently usable and no diagnostics action can bypass a submitted confirmation lock.
- The sheet uses selected Focus Rail tokens, flat dividers/rails, Lucide icons, six-pixel maximum radius, restrained type, and no nested cards, terminal/code-console motif, file tree, decorative asset, raw JSON block, desktop inspector, or Signal Ledger borrowing.

## Harsh Success Criteria

| ID | Requirement |
| --- | --- |
| `EVD-01` | One strict immutable-session headless owner validates exact construction, snapshot/events/boundary context, one read port, subscriptions, and close; malformed/foreign/duplicate context fails loudly without React, direct HTTP, timers, persistence, or write ports. |
| `EVD-02` | `open(cursor)` accepts only a non-negative safe cursor currently owned by the validated feed or continuity boundary, snapshots one exact selection, rejects caller payload/identity and missing/ambiguous cursors, and cannot cross sessions, owners, routes, or browser lifetimes. |
| `EVD-03` | A current positive retained event issues exactly one abortable `session_events` GET with one session id, `limit=1`, and the canonical exclusive cursor derived only from that event; cursor-zero and continuity-only evidence make their no-read limitation explicit. |
| `EVD-04` | Every success passes the complete page/event schema and exact session/cursor/content or minimal continuity-boundary correlation; empty, multi-event, mixed, advanced, pruned replacement, malformed, foreign, or similar responses fail closed and never replace selected evidence. |
| `EVD-05` | Duplicate activation, StrictMode, rerender, dismissal, Escape, outside click, unmount, event/owner/target replacement, abort, and late settlement own exact single-flight cancellation with no prefetch, polling, focus refresh, page widening, or automatic retry. |
| `EVD-06` | Capture epoch/read-authority/target identity makes route-verified data current or stale explicitly; reader/disclosure/session/thread/runtime/route replacement clears it, while read-only/write/CSRF/lock/turn changes preserve authorized read detail as required. |
| `EVD-07` | Local retained projection, current verification, pending verification, stale capture, explicit Retry, sanitized failure, and no-retained-evidence states are deterministic; fallback is visible and a failed/mismatched response never appears as current or alters the selected event. |
| `EVD-08` | Public identity shows exact cursor/type/captured time plus only server-projected optional upstream time/event id/type and one stable source label; nulls remain explicit and no private host, reader, thread, generation, path, storage, or protocol identity leaks. |
| `EVD-09` | All eight event variants use exhaustive explicit payload mappings with stable labels/order; no reflection/raw JSON/unknown key path, semantic inference, cross-event merge, history claim, or unsupported field exists. |
| `EVD-10` | Null, empty, zero, multiline, non-ASCII, control-like, and maximum bounded payload values remain distinct, escaped, wrapped, accessible, and fully reachable; per-field disclosure never executes, linkifies, copies, downloads, or destructively shortens content. |
| `EVD-11` | Complete/redacted/truncated/both content truth passes `selectedEventDiagnosticsSchema`, uses non-color text/icon meaning, shows exact limitation notice where required, and always identifies the surface as one bounded projection rather than complete history. |
| `EVD-12` | Persisted and continuity-only replay boundaries expose exact nullable after/cursor/next/reason semantics, never invent removed counts/times/events, never look healthy/contiguous, and cannot be converted into an arbitrary cursor browser. |
| `EVD-13` | Unknown optional events retain bounded upstream type/summary and an unrecognized label; they do not crash, disappear, become raw payload, imply support, or enable a control. |
| `EVD-14` | Session-not-found/stale/pruned, permission, malformed/protocol, timeout/overload/rate, transport, abort-after-dispatch, and unexpected failures use bounded local copy; raw API body/message/cause/retryability and unverified payload never render or persist. |
| `EVD-15` | Production diagnostics code cannot accept arbitrary session/cursor/payload input, paginate history, read filesystem/storage directly, invoke shell/tmux/terminal, start/steer/interrupt/archive/approve a turn, send slash text, repair SSE, navigate files/URLs, or call any selected route except `session_events`. |
| `EVD-16` | Normal and consolidated message/activity/turn/control/runtime/unknown rows plus event-backed approval and boundary rows expose exactly one live details action; consolidated rows target the latest event, synthetic non-event rows have no dead action, and adjacent timeline/approval semantics remain unchanged. |
| `EVD-17` | One labelled modal owns focus trap/restore, Close/Escape/outside dismissal, current Retry, and replacement; no nested dialog, hidden interactive sheet, utility/dock duplication, approval-lock bypass, or lost originating focus remains. |
| `EVD-18` | Dialog/heading/list semantics, keyboard order/activation, long-field disclosure, visible focus, accessible names/descriptions, restrained live status, reduced motion, non-color meaning, tooltip titles, and 44 px interactive targets pass. |
| `EVD-19` | The sheet maps approved Focus Rail timeline/sheet tokens, flat rails/dividers/type/icons/radii/safe areas, one scroll owner, and fixed footer with no cards-in-cards, decoration, terminal/raw-JSON motif, Signal Ledger borrowing, or desktop-led structure. |
| `EVD-20` | 320/360/390/412/768/1280, 390 x 420, 200 percent reflow, all event/content/boundary states, null/empty/max ids and 12,000-character content, expanded/scrolled payload, and long target have no overlap, clipping, horizontal overflow, hidden status/action, composer obstruction, or dynamic-label shift. |
| `EVD-21` | Headless tests cover strict construction/context, every event/content variant, selection/consolidation identity, exact query/page correlation, cursor-zero/continuity fallback, cancellation, retry, epoch/authority/target races, sanitized failures, deep immutability, and private-free public views. |
| `EVD-22` | Component/API tests prove one affordance per eligible row, exact GET shape/count/order, no prefetch/poll/automatic retry/storage/fallback ambiguity, stale/current/failure rendering, long disclosure, modal focus/dismissal, approval coexistence, and adjacent Session Detail/prompt/control continuity. |
| `EVD-23` | Deterministic browser captures and layout measurements cover complete, all limitation states, all eight variants, loading/current/stale/failure/malformed/mismatch/pruned, cursor-zero, continuity-only, read-only/locked, consolidated/approval, long/expanded/scrolled, responsive/short-height/zoom states; manual comparison records only approved Focus Rail drift. |
| `EVD-24` | Focused and aggregate web/browser suites plus full unit/contract/integration/type/lint/scaffold/planning/runtime-boundary/build/package/install/audit/privacy/diff/residue checks, owner-doc evidence, clean commits, and pushes pass before closure. |

## Criteria Correction

- The selected production SSE protocol cannot emit a cursor-zero retained event: its first ordinary event and first replay boundary both begin at cursor one. Injecting cursor zero into the production-shell browser fixture would therefore create evidence for a state the production route cannot produce.
- `EVD-03`, `EVD-21`, and the local-fallback part of `EVD-23` are satisfied by direct headless and component cursor-zero tests. Production-shell Chromium covers the same no-read presentation, authority, and dismissal path through a valid continuity-only boundary. This correction narrows only the evidence layer; cursor-zero remains accepted defensively by the public event schema and remains explicit local-only truth.

## Planned Evidence

- Headless tests own exact context/selection validation, query derivation, response correlation, stale/current authority, retained fallback, cancellation/retry, exhaustive projection, sanitized failures, and immutable private-free views.
- Component tests own timeline affordances, consolidated-message/approval cursor selection, one modal, identity/limitation/payload rails, field disclosure, Retry/status, focus restoration, and adjacent action continuity.
- Production-shell Chromium owns exact GET query/body/CSRF shape, no prefetch/poll/automatic retry, malformed/pruned/authority races, DOM/history/storage/request privacy, responsive containment, and effective 200 percent reflow.
- Deterministic screenshots and layout JSON own Focus Rail fidelity, one modal/scroll owner, fixed footer, 44 px targets, exact limitation/boundary/unknown meaning, maximum payload wrapping/expansion, and no viewport/document overflow.
- Repository validation owns contract/coordinator/Session Detail regressions, production route/runtime boundaries, package/build truth, no dependency drift, privacy/secret review, no process/listener/device residue, and clean pushed history.

## Reuse And Ownership

Reuse `selectedProjectionEventSchema`, `selectedEventPageResponseSchema`, `selectedEventDiagnosticsSchema`, the `session_events` browser route, coordinator selected-session authority, the bounded Session Detail feed, Radix Dialog, Focus Rail timeline/sheet primitives, Lucide icons, selected runtime/mobile fixtures, and Playwright production shell. Add no production dependency or generated asset; `assets/ui-concepts/option-b/mobile-session-detail-active.png`, `mobile-approval-boundary-states.png`, `primary-controls.png`, and the Option B design system are the approved targets.

`FE-V1-014` owns only browser event selection/read state, explicit normalized diagnostic projection, eligible timeline affordances, the read-only details sheet, and deterministic UI evidence. `IFC-V1-069` retains page/auth/storage/retention truth; `FE-V1-012` retains feed/timeline/SSE behavior; `FE-V1-022` retains approval decisions; `FE-V1-036` and `FE-V1-037` retain interrupt/archive; `FE-V1-015`, `FE-V1-016`, `FE-V1-039`, `FE-V1-017`, and release leaves retain aggregate state, responsive/accessibility, module, physical-device, packaged-asset, and release acceptance.

## Completion Evidence

- Implementation commits `4633bcd`, `246208f`, and `0489a86` add one strict immutable-session diagnostics owner, exact one-event verification, local-only boundary fallback, exhaustive eight-variant projection, sanitized failure taxonomy, eligible timeline actions, and one accessible Focus Rail sheet. Production code adds no dependency, persistence, timer, polling, retry loop, arbitrary cursor/history input, write path, raw JSON/protocol surface, link, copy, download, or terminal behavior.
- Focused state/component tests pass 56/56; the wider affected focused matrix passes 91/91. Aggregate web passes 683 tests in 38 files. Production-shell Chromium passes 85/85, including six dedicated diagnostics scenarios and adjacent approval, Session Detail keyboard/geometry, prompt, control, utility, security, and recovery regressions. Unit passes 2,560 with 28 intentional external skips; contract passes 245; integration passes 36.
- Root typecheck, lint/exports across 686 files and eight packages, scaffold (eight packages/21 scripts), planning before closure (220 tasks/84 requirements/683 dependencies/five queued), selected runtime boundary (614 production modules/22 externals), and exact Codex 0.144.0 binding (671 files) pass. A clean isolated `0489a86` worktree also passes the exact deterministic/structured/lifecycle runtime aggregate in 160.24 seconds with zero owned process, file, root, or report residue.
- Vite and root builds pass. Deterministic package acceptance and verification pass at 614 sources, 1,235 owned outputs, 6,449 entries, and SHA-256 `35f41f5daccab92d6ded30bf1de374d5451e1ce81282e1136a2452f7810a3ace`; frozen offline install and the production audit pass with zero findings across 184 dependencies. Only test registration changed package manifests; no dependency or lockfile changed.
- Thirty-two deterministic PNGs plus `layout-measurements.json` cover all eight variants, four limitation states, current/loading/stale/retry/failure/malformed/mismatch/pruned truth, nullable and continuity-only boundaries, read-only/locked authority, consolidated message and approval selection, long expanded/scrolled content, 320/360/390/412/768/1280 widths, 390 x 420 short height, and effective 200 percent reflow. Measurements and manual inspection prove one scroll owner, fixed visible footer, 44 px controls, wrapped maximum content, no document/sheet horizontal overflow, and no approved Focus Rail drift.
- Browser request/DOM/history/storage privacy assertions, explicit private-sentinel rejection, source-boundary review, dependency/diff checks, listener/temp-root inspection, and generated-artifact cleanup pass. The pre-existing port 5173 preview and user-owned historical screenshot edits were left untouched; no phone, Tailscale profile, Serve configuration, or device state was changed for this leaf.

## Criteria Result

| Criteria | Result | Evidence |
| --- | --- | --- |
| `EVD-01` to `EVD-07` | Pass | Strict construction, exact selection/read correlation, single-flight cancellation, authority epochs, stale/current/local-only truth, retry, and failure tests. |
| `EVD-08` to `EVD-15` | Pass | Exhaustive private-free public projection, all variants/limitations/boundaries, sanitized error taxonomy, and production source-boundary inspection. |
| `EVD-16` to `EVD-20` | Pass | Eligible/consolidated row actions, modal/focus/accessibility behavior, approved Focus Rail mapping, and full geometry/reflow evidence. |
| `EVD-21` to `EVD-23` | Pass | Focused, aggregate, and browser matrices plus 32 captures and layout JSON; cursor zero uses the corrected direct/component evidence layer above. |
| `EVD-24` | Pass | Full workspace, exact-runtime, build/package/install/audit/privacy/diff/residue gates and pushed implementation commits. |
