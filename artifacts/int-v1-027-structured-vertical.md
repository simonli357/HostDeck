# INT-V1-027 Assembled Structured Vertical

Date: 2026-07-11

Status: blocked on the selected host Bubblewrap AppArmor profile. This artifact does not claim aggregate runtime acceptance.

## Implemented

- One connection callback now serializes selected raw notifications through the strict normalizer, durable projection append/publication, and one fixed post-commit control observer fanout.
- The fanout owns Plan/model, goal, compact, usage, approval, interrupt, and prompt observation in one explicit order. It carries one captured positive connection generation and stops on the first contradiction.
- Exact repeated thread status, name, settings, and goal snapshots normalize to bounded content-free `redundant_state` observations. They do not append duplicate activity or reach controls; true lifecycle duplicates remain fatal.
- Startup and mapping-time callbacks enter one bounded generation-tagged queue until both durable mappings and the shared pipeline exist. The queue drains in original order through that same pipeline before live callback admission; no startup frame or second normalizer is allowed.
- `smoke:codex-vertical` creates two isolated Git cwd mappings in one migrated SQLite repository and one exact private-socket app-server lifecycle. It limits the lifecycle to three low-cost minimal/low-effort turns plus one compact request.
- The aggregate requires model plus Plan composition, passive goal state, usage, two-cwd skills, command approval and side effect, exact interrupt, compact running/completed/reset evidence, thread-B isolation, live TUI coexistence, bounded proof labels, remote archive read-back, and reverse cleanup.
- Generation drift, callback/projection/control failure, terminal failure, protocol issue, extra turn, command side-effect failure, proof disclosure, timeout, and cleanup failure all fail the run. There is no sandbox or approval downgrade.

Implementation: `f8ebcfc`; callback-admission hardening: `d765855`.

## Deterministic Evidence

- Focused normalizer, pipeline, and control-fanout matrix: 30 passed.
- Repeated thread status/name/settings/goal snapshots advance connection-local sequence and redundant count, while only the first state transition commits and reaches the observer.
- Commit-before-observe ordering, exact generation propagation, first-owner failure, no later observer execution, durable truth after observer failure, stopped-pipeline behavior, unmanaged filtering, and invalid-generation rejection pass.
- Aggregate code typechecks and is skipped unless explicitly enabled. Request and proof ledgers are bounded; proof entries can contain only a static claim and one reviewed source label.

## Exact Runtime Attempts

- Runtime: `codex-cli 0.144.0`.
- Exact executable SHA-256: `134063e133f0b4244fa3b251acf973d4fe4b4aeeacbdc135211bf480f59f1477`.
- Reviewed generated binding SHA-256: `e1a1a5cff3ab91862f9215dd06538eae1ea0b00bae48cbb7d87061faaee27e24` across 671 files.
- Attempt 1 stopped in 5.9 seconds on repeated goal-clear snapshots. The captured behavior produced the explicit redundant-state correction and focused tests.
- Attempt 2 stopped in 5.4 seconds because the harness clock predated prompt dispatch. The harness now uses a nondecreasing wall clock while preserving stale-event checks.
- Attempt 3 received a durable failed terminal but waited 120 seconds because success-only polling discarded terminal evidence. Every turn/compact wait now exits on any authoritative terminal and reports its bounded durable state.
- Attempt 4 stopped in 4.8 seconds on the account runtime usage gate and proved immediate failed-terminal reporting.
- Attempt 5 replayed mapping-time callbacks instead of dropping them, then exposed an unchanged cleanup status snapshot. The generalized redundant-state rule closed that false fatal path.
- Attempt 6 stopped only on the known account gate in 6.1 seconds. It recorded 34 requests, 29 raw notifications, 15 durable publications across both sessions, 16 completed observer receipts, exactly one `turn/start`, no server request, and no protocol issue.
- The default user installation was returned to exact 0.144.0. The 671-file binding hash, installed-runtime compatibility smoke, and a fresh authenticated Plan-mode turn pass; the former account usage gate is cleared without changing the aggregate.
- Every attempt completed reverse cleanup without an aggregate cleanup error. No temporary path, thread/session/operation id, prompt, model value, usage value, or credential is retained here.

## Unproven Gates

- The final eight-source proof ledger remains incomplete because the unchanged aggregate has not been rerun after the authenticated-turn prerequisite cleared.
- Command-backed approval and its filesystem side effect were not reached. App-server startup also reports that Bubblewrap cannot create the required user namespace on this host; the strict command path must pass without policy downgrade.
- Interrupt, compact running/completed/reset, TUI coexistence, thread-B final isolation, successful archive read-back, final duration/cost counts, and complete proof-source coverage were not reached in one accepted lifecycle.
- `INT-V1-027` remains blocked on the host profile; no dependent task may treat this artifact as completion evidence.

## Validation

- Unit: 751 passed; 29 explicit external tests skipped.
- Contract: 138 passed; integration: 16 passed; web: 14 passed.
- Root typecheck, lint/package exports, scaffold, planning, exact 0.144.0 binding check, frozen offline install, production audit, and diff checks pass.
- Planning remains 196 tasks, 84 requirements, 631 dependencies, and 3 queued tasks.

## Next Acceptance

1. Install and load Ubuntu's packaged narrow `bwrap-userns-restrict` AppArmor profile without disabling the global user-namespace restriction.
2. Re-run the unchanged exact command without changing read-only/on-request policy.
3. Accept only one complete lifecycle with all eight proof sources, three turns, one compact, TUI coexistence, no disclosure, and complete cleanup.
