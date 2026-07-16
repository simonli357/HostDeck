# INT-V1-032 Selected Runtime Lifecycle Acceptance

Date: 2026-07-16

Status: complete. Criteria were frozen before implementation; the aggregate evidence is bound to clean pushed commit `75843219be62587110b5fa60fed18544d6468785`.

## Scope

Accept the selected Codex runtime lifecycle as one bounded V1 system claim without rebuilding the already-complete reconnect, crash-reconciliation, HostDeck-restart, or TUI-coexistence leaves. One outer command must execute a fixed deterministic integration pair and three exact Codex 0.144.0 subprocess proofs, validate their machine truth, prove aggregate cleanup, and publish one redacted artifact from a clean commit.

This is the acceptance gate between `INT-V1-028` to `INT-V1-031` and legacy-runtime disposition in `INT-V1-008`. It is not host-service/Fastify startup composition, SSE recovery, packaging, UI, phone, Tailscale, or release acceptance.

## Pre-Implementation Audit

- `INT-V1-028` already proves generation admission, compatibility repetition, once-per-generation cleanup, equal-jitter backoff, cancellation, bounded held inbound work, approval supersession, and no mutation replay with deterministic time and a real broker/connection composition.
- `INT-V1-029` already proves durable disconnect truth, accepted-operation incompletion, approval supersession/re-registration, one continuity boundary, read-only reconciliation, no-override resume, held-event drain, model/Plan rehydration, and final write readmission against migrated SQLite.
- `INT-V1-030` already proves four HostDeck OS-process lifetimes, service-owned active-turn continuity, duplicate daemon-lease rejection, one restart boundary, exact no-override resume, and two distinct foreground children with owner cleanup.
- `INT-V1-031` already proves one exact app-server with HostDeck plus normal TUI clients, one live turn, both client-teardown directions, unmanaged-thread non-import, contiguous durable events, and private process/socket/tmux cleanup.
- Repeating those internals in a new monolithic fake would weaken the evidence. Aggregate ownership is fixed-command orchestration, child-report validation, cross-scenario contradiction checks, privacy, and cleanup.
- Existing exact restart and coexistence smokes support private report paths. The supervisor smoke must gain the same private-report contract and process-tree-safe outer cleanup before it can be aggregate evidence.

## Frozen Scenario Manifest

The outer harness runs these scenarios sequentially in separate detached process groups. Names, files, configuration, environment gates, order, and evidence source are fixed in code; callers may provide only the exact Codex binary and final report path.

| Order | Scenario | Fixed execution | Required truth |
| --- | --- | --- | --- |
| 1 | `headless_reconnect_crash` | `tests/codex-reconnect-controller.integration.test.ts` and `tests/codex-runtime-crash-reconciliation.integration.test.ts` under the integration config and JSON reporter | Two exact test files/two tests pass; reconnect/backoff/cancellation, approval supersession, accepted audit incompletion, continuity boundary, held-event drain, no replay, and readmission remain composed. |
| 2 | `exact_supervisor` | Opt-in `packages/server/src/codex-runtime-supervisor.smoke.test.ts` | Exact 0.144.0 no-model foreground child is terminated/socket removed; service-owned sibling survives HostDeck close with zero HostDeck signals and is stopped only by the smoke owner. |
| 3 | `exact_hostdeck_restart` | Opt-in `packages/server/src/codex-hostdeck-restart.smoke.test.ts` with a private temporary report | One service app-server/thread/turn survives worker A; worker B reconciles one boundary/resume and observes completion; duplicate lease fails; two foreground workers own distinct children; cleanup is zero. |
| 4 | `exact_tui_coexistence` | Opt-in `packages/server/src/codex-hostdeck-tui-coexistence.smoke.test.ts` with a private temporary report | Two HostDeck and two TUI lifetimes share one managed thread; each teardown direction preserves the peer/runtime; one foreign thread remains unimported; ordered publication and cleanup pass. |

