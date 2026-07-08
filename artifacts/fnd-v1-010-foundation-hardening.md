# FND-V1-010 Foundation Production-Hardening Pass

Date: 2026-07-08

## Target

- Harden `BLK-V1-01` foundation contracts before storage, tmux, API/CLI, and web implementation consume them.
- Scope: `@hostdeck/core`, `@hostdeck/contracts`, `@hostdeck/test-fixtures`, and fixture-backed contract/unit tests.
- Out of scope: real tmux, SQLite, server routes, CLI commands, browser UI, packaging.

## Harsh Success Criteria

- API output responses reject events from any session other than the response `session_id`.
- Host/network contract state rejects contradictory LAN truth, such as LAN bind mode with `lan_enabled: false`.
- UI trust view models reject every inconsistent state/flag combination for trusted write, trusted read-only, locked, unpaired, expired, revoked, and permission-denied states.
- Mission Control contracts reject unsorted cards when `attention_sorted` is true.
- UI card contracts reject enabled write controls for non-running lifecycle states.
- Output response cursors reject non-advancing replay boundaries, out-of-order events, and `next_cursor` values behind event cursors.
- Storage settings reject contradictory LAN bind configuration.
- Audit records reject dashboard actors without client identity/permission, system actors with client identity, and session write actions without a selected session.
- Classifier fixture coverage proves unknown text stays unknown, test failures remain failures, and explicit zero-failure wording is not misread as failed.
- All changes have direct unit or contract tests and pass root validation commands.
- Remaining gaps are explicit and belong to later blocks, not hidden as foundation readiness.

## Initial Gaps Found

- `sessionOutputResponseSchema` validated each event but did not enforce that all events matched the response `session_id`.
- `hostStatusResponseSchema` and `networkStateResponseSchema` allowed bind/LAN contradictions.
- `uiTrustStateViewModelSchema` allowed some impossible state combinations, for example `trusted_write` without enabled write controls.
- `uiMissionControlViewModelSchema` trusted the `attention_sorted` flag without checking card order.
- `uiSessionCardSchema` could accept an enabled write control on stale/stopped/crashed/unknown lifecycle states.
- `classifyCodexOutput` treated any `failed` wording as a test failure, including explicit zero-failure phrases.
- Output response cursors did not prove monotonic event order or that `next_cursor` covered returned events.
- Stored settings could represent LAN bind mode while `lan_enabled` was false.
- Audit actor records could omit dashboard client identity or omit session ids for session write actions.

## Manual AI Inspection Plan

- Review schemas for hidden fallback or fake success states after patching.
- Review fixture ordering and state flags against the requirements matrix.
- Confirm that added refinements fail loudly through Zod rather than normalizing invalid state.

## Validation

Passed:

- `pnpm install --frozen-lockfile`
- `pnpm check:scaffold`
- `pnpm typecheck`
- `pnpm -r --if-present typecheck`
- `pnpm lint`
- `pnpm test`
- `pnpm test:unit`
- `pnpm test:contract`
- `git diff --check`

Observed results after hardening:

- Unit tests: 6 files, 43 tests passed.
- Contract tests: 4 files, 35 tests passed.

## Manual AI Inspection

- Reviewed schema refinements for hidden normalization or fallback behavior; invalid state now fails Zod parsing instead of being corrected.
- Reviewed fake Mission Control fixture ordering against `attentionPriority`; the fixture now lists failed, approval, input, then unknown attention.
- Reviewed classifier order so explicit failures still win over pass markers, while zero-failure wording with pass markers remains success.
- Reviewed scope against `BLK-V1-01`; real tmux, SQLite persistence, API route execution, CLI behavior, browser rendering, and release packaging stay in later blocks.

## Remaining Gaps

- No remaining `BLK-V1-01` hardening gap found in this pass.
- Downstream V1 proof still requires storage/auth/audit implementation, tmux/output implementation, API/CLI implementation, UI mockups and screenshots, and release readiness evidence.
