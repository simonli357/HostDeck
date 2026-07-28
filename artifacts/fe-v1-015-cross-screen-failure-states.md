# FE-V1-015 Cross-Screen Failure States

Date: 2026-07-27

Status: criteria frozen; implementation audit in progress.

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

Pending.

## Validation

Pending.

## Completion Record

Pending.
