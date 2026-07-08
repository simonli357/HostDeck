# Engineering Style

Reusable engineering standards for implementation, review, and hardening. `AGENTS.md` owns agent behavior; this file owns durable code quality expectations.

## Code Quality

- Prefer simple, explicit code over clever abstractions.
- Keep domain/core logic independent from UI, framework, storage, and network adapters.
- Prefer typed data models and explicit contracts.
- Make invalid states impossible where practical.
- Keep modules small enough to test directly.
- Avoid broad conditional trees that hide missing design decisions; extract clear states, contracts, or strategy objects instead.

## Architecture

- Build headless contracts before UI when the product has user-facing screens.
- Keep adapters thin and replaceable.
- Put durable architecture, dependency, service, environment, and security choices in `docs/planning/04-technical-plan.md`.
- Put detailed module design, sequencing, spike results, and rollout notes in `docs/planning/04a-implementation-blueprint.md`.

## Error Handling

- Fail loudly for invalid configuration, missing credentials, schema mismatches, unsupported platforms, and impossible states.
- Do not swallow exceptions without recording the reason and recovery path.
- Do not return fake success values.
- Fix root causes instead of masking symptoms.
- Do not silently downgrade behavior unless the fallback is required, visible, documented, and tested.

## Fallbacks

A fallback is allowed only when:

- The user or system can tell it happened.
- The degraded behavior is safe.
- The fallback path has validation coverage.
- The owning planning or delivery doc records the behavior.

## Dependencies And Reuse

- Prefer mature maintained libraries, open-source packages, or proven repos for common capabilities.
- Check license, maintenance, security posture, platform support, and integration cost before adopting a dependency.
- Record task-local reuse checks in the owning task; record durable dependency decisions in the technical plan or decision log.

## Testing

- Add or update tests for changed behavior.
- Prefer unit tests for core logic and integration tests for adapter boundaries.
- Use system, E2E, visual, performance, security, packaging, or manual inspection evidence when the risk requires it.
- Every task marked done needs command output, artifact evidence, screenshot, log, or an explicit validation gap.

## Commit Rules

- Commit coherent units only.
- Stage only intended files.
- Run relevant validation before committing when practical.
- Use concise imperative commit messages.
- Prefer prefixes when useful: `[docs]`, `[fix]`, `[feat]`, `[test]`, `[refactor]`.
- Link task IDs in commit messages when the work maps to a task, for example `[fix] Resolve DAT-V1-014 asset path handling`.
- Record push blockers in `docs/status.md`.
