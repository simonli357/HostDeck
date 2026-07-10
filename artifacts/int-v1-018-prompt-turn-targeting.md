# INT-V1-018 Prompt/Turn Targeting

## Scope

- Exact Codex 0.144.0 `turn/start` and event-gated `turn/steer` for one managed thread.
- One prompt transaction consumes the exact pending model/Plan revisions without a second turn.
- This leaf does not assemble API/audit wiring, reconnect recovery, or the full multi-control vertical; those remain owned by `IFC-V1-041`, `DAT-V1-023`, `INT-V1-027`, and `INT-V1-029`.

## Hard Success Criteria

| Area | Required proof |
| --- | --- |
| Target | Missing, mismatched, stale, archived, malformed, or non-writable session/thread identity rejects before mutation. |
| Compatibility | Missing `turn/start`, `turn/steer`, model, or Plan capability rejects without text fallback. |
| Exactly once | Per-session concurrency emits at most one start; capacity is bounded; a possible-send failure latches unknown and never retries. |
| Pending controls | Model/Plan revisions are synchronously snapshotted, non-pending phases reject, model plus Plan uses one combined path, and returned revisions must match the snapshot. |
| Start truth | Only the strict accepted response is returned; it does not claim running or steerable before a matching normalized `turn/started`. |
| Event races | Matching early start is retained, mismatched early start becomes unknown, fast terminal clears, stale initial idle does not erase acceptance, and observed active-to-terminal projection can reconcile event loss. |
| Steer | Only an exact accepted plus event-proven in-progress turn can steer; wire input includes `expectedTurnId`; steer never falls back to a second start. |
| Failure truth | Known rejection can be retried explicitly; timeout/disconnect/protocol ambiguity remains unknown; terminal evidence clears exact tracked state only. |
| Isolation | Same-session operations serialize, different threads remain isolated, and foreign events cannot acquire or clear another prompt operation. |
| Real boundary | Pinned 0.144.0 over a private Unix socket creates two managed threads, starts and steers one exact turn, emits one `turn/started`, leaves the other thread unchanged, reaches successful terminal truth, archives both threads, and removes temporary state. |

## Hardening Audit

Initial focused tests and one real smoke passed before terminal-success inspection was added. Manual hardening then found and closed these implementation gaps:

- Downstream model/Plan runtime and protocol errors now preserve their owning failure class.
- Prompt snapshots reject impossible accepted/action/timestamp combinations and are deeply frozen at the exposed object/error boundary.
- Direct turn calls reject malformed objects, extra fields, invalid signals/settings/ids, unsupported capabilities, and malformed accepted responses before false success.
- All terminal cleanup uses one path, including event-before-response and accepted-revision-contradiction races; internal active markers cannot survive visible state cleanup.
- Malformed pending readers fail as pre-wire protocol errors instead of leaking raw exceptions.
- The real smoke now requires successful `turn/completed` status with no structured error and uses only a visible mini/spark model from the exact live catalog.

## Evidence

- Focused shared-turn and prompt/model/Plan service matrix: 42 passed.
- Unit: 565 passed; 23 explicit external tests skipped by default.
- Contract: 115 passed.
- Integration: 16 passed.
- Web: 14 passed.
- Root and all-package typechecks, lint/package exports, scaffold, planning, exact binding identity, frozen offline install, production audit, and diff checks pass.
- Exact binding: Codex 0.144.0, 671 generated files, reviewed tree identity `e1a1a5cff3ab91862f9215dd06538eae1ea0b00bae48cbb7d87061faaee27e24`.
- Production dependencies: no known vulnerabilities from `pnpm audit --prod`.

## Remaining Gate

`HOSTDECK_CODEX_BIN=<exact-0.144.0> pnpm smoke:codex-prompt` reaches an accepted exact start and exact steer against two isolated managed threads, then currently receives an account-level usage-limit terminal from Codex. The stricter smoke correctly fails instead of reporting completion. Selecting a visible low-cost catalog model produced the same external result, so further model calls were stopped.

`INT-V1-018` remains in progress until the authenticated runtime can produce one successful terminal run with the exact start/steer/isolation/archive assertions and cleanup. No implementation retry or fallback is enabled. Existing `INT-V1-006` evidence remains semantic proof of the external operation, not a substitute for this implementation smoke.
