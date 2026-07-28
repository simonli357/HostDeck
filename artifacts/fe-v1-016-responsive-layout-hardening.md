# FE-V1-016 Responsive Layout Hardening

Date: 2026-07-27

Status: criteria frozen; implementation pending.

## Scope

Harden the complete implemented dashboard as one responsive product. Prove Mission Control, Session Detail, the composer and primary dock, every supporting sheet, inline approvals, confirmations, Host & access, pairing, and the selected desktop expansion against the executable 141-state mobile contract.

This leaf owns layout composition, stable sizing, long-content containment, safe-area accounting, dynamic-viewport and keyboard geometry, orientation, 320 px reflow, reference viewports, and the approved 1280 list/detail expansion. It may add a headless page-memory navigation context and refactor markup/CSS only where required to make the selected composition truthful and testable.

Excluded: changing state, API, runtime, trust, operation, Tailscale, pairing, package, or service contracts; adding a route or capability; a second browser client or hidden read; complete semantic/screen-reader/contrast review owned by `FE-V1-039`; second-engine and supported-browser claims owned by `FE-V1-040`; pixel-diff closure owned by `FE-V1-017`; copy/workflow review owned by `FE-V1-018`; final physical-phone module hardening owned by `FE-V1-090`; packaged assets, install, and release-readiness claims.

## Audit Findings

- The executable design contract owns 141 states across 15 surfaces, 39 interactions, all `UX-001` to `UX-012`, five reference viewports, and maximum fixtures for a 64-character session name, 160-character project/model cue, 240-character branch, 512-character goal/summary, and 12,000-character event body.
- Completed module leaves already provide extensive local responsive evidence. That evidence is intentionally fragmented by owner and does not prove the final composed shell, every shared fixed region, or complete state-to-layout coverage.
- The phone implementation is structurally sound: one column, stable type, a 56 px app bar, a three-cell access rail, semantic queue/timeline rails, and the complete primary dock/composer. At 390 x 844 the current mixed fixture exposes the full status rail and more than the required two priority rows.
- The selected `responsive-continuum.png` requires a grouped Mission queue beside the same Session Detail timeline at 1280 x 800. Mission Control and Session Detail deliberately deferred this split to `FE-V1-016`; current production composition only centers one independent route.
- The coordinator owns exactly one live route target. A desktop split must not mount another coordinator, fetch a second list, switch the live target, persist session data, or call a hidden refresh. The only admissible list context is the last authorized Mission snapshot observed during normal navigation.
- Retained desktop navigation is protected session data. Its owner must purge synchronously when read authority is lost or the coordinator closes, expose no CSRF/device credential, make no request, and label the list retained rather than live. Direct detail entry has no such list and must render a truthful Mission Control navigation fallback instead of fabricated rows.
- At 768 px the approved inspector is explicitly optional. The existing route hierarchy may remain one bounded route; no duplicate interactive Host & access tree or unsupported tablet-only workflow is permitted.
- Safe-area offsets are currently repeated as direct `env()` expressions. The production values are correct but cannot be overridden in deterministic layout tests. One shared top/bottom token is required so nonzero inset geometry can be exercised without inventing runtime behavior.
- `interactive-widget=resizes-content`, dynamic viewport units, and fixed bottom controls already support mobile keyboard resizing. Existing module tests mostly use 390 x 420 proxies and one physical Android prompt run; this leaf must prove the complete dock/composer/sheet composition at short height and landscape without claiming a new physical run.
- The 6,598-line shared stylesheet contains module-specific short-height and narrow-width rules. Aggregate checks must detect cross-module document overflow, nested primary scroll regions, hidden fixed actions, unstable targets, and selectors that only work in one local fixture.

## Frozen Boundary

### Viewport Regimes

