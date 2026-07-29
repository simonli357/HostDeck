# FE-V1-017 Selected-Target Fidelity

## Purpose

Close the aggregate visual-fidelity gate between the seven human-selected Focus Rail references and the current production dashboard. This task owns current-build screenshots, target/current comparison artifacts, complete state-to-target traceability, measurable design-system checks, manual drift review, and tightly scoped UI corrections. It does not change product behavior, authority, routes, copy ownership, remote ingress, or the selected visual direction.

## Audited Baseline

- `DEC-028` selects all seven current files in `assets/ui-concepts/option-b/`; Option A and both legacy desktop boards remain rejected.
- The product already implements 141 canonical mobile state traces, 39 interactions, 12 journeys, 15 surfaces, responsive layout, semantic accessibility, and Chromium/Firefox package coverage.
- Earlier UI leaves contain many screenshots and local fidelity observations, but there is no one executable map from every canonical state to an approved target family and no current-build aggregate target/current comparison set.
- Generated raster text, sample data, illustrative QR art, and the pre-claim review panel are not product schemas. Typed state/interaction contracts, fragment-safe pairing, runtime-backed copy, privacy, and accessibility remain authoritative as explicitly recorded by `DEC-028` and the selected asset docs.
- This task writes fresh evidence only under `artifacts/fe-v1-017-selected-target-fidelity/`; it does not rewrite evidence owned by completed UI leaves.

## Frozen Target Set

| Visual family | Exact selected target | Required current evidence |
| --- | --- | --- |
| Mission Control | `assets/ui-concepts/option-b/mobile-mission-control-mixed.png` | Mixed attention at 360, 390, 412, 768, and 1280; first-viewport geometry. |
| Session Detail | `assets/ui-concepts/option-b/mobile-session-detail-active.png` | Active writable detail at the same five viewports; sticky dock/composer and timeline geometry. |
| Approval and boundary | `assets/ui-concepts/option-b/mobile-approval-boundary-states.png` | Replay boundary, normal pending approval, and elevated confirmation at 390. |
| Pairing journey | `assets/ui-concepts/option-b/pairing-journey.png` | Fragment-safe claiming and paired confirmation at 390 plus explicit CLI/local-only and automatic-claim divergences. |
| Access and recovery | `assets/ui-concepts/option-b/access-recovery-states.png` | Locked/read-only, remote disabled, Tailscale unavailable, wrong profile, Serve conflict, and browser-preload ownership mapping. |
| Primary controls | `assets/ui-concepts/option-b/primary-controls.png` | Current `/model`, active `/goal`, and current `/plan` sheets at 390. |
| Responsive continuum | `assets/ui-concepts/option-b/responsive-continuum.png` | Mission continuum plus 1280 retained-list/live-detail split with no desktop-only route or action. |

## Comparison Policy

- Bind every target and current screenshot by relative path, dimensions, byte size, and SHA-256 in one deterministic manifest.
- Direct phone targets receive normalized target/current/absolute-difference triptychs. Difference pixels are diagnostic, not a pass threshold, because authoritative copy and fixture data intentionally differ.
- Composite targets receive labelled target-plus-current contact sheets and an executable landmark matrix for each represented panel/state.
- Automated acceptance owns exact tokens, typography bounds, radii, target sizes, rail/section geometry, first-viewport usefulness, fixed/sticky ownership, overflow, clipping, and responsive structure.
- Manual review owns visual hierarchy, density, continuity, balance, legibility, icon fit, and whether each difference is contract-authorized or visible drift. A structural difference not already authorized by the selected docs requires correction or a new human decision.
- Evidence generation is fail-closed: fixed clock, animations disabled, device scale factor 1, pinned Chromium, local assets only, empty unexpected diagnostics, no retries, and atomic replacement of the task-owned output directory.

## Frozen Success Criteria

