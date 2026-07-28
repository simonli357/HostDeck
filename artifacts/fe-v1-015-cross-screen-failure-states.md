# FE-V1-015 Cross-Screen Failure States

Date: 2026-07-27

Status: complete; `CFS-01` to `CFS-24` pass.

## Scope

Run one production-hardening pass over the complete implemented dashboard. Prove that Mission Control, Session Detail, Host & Access, the prompt composer, model/goal/Plan, utilities, approvals, event diagnostics, interrupt, archive, laptop resume, lock, and device management consume the selected coordinator and their exact owner contracts without contradictory failure truth.

This leaf owns cross-screen consistency for unknown, stale, interrupted, failed, incompatible, disconnected, replay-boundary, degraded, authority-loss, and recovered states. It may fix missing or contradictory behavior in an owning web projector/component and add aggregate tests and visual evidence.

Excluded: adding a route or capability; changing server/runtime/API contracts; changing the reviewed Codex binding; changing Tailscale/profile/Serve, pairing, service, package, or phone state; broad responsive/accessibility/browser hardening owned by `FE-V1-016`, `FE-V1-039`, and `FE-V1-040`; visual redesign; automatic retry/polling; browser persistence; and release-readiness claims.

## Audit Findings

- The coordinator already owns independent access, host, target, stream, CSRF, canonical write-eligibility, exact target epoch, retained failure, and authority-purge truth. Cross-screen code must consume that state rather than construct a second health or write policy.
- Completed module leaves have strong direct and browser evidence, but no aggregate test proves the complete route/control matrix against one shared set of coordinated failures.
- Mission Control and Session Detail show stale labels but do not expose the required last-confirmed time. Activity age is not a substitute for resource-observation freshness.
- The coordinator intentionally retains `lastFailure` after a successful same-target recovery, but neither primary route distinguishes that recovered failure from a route that never failed. Route/authority change already clears or purges that evidence.
- Mission Control classifies all 1,260 valid selected session combinations and Session Detail distinguishes every turn state. The hardening pass must preserve this exact taxonomy while checking it through production composition.
- A replay boundary describes retained history, not necessarily a broken current connection. It must remain visible after live continuity resumes without falsely disabling otherwise exact current actions.
- Authority loss already purges protected route data and CSRF. Aggregate evidence must prove every open or retained control also hides or disables synchronously and cannot publish a late result.
- Host lock and device revocation have deliberately narrower security authority than ordinary session writes. The pass must preserve those reviewed exceptions instead of forcing them through the generic session-write gate.
- A fresh phone navigation that cannot load HostDeck has no app-renderable diagnosis. Browser/Tailscale preload failure remains outside the React state matrix; an already loaded page may show only the bounded generic reconnect state it actually observed.
- The approved Focus Rail assets already define the route, notice, timeline-boundary, action-dock, and Host & Access structure. No new mockup or structural variation is required.

## Frozen Boundary

### State Axes

- Treat access authority, host health/compatibility, selected target freshness, session lifecycle/turn state, stream continuity, and operation result as independent axes. A favorable axis cannot overwrite an unfavorable one.
- Current session disclosure requires retained exact target identity plus still-readable authority. Unpaired, invalid, expired, revoked, permission-denied, authority-mismatched, or closed state removes protected session, target, event, control, and command data.
- `unknown`, `failed`, `interrupted`, `incompatible`, `version_drift`, `disconnected`, `stale`, and `degraded` remain literal states with non-healthy semantic tone/copy. No fallback infers healthy, quiet, completed, current, or writable from missing evidence.
- Loading, empty, not found/archived, access limited, unreachable, remote unavailable, runtime offline, incompatible, degraded, fatal, and closed remain distinct route outcomes.
- Retained same-target data is visibly stale and includes a bounded last-confirmed timestamp derived from the owning resource/session fact. Missing or invalid observation time is explicit and never replaced with the browser clock.
- A retained replay boundary remains a semantic timeline break with exact bounded reason/cursor meaning. Current stream recovery does not erase it, and historical loss is not mislabeled as a current disconnect.
- A failed access/host/target/stream observation that later recovers on the same target remains visible as a bounded prior issue with source and observation time while current truth is clearly labeled recovered/current. Target or authority change purges that prior issue.
- Recovery requires an explicit later successful coordinated observation. Elapsed time, a timer, retained ready data, or a successful unrelated resource cannot clear a failure.

