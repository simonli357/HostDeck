---
name: docs-sync
description: Use when code, behavior, architecture, setup, validation, release status, tasks, decisions, user-facing behavior, developer commands, dependencies, or project scope changes and repository docs must stay synchronized. Triggers include "sync docs", "update docs", "docs are stale", "handoff", "status update", "task evidence", "developer guide", "decision log", or before claiming a task complete.
---

# Docs Sync

Use this skill to keep docs aligned with actual project truth.

Core rule: docs must describe real current behavior, not hoped-for behavior, with each fact owned by the smallest necessary doc set.

## Documentation Impact Rule

Before editing docs, select the documentation impact tier in `docs/README.md`.

- Tier 1 local fixes should stay in `docs/status.md`, the relevant bug/task entry, and direct validation evidence.
- Do not update planning docs, delivery docs, design-system docs, or `docs/tracking/05-delivery-plan.md` unless their owned facts changed.
- If a broader doc is skipped intentionally, record that briefly in the task, bug log, or status when it may be non-obvious.

## Required Workflow

1. Identify what changed: behavior, interface, setup, dependency, architecture, validation, release status, task state, or decision.
2. Read `docs/README.md` for the documentation impact tiers and update map, then choose the smallest valid tier.
3. Read the smallest affected doc set for that tier.
4. Compare docs against implementation, commands, validation output, and current task state.
5. Update owning docs before claiming the work complete.
6. Keep unresolved questions in the planning doc, resolved decisions in `docs/planning/07-decisions.md`, and current handoff truth in `docs/status.md`.
7. Record validation evidence in `docs/tracking/06-tasks.md` or the relevant bug/feature log.
8. If docs cannot be made truthful, record the gap, owner, and next action in `docs/status.md`.

## Sync Targets

- Current phase, active work, blockers, and next action: `docs/status.md`
- End goal, roadmap, scope, requirements, interfaces, architecture, block specs, and validation strategy: files under `docs/planning/`
- Reusable engineering standards: `docs/engineering-style.md`
- Task state, hardening criteria, validation evidence, bugs, and accepted features: files under `docs/tracking/`
- Setup, usage, commands, behavior maps, packaging, and release instructions: files under `docs/delivery/`
- Material choices: `docs/planning/07-decisions.md`

## Quality Bar

- Docs and code agree on names, commands, paths, environment variables, ports, files, and supported platforms.
- Validation evidence includes commands run and meaningful results, or an explicit gap.
- Stale TODOs, aspirational language, and contradicted instructions are removed or marked as known gaps.
- Docs explain the current state compactly enough for the next agent to continue without rediscovery.

## Stop Conditions

Do not mark docs synchronized if:

- `docs/status.md` points to old work or hides blockers.
- Delivery docs mention commands or behavior that were not verified.
- A material decision is buried in task notes instead of the decision log.
- Tracking docs claim completion without evidence.
- Known drift is left implicit.
- Small local fixes caused broad planning or delivery doc churn without an owned fact changing.
