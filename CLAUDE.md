# CLAUDE.md

Follow `AGENTS.md` and `docs/README.md`.

## Reminders

- Start with `docs/status.md`.
- Ignore root `human.md`: do not read, summarize, edit, stage, commit, or use it as context.
- Read `docs/tracking/06-tasks.md`, then load only the selected task's backlog group and docs that own changed facts.
- Use the planning pipeline in `docs/README.md` before backlog work: concept, end goal, roadmap, active-version PRD, requirements, architecture, UX/interface contract, detailed design/spikes, test plan, capability blocks, backlog.
- For bug reports, follow `docs/README.md` Bug Workflow; the human does not need to format the report.
- Follow `docs/engineering-style.md` for reusable engineering standards.
- Implement from ready leaf tasks, not broad task rollups.
- Respect `Blocked by` and `Blocks`; do not mark blocked work as ready.
- Keep docs concise: bullets, tables, commands, artifact paths.
- Use the smallest docs update tier.
- Do not update planning docs for routine evidence.
- Do not duplicate artifact details in prose.
- Link leaf tasks to block, requirement, design, spike, and test refs.
- Map every active-version requirement to a task, spike, or explicit deferral before implementation.
- Map every required V1 block to epics, tasks, validation evidence, and completion-matrix status before implementation.
- Seed module-hardening, UI-fidelity, and release-readiness tasks when applicable.
- Keep unresolved questions in `docs/planning/01-prd.md`.
- Keep decisions in `docs/planning/07-decisions.md`.
- Commit and push coherent units when staging can include only intended files.
- Record push blockers in `docs/status.md`.

## Skills

Use these repo skills when present:

- `docs-sync`: docs/status/task/release truth changes.
- `production-hardening`: module or release hardening.
- `ui-fidelity`: UI implementation or review.
- `release-readiness`: demo, handoff, package, release, go/no-go.

## Quality

- Prefer headless contracts, isolated adapters, and thin UI.
- Prefer maintained libraries for common capabilities.
- Fix root causes.
- Fail loudly for bad config, schema mismatch, invalid state, and unsupported platforms.
- Add fallbacks only when required, documented, observable, and tested.
- UI work needs approved visual direction, module mockups, assets, and screenshot/fidelity evidence.
