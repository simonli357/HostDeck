---
name: production-hardening
description: Use when a module, workflow, interface, feature, release path, or implementation slice must be audited and improved to production-grade quality. Triggers include "harden this module", "make this production grade", "audit this feature", "is this actually done?", "pass 2", "module hardening", "release hardening", "strict success criteria", or concerns that work is only surface-level.
---

# Production Hardening

Use this skill to turn surface-level functionality into production-grade behavior.

Core rule: define harsh success criteria before implementing fixes. Do not start by patching code.

## Required Workflow

1. Identify the hardening target: module, workflow, interface, feature, release path, or task cluster.
2. Read the smallest relevant doc set:
   - `docs/status.md`
   - `docs/planning/00-end-goal.md`
   - `docs/planning/00-roadmap.md`
   - `docs/planning/01-prd.md` or `docs/planning/01-project-plan.md`
   - `docs/planning/02-requirements.md`
   - `docs/planning/03-ux-spec.md` or `docs/planning/03-interface-spec.md` when relevant
   - `docs/planning/04-technical-plan.md`
   - `docs/planning/04a-implementation-blueprint.md`
   - `docs/planning/04b-test-plan.md` or `docs/planning/04b-validation-plan.md`
   - relevant block spec under `docs/planning/05-blocks/`
   - `docs/tracking/05-delivery-plan.md`
   - `docs/tracking/06-tasks.md`
   - `docs/engineering-style.md`
3. Inspect the implementation, tests, runtime setup, and existing evidence for the target.
4. Write or update strict success criteria before changing implementation.
5. Compare current behavior against the criteria and identify gaps.
6. Update the owning task, blueprint, and validation plan with requirement/design/spike/test refs, criteria, gaps, manual inspection plan, and evidence required.
7. Implement the smallest root-cause fixes needed to meet the criteria.
8. Run automated validation and perform manual AI inspection.
9. Record evidence, remaining gaps, approved deferrals, and commit/push status in the tracking docs.

## Success Criteria Quality Bar

Good criteria are specific, inspectable, and harsh:

- Correct behavior is proven for normal, boundary, invalid, and repeated use.
- Invalid input, missing config, broken contracts, and unsupported states fail loudly.
- Security, privacy, permissions, credentials, data integrity, and destructive actions are reviewed when relevant.
- External failures have explicit user/operator-facing behavior and observability.
- Core logic has direct tests when practical, not only interface-level smoke tests.
- Interfaces, outputs, generated artifacts, docs, and examples match real behavior.
- Runtime setup, packaging, deployment, or handoff paths work from a clean environment when relevant.
- Manual inspection evidence exists for behavior automation cannot fully prove.
- The owning block completion-matrix row is updated when hardening changes block maturity.

Weak criteria are not acceptable:

- "Works well"
- "Has good tests"
- "Handles errors"
- "Looks production ready"
- "Should be robust"

Rewrite weak criteria into concrete checks before continuing.

## Hardening Checklist

- End-goal alignment:
- Owning module, workflow, or interface:
- Current maturity:
- Production-grade target:
- Harsh success criteria:
- Known gaps:
- Edge cases and invalid states:
- Security, privacy, or data-integrity concerns:
- Failure and fallback behavior:
- Observability or diagnostics:
- Automated validation required:
- Manual AI inspection required:
- Documentation updates required:
- Remaining gaps or approved deferrals:

## Stop Conditions

Do not mark hardening complete if:

- Criteria are vague or missing.
- Only the happy path was inspected.
- Tests pass because of silent fallbacks, fake defaults, broad catch-all recovery, or swallowed errors.
- Manual inspection was skipped for runtime behavior, outputs, visual/user-facing behavior, or release paths that automation does not fully prove.
- Tracking docs do not record validation evidence and remaining gaps.
- The result drifts from `docs/planning/00-end-goal.md` without human-approved documentation.
