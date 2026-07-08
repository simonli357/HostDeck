# Docs Map

This file owns the repository workflow, read sets, document owners, and docs-update budget.

## Default Rule

Track the work without turning every change into a documentation project.

- One fact has one owner.
- Evidence goes in artifacts or the owning task.
- Other docs link or summarize only when they own a changed fact.
- Planning docs are mostly stable after scope is set.
- Write short bullets and tables. Avoid long paragraphs.
- Prefer paths, commands, status, and next action over narrative.

## Doc Budget

Use the smallest truthful update.

| Change | Default docs |
| --- | --- |
| Exploration or no-op | No doc update |
| Small bugfix | Bug/task owner only; `docs/status.md` only if handoff changes |
| New/refined task, task status, or dependency | Relevant backlog group file; `docs/tracking/06-tasks.md` only if the queue or release-gate dashboard changes |
| Validation rerun | Artifact plus owning task; no planning updates |
| New command | `docs/delivery/11-command-reference.md`; developer guide only if setup/env changed |
| New behavior or contract | Owning planning doc plus task |
| Release gate status | Release artifact plus `docs/status.md`; delivery plan only on milestone/go-no-go change |
| New dependency or service | Technical plan plus developer guide if setup changes |
| Human decision | `docs/planning/07-decisions.md` plus affected owner |

Default maximums:

- Routine task or evidence update: 0 to 2 docs.
- New command or setup change: 1 to 3 docs.
- Product/contract change: affected owner docs only.
- Release/handoff event: release read set.

## Stage Read Sets

Start small. Load more only when linked or affected.

| Stage | Read first | Add only when needed |
| --- | --- | --- |
| Intake | `README.md`, `docs/status.md`, intake files | `docs/README.md` |
| Planning | `docs/status.md`, `docs/planning/00-end-goal.md`, roadmap, PRD, requirements, UX, technical plan, blueprint, test plan, block index, decisions | Examples only for format |
| Implementation | `docs/status.md`, current queue in `docs/tracking/06-tasks.md`, relevant backlog group file | Relevant block spec, blueprint/test sections only when needed; PRD/UX/technical/delivery only when facts change |
| Bugfix | human report, `docs/status.md`, bug log, owning task when known | Backlog, test plan, planning, or delivery docs only when routing requires them |
| Feature intake | feature log, owning task, status | Planning docs only when accepted scope changes |
| UI work | status, active task, selected design system, approved mockups | UX/spec only when UI contract changes |
| Hardening | status, delivery plan, owning task, relevant test plan section | Production-hardening skill, affected code/docs |
| Release/handoff | status, delivery plan, tasks, test plan, user/developer/repo/command guides | Planning docs only for changed behavior |

## Owners

| Fact | Owner |
| --- | --- |
| Current phase, active work, blockers, next action | `docs/status.md` |
| Product destination | `docs/planning/00-end-goal.md` |
| Version roadmap and active-version scope | `docs/planning/00-roadmap.md` |
| Open human questions | `docs/planning/01-prd.md` |
| Requirements | `docs/planning/02-requirements.md` |
| UX contracts | `docs/planning/03-ux-spec.md` |
| High-level architecture, dependencies, services, env policy | `docs/planning/04-technical-plan.md` |
| Detailed design, spike results, implementation sequencing | `docs/planning/04a-implementation-blueprint.md` |
| Validation strategy | `docs/planning/04b-test-plan.md` |
| Capability block map, block specs, and V1 completion matrix | `docs/planning/05-blocks/` |
| Resolved decisions | `docs/planning/07-decisions.md` |
| Milestone and release dashboard | `docs/tracking/05-delivery-plan.md` |
| Current execution queue and release-gate dashboard | `docs/tracking/06-tasks.md` |
| Backlog program map, dependency graph, ordering rules, and quality gates | `docs/tracking/backlog/00-index.md` |
| Leaf task state, refs, requirements, dependencies, criteria, and task evidence | `docs/tracking/backlog/` group files |
| Bugs | `docs/tracking/06a-bug-log.md` |
| Accepted features | `docs/tracking/06b-feature-log.md` |
| User behavior and troubleshooting | `docs/delivery/08-user-guide.md` |
| Developer setup and env context | `docs/delivery/09-developer-guide.md` |
| Repo structure and module map | `docs/delivery/10-repo-guide.md` |
| Copy-paste commands | `docs/delivery/11-command-reference.md` |
| UI concept assets and tokens | `assets/ui-concepts/` |
| Reusable engineering standards | `docs/engineering-style.md` |
| Machine-readable validation evidence | `artifacts/` |

