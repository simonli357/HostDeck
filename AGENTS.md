# AGENTS.md

## Purpose

Plan, implement, validate, and maintain a mobile app without broad documentation churn.

## Operating Contract

- `docs/README.md` owns the workflow, read sets, owners, update tiers, and doc budget.
- `docs/engineering-style.md` owns reusable engineering standards.
- `human.md` is human-only. Do not read, summarize, edit, stage, commit, or use it as context.
- Start from `docs/status.md`.
- Read `docs/tracking/06-tasks.md`, then only the selected task's backlog group file and docs that own changed facts.
- Treat `docs/brainstorming/00-freeform-idea.md` as optional rough intake.
- When a human reports a bug, they do not need to format it. Triage, log, route, fix or task it, validate it, and update only the owning docs.
- Ask small question rounds: 1 to 3 questions, recommended option first.
- Keep unresolved human choices in `docs/planning/01-prd.md`.
- Keep resolved choices in `docs/planning/07-decisions.md`.
- Use `docs/planning/00-end-goal.md` as the product north star.
- Use `docs/planning/00-roadmap.md` to define V1, V2, and later scopes before requirements.
- Fill planning in this order before backlog decomposition: concept, end goal, roadmap, active-version PRD, requirements, architecture, UX/interface contract, detailed design/spikes, test plan, capability blocks, backlog.
- Do not write product code until planning exists and the human authorizes implementation.
- Before implementation, define required V1 blocks under `docs/planning/05-blocks/`, then convert them into a dependency-aware backlog under `docs/tracking/backlog/`.
- Implementation work must use leaf tasks, not broad rollups.
- Check `git status` before staging or committing.
- Stage only intended files.
- Do not revert user changes.
- Commit and push coherent units when remote access exists and staging can stay clean.
- If commit or push is blocked, record the blocker in `docs/status.md`.

## Lightweight Docs Rule

- One fact has one owner.
- Routine task/evidence updates should touch 0 to 2 docs.
- New commands update the command reference; update developer docs only if setup/env changed.
- Planning docs do not change for routine evidence.
- Delivery plan changes are for milestone, maturity, or release-truth changes.
- Status changes are for handoff facts only: phase, active task, blockers, next action, validation, push state.
- Prefer artifacts for detailed evidence.
- Write concise bullets and tables.

## Task Granularity And Order

- Organize work as Program Area -> Epic -> Leaf Task.
- Every leaf task must include status, block refs, requirements, `Blocked by`, `Blocks`, description, success criteria, and validation/evidence.
- Bugfix work follows `docs/README.md` Bug Workflow: small fix, backlog bug task, spike/planning bug, or release blocker.
- A task is `ready` only when all `Blocked by` tasks are done, requirements are available, validation is known, and scope does not need redefining.
- A task is too broad if it contains multiple independent outcomes, requires deciding what to build while doing it, or cannot be handed to a junior engineer with a clear expected result.
- Decompose tasks like "finish UI", "add auth", "integrate API", or "ship release" before implementation.
- For non-trivial products, expect dozens to hundreds of leaf tasks; a short task list is not proof that the release is scoped.
- Map every active-version requirement to a leaf task, spike, or explicit release deferral before implementation starts.
- Map every required V1 block to epics, leaf tasks, validation evidence, and completion-matrix status before implementation starts.
- Seed module-hardening, applicable UI-fidelity, and release-readiness tasks during backlog decomposition.
- Maintain the current next queue in `docs/tracking/06-tasks.md`.
- Maintain the dependency graph in `docs/tracking/backlog/00-index.md`.
- Do not ask what to do next if a `ready` task exists.
- Prefer this order: contracts/data models, fixtures/mocks, core logic, native adapters/permissions, UI consuming contracts, failure states, persistence/sync, hardening, device/store release gates, human acceptance.

## Required Skills

Use these repo skills when present:

- `docs-sync`: docs/status/task/release truth changes.
- `production-hardening`: module or release hardening.
- `ui-fidelity`: UI implementation, review, or hardening.
- `release-readiness`: release, demo, package, handoff, or go/no-go.

## Delivery Loop

Use three passes:

1. Foundation: contracts, core logic, adapters, minimal app surface.
2. Module hardening: one module at a time with strict criteria and evidence.
3. Release hardening: packaging, setup, support docs, go/no-go.

Do not mark production-grade work complete just because tests pass. Inspect behavior, failure states, and UI/runtime output where applicable.

## Engineering Rules

- Follow `docs/engineering-style.md`.
- Prefer explicit contracts, headless logic, isolated adapters, and a thin UI.
- Prefer mature maintained libraries for common capabilities.
- Record dependency/reuse decisions only in the owning task, technical plan, or decision log.
- Fix root causes.
- Fail loudly for broken config, invalid state, schema mismatch, unsupported platform assumptions, and impossible branches.
- Add fallback behavior only when required, observable, documented, and tested.

## UI Rules

- Headless product contracts and validation come before UI.
- UI implementation requires two visual direction options, human selection, and a recorded decision.
- Before each screen group, use approved mockups, state coverage, design-system mapping, and required assets.
- Store generated project assets in the repo.
- Treat approved mockups as implementation targets.
- Before marking UI work done, capture screenshots or visual diffs and record drift or approval.

## Done Criteria

- Code behavior matches tests and manual inspection evidence.
- Owner docs selected by `docs/README.md` match actual behavior.
- `docs/status.md` is current when handoff facts changed.
- Leaf tasks and bugs have owning evidence before closure.
- Commands added or changed appear in `docs/delivery/11-command-reference.md`.
- Setup/env changes appear in `docs/delivery/09-developer-guide.md`.
- Release blockers are visible in status, delivery plan, or release artifacts.
- Product code changes include verification or a clear validation gap.
- No hidden fallback, fake readiness, swallowed error, or secret leakage is introduced.
- Completed work is committed and pushed, or the blocker is recorded.
