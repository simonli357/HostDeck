# FND-V1-015 Selected-Path Contracts And Fixtures

Date: 2026-07-09

## Outcome

- Added HostDeck-owned app-server identifiers, lifecycle/turn/freshness states, required and optional capability policy, structured operation kinds, mobile attention ordering, and selected audit vocabulary.
- Added normalized runtime compatibility, managed-session identity/projection, event, approval, operation, storage, recovery, audit, and phone view-model schemas.
- Added exact managed-session/thread targets for every selected operation and exact request/turn targets for approval response and interrupt.
- Kept accepted dispatch, running progress, and terminal succeeded/failed/incomplete outcomes distinct.
- Added explicit projection capture time, upstream identity/type, content completeness/redaction/truncation notice, ordered cursor, and replay-boundary contracts.
- Added phone Mission Control and Session Detail contracts with host/access state, approval-first ordering, structured primary and utility controls, read-only diagnostics, and no raw terminal input.
- Marked superseded tmux, terminal-output, slash-injection, raw-input, storage, and desktop-led UI contracts deprecated without breaking current legacy consumers.

## Fixture Inventory

Structured runtime fixtures cover all `SFR-011` cases exactly once:

`running`, `needs_input`, `approval`, `completed`, `interrupted`, `failed`, `compacting`, `rate_limit`, `incompatible`, `unknown_optional`, `disconnect`, and `replay_boundary`.

Selected phone fixtures cover Mission Control and Session Detail loading, empty/ready, offline, incompatible, certificate, permission, stale, degraded, fatal, locked, not-found, approval, and boundary states. Contract tests reject duplicate sessions, contradictory display labels, inaccessible data leaks, writable controls on unavailable projections, and legacy raw-input keys.

## Boundary Review

- `packages/core`, `packages/contracts`, and `packages/test-fixtures` have no generated Codex protocol imports; generated bindings remain adapter-private work for `INT-V1-003`.
- Required capabilities gate readiness; unavailable optional `/usage`, `/compact`, or `/skills` behavior does not falsely make the runtime incompatible.
- Incompatible, disconnected, unknown, stale, redacted, truncated, rejected, and incomplete states remain explicit and cannot parse as ready or successful equivalents.
- Legacy contracts remain exported only for migration continuity and carry `@deprecated` markers. Their production removal or deferral remains owned by `INT-V1-008`.
- No planning, setup, dependency, or command-reference facts changed.

## Validation

- `pnpm check:scaffold`: passed, 8 packages and 13 root scripts.
- `pnpm typecheck`: passed.
- `pnpm -r --if-present typecheck`: passed for all 8 workspace packages with typecheck scripts.
- `pnpm lint`: passed; Biome and package-export checks clean.
- `pnpm test:unit`: passed, 33 files plus 1 skipped file; 193 tests passed and 1 skipped.
- `pnpm test:contract`: passed, 8 files and 92 tests.
- `pnpm test:integration`: passed, 15 tests.
- `pnpm test:web`: passed, 14 tests.
- `pnpm check:planning`: passed, 104 tasks, 84 requirements, and 262 dependencies before queue advancement.
- `git diff --check`: passed.

The unchanged real-tmux retained-suffix test repeatedly exceeded Vitest's 5-second default only in the expanded parallel suite, while its isolated rerun passed in 3.65 seconds. Its explicit test budget is now 10 seconds; the final full suite passed without changing its behavioral assertion.

## Next Hardening Boundary

`FND-V1-016` owns strict calendar timestamp round trips, safe-integer cursors/counts, explicit user versus reconciliation transitions, further target/capability invariants, and accepted/terminal audit-trail state-machine tests. This task defines those selected-path shapes but does not claim that downstream storage, adapter, API, or React consumers are implemented.
