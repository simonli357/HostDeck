---
name: release-readiness
description: Use when preparing, auditing, or hardening a release, handoff, demo, deployable build, packaged artifact, production cut, or final delivery. Triggers include "release ready", "ship it", "handoff", "pre-release", "final validation", "deployment check", "package check", "production cut", "go/no-go", or before claiming a project is ready for users.
---

# Release Readiness

Use this skill to decide whether the current project can be responsibly handed to users, operators, or developers.

Core rule: release-ready means setup, runtime behavior, validation, docs, and known gaps are all explicit and inspected.

## Required Workflow

1. Identify the release target: demo, internal handoff, local package, hosted deployment, app store build, downloadable artifact, or production release.
2. Read:
   - `docs/status.md`
   - `docs/planning/00-end-goal.md`
   - `docs/planning/00-roadmap.md`
   - `docs/planning/05-blocks/00-index.md`
   - `docs/tracking/05-delivery-plan.md`
   - `docs/tracking/06-tasks.md`
   - validation plan: `docs/planning/04b-test-plan.md` or `docs/planning/04b-validation-plan.md`
   - `docs/delivery/08-user-guide.md` or `docs/delivery/08-usage-guide.md`
   - `docs/delivery/09-developer-guide.md`
   - `docs/delivery/10-repo-guide.md`
3. List release blockers, open hardening gaps, unvalidated assumptions, and accepted deferrals.
4. Verify clean-environment setup instructions, required config, secrets policy, local services, build/package commands, and test commands.
5. Run the release validation path or record why any step cannot run.
6. Manually inspect the primary runtime flow, failure states, generated artifacts, UI or interface behavior, and release docs.
7. Update tracking and delivery docs with evidence, known limitations, and the go/no-go result.
8. Commit and push the release-readiness update when a remote is configured.

## Release Quality Bar

- A fresh developer can set up, run, test, and build from documented commands.
- Required environment variables, secrets, services, permissions, and platform assumptions fail loudly when missing.
- Tests and manual inspection cover the primary flow, important edge cases, and expected failure paths.
- Packaging, deployment, or distribution steps are documented and validated for the release target.
- User and developer docs match shipped behavior.
- Known limitations are explicit, owned, and acceptable for the release type.
- The release target matches the active-version exit criteria or records the approved gap.

## Stop Conditions

Do not claim release readiness if:

- Setup, run, test, build, package, or deploy commands are missing or unverified.
- Required config or secrets fall back silently.
- Open production-hardening gaps are not triaged.
- Required V1 blocks lack completion evidence.
- Delivery docs are stale or aspirational.
- Manual inspection was skipped for behavior automation cannot fully prove.
- Release blockers are hidden in task notes instead of status or delivery tracking docs.
