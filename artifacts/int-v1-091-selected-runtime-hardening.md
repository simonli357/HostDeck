# INT-V1-091 Selected Codex Runtime Hardening

Date: 2026-07-16

Status: criteria frozen before implementation.

## Hardening Target

- Owning block: `BLK-V1-03`.
- Requirements: `FR-001`, `FR-003` to `FR-009`, `FR-013`, `FR-014`, `FR-016` to `FR-018`, `NFR-002`, `NFR-005` to `NFR-007`, `NFR-010`, `NFR-012`, `PR-001`, `PR-006`, `PR-007`, `PR-010`, `SFR-010`, and `SFR-011`.
- Module: generated/version-gated Codex adapter, private Unix transport and broker, managed thread/turn/control/approval/event services, runtime ownership/reconnect/reconciliation, exact TUI coexistence, and executable legacy-runtime absence.
- Production target: one selected app-server runtime module whose deterministic and exact-runtime evidence is fixed, current, machine-validated, commit-bound, privacy-bounded, and cleanup-gated.

This gate closes the runtime module only. Fastify/SSE production composition, route registration, packaged CLI, systemd units, browser, Tailscale, phone, and release acceptance remain owned by `IFC-*`, `FE-*`, and `REL-*` tasks.

## Pre-Implementation Audit

- `INT-V1-003` to `INT-V1-027` already prove generated binding identity, compatibility, private IPC, managed lifecycle, exact structured controls, approvals, event normalization/projection, and one assembled two-thread real vertical.
- `INT-V1-007` and `INT-V1-028` to `INT-V1-032` already prove foreground/service process ownership, bounded reconnect, crash reconciliation, HostDeck-only restart, exact TUI coexistence, no mutation replay, and aggregate cleanup.
- `INT-V1-008` removes the executable tmux package/service/CLI path and adds a static no-regression gate. Tmux remains only as an isolated test terminal for exact TUI evidence.
- The ordinary unit suite covers these leaves but intentionally skips exact-runtime smokes. Passing it does not prove the external boundary.
- The test plan advertises `pnpm test:codex`, but no such root command exists.
- The exact structured vertical emits an ad hoc stdout summary. It does not publish a strict exact-key report, bind its claims to a clean commit, require an absolute single-link exact-version binary, or let a parent aggregate validate cleanup and privacy mechanically.
- The lifecycle aggregate is strict and commit-bound, but it intentionally excludes the full structured-control vertical. No current command binds both accepted aggregates and the complete deterministic runtime inventory into one module-hardening result.

## Frozen Aggregate

`HOSTDECK_CODEX_BIN=/absolute/path/to/exact-codex-0.144.0 pnpm test:codex` will execute one fixed no-retry manifest from a clean commit:

| Order | Scenario | Required source | Required truth |
| --- | --- | --- | --- |
| 1 | `deterministic_runtime` | One dedicated Vitest config and JSON report for the frozen adapter/server runtime inventory | Every selected non-smoke test file runs, no test is skipped/pending/failed, and exact relative file inventory matches the reviewed manifest. |
| 2 | `exact_structured_vertical` | Hardened `codex-structured-vertical.smoke.test.ts` private report | One exact runtime/connection, two managed threads/cwds, three turns, one compact, all structured controls, one approval side effect, interrupt, TUI, durable publication, privacy, and cleanup pass. |
| 3 | `headless_reconnect_crash` | Existing lifecycle deterministic integration pair | Reconnect/backoff/cancel, approval supersession, accepted-operation incompletion, one boundary, no replay, and readmission pass. |
| 4 | `exact_supervisor` | Existing private supervisor report | Foreground ownership and service non-ownership pass without a model turn. |
| 5 | `exact_hostdeck_restart` | Existing private restart report | Active work survives HostDeck replacement; duplicate lease, boundary/resume, opposite foreground ownership, and cleanup pass. |
| 6 | `exact_tui_coexistence` | Existing private coexistence report | Two HostDeck and two TUI lifetimes preserve one managed thread, event integrity, foreign non-import, both teardown directions, and cleanup. |

The exact model budget is five turns total: three in the structured vertical and one each in restart and coexistence. The structured vertical may issue one compact operation. No scenario may be omitted, reordered, retried, replaced from caller input, or satisfied from a committed historical artifact.

## Harsh Success Criteria

