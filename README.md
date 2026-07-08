# Mobile App Planning Template

This repository is a lightweight docs-first template for planning, shipping, and maintaining a mobile app with an AI coding agent such as Codex CLI or Claude Code.

Use it for native mobile apps, cross-platform mobile apps, companion apps, and internal mobile tools that benefit from a structured planning phase before implementation.

## Quick Start

1. Write a rough idea in `docs/brainstorming/00-freeform-idea.md`. One paragraph is enough.
2. Start `/plan` mode and ask your AI to refine the idea using `docs/status.md` and the stage read set in `docs/README.md`.
3. Answer the AI's recommended questions and choose from its suggested options.
4. Review the generated end-goal paragraph, roadmap, V1 planning docs, capability blocks, leaf-task backlog, and dependency queue before any product code is written.
5. Expect implementation to run from ready leaf tasks in passes: foundation first, module-by-module production hardening next, and release hardening before shipping.

## Repo Layout

- `AGENTS.md`: agent-specific rules for Codex-style agents
- `CLAUDE.md`: agent-specific rules for Claude Code
- `human.md`: human-only scratchpad that agents must ignore
- `docs/README.md`: workflow, read sets, document owners, and docs-update budget
- `docs/engineering-style.md`: reusable engineering quality standards
- `docs/status.md`: one-page current state and handoff spine
- `assets/`: generated UI concept options, selected visual direction, and product imagery
- `docs/brainstorming/`: human-owned freeform rough idea intake
- `docs/planning/`: end goal, roadmap, product, UX, technical, implementation, block specs, validation, and decision docs
- `docs/tracking/`: milestone truth, production pass tracking, dependency-aware leaf-task backlog, bug intake, and feature intake
- `docs/delivery/`: end-user, developer, and repo guides
- `docs/examples/`: optional completed examples for formatting reference

See `docs/README.md` for the workflow, read sets, and owner-only update rules.
