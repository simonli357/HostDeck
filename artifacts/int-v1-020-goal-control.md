# INT-V1-020 Structured Goal Control

Date: 2026-07-10

## Scope

- Runtime contract: exact `codex-cli 0.144.0`, experimental binding `codex-app-server-0.144.0-experimental:sha256:e1a1a5cff3ab91862f9215dd06538eae1ea0b00bae48cbb7d87061faaee27e24`.
- Product boundary: full goal read, passive paused set/edit, pause, agentic resume, complete, clear, optimistic revision, exact target, pending-setting guard, read-back, event reconciliation, and bounded uncertainty.
- Excluded: combined prompt/model/Plan dispatch, public HTTP/CLI/audit composition, UI, runtime supervision/restart, and release readiness.

## Implemented Boundary

- `@hostdeck/contracts` replaces the cue-only control response with full bounded goal state: objective, normalized status, token budget/use, time use, strict created/updated timestamps, and deterministic SHA-256 revision. The revision covers goal identity/control state but excludes volatile usage counters so active telemetry cannot make Pause conflict continuously. Session-list `goalCue` remains compact.
- Goal intents carry the exact observed revision. Non-set actions require a goal revision; stale or missing state rejects before mutation.
- `@hostdeck/codex-adapter` strictly parses exact goal fields and identities, normalizes status/timestamps, validates counters, and implements `thread/goal/get`, paused objective `set`, exact status `set`, and `clear` without slash or terminal input.
- `@hostdeck/server` serializes mutations per session, revalidates target/turn state after remote reads, and keeps pause separate from interrupt. Set is always paused. Replace, complete, and clear require a non-active goal and proven idle turn. Resume accepts only paused/blocked state on an idle thread.
- Agentic resume checks the shared pending-turn-setting reader. Any model or Plan setting, including conflict/unknown phases, blocks resume because goal activation cannot carry those settings.
- Resume response is `accepted`, never terminal success. Passive changes require matching response plus immediate read-back. State-proven paused/set/complete no-ops dispatch nothing.
- Possible-send timeout, malformed mutation response, or accepted-but-unverified read-back enters a bounded per-session unknown latch. Known remote rejection does not latch. Matching post-request event/read-back clears the latch; unchanged baseline stays unknown; contradictory state becomes conflict. No mutation is retried automatically.
- Global pending/uncertain capacities reserve slots before asynchronous reads or dispatch, preventing concurrent sessions from exceeding configured bounds. Missing/archived ownership releases retained state.

## Transition And Failure Matrix

| Case | Result |
| --- | --- |
| No goal + set objective | Dispatch paused goal, verify response/read-back, return succeeded. |
| Paused goal + same set/pause | State-proven succeeded no-op; no protocol mutation. |
| Active goal + pause | Dispatch paused state; current turn remains independently active until explicit interrupt. |
| Paused/blocked goal + resume, idle, no pending settings | Dispatch active state and return agentic accepted. Turn lifecycle remains event-owned. |
| Resume with active/unknown turn or pending model/Plan | Conflict before wire mutation. |
| Replace/complete/clear while goal active, or set/complete/clear while turn active | Conflict requiring pause and/or interrupt first. |
| Missing goal, stale revision, mismatched target, stale/archived session | Typed rejection before wire mutation. |
| Known remote rejection | Typed remote rejection; no unknown latch. |
| Possible-send timeout/disconnect or malformed mutation response | Unknown latch; no retry or success claim. |
| Accepted mutation but failed/mismatched read-back | Unknown/conflict latch; no passive success claim. |
| Event captured before request | Ignored for uncertainty resolution. |
| Matching post-request goal update/clear or later read-back | Uncertainty clears without rewriting the original mutation as proven terminal success. |

## Real Boundary Evidence

- Command: `HOSTDECK_CODEX_BIN=/home/simonli/.npm/_npx/b3578c5622a0f24c/node_modules/.bin/codex pnpm smoke:codex-goal`.
- Isolation: temporary mode-`0700` runtime, Codex home, and Git project; private auth copy; private Unix socket; one materialized thread; archive; connection/process/root cleanup.
- Probe policy: disposable app-server uses explicit `danger-full-access` and `never` settings because this host cannot create the default bubblewrap namespace. Production goal control never changes sandbox or approval policy.
- Assertions: paused objective response/read-back; no turn from passive set; active response and goal update; exactly one autonomous `turn/started`; explicit pause update; explicit turn interrupt/terminal event; no second goal turn; nonnegative goal usage; complete/read-back; clear/null read-back; no client `turn/start`; archive and cleanup.
- Immediate pause/interrupt can legitimately leave goal token usage at zero even though `turn/started` proves agentic activation. HostDeck validates the counter but does not infer usage from turn start; the longer `INT-V1-006` capture remains the usage-accounting evidence.
- Prompt, response, objective, model, ids, paths, usage totals, credentials, and raw protocol frames are not retained in this artifact.

## Cross-Control Review

- `INT-V1-019` now exposes one generic pending-turn-setting reader. `INT-V1-021` must contribute the Plan owner through the duplicate-owner-checked combiner.
- Goal activation checks the combined reader. It cannot silently consume or discard pending model/Plan state.
- Pause is intentionally allowed while a turn is active but does not claim interrupt. Complete/clear require an idle turn so the UI cannot present them as stop controls.

## Validation

- Focused goal adapter/service, pending-setting composition, and model-guard tests: pass.
- Exact authenticated goal smoke: pass with one autonomous turn and complete cleanup.
- Root/all-package typechecks, unit, contract, integration, web, lint/exports, scaffold/planning, exact binding, frozen offline install, production audit, and diff checks: pass.

Final suite counts and implementation commit are recorded in the owning backlog row and `docs/status.md` after the coherent implementation commit.
