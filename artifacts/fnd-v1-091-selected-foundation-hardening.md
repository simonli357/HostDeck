# FND-V1-091 Selected Foundation Hardening

Date: 2026-07-09

## Scope

Aggregate hardening for `BLK-V1-01`: normalized app-server/mobile/security contracts, strict core invariants, deterministic fixtures, planning integrity, cross-package schema use, and generated-protocol isolation.

This closes the contract/core/fixture block only. Production storage, Codex adapter, server, and React adoption remain owned by Blocks 02 through 05.

## Foundation Matrix

| Area | Normal | Boundary / invalid | Repeated / concurrent |
| --- | --- | --- | --- |
| Timestamps | Canonical UTC and RFC 3339 offsets normalize to UTC. | Invalid calendar day, leap day, offset, and format reject. | Parse/serialize returns one canonical UTC value. |
| Cursors/counts | Zero and safe max parse; bounded selected counts use shared schemas. | Negative, fraction, and unsafe integer reject. | Duplicate/out-of-order event cursors reject; transactional append concurrency remains `DAT-V1-020`. |
| Lifecycle | Normal start/archive and reconciliation recovery tables are separate. | Normal stale/incompatible/unknown transitions reject. | Explicit same-state idempotency is deterministic; archived writes fail eligibility. |
| Errors/outcomes | Bounded true causes and success records parse. | Secret/unbounded details, contradictory progress, and result/error pairs reject. | Audit trails permit one pending acceptance or one terminal path; duplicate records/identity drift reject. |
| Target identity | Session, approval, turn, device, and host targets are discriminated. | Missing, extra, mismatched, and action-incompatible targets reject. | Stable operation/action/target/actor identity is required across audit phases. |
| Capability state | Required and optional capabilities plus mutation policy are explicit. | Required drift is incompatible; unknown/unavailable controls cannot appear available. | Optional degradation preserves proven required mutations and read-only utilities. |
| Schema drift | Known normalized events and selected view models parse. | Unknown required fields reject. | Explicit `unknown_optional` events remain bounded and non-healthy. |

## Cross-Package Evidence

- `packages/test-fixtures/src/foundation-boundary.contract.test.ts` scans TypeScript import/export specifiers in every package and rejects generated Codex protocol imports outside `packages/codex-adapter/`.
- The same test parses all selected runtime fixtures in 32 concurrent passes and proves source fixtures are unchanged.
- Public exports pass `scripts/check-package-exports.mjs`; generated Codex bindings do not appear in core, contracts, storage, server, web, CLI, or fixture imports.
- Nine contract-test files cover selected schemas plus existing API/storage/UI cross-package compatibility.
- Structured runtime fixtures cover every `SFR-011` case. Mobile fixtures add paired-write, paired-read-only, lock, certificate, permission, degraded capability, disconnect, incompatible, and replay-boundary behavior without raw phone input.

## Manual Inspection

- Found and fixed a matrix mismatch: strict timestamps accepted only `Z`, while the test plan required RFC 3339 offsets. Offsets now validate their written calendar fields and normalize to UTC.
- Confirmed unknown, stale, disconnected, incompatible, rejected, failed, and incomplete states never parse as ready/succeeded equivalents.
- Confirmed selected operation and mobile schemas contain no raw terminal input or blind slash injection.
- Corrected stale block wording that implied production consumers had migrated; those adoption gates remain visible in `DAT-V1-018`, `INT-V1-003`, `IFC-V1-016`, and `FE-V1-004`.
- No hidden fallback, generated-type re-export, mutable fixture state, or duplicate terminal audit path was found.

## Validation

- `pnpm check:scaffold`: passed, 8 packages and 13 root scripts.
- `pnpm typecheck`: passed.
- `pnpm -r --if-present typecheck`: passed for all 8 package typecheck scripts, including the Node-scoped boundary test.
- `pnpm lint`: passed, including package-export validation.
- `pnpm exec vitest run --reporter=dot`: passed, 33 files plus 1 skipped; 211 tests passed and 1 skipped.
- `pnpm test:contract`: passed, 9 files and 104 tests.
- `pnpm test:integration`: passed, 15 tests.
- `pnpm test:web`: passed, 14 tests.
- `pnpm check:planning`: passed before completion-matrix advancement.
- `git diff --check`: passed.

## Remaining Gates

- Real generated binding regeneration/schema checksum/version negotiation: `INT-V1-003`.
- Transactional concurrent cursor assignment, retention, audit persistence, and crash completion: `DAT-V1-018`, `DAT-V1-020`.
- Production route/auth/origin/rate/approval-response concurrency: `IFC-V1-016` onward.
- Complete mobile interaction state matrix, approved mockups, implementation, screenshots, and phone evidence: `FE-V1-004` onward.
