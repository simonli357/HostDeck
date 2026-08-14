# INT-V1-111 Codex 0.147 Binding

Status: passed

## Result

- Pinned `@openai/codex` and production compatibility to exact `0.147.0`.
- Regenerated 723 adapter-private protocol files with tree hash `673c02b5a758e082cb02c15f36bf4f37e88501470fd430ad232bebd754e8689c`.
- Rebased the selected request/notification catalog and all current runtime fixtures. Historical 0.144 evidence remains isolated to its explicit owners.
- Strictly handles the 0.147 notification `emittedAtMs` envelope, thread section/direct-input metadata, resume history cursors, and new user-input variants without exposing additive fields through product contracts.
- Fixed the real Unix-socket disconnect caused by rejecting the new notification envelope.

## Validation

- Real exact-binary stdio compatibility smoke passed without a model turn.
- Real exact-binary Unix WebSocket IPC smoke passed.
- Real native TUI create/close plus app-server discover/read/resume smoke passed with the unchanged native UUID and no model turn.
- Unit: 284 files passed, 30 intentional external skips; 3,235 tests passed, 32 skipped.
- Contract: 43 files and 304 tests passed.
- Typecheck, Biome/package exports, deterministic binding check, clean-environment contract, planning graph, and selected-runtime boundary passed.
