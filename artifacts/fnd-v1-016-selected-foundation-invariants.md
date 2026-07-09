# FND-V1-016 Selected Foundation Invariants

Date: 2026-07-09

## Hardening Target

Selected foundation contracts and headless rules for timestamps, cursors/counts, lifecycle reconciliation, exact operation targets, capability readiness, operation eligibility, and accepted/terminal audit outcomes.

## Strict Criteria

- Calendar-normalized but invalid timestamps reject; canonical leap dates pass.
- Cursors and unbounded count fields reject values above `Number.MAX_SAFE_INTEGER`.
- Normal lifecycle actions and reconciliation observations use separate transition tables; repeated transitions are deterministic.
- Session, approval, and turn targets are distinct strict unions; operation kind, result, and audit target identity agree.
- Missing, mismatched, starting, archived, stale, incompatible, unknown, disconnected, and unsupported targets produce one explicit denial before dispatch.
- Required capability drift blocks mutations; unavailable/unknown optional utilities remain explicit without disabling proven required operations.
- Audit state is exactly pre-dispatch rejection, accepted-pending, or accepted followed by one succeeded/failed/incomplete terminal record with stable operation/action/target/actor identity.

## Fixes

- `parseIsoTimestamp` now requires canonical `Date.toISOString()` round trip, rejecting dates such as 2026-02-29 and 2026-04-31.
- `parseOutputCursor` and shared count schemas enforce safe integers; selected and retained legacy count fields consume the shared schemas.
- Added separate normal and reconciliation transition maps for legacy and selected session states.
- Added exact approval and turn target schemas; approval request id and interrupt turn id now live inside their target identity.
- Added deterministic selected-operation eligibility with typed denial reasons and target-resolution mismatch handling.
- Added explicit runtime mutation policy independent of connection/degradation state. Degraded optional capability probes may allow proven required operations; incompatible/disconnected states cannot.
- Control availability now agrees with negotiated capability state, and Session Detail validates controls against the compatibility snapshot.
- Added audit trail validation, exact interrupt targets, same-identity phases, unique records, pre-dispatch rejection, accepted-pending, terminal success/failure/incomplete, and local CLI versus remote dashboard actor rules.
- Added read-only Mission Control and Session Detail fixtures proving prompts/risky controls stay disabled while `/usage` and `/skills` remain readable.

## Manual Inspection

- Corrected an initial over-conservative rule that blocked all writes for `degraded`, even when only an optional capability was unknown.
- Corrected mutation policy application so it does not block read-only `/usage` and `/skills`.
- Allowed accepted and terminal audit records to share a millisecond while rejecting terminal timestamps that precede acceptance.
- Verified no selected schema contains raw terminal input, blind slash injection, ambiguous multi-target fields, generated Codex protocol imports, or a fallback that converts unknown/incomplete into success.
- Legacy tmux lifecycle behavior remains isolated and explicitly separates normal transitions from restart reconciliation.

## Validation

- `pnpm check:scaffold`: passed, 8 packages and 13 root scripts.
- `pnpm typecheck`: passed.
- `pnpm -r --if-present typecheck`: passed for all 8 packages with typecheck scripts.
- `pnpm lint`: passed, including package-export validation.
- `pnpm test:unit --reporter=dot`: passed, 33 files plus 1 skipped; 211 tests passed and 1 skipped.
- `pnpm test:contract`: passed, 8 files and 100 tests.
- `pnpm test:integration`: passed, 15 tests.
- `pnpm test:web`: passed, 14 tests.
- `pnpm check:planning`: passed before task advancement, 104 tasks, 84 requirements, and 262 dependencies.
- `git diff --check`: passed.

## Remaining Ownership

- Storage transactions and repository enforcement remain `DAT-V1-018` and `DAT-V1-020`.
- Generated Codex bindings and live capability negotiation remain `INT-V1-003` onward.
- API authorization, audit persistence, rate/concurrency policy, and duplicate approval response behavior remain downstream interface/data tasks.
- Aggregate foundation matrix review is `FND-V1-091`; this task does not claim a real Codex runtime or production server path.
