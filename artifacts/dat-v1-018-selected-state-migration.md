# DAT-V1-018 Selected Runtime State Migration

Date: 2026-07-09

## Outcome

- Added additive migration `202607090006_selected_runtime_state` without modifying historical migration SQL or reinterpreting legacy rows.
- Added durable selected session mappings, projections, projected events, runtime compatibility, session-start recovery, and explicit legacy disposition tables.
- Added `SelectedStateRepository` and `RuntimeCompatibilityRepository` public storage APIs.
- Kept legacy `sessions` rows separate; migration and insert/update triggers classify every old or newly created tmux row as `legacy_unmigrated` with no selected mapping.

## Durable Invariants

- HostDeck session id, alias, Codex thread id, and selected projection identity must agree across mapping and projection rows.
- Codex thread id, creation time, and completed archive state are immutable.
- Generic state replacement requires an optimistic mapping/projection/cursor revision and cannot rewrite event or retention state.
- Replacement revisions must advance both durable timestamps, preventing equal-time metadata overwrites from preserving a stale revision token.
- Event insert and projection advancement share one immediate SQLite transaction.
- Committed event cursors are contiguous; stale projections, skipped cursors, duplicate cursors, and duplicate non-null Codex event ids reject.
- Stored event JSON, indexed columns, exact UTF-8 byte length, retained count/bytes, and earliest/latest cursors must agree on replay or before mutation.
- A retention gap is visible only through a first retained `replay_boundary` event; missing retained history fails loudly.
- Recovery records start `reserved`, reserve unique session/alias/thread identity, cannot claim persistence before matching selected state exists, follow explicit transitions, and survive restart until deleted after resolution.
- Compatibility JSON and indexed state agree; immediate transactions serialize writers, while invalid input, column drift, older results, and conflicting equal-time results reject.

## Migration Evidence

- Fresh databases apply all six migrations and create the complete selected table/index/trigger set.
- Fixed SHA-256 assertions protect every published migration from 001 through 005 against source drift.
- Databases at migration 005 apply only migration 006 and classify existing tmux rows without creating selected sessions.
- Post-migration legacy inserts are classified automatically by a database trigger.
- A prior row that cannot satisfy the new explicit legacy contract causes migration 006 to roll back entirely; historical schema and five applied migrations remain intact.
- Existing legacy repository, retention, auth, settings, restart, and migration tests continue to pass.

## Repository Evidence

- Create/list/get-by-thread/replace/restart paths preserve stable Codex identity.
- Duplicate alias/thread/session constraints map to typed repository errors.
- Two SQLite connections reading the same projection prove stale writer rejection after one commits.
- Event/projection rollback is proven for stale counters and duplicate upstream event identity.
- Replay boundary, empty/future replay cursor, column/JSON corruption, and missing retained event cases fail or report truncation explicitly.
- Numeric and unknown-cursor replay boundaries persist without conflating a nullable prior cursor with contiguous history.
- Read/restart tests cover ready and degraded compatibility plus optional capability state.
- Hostile persisted mapping/version/event/compatibility drift fails at SQL or contract reload boundaries.

## Manual Inspection

- Corrected a migration draft that briefly touched historical base SQL; final diff adds migration 006 only, preserving all prior checksums.
- Added legacy insert/update triggers after finding that legacy rows created after migration would otherwise lack disposition.
- Replaced monotonic-only cursor validation with contiguous cursor assignment so gaps cannot appear without a boundary.
- Added optimistic state revisions after finding generic replacement could otherwise lose a concurrent projection update.
- Separated ordinary metadata/lifecycle replacement from event and retention state mutation.
- Added stale compatibility-result rejection and chronology checks for mappings, projections, events, archives, activity, and recovery records.

## Validation

- `pnpm check:scaffold`: passed, 8 packages and 13 root scripts.
- `pnpm typecheck`: passed.
- `pnpm -r --if-present typecheck`: passed for all 8 package typecheck scripts.
- `pnpm lint`: passed, including package-export validation.
- `pnpm exec vitest run --reporter=dot`: passed, 35 files plus 1 skipped; 227 tests passed and 1 skipped.
- Storage suite: 11 files and 71 tests passed.
- `pnpm test:contract`: passed, 9 files and 104 tests.
- `pnpm test:integration`: passed, 15 tests.
- `pnpm test:web`: passed, 14 tests.
- `pnpm check:planning`: passed before task advancement.
- `git diff --check`: passed.

## Remaining Ownership

- Production retention invocation, pruning/reset transaction, accepted/terminal audit persistence, and crash completion remain `DAT-V1-020`.
- Runtime-generated binding identity and live capability negotiation remain `INT-V1-003` onward.
- State/runtime directory permissions and daemon lease remain `DAT-V1-019`.
- Legacy tmux table/code removal or explicit final deferral remains `INT-V1-008`.
