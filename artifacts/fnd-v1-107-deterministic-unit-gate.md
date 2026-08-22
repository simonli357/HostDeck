# FND-V1-107 Deterministic Unit Gate

Closes `BUG-093`. The unit gate now passes repeatedly under the load it actually runs on,
without inflating any budget far enough to hide a real regression.

## Problem

A clean sequential `pnpm test:unit` failed 14 tests across 11 files, every one a 5,000 ms
timeout with zero assertion failures. The same files passed 112/112 in isolation. Because
every completed task card in this repository cites a unit-suite pass as evidence, a gate
whose result depends on scheduler load undermines the evidence model itself.

Measured duration distribution before the fix, full suite, 3,261 tests:

| bucket | tests |
| --- | --- |
| over 5,000 ms | 14 |
| 4,000 to 4,999 ms | 8 |
| 3,000 to 3,999 ms | 25 |
| 2,000 to 2,999 ms | 51 |
| 1,000 to 1,999 ms | 147 |
| under 1,000 ms | 3,016 |

47 tests sat at or above 60 percent of a budget nobody had chosen.

## Cause

Two independent contributions, established separately.

**Self-inflicted contention.** No runner config set `maxWorkers`, so Vitest sized its pool
from the CPU count. This suite composes real Fastify applications and real jsdom trees
rather than mocking them, so each worker holds a large resident set and the workers
contend for memory instead of running. Measured on the 16-core host in a quiet window:

| workers | failures | wall | slowest test |
| --- | --- | --- | --- |
| default (~15) | 9 | ~245 s | 89,968 ms |
| 8 | 3 | 286 s | 62,163 ms |
| 6 | 0 | 196 s | 37,800 ms |
| 4 | 0 | 443 s | 30,667 ms |

Six is both the stable point and the fastest. Over-subscription costs more wall time than
it buys, and it inflated the slowest test by 2.4x.

**Received contention.** The development host also runs a ROS2 simulation; observed load
average reaches 36 to 48 on 16 cores. Bounding workers cannot remove load this suite does
not control. With workers capped at 6 but the implicit 5,000 ms default retained, a run at
load 33 to 43 still failed 26 tests, all timeouts, with the heaviest ordinary tests
measured at 5.0 to 6.1 s.

Verified that this was environmental rather than a regression: the ten originally failing
files passed 112/112 both with and without the review-remediation changes, and those
changes have no import reachability into them.

## Change

- `vitest.workers.ts` (new) declares `vitestMaxWorkers`, `vitestTestTimeoutMs`, and
  `vitestHookTimeoutMs` once, with the measurements above recorded inline.
- All four runner configs consume them: `vitest.config.ts`,
  `vitest.contract.config.ts`, `vitest.integration.config.ts`, `vitest.codex.config.ts`.
- `vitestMaxWorkers` is `max(1, min(6, cpus - 1))`. It is a cap, not a target: it binds
  only above seven cores, so small CI runners keep their current parallelism and timings.
- `vitestTestTimeoutMs` is 20,000, roughly three times the slowest ordinary test observed
  under load. It is declared rather than inherited, matching how this repository already
  treats its 99 runtime resource limits.
- `BUG-094`: `settleOwnedProcessGroup` waited 2,000 ms for a SIGKILLed process group to be
  reaped, hardcoded and duplicated verbatim in `service-package-verifier.ts:255` and
  `systemd-user-manager.ts:523`. Under load the kernel had not finished reaping, so the
  verifier reported `cleanup_failed` for a group that had exited. Both are now a named
  `ownedProcessGroupSettleMs = 10_000` with the rationale recorded. The poll exits the
  instant the group is gone, so the larger bound costs nothing on the happy path and only
  delays how quickly a genuinely stuck group is reported. This is a real production defect,
  not a test-only one: it would spuriously fail a service install on a busy host.

## Evidence

Two consecutive full runs after the change, on the same loaded host:

| run | load average | exit | wall | result |
| --- | --- | --- | --- | --- |
| 1 | 19.05 | 0 | 236 s | 3,229 passed, 32 skipped |
| 2 | 30.22 | 0 | 225 s | 3,229 passed, 32 skipped |

An earlier post-change run at load 33 to 43 also passed 3,229 with zero failures. Wall
time improved against the pre-change baseline despite fewer workers.

Companion suites with the same configuration: contract 287 passed across 42 files,
integration 36 passed across 21 files. `typecheck`, `lint` over 900 files,
`check:scaffold`, `check:runtime-boundary` at 638 modules, and `check:planning` with 23
technical-plan facts all pass.

## Stated limits

- Zero failures is demonstrated at load up to roughly 46, not proven for unbounded load.
- A 20,000 ms budget detects a gradual slowdown later than a tight one would. Tests that
  are heavy by nature already carry their own longer per-test timeouts, and a pathological
  test still fails. Guarding against gradual drift belongs in duration tracking rather than
  in a timeout tuned so tightly that unrelated load decides the result.
- Three tests remain genuinely heavyweight and are unrelated to assertion overhead:
  `selected-session-read-repository.test.ts` seeding 4,096 real SQLite rows,
  `connection-state.test.ts` driving a 4,096-session inventory, and
  `codex-runtime-lifecycle-acceptance.failure.test.ts`. They carry their own budgets.
- `settleOwnedProcessGroup` is still duplicated between the two CLI modules. Consolidation
  belongs to `FND-V1-103`, not here.