| Area | Required evidence |
| --- | --- |
| Fixed deterministic scope | A dedicated config selects only reviewed adapter/runtime tests and excludes every opt-in smoke/worker. The JSON parser requires exact file inventory, positive assertion counts, all passed status, zero skipped/pending/todo/failure, bounded durations/output, and no unknown top-level/file/assertion shape. |
| Exact compatibility | The caller supplies one absolute canonical executable regular file with one link and execute permission. Parsed version must equal the reviewed 0.144.0 binding. Binding regeneration/hash check passes separately; no `PATH`, version range, schema downgrade, or alternate transport fallback is allowed. |
| Structured operations | One exact private app-server lifecycle proves managed start/read/list/archive, prompt/steer, model, goal, plan, usage, compact, skills, approval, interrupt, normalized events, durable projection/publication, two-thread isolation, and one normal TUI against the same runtime. |
| Lifecycle | Foreground child/service sibling ownership, duplicate owner, reconnect cancellation/backoff, app-server crash, HostDeck-only restart, active/approval/incomplete truth, explicit continuity boundary, multi-client TUI coexistence, and no mutation replay all have authoritative sources. |
| Invalid/boundary/repeated/concurrent/timeout | The deterministic inventory retains direct hostile schema, malformed frame/event, unsafe path/socket, capacity, duplicate/late/stale, target race, abort/timeout, partial start, reconnect, process-group, report corruption, and cleanup tests. No aggregate fake replaces those leaf matrices. |
| Machine truth | Every child emits JSON to a distinct current-owner private path. Exact-key parsers reject missing/extra/malformed/unsafe/stale/contradictory reports. Console prose, exit status alone, elapsed time, and old artifacts cannot prove semantic claims. |
| Commit identity | The aggregate starts only from a clean worktree and one full Git commit. Every exact child report names that same commit and exact runtime. A dirty tree, stale report, changed deterministic inventory, or mixed commit fails before final evidence. |
| Process ownership | Every child is a separate Linux process group with bounded argv/env/output/deadline and TERM-to-KILL cleanup. Only verified owned groups may be signaled. Timeout, output overflow, child failure, or cleanup uncertainty prevents passing evidence and does not trigger a retry. |
| Privacy | The final artifact contains only task/schema/time/commit/binding identity, bounded counts, reviewed booleans, and zero-resource cleanup. It contains no PID, path, socket/process identity, thread/turn/session/request/operation id, model/effort, prompt/objective, command, TUI text, auth, protocol payload, output, audit target, or error cause. |
| Cleanup | Passing evidence is impossible until every app-server/TUI/tmux child group is gone, every database/connection is closed, every socket/special file/report/temp root is removed, and no current-user process references the private aggregate root. Final publication is atomic to an owner-only single-link file. |
| Static selected-runtime boundary | `pnpm check:runtime-boundary` passes; no production tmux package, dependency, export, CLI path, spawn, or selected configuration reappears. Test-only TUI terminal use remains isolated. |
| Honest block boundary | Completion advances `BLK-V1-03` only. Production HostDeck listener/startup/health/SSE composition and release packaging remain explicit downstream work rather than inferred from runtime tests. |

## Failure Truth

- Wrong/missing/insecure Codex binary, schema/binding drift, dirty worktree, unsafe report path, changed test inventory, skipped test, malformed child JSON, stale commit, count contradiction, nonzero/signaled/timed-out/overflow child, or cleanup residue fails the aggregate.
- Known not-sent failures may remain retryable only where their leaf contract allows it. Possible-send ambiguity remains incomplete and is never replayed automatically.
- Unsupported controls, malformed required protocol, impossible normalized order, target/generation drift, or partial start fail loudly; no terminal text, tmux runtime, fake success, permissive compatibility, or silent repair path is introduced.
- Aggregate failure publishes no passing artifact. Cleanup errors are reported with the original failure and cannot be hidden by successful assertions.

## Implementation Plan

1. Add a dedicated deterministic runtime Vitest config and a frozen expected file inventory.
2. Add strict structured-vertical report schema/path/publication tests and harden the exact vertical to publish only after reverse cleanup.
3. Add a fixed six-scenario hardening manifest, strict deterministic/vertical/lifecycle aggregate parsers, cross-scenario invariants, owned process execution, and final private evidence publication.
4. Add root `pnpm test:codex`; keep all caller behavior overrides except the exact binary and final report path forbidden.
5. Run focused parser/manifest/failure tests, full workspace gates, exact binding/static boundary, frozen install, dependency/license/audit review, and the exact aggregate from a clean pushed implementation commit.
6. Inspect production imports/exports, child processes, sockets, tmp roots, report privacy, active handles, and retained test-only tmux references manually before closure.

## Required Evidence

- Criteria and implementation commits.
- Strict final JSON evidence bound to the clean implementation commit.
- Exact deterministic file/assertion count and zero skips.
- Exact vertical and lifecycle scenario counts, five-turn budget, privacy declarations, and zero-resource cleanup.
- Full unit/contract/integration/web/type/lint/scaffold/planning/binding/runtime-boundary/install/dependency/license/audit/diff results.
- Manual import/export/fallback/privacy/process/socket/temp inspection and explicit downstream exclusions.
