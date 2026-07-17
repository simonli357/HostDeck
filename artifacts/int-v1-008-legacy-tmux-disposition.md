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

## Implementation Outcome

- Criteria commit: `2a16077`.
- Implementation commit: `d3d91c1`.
- Deleted the complete `packages/tmux-adapter` workspace package and its lockfile/server/scaffold/export wiring.
- Deleted the executable historical server path: `startup`, `host-service`, `output-reader`, `restart-reconciler`, read/write/session-control/stream routes, and their direct smoke/unit/integration tests.
- Deleted historical CLI/API-client service behavior and source commands `serve`, standalone `status`, `list`, `attach`, and `stop`. Parser/help/failure tests prove they reject before config, network, storage, or process construction.
- Replaced the Fastify lifecycle test's borrowed historical startup with a direct selected-neutral secure lease fixture.
- Added `packages/storage/src/legacy-session-repository.ts` and local CLI administration for exact `legacy status` and confirmed `legacy reset --confirm` forms.
- Added `scripts/check-selected-runtime-boundary.mjs` and root `pnpm check:runtime-boundary`; it rejects package, lockfile, dependency, export, source-import, production spawn, CLI-surface, and reset-repository drift.

## Retained Surfaces

- Published migration SQL, checksums, legacy tables/columns, contracts needed to decode those rows, and historical audit records remain unchanged. Existing rows stay `legacy_unmigrated` and cannot enter selected listings.
- Confirmed reset runs in one immediate SQLite transaction, verifies session/disposition count agreement before and after deletion, relies on declared foreign-key cascades for legacy child rows, preserves selected sessions/projections/security/global audit data, and is idempotent.
- Reset has no process port, shell call, adapter import, or target identifier. Status/reset rendering accepts exact keys and emits only disposition plus bounded counts; injected names, cwd, pane, output, commands, or private fields fail validation.
- Tmux remains only in opt-in exact Codex TUI/lifecycle test harnesses as a terminal emulator. It is absent from production packages, dependencies, exports, scripts, configuration, and source command behavior.
- Retained direct-LAN/schema contracts are separate historical migration surfaces. Their reviewed final retirement remains `IFC-V1-067`; selected server composition remains `IFC-V1-046`.

## Validation

| Scope | Result |
| --- | --- |
| Focused CLI contract | 6 passed. |
| Focused storage/local-admin/Fastify/archive regression | 18 passed; standalone Fastify lifecycle 5, local admin 7, archive 6. |
| Root and all-package typecheck | Passed across all 8 workspace packages. |
| Lint/exports and scaffold | Passed: 486 files, 8 package exports, 8 packages, 19 scripts. |
| Static/planning gates | `pnpm check:runtime-boundary` passed; planning passed with 212 tasks, 84 requirements, and 649 dependencies. |
| Unit | 1,664 passed, 26 explicit skips, 0 failed. |
| Contract | 33 files, 259 passed. |
| Integration | 14 files, 18 passed. |
| Web | 3 files, 33 passed. |
| Install/dependencies | Frozen offline install passed for the root plus 8 packages; server production tree contains no tmux adapter. |
| Production audit/licenses | `pnpm audit --prod` reported no known vulnerabilities; production licenses are permissive (`MIT`, `BSD-3-Clause`, `ISC`, `Apache-2.0`, `0BSD`, `BlueOak-1.0.0`, and permissive alternatives). |
| Exact Codex binding | The default 0.144.5 binary correctly failed the 0.144.0 gate; isolated exact 0.144.0 passed 671-file identity hash `e1a1a5cff3ab91862f9215dd06538eae1ea0b00bae48cbb7d87061faaee27e24`. |
| Selected no-model smokes | Exact 0.144.0 compatibility, Unix IPC, supervisor, and thread/TUI smokes each passed once. |

## Manual Inspection And Cleanup

- Package manifests, lockfile, package-root exports, root scripts, and production source have no executable tmux runtime path. The retained string occurrences are migration/history or isolated TUI test ownership.
- Legacy status/reset output and malformed-input tests expose no legacy identity, path, terminal content, command text, or selected-state detail.
- Process inspection after validation found zero tmux and zero ADB processes, no tmux sockets, and no HostDeck test temp roots. The only retained temp root is the intentional isolated Codex 0.144.0 toolchain.
- Two live `codex app-server` processes are children of active VS Code sessions, not HostDeck test children; they were not touched.
- No external tmux process existed during cleanup. The implementation has no capability to inspect, signal, attach to, or terminate one.
