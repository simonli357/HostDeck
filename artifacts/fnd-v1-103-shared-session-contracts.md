# FND-V1-103 Shared Session Contracts

Status: passed

## Result

- Added a strict native Codex UUIDv7 identity alongside the historical opaque Codex id; public targets accept exactly one native UUID or internal `sess_...` id.
- Added strict tracked-session, loaded-root eligibility, standard Unix endpoint, automatic membership, bounded enrollment/history, and catalog reset/upsert/remove/ready/boundary contracts.
- No-rollout threads remain explicit `pending_materialization` candidates. Per-thread event/count/byte/time/retry limits are selected resource budgets and flow into immutable adapter options.
- Public endpoint and boundary diagnostics reject paths, credentials, controls, unknown fields, contradictory states, buffer mismatch, overflow, silent loss, and projection identity drift.
- Historical adopted membership remains parseable without weakening automatic UUIDv7 enrollment.

## Validation

- Contract: 43 files, 304 tests passed.
- Unit: 284 files passed, 30 intentional external skips; 3,230 tests passed, 32 skipped.
- Root typecheck passed.
- Selected-runtime boundary passed: 639 production source modules and 24 external modules.
- Focused formatting, resource-policy, fixture concurrency, overflow, privacy, and identity tests passed.
