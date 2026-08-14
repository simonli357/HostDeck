# DAT-V1-106 Automatic Enrollment State

## Result

- Migration `202608140021_automatic_session_membership` preserves immutable historical adoption rows and adds strict automatic membership plus `session_enroll` audit storage.
- Full native UUID derivation produces injective `sess_...` ids and bounded deterministic project aliases. Existing mappings keep their internal id and alias.
- One immediate SQLite transaction creates or reuses mapping, projection, membership, and an explicit `enrollment` boundary. Existing HostDeck mappings are enrolled in place; failed writes restore their prior projection.
- Native UUID and internal id reads resolve the same state. Legacy adoption reads/unmanage behavior remains distinct from automatic membership.
- HostDeck stores only bounded normalized projection events. No transcript, rollout path, or Codex history copy was added.

## Validation

- `pnpm test:unit`: 285 files passed, 30 skipped; 3,244 tests passed, 32 skipped.
- `pnpm test:contract`: 44 files and 307 tests passed.
- `pnpm typecheck`, `pnpm lint`, `pnpm check:planning`, `pnpm check:runtime-boundary`, and `pnpm check:codex-bindings` passed.
- Focused real-SQLite coverage proves migration rollback, two-open-handle convergence, restart reload, immutable rows, historical adoption reuse, existing-mapping conversion, injected failure rollback, privacy rejection, and accepted-only audit reconciliation.

## Remaining Boundary

`INT-V1-112` owns standard-socket broker lifecycle. `INT-V1-113` consumes this transaction for loaded-thread reconciliation, bounded history materialization, and live subscriptions.
