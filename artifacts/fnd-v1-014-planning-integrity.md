# FND-V1-014 Planning Integrity Validation

Date: 2026-07-09

## Scope

- Add a repository command that parses backlog task tables, requirement definitions/trace rows, block refs, and the current queue.
- Fail on duplicate/invalid task ids, unknown task/block/requirement refs, dependency cycles, self-dependencies, invalid ready/in-progress dependencies, missing done-task evidence, uncovered requirements, queue/status drift, duplicate queue tasks, and non-current queue statuses.
- Keep templates out of executable task inventory.

## Implementation

- `scripts/planning-graph.mjs`: table parser, id/range expansion, model builder, graph/trace/queue validation.
- `scripts/check-planning.mjs`: repository entrypoint.
- `scripts/check-planning.test.mjs`: valid graph, duplicate/cycle, uncovered requirement, invalid ready dependency, and range-expansion tests.
- Root command: `pnpm check:planning`.
- Command reference and scaffold script include the new command.

## Evidence

Passed:

- `pnpm check:planning`
  - 5 checker tests passed.
  - 104 leaf tasks parsed.
  - 84 requirements parsed and traced.
  - 262 explicit task dependencies validated.
  - 1 current in-progress queue task validated after `FND-V1-014` closure.
  - No unknown reference, dependency cycle, uncovered requirement, or invalid ready state.
- `pnpm lint`
  - 115 files checked.
  - Package exports for 8 current packages passed.

## Limits

- The checker validates structural and graph truth, including that `todo` work still has an unfinished dependency. Human review still owns whether a dependency or success criterion is semantically sufficient.
- Markdown task tables are an intentional repository contract; malformed table shape fails parsing rather than being silently ignored when it matches an owned task header.