| ID | Required behavior |
| --- | --- |
| `FID-01` | Verify exactly the seven `DEC-028` target paths, expected raster dimensions, decodability, SHA-256 identities, and selected Option B ownership; reject missing, changed, extra, Option A, or legacy-board input. |
| `FID-02` | One immutable executable ledger maps all 141 canonical state traces exactly once to one of the seven visual families or an explicit browser/local-only boundary, preserving all 15 surfaces, 39 interactions, 12 journeys, and five reference viewports. |
| `FID-03` | Every ledger row names its behavior owner, required current evidence tier, target landmarks, permitted contract-authorized divergence, and whether fresh screenshot, existing state evidence, or non-app boundary evidence closes it. |
| `FID-04` | Fresh task-owned capture uses the current production web build, fixed fixtures/time, pinned Chromium identity, device scale factor 1, local-only requests, disabled animations/caret, loaded fonts, zero unexpected console/page errors, and no retry or stale prior output. |
| `FID-05` | Mission Control preserves the compact app bar/status rail, grouped `ACT NOW`/`IN PROGRESS`/`QUIET` hierarchy, semantic state rails, whole-row targets, and at least two normal `ACT NOW` rows in the first 390 x 844 viewport. |
| `FID-06` | Session Detail preserves one event-first semantic rail, distinct user/agent/tool/progress/approval/boundary nodes, exact session context, primary dock, and sticky prompt composer without obscuring the active focus or required content. |
| `FID-07` | Replay boundary, pending approval, and elevated confirmation preserve timeline attachment, risk hierarchy, exact target/consequence, distinct deny/approve actions, and readable background/dialog separation without nested-card drift. |
| `FID-08` | Pairing preserves the finite progress rail and one dominant bounded state. The local CLI owns QR creation, and automatic post-scrub claim omits the illustrative review/second-submit step exactly as frozen by `PHA-01` to `PHA-20`; no QR raster reuse or invented phone action is allowed. |
| `FID-09` | Access/recovery preserves owner labels and state rails for phone, browser-preload, and local-laptop boundaries; no remote unlock, profile switch, Serve repair, or diagnosis before document load appears in the app. |
| `FID-10` | `/model`, `/goal`, and `/plan` use the shared bottom-sheet structure, exact target, current/next-turn or objective/execution rails, stable actions, and selected control hierarchy without literal slash dispatch or desktop form drift. |
| `FID-11` | The 360/390/412 phone hierarchy stays one-column; 768 adds only bounded context; 1280 uses the selected retained grouped-list/live-detail split. Every phone action remains available without a desktop-only route or control. |
| `FID-12` | Computed design tokens match the selected palette (`#121313`, `#191b1c`, `#f5f3ee`, `#a9acb0`, `#414447`, `#45c2b1`, `#f1b43c`, `#ff675b`, `#4e8dff`) and use only 0/4/6 px product radii. |
| `FID-13` | Computed page/title/body/meta typography stays within the selected fixed 24/18/16/12-14 px scale, has zero negative letter spacing, does not scale with viewport width, and retains the approved weight/line-height hierarchy. |
| `FID-14` | All visible primary/icon/destructive controls are at least 44 x 44 CSS px where the selected contract requires it and never below the accessibility-approved 40 x 40 exception; labels and icons remain centered and stable across states. |
| `FID-15` | No required viewport has document or component horizontal overflow, clipped visible text, incoherent overlap, fixed-region collision, unintended hidden action, or layout shift after fonts/state settle. |
| `FID-16` | Long names, branches, model labels, objectives, paths, reasons, and recovery copy remain bounded and accessible at 320 reflow, 360 phone, short-height, 200 percent zoom, tablet, and desktop stress cases. |
| `FID-17` | Color is never the sole state signal; rails/nodes remain semantic rather than decorative; contrast, visible focus, reduced motion, sheet semantics, and route/dialog focus behavior remain at the completed `FE-V1-039` bar. |
| `FID-18` | All seven target families receive a labelled current comparison. The two direct phone targets receive target/current/difference triptychs, while all five composite targets receive panel mappings with no omitted selected panel. |
| `FID-19` | Manual review records each selected landmark as match, contract-authorized divergence, corrected drift, or unresolved human decision. No unresolved overlap, clipping, hierarchy, density, asset, or structural drift may remain at closure. |
| `FID-20` | The evidence manifest binds Git revision, clean tracked implementation state, target/current hashes, browser/build identity, fixture time, viewport, capture route/state, comparison outputs, diagnostics, and cleanup without private origin, user, device, prompt, credential, or profile data. |
| `FID-21` | Target/current evidence is deterministic across two independent generations: manifests and every task-owned PNG hash match after excluding only the manifest's run timestamp, which should be absent by design. |
| `FID-22` | Focused fidelity/coverage/browser tests, complete web and shell browser regressions, responsive/accessibility checks, package browser/e2e gates, workspace static gates, and production package verification pass after any correction. |
| `FID-23` | Evidence generation leaves no preview/browser/process/listener/temp residue, does not mutate Tailscale/Serve/profile/phone/ADB state, and leaves all upstream task artifacts byte-identical. |
| `FID-24` | Closure records exact criteria/implementation/evidence commits, commands/counts, target and evidence hashes, corrected drift, authorized divergences, remaining physical-device limitations, and no claim beyond visual-fidelity scope. |

## Planned Evidence

- `packages/test-fixtures/src/ui-fidelity-matrix.ts` and focused contract tests.
- A dedicated Playwright capture configuration and deterministic comparison/manifest validator.
- `artifacts/fe-v1-017-selected-target-fidelity/` screenshots, comparison sheets, measurements, manifest, and manual review ledger.
- Focused UI fixes only where the current build visibly violates the selected targets or design-system rules.

## Commit Record

- Criteria: pending.
- Implementation/evidence: pending.
- Closure: pending.