## Canonical Workflow

1. Start from `docs/status.md`.
2. If planning or backlog is incomplete, run the planning pipeline before implementation.
3. Read `docs/tracking/06-tasks.md` and choose one ready leaf task unless the user gives a different priority.
4. Read only the selected task's backlog group file and the owner docs affected by the change.
5. Implement or validate the smallest coherent unit.
6. Write durable evidence to an artifact when possible.
7. Update the owning backlog task card; update `docs/status.md` only if handoff truth changes.
8. Run relevant validation.
9. Commit and push coherent units when the worktree is clean enough to stage only intended files.

## Planning Pipeline

Fill planning in this order. Do not fill all docs at once; stop and ask when a stage cannot exit truthfully.

| Order | Stage | Owner | Output | Exit gate |
| --- | --- | --- | --- | --- |
| 1 | Concept | `docs/brainstorming/00-freeform-idea.md` | Rough idea, references, constraints, or `idk` notes | AI can summarize the idea and missing choices |
| 2 | End goal | `docs/planning/00-end-goal.md` | One paragraph describing the finished product and quality bar | Human agrees this is the target |
| 3 | Version scopes | `docs/planning/00-roadmap.md` | V1, V2, and later scopes through the end goal | V1 is narrow and future scope is visible |
| 4 | Active-version product shape | `docs/planning/01-prd.md` | Users, value, journeys, risks, open choices | Human choices are resolved or explicitly open |
| 5 | Requirements | `docs/planning/02-requirements.md` | Functional, non-functional, interface, data, platform, safety/failure requirements | Requirements have IDs and validation ideas |
| 6 | Architecture | `docs/planning/04-technical-plan.md` | High-level architecture, dependencies, env, security, reuse decisions | Major technical choices are explicit |
| 7 | UX and interface contract | `docs/planning/03-ux-spec.md` | Surfaces, flows, states, accessibility, visual direction gate | UI contracts and visual gates are clear |
| 8 | Detailed design and spikes | `docs/planning/04a-implementation-blueprint.md` | Module design, sequencing, spike questions/results | Unknowns are resolved or tracked as spikes |
| 9 | Test plan | `docs/planning/04b-test-plan.md` | Commands, coverage matrix, manual inspection layers | Each important requirement has evidence planned |
| 10 | Capability blocks | `docs/planning/05-blocks/` | Required V1 blocks, local specs, completion matrix | Every V1 requirement maps to a block, spike, or deferral |
| 11 | Backlog | `docs/tracking/backlog/` | Program profile, block-linked epics, leaf tasks, dependencies, refs | Ready queue has dependency-aware leaf tasks |

## Task Workflow

- Work is organized as Program Area -> Epic -> Leaf Task.
- A leaf task must include status, refs, requirements, `Blocked by`, `Blocks`, description, success criteria, and validation/evidence.
- `docs/tracking/06-tasks.md` owns the current next queue and release-gate dashboard.
- `docs/tracking/backlog/00-index.md` owns the program map, dependency graph, ordering rules, and backlog quality gates.
- Backlog group files own task detail and evidence.
- `docs/tracking/06-tasks.md` is a dashboard, not the full backlog.
- During backlog decomposition, map every active-version requirement to a leaf task, explicit spike, or explicit release deferral.
- Before backlog decomposition, define required V1 blocks in `docs/planning/05-blocks/00-index.md`.
- Every backlog group, epic, and leaf task should reference the relevant block ID, such as `BLK-V1-01`.
- V1 completion is proven by the block completion matrix, not by an unverified task count.
- Seed module-hardening tasks for every V1 module/workflow; seed UI-fidelity tasks for every UI screen group when UI exists; seed release-readiness tasks for device QA, signing, privacy labels, docs/support, and go/no-go.
- Do not leave `TBD`, ambiguous blockers, or broad "polish/hardening" rollups after planning sign-off.
- A task is `ready` only when dependencies are done, requirements are available, validation is known, and scope does not need redefining.
- Broad tasks like "finish UI", "add auth", or "integrate API" are invalid execution tasks until decomposed.
- For non-trivial products, expect dozens to hundreds of leaf tasks; a short task list is not proof that the release is scoped.

## Bug Workflow

