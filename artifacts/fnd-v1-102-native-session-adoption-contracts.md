# FND-V1-102 Native Session Adoption Contracts

Status: passed

## Result

- Public contracts define bounded local discovery, exact-id adoption, non-destructive unmanage, strict native thread identity, terminal recent-turn history, adopted membership, and lifecycle audit records.
- Discovery candidates are quiet persisted root `cli` threads only. Public metadata excludes preview, rollout path, transcript, model provider, Git remote, and other unneeded content.
- Adoption requires literal `confirm_handoff: true`; history is bounded to 20 chronological terminal turns and user/agent messages only; malformed, duplicate, oversized, active, archived, ephemeral, child, fork, and invalid-cwd states reject.
- `session_adopt` and `session_unmanage` are frozen selected and persisted audit actions with local-CLI-only authority and secret-free phase summaries.
- `adoption` is a first-class replay-boundary reason. Existing Session Detail and diagnostics render it as an explicit boundary to earlier Codex-owned history.

## Validation

- Contract: 42 files, 286 tests passed.
- Unit: 278 files passed, 27 intentional external skips; 3,171 tests passed, 29 skipped.
- Web: 54 files, 940 tests passed.
- Typecheck and selected-runtime static boundary passed; boundary inventory is 634 production source modules and 23 external modules.
- Planning and whitespace validation passed.