| Regime | Required geometry | Contract |
| --- | --- | --- |
| Minimum reflow | 320 x 800 and 200 percent effective reflow | One readable column, stable type, no document horizontal scroll, every core flow reachable. |
| Narrow phone | 360 x 800 | Long labels and maximum private-free values wrap or clamp without moving controls. |
| Primary phone | 390 x 844 | Full host/access strip and at least two normal-height priority rows; detail identity/feed and composer target/action remain useful. |
| Large phone | 412 x 915 | Same hierarchy with stable fixed controls and no artificial desktop transition. |
| Tablet | 768 x 1024 | Same routes and actions with bounded readable width; an inspector is optional and no new workflow appears. |
| Desktop | 1280 x 800 | Mission route remains a grouped queue; normal Mission-to-detail navigation expands to retained queue plus live detail using the selected Focus Rail split. |
| Short viewport | 320 x 480 and 390 x 420 | Fixed controls, sheet header/body/footer, consequences, and actionable status remain reachable through one explicit scroll owner. |
| Landscape | 800 x 360 and 915 x 412 | Mobile/tablet hierarchy remains usable with no hidden composer, header, sheet action, or horizontal overflow. |
| Insets | deterministic 32 px top / 24 px bottom stress | Insets are applied exactly once to the app bar and bottom-owned surfaces; content and actions do not enter inset regions. |

No font size scales with viewport width. Width transitions are driven by layout/container constraints, not user-agent guesses or transport behavior.

### Responsive Desktop Context

- One headless store may retain only a frozen coordinator snapshot whose exact target is Mission Control and whose disclosed list came from the selected coordinator. It owns no timer, network port, retry, storage, history serialization, or mutation.
- Mission snapshots may update while Mission Control is the live target. On route transition to Session Detail, the last snapshot remains available only while the current coordinator still carries readable authority. Stale/failure source truth remains visible.
- Unpaired, invalid, expired, revoked, permission-denied, authority-mismatched, blocked, or closed state clears retained context synchronously before subscribers render it. Close clears listeners and data exactly once.
- Desktop Session Detail uses the retained queue only as navigation context. It marks the selected row, preserves canonical group/order and Focus Rail semantics, and never calls Mission refresh/load-more from the retained pane.
- Direct/deep-linked Session Detail and reloaded detail have no prior Mission snapshot. The left pane contains a bounded link back to Mission Control and explicit unavailable context; no fake count, row, current label, or request is allowed.
- Below the desktop layout threshold the retained pane is absent from layout and accessibility trees. Phone and tablet navigation, history, back behavior, requests, and scroll ownership remain unchanged.

### Layout And Containment

- The document remains the primary scroll owner on phone/tablet. At desktop split, each visible pane may own one bounded vertical scroller so the retained queue and live timeline remain independently reachable while the action dock/composer stay attached to the detail pane.
- The app bar, host/status rails, queue rows, timeline nodes, primary dock, composer, sheet headers/footers, and destructive confirmations use stable dimensions. Loading, labels, errors, streaming updates, and focus outlines cannot resize adjacent targets incoherently.
- Maximum contract-valid names, paths, branches, models, goals, summaries, commands, reasons, device facts, skills, usage values, and event content wrap, clamp, or scroll only in their declared owner. No protected value is added merely to test layout.
- Sheets remain bounded bottom sheets with one internal body scroller and fixed header/footer. Desktop width does not turn them into a new route, sidebar application, or nested card.
- Safe-area top and bottom values are centralized as CSS custom properties backed by `env(safe-area-inset-*)`. Tests may override only those public layout tokens.
- Focus Rail tokens, continuous semantic rails, flat repeated surfaces, six-pixel maximum radius, Lucide controls, equal primary commands, and phone-first hierarchy remain unchanged. Signal Ledger, desktop console, editor, terminal, decorative rail, and cross-option structure remain prohibited.

## Executable Coverage Matrix