No scenario may be omitted, reordered, retried after failure, replaced by another test file, or counted from pre-existing committed artifacts. The two model-bearing exact scenarios permit exactly one turn each; the supervisor remains no-model.

## Outer Harness Contract

- Verify the supplied Codex binary is an absolute regular executable whose parsed version equals the reviewed binding `0.144.0`. Do not search `PATH`, downgrade compatibility, or use the installed 0.144.3 default as evidence.
- Require Linux process-group ownership, a clean Git worktree, one valid full HEAD commit, one current-owner private temporary root, and a final evidence path under `artifacts/`. Refuse accessors, extra options, unsafe paths, symlinks, hard links, weak modes, or report aliasing.
- Spawn each fixed Vitest command with `process.execPath`, the resolved local Vitest entry, `shell: false`, bounded environment, detached process-group ownership, closed stdin, bounded stdout/stderr, and one scenario deadline. A failed, timed-out, signaled, or output-overflow child stops the aggregate.
- Give every scenario a distinct private `TMPDIR`. Temporary JSON reports may contain paths/test names needed for validation but are deleted with their scenario root and never copied into aggregate evidence.
- On timeout or failure, terminate only the owned child process group with bounded TERM then KILL escalation. Require the group to disappear; never signal by pattern, PID reuse guess, or unverified ownership.
- Validate the deterministic Vitest JSON report structurally: exact two files, exact two tests, zero failed/pending/skipped tests, successful status, and only the two frozen basenames. Do not infer test truth from console text.
- Validate supervisor, restart, and coexistence reports with strict exact-key parsers. Every report must identify its scenario/task, exact runtime, and current full commit; required booleans/counts must match the frozen matrix. Unknown/missing/extra keys, unsafe counts, contradictory truth, stale commit, or privacy declaration failure rejects.
- After every scenario, prove its child group is gone and its private root contains only the expected report files before owner removal. After all scenarios, prove no process command line references the outer root, no socket/FIFO/device remains under it, remove it, and only then publish aggregate evidence.

## Cross-Scenario Acceptance Matrix

| Claim | Required sources | Aggregate contradiction rule |
| --- | --- | --- |
| Exact compatibility | All three exact reports plus outer binary check | Every version and commit agree; no incompatible/downgraded mutation state. |
| Foreground ownership | Supervisor and restart reports | Every foreground child is owner-terminated and socket-cleaned; service claims cannot report HostDeck TERM/KILL. |
| Service non-ownership | Supervisor and restart reports | HostDeck closes while the sibling remains alive; only each outer smoke owner stops it. |
| Duplicate owner | Restart report plus deterministic lifecycle integration | One real lease contender loses; no second admitted generation/state owner appears. |
| Reconnect/backoff/cancel | Deterministic reconnect integration | Exact test identity passes; no exact report may show generation drift, reconnect substitution, or cleanup residue. |
| Crash and continuity | Deterministic crash integration plus restart report | Accepted work becomes incomplete where unknowable; active exact work survives HostDeck-only restart; exactly one explicit gap boundary/resume is claimed where required. |
| Approval/incomplete truth | Deterministic crash integration | Approval supersession/re-registration and accepted audit incompletion pass; no exact report invents approval or completion truth. |
| TUI multi-client | Coexistence report | Two TUI/two HostDeck lifetimes, one turn, one managed mapping, foreign non-import, and both teardown directions all pass together. |
| Event integrity | Crash, restart, and coexistence reports | No pipeline failure, duplicate terminal, replay contradiction, mutation replay, or publication-count mismatch. |
| Cleanup | Every child report plus outer inspection | All child groups, app-servers, TUI/tmux processes, sockets, database handles, runtime threads, temporary roots, and outer resources are gone. |

## Hard Success Criteria