Humans only need to report the symptom, screenshot, log, or rough reproduction notes. The agent owns triage, logging, routing, backlog updates, validation, and closure.

| Route | Use when | Agent action | Docs touched |
| --- | --- | --- | --- |
| Small bugfix | Root cause is local, expected behavior is clear, and no contract/setup/planning change is needed | Log bug, fix root cause, add focused regression evidence, close bug | Bug log plus owning task/artifact; status only if handoff changes |
| Backlog bug task | Fix affects planned work, multiple files, or a completed task's behavior, but requirements are already clear | Log bug, create or update leaf task(s), add `BUG-*` refs, update blockers/queue if needed | Bug log, relevant backlog group, `06-tasks.md` only if queue/gates change |
| Spike / planning bug | Root cause, expected behavior, architecture, UX, or validation strategy is unclear | Log bug, create a triage/spike leaf task, resolve uncertainty before implementation | Bug log, backlog group, affected planning owner only when facts change |
| Release blocker | Bug threatens primary flow, data integrity, security/privacy, install/run, deployment, payment, destructive action, or release acceptance | Log bug, mark blocker in status/release tracking, prioritize blocking leaf tasks | Bug log, status, relevant backlog/release docs |

Bug routing rules:

- Do not ask the human to format the bug. Extract the missing fields if possible and ask only for blocking reproduction or priority details.
- Do not create a planning update for an implementation mistake.
- Do update the owning planning doc when the bug proves the expected behavior, contract, architecture, setup, or validation strategy was missing or wrong.
- Do not patch around bugs with hidden fallbacks, fake success, swallowed errors, or broad conditional bandaids.
- Existing planned tasks should be blocked by the bug when they depend on the broken behavior.
- A done task can be reopened only if it owns the broken behavior; otherwise create a new bugfix leaf task that references the old task.

## Planning

- Use intake files as rough notes, not a form gate.
- Ask 1 to 3 focused questions at a time.
- Draft `docs/planning/00-end-goal.md` after the first planning pass.
- Fill the planning pipeline in order before backlog decomposition.
- Define the roadmap before V1 requirements; future versions stay lightweight until they become active.
- Root planning docs describe the active version. Create versioned docs for later versions only when those facts materially differ.
- Overall planning docs own cross-block truth; block specs own local architecture, implementation sequence, validation, epics, and task links.
- Do not start backlog decomposition until required V1 blocks and the V1 completion matrix exist.
- Keep unresolved choices in the PRD.
- Keep resolved choices in the decision log.
- Do not rewrite planning docs for routine evidence.

## Production Delivery

Use three passes:

1. Foundation: contracts, core logic, adapters, minimal app.
2. Module hardening: one module at a time, with strict criteria and evidence.
3. Release hardening: packaging, setup, support docs, go/no-go.

Use repo skills when present:

- `docs-sync`: docs/status/task/release truth changes.
- `production-hardening`: module or release hardening.
- `ui-fidelity`: UI implementation, review, or hardening.
- `release-readiness`: release, demo, handoff, packaging, go/no-go.

## UI Gate

- Headless contracts and validation come before UI.
- Two visual direction options are required before UI implementation.
- The human-selected option must be recorded in decisions.
- Each implemented screen group needs approved references and screenshot/fidelity evidence.
- Generated assets must be stored in the repo or explicitly deferred.

## Reuse Gate

Prefer maintained libraries for common capabilities.

Record reuse evidence only where it matters:

- Task-local assessment: owning task.
- Durable dependency or architecture choice: technical plan or decision log.
- Setup impact: developer guide and command reference.

## Update Tiers

| Tier | Use when | Required updates |
| --- | --- | --- |
| 0 | Exploration/no durable change | None |
| 1 | Local task, bugfix, validation, asset polish | Owning backlog group, bug, or artifact; status only if handoff changes |
| 2 | Product behavior, UX, validation strategy, human choice | Affected planning owner plus task/status if needed |
| 3 | Architecture, dependency, setup, command, module maturity, release blocker | Technical/delivery/release owners only for changed facts |
| 4 | Demo, handoff, package, release candidate, final delivery | Release read set and release-readiness evidence |

## Stop Conditions

Do not claim docs are current if:

- `docs/status.md` hides active blockers.
- A command is documented but unverified or unavailable.
- A task says done without evidence or an explicit gap.
- A release blocker is only buried in notes.
- The same transient fact was copied into multiple owner docs.