| Layout family | Contract surfaces | Densest required states | Stress ownership |
| --- | --- | --- | --- |
| Shell and Mission queue | app shell, Mission Control | loading, mixed, quiet, access-limited, locked, stale/failure, runtime degraded/incompatible/disconnected, long content | all reference widths; 390 first viewport; 320 reflow; 1280 Mission route |
| Detail timeline | Session Detail, inline approval | active, approval, boundary, stale/recovered, reconnecting, interrupted, failed, unknown, not found, long event | all reference widths; landscape; desktop split; 200 percent reflow |
| Fixed action region | composer, model/goal/Plan dock, utilities | empty, multiline, submitting, accepted/running/completed, failure, disabled causes, long target/status | 320 x 480; 390 x 420; landscape; bottom inset; desktop detail pane |
| Primary control sheets | model, goal, Plan | loading/current/pending, confirmation, unsupported/conflict/failure, longest model/objective/summary | 320/360/390/412/768/1280; short height; 200 percent reflow |
| Utility sheets | usage, Compact, Skills | loading/content/empty/stale/partial, confirmation/progress/result, 1,024 skills, longest values | 320/390/768/1280; short height; expanded/scrolled; bottom inset |
| Session action and diagnostics sheets | event details, interrupt, archive, laptop resume | maximum payload/command/reason, confirmation, pending/success/uncertain/failure | 320/390/768/1280; short height; expanded/scrolled; 200 percent reflow |
| Host & access | access recovery, remote state, compatibility, lock, devices | longest origin/reason/device, list pagination, confirmation, denied/revoked/locked | 320/390/768/1280; short height; bottom inset; authority purge |
| Pairing and route errors | pairing, not found/runtime failure | claiming/paired/rejected/unknown, long bounded error, invalid route | 320/360/390/412/768/1280; top/bottom inset; landscape |

An executable ledger must map every one of the 141 trace IDs to exactly one primary layout family and its existing behavior owner. Representative browser scenarios execute the densest product of each family and every geometry regime; this leaf does not duplicate all behavior permutations already proven by their owner tests.

## Strict Success Criteria

