# Leaf Task Template

Use this template for each concrete task. A broad release gate is not a leaf task.

## Requirements Vocabulary

Use the most specific requirement that applies:

- `none`
- `local dev server`
- `iOS simulator`
- `Android emulator`
- `physical iOS device`
- `physical Android device`
- `Apple Developer account`
- `Google Play account`
- `signing certificate`
- `push credentials`
- `camera/location/notification permission`
- `test account`
- `legal/privacy review`
- `human acceptance`

## Task Card

```md
## EP-AREA-00 Epic Name

| ID | Status | Refs | Requires | Blocked by | Blocks | Description | Success criteria | Validation / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `AREA-V1-001` | todo | `BLK-V1-01`, `FR-001`, `04a:SPK-001`, `04b:Unit` | none | none | `AREA-V1-002` | One concrete action. | Observable result that proves the task is complete. | Command, simulator/device screenshot, artifact, or explicit validation gap. |
```

Refs should link the task to block IDs, requirement IDs, design sections, spike decisions, test IDs/layers, decision IDs, or `none` when the task is purely local.

## Success Criteria Rules

Success criteria must name:

- The observable user/system result.
- The expected failure behavior.
- The validation command, simulator/device inspection, screenshot/video, trace, or artifact.
- Any explicit gap, blocker, or release deferral.

Do not mark UI, native capability, sync, persistence, security/privacy, device QA, signing, or store release work done with "tests pass" alone. Add inspection evidence where behavior or appearance matters.

## Readiness Rules

A task is `ready` only when:

- All `Blocked by` tasks are `done`.
- Required devices, accounts, certificates, permissions, services, or human decisions are available.
- The validation path is known.
- The task can be completed without redefining product scope mid-task.

## Granularity Test

A task is too broad if:

- It contains multiple independent outcomes.
- It would require deciding what to build while doing it.
- It cannot be handed to a junior engineer with a clear expected result.
- It spans more than one coherent implementation slice.
- It says "implement app", "finish UI", "add auth", or "integrate API" without narrower subtasks.

For non-trivial products, expect dozens to hundreds of leaf tasks. A short task list is not proof that the release is scoped.

## Decomposition Checks

When creating tasks from planning:

- Map every active-version requirement to a leaf task, spike, or explicit deferral.
- Create separate tasks for contracts/fixtures, implementation, denied permissions/failure states, persistence/sync/redaction, hardening, and release validation when they are meaningful.
- Create one UI-fidelity task per screen group/state set after a visual direction is selected.
- Add `BUG-*` or `FEAT-*` refs for accepted bug or feature intake work.
- Replace `TBD` with a decision, spike, blocker, or deferral before planning sign-off.