### Route And Control Policy

- Mission Control preserves canonical server order within `ACT NOW`, `IN PROGRESS`, and `QUIET`; unknown, stale, failed, interrupted, and incompatible rows remain attention-bearing and use text plus semantic tone.
- Session Detail keeps authorized retained identity/activity readable while separately showing stale, compatibility, remote, stream, boundary, and prior-failure truth. Notices cannot hide the timeline boundary or claim a mutation result.
- Prompt, approval, model, goal, Plan, Compact, interrupt, and archive dispatch only through their exact owner after current target, authority, session, operation, and required stream evidence passes. Canonical write-block causes disable without a stale enabled frame.
- Usage, Skills, event diagnostics, laptop resume metadata, device reads, and compatibility/remote checks remain read-only and apply their own exact current-authority/target rules. Retained captures are labeled stale; they never become write authority.
- Unknown/stale/incompatible session truth blocks operations whose exact owner requires a current writable session. Turn-specific operations additionally reject unknown or incompatible turn evidence; next-turn staging may remain available only where its completed owner contract explicitly proves that active state is safe.
- A current stream with a retained historical boundary may support exact operations that explicitly accept boundary continuity. Reconnecting, failed, closed, idle/connecting where current activity is required, or unproven continuity cannot.
- Emergency host lock and exact device revocation preserve their reviewed independent security authority. They do not open ordinary session writes and cannot manufacture current session health.
- Recovery, refresh, check, and read controls remain explicit one-attempt actions. No route/control adds automatic retry, write replay, polling, timer-owned healing, hidden fetch, broad catch-all success, or durable browser state.

### UI And Evidence

- Reuse the selected Focus Rail structure, tokens, rails, notices, timeline boundary, action dock, sheets, Lucide icons, and existing route hierarchy. This hardening pass does not add cards, desktop-only controls, routes, or cross-option visual borrowing.
- Capture every required failure family at 390 x 844 through the production shell. Stress the densest combined route states at 320/360, 412, 768, 1280, short height, reduced motion, and 200 percent reflow only where needed; aggregate viewport completeness remains downstream.
- Browser evidence must assert exact visible state, disabled/enabled controls, no contradictory healthy/current copy, timestamp and boundary persistence, recovery history, request counts, no duplicate/retry behavior, privacy, focus/semantics, target size, overflow/clipping, console/page errors, and cleanup.

## Strict Success Criteria