| Area | Required evidence |
| --- | --- |
| Fixed execution | One documented root command runs exactly four scenarios and five fixed test files in order with no caller-selected file, flag, model, cwd, socket, or behavior override. |
| Process isolation | Every scenario is a separate owned process group; bounded output/deadline/TERM/KILL behavior and child-group disappearance pass on success and injected failure. |
| Machine truth | Deterministic JSON plus three strict private exact reports are parsed structurally; console text, historical artifact presence, elapsed time, and exit code alone cannot prove semantic claims. |
| Real/fake boundary | Fake time/transport proves deterministic reconnect/crash branches; exact 0.144.0 processes prove ownership, process restart, live work, and TUI concurrency. Neither substitutes for the other. |
| Mutation budget | Exactly two bounded model turns across the aggregate, no aggregate-issued runtime request, no mutation retry, no hidden rerun, and no fallback binary/transport/runtime. |
| Identity | All exact reports bind to one full clean HEAD and exact runtime. Thread/turn/process/socket identities remain private but stable relations and counts agree. |
| Lifecycle matrix | Foreground/service ownership, duplicate owner, reconnect cancellation/backoff, crash, HostDeck restart, active/approval/incomplete truth, boundaries, TUI coexistence, and final cleanup each have at least one authoritative source and no contradiction. |
| Privacy | Final artifact contains only schema/task/time/commit/version, scenario/test/turn counts, bounded message high-water, required booleans, and zero-resource counts. No path, PID, process command, socket identity, test output, thread/turn/session/request id, model, prompt, TUI text, auth, raw protocol, audit target, or error cause. |
| Cleanup | Success artifact is impossible until every child report is validated, every process group and temporary special file is absent, all temporary roots are removed, and the final report is atomically written as a current-owner `0600` single-link regular file. |
| Exclusions | No Fastify/SSE/service-install/package/UI/browser/phone/Tailscale/release claim and no dependency change. |

## Failure Truth

- A dirty worktree, wrong binary/version, malformed Git identity, unsafe output path/root/report, unavailable fixed test, changed test count/name, nonzero/signaled child, timeout, output overflow, or report parse mismatch fails before aggregate publication.
- Any child semantic failure, stale/different commit, missing cleanup proof, model-turn excess, version contradiction, duplicate/replay/publication contradiction, privacy declaration failure, or impossible count prevents passing evidence.
- Cleanup failure is a first-class aggregate failure even when every child test passed. Failure cleanup may remove only verified owned roots and signal only verified owned groups; uncertainty leaves no passing artifact.
- The harness never retries a child, reads committed prerequisite evidence as a substitute, parses human console prose for semantics, writes synthetic child reports, or downgrades an exact scenario to a fake.

## Evidence Contract

- The command writes `artifacts/int-v1-032-runtime-lifecycle-acceptance-evidence.json` only from a clean implementation commit and only after complete child and outer cleanup.
- The final schema records exact version/commit, four scenario and five test-file counts, deterministic test count, exact-process/HostDeck/TUI/model-turn counts, lifecycle claim booleans, privacy declarations, and zero remaining process/socket/root/report counts.
- Direct tests must reject every malformed/extra/missing/contradictory child report and prove failed/timeout/overflow child cleanup with harmless fixtures. Test fixtures may not invoke a model.

## Validation Plan

- Add strict report schemas/parsers for supervisor, restart, coexistence, deterministic Vitest JSON, and aggregate evidence; unit-test normal, malformed, extra-key, unsafe-count, stale-commit, contradiction, privacy, and deep-freeze behavior.
- Add an opt-in outer aggregate smoke plus fixture-driven subprocess tests for fixed argv/env, output bounds, timeout, TERM/KILL, process-group ownership, temporary-root inventory, no-retry, and no-artifact-on-failure.
- Harden the exact supervisor smoke to emit a private cleanup-complete report and own the complete wrapper/native process group without changing production behavior.
- Run focused parser/orchestrator/process tests; full unit/contract/integration/web suites; root/all-package typechecks; lint/exports; scaffold/planning; exact 0.144.0 binding; frozen offline install; production license/audit checks where available; diff/privacy/process/socket/temp/active-handle inspection; and the complete aggregate command from a clean pushed commit.
- The physical phone may remain disconnected.