- `RSP-01`: one executable ledger covers all 141 mobile state traces, 15 surfaces, 12 journeys, five reference viewports, and every layout family without duplicate, missing, invented, or unsupported state ownership.
- `RSP-02`: 320 x 800, 360 x 800, 390 x 844, 412 x 915, 768 x 1024, and 1280 x 800 production-shell captures and layout records use exact decoded dimensions and nonblank output.
- `RSP-03`: every required route, rail, row, timeline item, dock, composer, sheet, confirmation, pairing result, and error state has no document horizontal scroll, viewport escape, incoherent overlap, clipped action, or inaccessible required content.
- `RSP-04`: the 390 x 844 Mission first viewport contains the complete host/access rail and at least two normal priority rows; loading, long, notice, and failure variants do not falsely claim this density.
- `RSP-05`: all frozen maximum-content fixtures stay within their declared owner through wrapping, clamping, or one bounded scroller; ellipsis has an accessible full label where the source owner provides one.
- `RSP-06`: app-bar icons, refresh, rows, primary commands, composer send, sheet close/footer, confirmations, and other core controls remain at least 44 px where frozen and never below 40 px; dynamic copy cannot shift an active target under the pointer.
- `RSP-07`: app bar, status/context rails, route headings, notices, and lock/recovery rails stack without collision at every regime and preserve compact phone hierarchy.
- `RSP-08`: Session Detail keeps one continuous timeline, visible boundary, reachable diagnostic actions, and contained 12,000-character content without a phone/tablet nested primary scroller.
- `RSP-09`: `/model`, `/goal`, `/plan`, utility overflow, prompt target/editor/send, and operation status stay attached to one exact detail pane and never cover the final reachable timeline content.
- `RSP-10`: 320 x 480, 390 x 420, 800 x 360, and 915 x 412 dynamic-height states keep the composer edit/send path and every open sheet's close, body, consequence/status, and primary action reachable with no fixed-region collision.
- `RSP-11`: nonzero top/bottom inset tests prove one centralized token owner, a full 56 px app-bar content row below the top inset, and exact bottom clearance for composer, docks, sheets, confirmations, pairing, and route padding without double application.
- `RSP-12`: each primary, utility, action, diagnostic, Host/access, lock, and device sheet has one body scroll owner, a stable header and footer, contained focus outline, no document-width expansion, and no hidden action at all required regimes.
- `RSP-13`: inline approval actions and interrupt/archive/lock/revoke confirmations preserve distinct safe/destructive targets, longest consequence text, pending state, and fixed action geometry without nesting a second dialog/card.
- `RSP-14`: Host & access content, origin/runtime/profile/Serve copy, device rows, and local-only recovery facts remain contained and available through the same sheet on phone/tablet/desktop; no duplicate interactive tablet inspector is introduced.
- `RSP-15`: normal Mission-to-detail navigation at 1280 x 800 renders the approved grouped-list/timeline split; the live timeline and fixed controls align to the detail pane, the selected row is explicit, and no desktop-only action or route exists.
- `RSP-16`: the desktop navigation context accepts only a coordinator-owned Mission snapshot, makes zero requests, remains page-memory-only, exposes retained rather than live truth, preserves canonical order, and synchronously purges on every authority-loss/close class.
- `RSP-17`: direct/reloaded desktop detail renders explicit unavailable Mission context plus one Mission Control link and zero fabricated rows/count/current state; phone/tablet do not expose the retained pane in layout or accessibility trees.
- `RSP-18`: tablet and landscape layouts preserve the same information architecture, source order, route history, control availability, and bounded reading widths without switching target or creating an unsupported inspector.
- `RSP-19`: actual 200 percent effective reflow reaches a 320 CSS px content regime, disables the desktop split naturally, retains stable type, and keeps every core flow free of horizontal scrolling.
- `RSP-20`: layout-facing semantics remain intact: one main landmark, correctly labelled navigation/regions/dialogs/toolbars, no duplicate ids, no hidden duplicate focus targets, logical DOM order, and restrained status geometry. Full accessibility acceptance remains `FE-V1-039`.
- `RSP-21`: reduced motion, loading indicators, stream updates, expanding disclosures, live notices, and fixed-region status changes do not cause required movement, scroll hijacking, or layout shift; behavioral announcement quality remains `FE-V1-039`.
- `RSP-22`: full-size and contact-sheet review preserves all seven selected Focus Rail assets' responsive structure, semantic rails, density, and phone-first hierarchy with no Signal Ledger borrowing, nested cards, terminal/editor treatment, or unrecorded structural drift.
- `RSP-23`: browser evidence records geometry, scroll owners, visibility, targets, request counts, history, privacy, storage, console/page errors, screenshot hashes/dimensions, and process/listener cleanup for every representative matrix row.
- `RSP-24`: focused tests, aggregate web/unit/contract/integration, complete production-shell Chromium, typecheck, lint/exports, scaffold, planning, runtime-boundary, build/package/install, audit/license, privacy, diff, and residue gates pass; owner docs, coherent commits, push state, limitations, and the 18 excluded user-owned screenshot changes match reality.

## Required Evidence

- Direct tests for retained Mission context admission, replacement, stale retention, every authority purge, no request/timer/storage behavior, immutable snapshots, subscriber lifecycle, close, and hostile input.
- An executable trace-to-layout ledger checked against `mobileStateTraceIds`, `mobileSurfaceIds`, `mobileJourneyIds`, and `mobileReferenceViewports`.
- Production-shell scenarios for Mission density/continuum, detail continuum and desktop split, direct detail fallback, long timeline/fixed controls, short-height and landscape keyboard geometry, safe-area override, each sheet family, Host/access, pairing/error states, and authority purge.
- New deterministic evidence under `artifacts/fe-v1-016-responsive-layout-hardening/`; existing owner screenshots are regression inputs and are not rewritten as FE-V1-016 evidence.
- Full-size and contact-sheet visual inspection against `assets/ui-concepts/option-b/responsive-continuum.png` plus the six adjacent selected assets, with exact drift disposition.
- Full selected repository validation and a clean staged scope that excludes the 18 pre-existing user-owned screenshot modifications.

## Implementation Record

Pending.

## Validation

Pending.

## Completion Record

Pending.