- `CFS-01`: one executable matrix enumerates every cross-screen access, host, target, session, stream, operation, and recovery state owned by this leaf, with exact expected disclosure, status, action, and evidence.
- `CFS-02`: preload network failure remains outside app-rendered diagnosis; an already loaded unreachable state stays generic and never invents laptop profile, Serve, runtime, or authorization detail.
- `CFS-03`: unpaired, invalid, expired, revoked, permission-denied, authority-mismatched, and closed states synchronously purge all protected route/control data and suppress late settlement.
- `CFS-04`: loading, empty, not found/archived, access limited, unreachable, remote unavailable, runtime offline, incompatible, degraded, fatal, and closed route outcomes remain distinct and never render fake rows, activity, or actions.
- `CFS-05`: every valid unknown session/turn/runtime/compatibility state uses explicit non-healthy text and tone; no unknown or missing fact renders as ready, current, quiet, completed, supported, or writable.
- `CFS-06`: failed and interrupted sessions remain distinct on both routes and in applicable operation progress; neither is collapsed into completed, quiet, stale, or generic unknown.
- `CFS-07`: incompatible, version-drift, disconnected, degraded, and runtime-offline truth reuses the selected shared projectors and cannot be overridden by readable retained session data.
- `CFS-08`: retained stale access, host, list, detail, utility, and operation data is visibly stale and shows its bounded last-confirmed time or explicit unavailable-time truth.
- `CFS-09`: retention/disconnect/restart/schema boundaries remain visible with bounded reason and timeline placement after reconnect; historical boundary truth never masquerades as a current stream failure.
- `CFS-10`: a same-target recovered access/host/target/stream failure remains visibly recorded with bounded source/time while current recovery is explicit; target/authority change removes it.
- `CFS-11`: recovery requires a later successful coordinated observation; equal/older, partial, unrelated, timer-derived, or retained-ready evidence cannot clear or relabel a failure.
- `CFS-12`: Mission Control preserves all 1,260 valid row combinations, canonical group/order semantics, exact non-healthy labels, protected-data suppression, and useful Focus Rail hierarchy.
- `CFS-13`: Session Detail preserves exact identity and authorized retained feed while independently projecting status, stale time, stream continuity, compatibility/remote truth, and prior failure without hiding boundaries.
- `CFS-14`: prompt, model, goal, Plan, Compact, approval, interrupt, and archive cannot dispatch under any applicable canonical write cause, stale/incompatible target, invalid lifecycle/turn, or insufficient stream evidence; no stale enabled frame or bypass exists.
- `CFS-15`: Usage, Skills, event diagnostics, compatibility/remote checks, laptop resume, and device reads obey exact read authority/target freshness, label retained captures stale, and never acquire mutation or retry behavior.
- `CFS-16`: approval, interrupt, archive, prompt, and turn-sensitive controls preserve exact target/turn/request identity through disconnect, boundary, race, duplicate activation, and recovery; uncertain outcomes remain locked until explicit read reconciliation.
- `CFS-17`: emergency host lock and exact device revocation preserve their reviewed independent security gates during ordinary write degradation without opening session writes or weakening authority purge.
- `CFS-18`: operation-local unsupported, known failure, unknown outcome, conflict, pending, accepted, and terminal states stay distinct and are not overwritten by aggregate route notices or recovery copy.
- `CFS-19`: no automatic retry, polling, timer-owned healing, mutation replay, hidden fallback, direct second client, browser storage, terminal/raw command, profile/Serve mutation, or external action is introduced.
- `CFS-20`: both routes and all sheets preserve approved Focus Rail grouping, semantic rails, flat notices, action dock, composer/timeline priority, and phone-first hierarchy without nested-card or desktop-console drift.
- `CFS-21`: required 390 x 844 captures plus selected 320/360/412/768/1280, short-height, reduced-motion, and 200-percent stress captures have no overlap, clipping, horizontal scroll, hidden state/action, unstable target, or misleading color-only status.
- `CFS-22`: alert/status semantics, headings, labelled sheets, keyboard order/focus restoration, restrained live regions, 44 px primary targets, disabled/busy states, and reduced-motion behavior pass direct and Chromium inspection.
- `CFS-23`: focused matrix, aggregate web/unit/contract/integration, complete production-shell Chromium, typecheck, lint/exports, scaffold, planning, runtime-boundary, build/package/install, audit/license, privacy, diff, and residue gates pass or an unrelated limitation is recorded precisely.
- `CFS-24`: issue/fix inventory, artifact, screenshots/layout data, task/status truth, coherent commits, and push state match actual behavior without staging user-owned artifacts or claiming downstream responsive/browser/device/package/release leaves.

## Required Evidence

