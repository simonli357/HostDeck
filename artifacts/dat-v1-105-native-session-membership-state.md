# DAT-V1-105 Native Session Membership State

- Added forward-only migration `202608120020_native_session_membership` with one immutable adopted-session membership table and `session_adopt` / `session_unmanage` audit actions.
- Adoption validates exact membership identity, one cursor-1 adoption boundary, bounded terminal message/turn history, contiguous cursors, event bytes, projection aggregates, quiet initial state, and recovery conflicts before one immediate transaction commits any row.
- Confirmed unmanage requires a current active adopted session in a quiet terminal turn state, checks the complete durable revision, and deletes only HostDeck mapping/projection/events/recovery/membership rows through one transaction and foreign-key cascades.
- Prior audit JSON bytes, indexes, triggers, migration checksums, cross-platform cwd behavior, and native SQLite crash/upgrade boundaries remain covered. Accepted-only adoption reconciles to explicit `activation_pending`; accepted-only unmanage reconciles incomplete without invented success.

## Validation

- `pnpm exec vitest run packages/storage/src --maxWorkers=1` passed.
- `pnpm --filter @hostdeck/storage typecheck` passed.
- `pnpm typecheck` passed.
- `pnpm check:runtime-boundary` passed: 634 production modules, 23 externals.
- `pnpm check:planning` passed: 275 tasks, 94 requirements, 767 dependencies, 5 queued before task closure.
- `pnpm exec biome check` passed for all changed storage sources and tests after formatting.

No Codex protocol request, transcript-copy table, phone UI, dependency, setup, or command behavior changed in this leaf.