## Implementation

- Added one strict aggregate schema/parser and exact child-report parsers for deterministic Vitest JSON, supervisor, HostDeck restart, and TUI coexistence truth. Exact keys, bounded counts, current commit/version, cross-scenario invariants, deep-frozen output, and privacy declarations fail closed.
- Added a fixed four-entry manifest, private path/inventory guards, and a Linux detached-process runner with bounded output/deadlines, scenario-attributed failures, owned process-group TERM-to-KILL cleanup, and no shell or retry path.
- Added the opt-in outer smoke and `pnpm smoke:codex-lifecycle`. It creates short private roots that remain within Unix socket limits, executes the five fixed test files sequentially, removes every child report/root, and atomically publishes one owner-only aggregate artifact only after complete cleanup.
- Hardened the supervisor private report and reused strict private reports from restart/coexistence. Parser and fixture regressions cover malformed/extra/stale/contradictory reports, finite high-resolution Vitest timestamps, unsafe paths/files, setup rejection, process-group descendants, output overflow, timeout escalation, and no-artifact failure.
- Aggregate validation exposed and fixed `BUG-011`: the exact TUI proof now has bounded model/tool timing, direct second-TUI resume identity, an isolated no-update test configuration, bounded readiness, and content-free diagnostics. No production runtime behavior or dependency changed.

## Validation Result

- `HOSTDECK_CODEX_BIN=/tmp/hostdeck-codex-0.144.0/node_modules/@openai/codex/bin/codex.js pnpm smoke:codex-lifecycle` passed in 91.01 seconds from clean pushed commit `75843219be62587110b5fa60fed18544d6468785`, with no retry. Four scenarios, five fixed test files, two deterministic tests, three exact scenarios, six app-server lifetimes, and exactly two model turns passed.
- The aggregate proves four HostDeck OS processes, two HostDeck connections, two TUI processes, three foreground and two service runtime lifetimes, one exact restart boundary, one no-override resume, zero coexistence pipeline/duplicate/foreign-mapping failures, equal publication/retention counts, and a 2,972,300-byte maximum inbound message.
- The final `0600` single-link artifact contains no PID, path, socket/process identity, thread/turn/session/request id, model, prompt, TUI output, auth, raw protocol/audit, or error cause. Every process, app-server, TUI, tmux socket, Unix socket, temporary root, and child-report cleanup count is zero; process and `/tmp/hd-lc-*` inspection found no residue.
- Focused lifecycle coverage passed 25 tests with one opt-in skip before exact execution. Full unit passed 1,724 with 41 opt-in skips; contract 277; integration 33; web 33. Root/all-package typechecks, lint/exports over 509 files and nine packages, scaffold, planning (212 tasks/84 requirements/649 dependencies), exact 671-file binding, frozen offline install, permissive production-license inventory, and production audit with no known vulnerabilities all passed.
- Implementation units are pushed through `27e8ea9`, `a8bee14`, `31df836`, `b0cf5a2`, `e67e263`, and `7584321`. The physical phone was not required for this headless runtime gate.

## Downstream Ownership

- `INT-V1-008` removes or explicitly isolates the legacy tmux runtime after this selected lifecycle is accepted. Test-only tmux used by the exact TUI proof does not select tmux as a product runtime.
- `INT-V1-091` performs selected-runtime module hardening after legacy disposition.
- `IFC-V1-036` to `IFC-V1-038` own application startup, health, SSE/fanout recovery, graceful drain, and installed user-service composition.
- Frontend, remote phone, packaging, security, and release acceptance remain downstream.
