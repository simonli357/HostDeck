# INT-V1-005 Managed Thread Lifecycle

Date: 2026-07-09

## Scope

Implement the first selected-runtime thread vertical: normalized start/list/read/archive calls, durable HostDeck mapping and recovery, and exact laptop TUI resume over the same private Unix socket.

## Harsh Success Criteria

- Reserve the HostDeck operation before dispatch and never repeat an ambiguous `thread/start`.
- Recover a pre-id unknown result only from bounded loaded-thread enumeration plus exact marker/cwd reads.
- Persist the returned Codex thread id before any later mutation can make the thread durable.
- Return success only after the exact thread is stored, named, goal-clean, readable, mapped, and TUI-resumable.
- Treat HostDeck's durable mapping as post-materialization ownership; reject arbitrary import and identity mismatch.
- Archive one exact mapped thread, distinguish unknown/remote-success/local-failure outcomes, and reconcile safely.
- Bound pagination, exact recovery reads, payload text, deadlines, TUI process lifetime, and cleanup.
- Prove the installed Codex boundary without a model turn, fake terminal output, public listener, or leaked auth material.

## Runtime Findings

Verified against exact `codex-cli 0.144.0`:

1. Generated `ThreadHistoryMode` advertises `paginated`, but `thread/start` rejects it with unsupported `paginated_threads`; V1 must use explicit `legacy` history for this binding.
2. A zero-turn legacy `thread/start` is loaded in memory but absent from stored `thread/list`; exact TUI resume rejects it because no rollout exists.
3. `thread/name/set` and `thread/metadata/update` do not materialize the rollout. `thread/goal/set` does; immediately clearing the internal marker leaves the final user goal empty.
4. The loaded start response reports session source `vscode`, not `appServer`, for this app-server client.
5. The operation `threadSource` exists while loaded but becomes `null` after legacy rollout persistence. It is valid for pre-id recovery only, not permanent ownership.
6. Official app-server documentation exposes `thread/loaded/list` specifically for in-memory thread ids; the selected recovery path combines that bounded list with exact `thread/read` validation.

Decision: `DEC-022`. Detailed sequence: `docs/planning/04a-implementation-blueprint.md`.

## Implementation

- `@hostdeck/codex-adapter`
  - Added strict normalized thread records and request/response validation.
  - Added bounded active/archived and loaded-thread pagination, cursor-cycle/duplicate detection, and exact-read caps.
  - Added operation-marker recovery across stored and loaded-only threads.
  - Added idempotent legacy materialization: conflict check, name set, internal goal set/clear, stored/read/name/goal verification.
  - Added shell-free immutable `codex resume --remote unix://... <thread-id>` command construction using the transport's socket validator.
  - Expanded required lifecycle capabilities with `thread/loaded/list` and `thread/name/set`.
- `@hostdeck/server`
  - Added a durable reserve -> thread-created -> persisted start saga over real SQLite state ownership.
  - Persists the returned id before materialization and resumes partial phases without redispatch.
  - Rejects duplicate aliases, conflicting operations, ambiguous markers, arbitrary runtime identity, and unsafe archive retries.
  - Reconciles exact mappings, archived state, stale/missing threads, and confirmed-remote/local-persistence failure.
- Real smoke
  - Uses a mode-`0700` temporary runtime/home/repository and mode-`0600` auth copy without parsing or logging credentials.
  - Uses isolated tmux only as a terminal emulator to inspect the real TUI; production remains app-server based.
  - Aggregates lifecycle and cleanup errors, kills the TUI/app-server, and removes the temporary tree.

## Failure Matrix Covered

- Invalid cwd/request/name/id, duplicate alias, operation-input conflict.
- Known-unsent start failure, unknown start outcome, unique loaded recovery, duplicate marker conflict.
- Recovery-id persistence failure semantics, partial/unknown/rejected materialization, mapping/finalization failure.
- Missing/wrong-source/wrong-cwd runtime identity and unmanaged thread isolation.
- Active/approval/input/system-error projection, missing/stale reconciliation, archived repair.
- Duplicate/concurrent archive, unknown archive gate, confirmed remote archive with local write failure.
- Malformed payload/status/goal/archive acknowledgement, duplicate ids, cursor cycles, page/read bounds.

## Validation

- `pnpm install --frozen-lockfile --offline`
- `pnpm check:scaffold`
- `pnpm check:planning`
- `pnpm check:codex-bindings`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm test:unit`
- `pnpm test:contract`
- `pnpm test:integration`
- `pnpm test:web`
- `pnpm smoke:codex-compatibility`
- `pnpm smoke:codex-ipc`
- `pnpm smoke:codex-threads`

The installed thread smoke passed start, loaded-only marker recovery, no-model materialization, stored list/read, exact authenticated TUI resume, archive, and cleanup on a private Unix socket.

Final broad results: 367 unit tests passed with four opt-in smokes skipped, 104 contract tests passed, 15 integration tests passed, and 14 web tests passed. The three installed-Codex no-model smokes passed when run explicitly.

## Remaining Gaps

- Real turn/event/model/goal/plan/usage/compact/skills/approval/interrupt behavior remains `INT-V1-006`.
- Multi-client event integrity, app-server/HostDeck restart, and process supervision remain `INT-V1-007`.
- The internal goal set/clear materialization is exact-version behavior and must be re-proved or removed during every Codex binding upgrade.
- This completes one leaf task, not `BLK-V1-03` or V1 release readiness.

Official surface reference: <https://learn.chatgpt.com/docs/app-server>.
