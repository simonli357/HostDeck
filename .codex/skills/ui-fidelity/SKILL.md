---
name: ui-fidelity
description: Use when designing, implementing, reviewing, or hardening a UI, visual surface, mockup-backed screen, design-system implementation, generated asset usage, screenshot review, responsive state, or visual regression. Triggers include "make this match the mockup", "UI fidelity", "visual drift", "design system", "screenshot review", "responsive UI", "mockup-faithful", "asset fidelity", or before marking UI work complete.
---

# UI Fidelity

Use this skill to make implemented UI match the approved visual direction rather than approximate it.

Core rule: approved mockups, design systems, and generated assets are implementation targets, not inspiration.

## Required Workflow

1. Identify the UI target: screen, flow, component group, layout state, generated asset, or visual regression.
2. Read the smallest relevant source set:
   - `docs/status.md`
   - `docs/planning/00-end-goal.md`
   - `docs/planning/03-ux-spec.md` or `docs/planning/03-interface-spec.md`
   - `docs/planning/04a-implementation-blueprint.md`
   - `docs/planning/04b-test-plan.md` or `docs/planning/04b-validation-plan.md`
   - relevant block spec under `docs/planning/05-blocks/`
   - `docs/tracking/06-tasks.md`
   - selected visual direction in `docs/planning/07-decisions.md`
   - selected files under `assets/ui-concepts/`
3. Confirm the target has complete references: mockups, design-system rules, assets, states, and responsive expectations.
4. If references are missing, update the task with the gap and generate or request the missing reference before implementation.
5. Map the implementation to the design system: tokens, components, states, layout rules, breakpoints, assets, and interaction states.
6. Implement against the approved references. Do not invent a custom approximation unless the divergence is documented and human-approved.
7. Capture screenshots or visual diffs for the required viewports and important states.
8. Manually compare implementation against references and fix visible drift before marking the UI target complete.
9. Record evidence, remaining drift, approved divergences, and validation commands in tracking docs.

## Fidelity Quality Bar

- Layout, spacing, sizing, typography, color, elevation, borders, and radius match the design system.
- Components match approved variants and states: default, hover, focus, disabled, loading, empty, error, selected, and active when relevant.
- Generated assets are used directly from the repo or a documented human-approved substitute is recorded.
- Text fits at desktop and mobile sizes without overlap, clipping, or layout jump.
- Responsive layouts preserve visual hierarchy and target functionality.
- Accessibility basics are preserved: semantic controls, focus visibility, labels, contrast, and reduced-motion behavior when relevant.
- Screenshots or visual diffs exist for the states automation cannot prove by unit tests.

## Stop Conditions

Do not mark UI work complete if:

- The selected visual direction, mockup, or design-system reference is missing.
- The implementation is only visually similar in broad strokes.
- Assets were generated but not used.
- Only the default desktop happy path was inspected.
- Text overlaps, clips, resizes containers unexpectedly, or hides important controls.
- Visible drift remains without a documented human-approved exception.