- Direct matrix tests over immutable coordinator snapshots for every route state, all selected session lifecycle/turn/freshness products, stale timestamps, boundaries, prior-failure recovery, authority purge, and hostile/invalid time input.
- Aggregate controller tests proving every mutating and read-only control's exact admission under canonical write causes, stale/incompatible/unknown targets, stream states, boundary continuity, authority loss, races, and recovery.
- Production-shell Chromium scenarios for Mission Control and Session Detail unknown/interrupted/failed/stale/incompatible/disconnected/degraded/boundary states, blocked control surfaces, same-target recovery history, route/authority purge, and generic preload separation.
- Required Focus Rail screenshots and layout JSON with manual full-size/contact-sheet inspection, accessibility/focus/target checks, privacy/request inventory, console/page-error checks, and zero listener/timer/output residue.
- Full selected repository validation and a clean staged scope that excludes the 18 pre-existing user-owned screenshot changes.

## Implementation Record

### Issue And Fix Inventory

| Issue found | Correction | Owning evidence |
| --- | --- | --- |
| No aggregate executable contract covered every coordinated route axis and every shipped read/write control. | Added one immutable state-axis inventory and a complete owner-level admission matrix across canonical write causes, selected-session read freshness, stream continuity, retained boundaries, and authority purge. | `packages/web/src/cross-screen-control-matrix.test.ts` |
| Mission Control and Session Detail labeled retained data stale without exposing when it was last confirmed. | Added one shared projector for exact access, host, list, detail, and session-projection observation times. Missing, malformed, and calendar-invalid RFC 3339 facts render explicit unavailable-time truth instead of browser-clock inference. | `packages/web/src/cross-screen-failure-state.ts`; route/component tests |
| Same-target coordinator failures disappeared from the visible routes after a successful observation even though `lastFailure` remained intentionally retained. | Added bounded recovered-issue projection for access, host, list, detail, and stream sources. Request-backed recovery requires a later coordinator epoch; ordered stream recovery may be proven within the same target epoch. Target or authority change purges the notice. | `packages/web/src/cross-screen-failure-state.test.ts`; six production-shell scenarios |
| The browser SSE fixture did not model cursor replay precisely enough for reconnect and retained-boundary acceptance. | Made the fixture replay only schema-valid seed events whose cursor is strictly greater than the requested `after` cursor, while preserving exact ordering and connection cleanup. | `tests/browser/mission-control-fixture.ts`; `tests/browser/mission-control-fixture.test.ts` |
| A host fixture used a calendar-invalid timestamp that permissive date parsing normalized silently. | Replaced permissive parsing at this boundary with the existing strict timestamp parser and added hostile invalid-date coverage. | Direct projector tests and production fixtures |
| The new projector was briefly exported as public package surface even though only selected web composition owns it. | Removed the unnecessary package-root export and updated the exact selected-runtime test inventory. | `scripts/check-selected-runtime-boundary.mjs`; runtime-boundary gate |

The implementation remains headless-first and consumes coordinator snapshots and completed control owners. Mission Control and Session Detail only render projected facts; no second transport, retry, polling, storage, timer-owned recovery, profile mutation, terminal path, API change, dependency, or public package contract was introduced.

### Executable Matrix

- Nineteen direct projector cases cover every stale source, unavailable and hostile time, all five recovered-failure sources, still-failed and incomplete recovery, wrong target, authority purge, future evidence, and request-versus-stream epoch ordering.
- Twenty-nine aggregate matrix cases inventory the access, host, target, session, stream, operation, and recovery axes. They execute all ordinary mutation owners against the fully current baseline and every canonical write cause; execute selected-session reads against access/target/session freshness; preserve structured recovery reads; keep exact current reads available across a retained boundary; and prove synchronous protected-control purge.
- Existing Mission Control classification still exhausts all 1,260 valid lifecycle/turn/freshness combinations. Existing operation-owner tests retain exact identity, no-resend, conflict, pending, accepted, unknown-outcome, and terminal semantics.

### Browser And Visual Evidence

