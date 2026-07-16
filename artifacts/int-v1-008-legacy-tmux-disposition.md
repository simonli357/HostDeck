# INT-V1-008 Legacy Tmux Runtime Disposition

## Hardening Target

- Owning block: `BLK-V1-03`.
- Decision basis: `DEC-018`, accepted structured vertical `INT-V1-027`, accepted lifecycle matrix `INT-V1-032`, and historical tmux hardening `INT-V1-090`.
- Target state: Codex app-server is the only selected product runtime. Tmux may remain only as a test-owned terminal emulator for exact Codex TUI evidence.

## Frozen Disposition

- Delete `@hostdeck/tmux-adapter`, its real/fake implementations, its package wiring, and its historical runtime smoke.
- Delete the custom tmux host startup/service, reconciliation, output-reader, read/write/session-control/stream handlers, and tests that execute those handlers.
- Remove the historical service, status, list, attach, and stop commands from the source CLI. They must fail as unknown commands until selected replacements are composed under `IFC-V1-046`; no default, injected, environment, or configuration fallback may start the old runtime.
- Keep selected CLI operations, Codex app-server supervision, Fastify primitives, selected routes, selected contracts, and exact TUI resume evidence.
- Keep published migration SQL and legacy tmux-shaped SQLite tables unchanged for forward compatibility. Existing rows remain `legacy_unmigrated`, never become selected sessions, and never cause a tmux process action.
- Add a local-only `legacy status` and confirmed `legacy reset --confirm` path. Status exposes only bounded counts/disposition. Reset transactionally deletes legacy session rows and their cascading legacy metadata/output while preserving selected sessions, selected projections/events, security state, and global audit history. It never inspects, attaches to, or terminates a tmux process.
- Retain deprecated data/API contracts and migration repositories only where still required by published migrations or later custom-listener retirement. Their final schema/export removal belongs to a reviewed later migration and `IFC-V1-067`, not this runtime task.

## Harsh Success Criteria

1. No workspace package, production dependency, package-root export, CLI default, server default, configuration key, or selected route can construct or import a tmux runtime adapter.
2. `serve`, historical `status`/`list`, `attach`, and `stop` are absent from CLI help and reject before config, network, storage, or process work. Selected start/resume/control commands remain unchanged.
3. The selected server package root exports no historical startup, host service, output reader, reconciliation, or tmux-backed route handler.
4. A prior database migrates without changing a published migration checksum; every old session remains explicitly `legacy_unmigrated` and absent from selected session listings.
5. Legacy status/reset rejects malformed or unconfirmed use. Confirmed reset is immediate-transactional, count-bounded, idempotent, preserves selected state, applies declared foreign-key behavior, and returns no names, cwd values, pane data, terminal output, or command text.
6. Reset never signals or shells out to tmux. Existing external tmux processes, if any, remain outside HostDeck ownership after the old runtime is removed.
7. Ordinary unit/contract/integration/web tests, root and package typechecks, lint/export checks, scaffold/planning checks, exact binding checks, frozen offline install, production dependency/license/audit checks, and diff/privacy inspection pass.
8. Selected no-model Codex compatibility, private IPC, and supervisor smokes still pass. Exact TUI/lifecycle tests may invoke system tmux only inside opt-in test files and must leave no tmux sockets/processes.
9. Source, package metadata, developer commands, architecture notes, status, task evidence, and dependency lockfile all describe the same boundary. No documentation advertises the removed historical service or tmux smoke as runnable V1 behavior.

## Failure Conditions

- A production package still depends on `@hostdeck/tmux-adapter` or shells out to tmux.
- The CLI can still reach the historical custom listener through normal options or dependency injection.
- Legacy rows are auto-converted, silently deleted, exposed as selected sessions, or reset without confirmation.
- Removing historical tests weakens selected app-server, Fastify, migration, or exact TUI coverage.
- The task is marked done while selected composition gaps are hidden rather than assigned to `IFC-V1-046`/`IFC-V1-067`.

## Required Evidence

- Exact deleted/retained file and package inventory with retained rationale.
- Focused legacy migration/reset and CLI boundary tests.
- Static production import/export/dependency boundary check.
- Full automated validation and selected no-model smokes.
- Manual inspection of package roots, CLI help/failure output, migration behavior, production dependency tree, process/listener inventory, and privacy-sensitive output.

## Current Gaps Before Implementation

- `@hostdeck/server` directly depends on and exports the tmux runtime.
- `codexdeck serve` defaults to the historical custom listener and tmux adapter.
- CLI status/list/attach/stop still consume tmux-shaped contracts.
- The workspace and command reference still require the historical adapter package and `pnpm test:tmux`.
- Legacy rows are classified safely, but there is no explicit local status/reset operation.
- Fastify lifecycle lease coverage borrows the historical startup and must own a selected-neutral secure lease fixture before that startup is removed.
