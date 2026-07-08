# Foundation Backlog

Seed group file. Replace or move the placeholder rows into project-specific backlog groups after planning.

## EP-FND-01 Planning To Execution

| ID | Status | Refs | Requires | Blocked by | Blocks | Description | Success criteria | Validation / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `FND-V1-001` | blocked | roadmap, requirements, UX, technical plan, blueprint, blocks, test plan | human acceptance | Planning sign-off | `FND-V1-002` | Decompose the approved plan into required blocks, selected program areas, epics, leaf tasks, refs, dependencies, and group files. | Required V1 blocks exist, backlog group files exist for selected program areas, and every candidate V1 requirement has a block, task, spike, or deferral owner. | Docs review and `git diff --check` |

## EP-FND-02 Backlog Quality Gates

Keep these tasks until the decomposed backlog has equivalent project-specific coverage.

| ID | Status | Refs | Requires | Blocked by | Blocks | Description | Success criteria | Validation / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `FND-V1-002` | blocked | requirements, UX, technical plan, blueprint, blocks, test plan, backlog index | human acceptance | `FND-V1-001` | First implementation task | Audit the block map and backlog against requirements, screens, native capabilities, dependencies, failure states, hardening needs, and release gates. | Every required block maps to epics, leaf tasks, and completion evidence; every active-version requirement maps to a leaf task, spike, or explicit deferral; no broad rollups or unexplained `TBD` remain. | Docs review plus `rg -n "TBD|finish UI|add auth|integrate API|ship release|polish" docs/planning docs/tracking` |
| `FND-V1-003` | blocked | end goal, requirements, blueprint, test plan, delivery plan | human acceptance | `FND-V1-002` | Module hardening pass | Create module-hardening leaf tasks for every V1 screen flow, native capability, integration, local data path, and sync path. | Each module/workflow has strict success criteria, permission/failure-state checks, simulator/device inspection where applicable, and evidence expectations. | Docs review against `docs/tracking/backlog/00-index.md` quality gates |
| `FND-V1-004` | blocked | UX, visual direction decision, assets/ui-concepts, test plan | human acceptance | `FND-V1-002` | UI implementation tasks | Create UI-fidelity and state-coverage leaf tasks for every V1 screen group, or record why V1 has no UI. | UI tasks name approved references, design-system mapping, state coverage, required assets, simulator/device screenshot evidence, and drift handling. | Docs review and selected design decision link |

## EP-REL-01 V1 Release Readiness

Move this into the chosen release/store backlog group after planning.

| ID | Status | Refs | Requires | Blocked by | Blocks | Description | Success criteria | Validation / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `REL-V1-001` | blocked | roadmap, requirements, delivery plan, test plan, developer guide, user guide, repo guide, command reference | human acceptance | `FND-V1-002` | Release hardening pass | Create V1 release-readiness leaf tasks for build/package, device QA, signing, privacy labels, docs/support, and go/no-go. | Release gates are represented as tasks with owners, blockers, validation artifacts, and explicit deferrals where needed. | Docs review and delivery-plan sync |

## EP-FND-99 Next-Version Planning Gate

Keep this task or move it into the chosen release/store backlog group after planning.

| ID | Status | Refs | Requires | Blocked by | Blocks | Description | Success criteria | Validation / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `REL-V1-999` | blocked | roadmap, end goal, decisions, delivery plan | human acceptance | V1 release acceptance | V2 backlog creation | Review V1 outcome, update the roadmap, choose the next active version, and run the planning pipeline for V2 before creating V2 epics and leaf tasks. | `docs/planning/00-roadmap.md` reflects the next active version and V2 planning docs/backlog tasks exist only after human approval. | Docs review and recorded human approval |