- Six production-shell Chromium scenarios cover the complete Mission Control failure family, stale and recovered truth, authority purge, generic observed API failure, incompatible/degraded/disconnected runtime truth, unknown/failed/interrupted Session Detail, stale access/detail truth, retained replay boundary while reconnecting, and same-target access recovery.
- Twenty deterministic state captures, `contact-sheet.png`, and `layout-measurements.json` live under `artifacts/fe-v1-015-cross-screen-failure-states/`.
- Evidence spans 320 x 480, 360 x 800, 390 x 420, 390 x 844, 412 x 915, 768 x 1024, and 200 percent zoom at 1280 x 800. Browser assertions cover exact copy and timestamps, control admission, request counts, privacy, focus/semantics, 44 px primary targets, no horizontal overflow, and notice/action-dock separation.
- Full-size and contact-sheet inspection found no hidden notice, clipped control, contradictory healthy/current copy, color-only status, nested-card drift, desktop-console drift, console/page error, listener, preview process, or browser residue.

## Validation

| Gate | Result |
| --- | --- |
| Direct cross-screen projector and admission matrix | 2 files, 48 tests pass (19 projector, 29 matrix). |
| Focused affected web slice | 5 files, 106 tests pass. |
| Aggregate web | 48 files, 886 tests pass. |
| Aggregate unit | 242 files pass, 27 files intentionally skipped; 2,770 tests pass and 28 are intentionally skipped. |
| Contract / integration | 34 files and 245 contract tests pass; 21 files and 36 integration tests pass. |
| Production shell | All 143 Chromium scenarios pass, including six dedicated cross-screen scenarios. |
| Static boundaries | Root/web typechecks, Biome over 721 files, exports over eight packages, scaffold over eight packages/21 scripts, and selected runtime boundary over 614 production modules/22 externals pass. |
| Planning | 220 tasks, 84 requirements, 683 dependencies, and the selected queue validate; all five planning-validator tests pass after closure. |
| Build / package | Vite builds 2,052 modules. Root build, two deterministic package builds, relocation, read-only runtime, config/static ownership, integrity rejection, and independent verification pass at 614 sources, 1,235 outputs, 6,449 entries, SHA-256 `35f41f5daccab92d6ded30bf1de374d5451e1ce81282e1136a2452f7810a3ace`. |
| Install / supply chain | Frozen offline install passes; production audit reports no known vulnerability; all production-license expressions are permissive. |
| Exact runtime | Isolated Codex 0.144.0 binding passes 671 files at hash `e1a1a5cff3ab91862f9215dd06538eae1ea0b00bae48cbb7d87061faaee27e24`. The default 0.145.0 binary correctly remains ineligible. |
| Manual / residue | Twenty captures plus contact sheet/layout data pass inspection; privacy, request-count, diff, process/listener, and output-residue checks pass. |

The existing Vite chunk-size advisory remains a downstream optimization signal, not a new failure. No test, screenshot, or release claim depends on the default drifted Codex binary.

## Completion Record

- `CFS-01` to `CFS-11`: the immutable executable matrix, strict timestamp parsing, independent stale facts, persistent bounded recovery history, explicit later-observation rules, and authority/target purge pass.
- `CFS-12` to `CFS-18`: both production routes preserve their exact classifications and boundaries; all mutation/read owners retain reviewed admission, independent security exceptions, identity, and operation-local result truth.
- `CFS-19` to `CFS-22`: source review, direct tests, browser request inventory, and inspected Focus Rail evidence show no retry/polling/fallback/storage/external mutation and no accessibility, reflow, clipping, or desktop-structure regression within this leaf's selected matrix.
- `CFS-23` and `CFS-24`: all selected gates pass; task, artifact, status, queue, implementation, screenshots, and pushed history agree.
- Frozen criteria: `2b09b17`. Implementation and evidence: `489f150`. Selected-boundary correction: `839361c`.
- The 18 pre-existing user-owned screenshot modifications were excluded from every commit, restored after aggregate browser execution, and byte-verified against their temporary backup.
- `FE-V1-016`, `FE-V1-039`, `FE-V1-040`, `FE-V1-017`, `FE-V1-018`, and `FE-V1-090` still own complete responsive, accessibility, supported-browser, mockup-diff, copy/workflow, and real-device module hardening. Package/install and final release acceptance also remain downstream; V1 is not release-ready.
