# INT-V1-026 Interrupt Control Evidence

Date: 2026-07-10

## Scope

- Interrupts one exact event-proven active Codex 0.144.0 turn for one managed session.
- Separates protocol acceptance from authoritative `turn/completed: interrupted` truth.
- Reuses selected turn targets and operation-progress contracts; it does not create archive/delete behavior or a raw terminal path.
- Does not assemble API/audit/lock wiring, reconnect recovery, or phone UI. Those remain with `DAT-V1-023`, `INT-V1-027` to `INT-V1-029`, `IFC-V1-045`, `IFC-V1-061`, `FE-V1-036`, and `FE-V1-037`.

## Hard Success Criteria

| Area | Required proof |
| --- | --- |
| Wire contract | Capability and mutation policy are available; exact input emits only `turn/interrupt {threadId, turnId}`; only an exact empty object is accepted. |
| Target | Session/thread/turn identity, confirmation, current writable projection, and matching normalized `turn/started` evidence must all agree before wire. |
| Origin | Event evidence can come from a HostDeck prompt, goal-driven turn, or concurrently attached TUI; projection status alone never invents the turn id. |
| Exactly once | Per-session serialization and bounded active-turn capacity allow one unresolved interrupt; duplicate/unknown attempts cannot send again. |
| Outcome | `{}` means accepted only. Matching `turn/completed: interrupted` is the sole success proof; completed, failed, archived, foreign, or contradictory terminal facts never become success. |
| Failure | Proven not-sent/known rejection can be explicitly retried while the same turn remains active; timeout, disconnect, or malformed post-send response becomes incomplete without automatic retry. |
| Races | Terminal and archive events arriving during the request are retained; no clock/config read after wire can misclassify an already-sent mutation as retryable. |
| Real boundary | Two managed threads, local pre-event rejection, one active exact turn, one interrupt request, interrupted terminal event, terminal retry rejection, foreign-thread isolation, no archive, and cleanup pass. |

## Protocol And State Contract

- The reviewed generated request is exactly `{ threadId, turnId }`; the reviewed response is `Record<string, never>`.
- The adapter validates operation/thread/turn/signal and timeout input before wire, checks `turn_interrupt` capability plus allowed mutation policy, sends one mutation, and rejects arrays, class instances, extra response keys, or other malformed response shapes.
- The service records normalized `turn/started` identity independently of prompt ownership. An active projection with no matching event is deliberately insufficient.
- Public state uses the existing `SelectedOperationProgress` contract with one exact turn target: `accepted`, `interrupted`, `failed`, or `incomplete`.
- Active projection states accepted for interruption are `in_progress`, `waiting_for_input`, and `waiting_for_approval`; `unknown` is not treated as writable active truth.

## Failure And Race Semantics

| Boundary | Result |
| --- | --- |
| Missing event, idle/completed projection, wrong turn | Local conflict; no wire request. |
| Missing, mismatched, stale, or archived session | Exact target error; no wire request. |
| Empty response | `accepted`; active identity remains until terminal event. |
| Matching interrupted event | Progress becomes `interrupted`; active evidence clears. |
| Matching completed/failed event | Progress becomes `failed` with bounded conflict cause; never `interrupted`. |
| Timeout/disconnect/malformed accepted response | Progress becomes `incomplete`; no retry; a later matching interrupted event may reconcile it. |
| Proven not sent or known remote rejection | Attempt state clears; an explicit retry is possible only if the same event-proven turn remains active. |
| Archive before terminal proof | Progress becomes `incomplete`; archive is never substituted for interruption. A later exact terminal event can still reconcile. |
| Second active turn before prior terminal | Protocol failure; evidence is not silently replaced. |
| Contradictory terminal statuses | Protocol failure; the first proven terminal state is retained. |

## Hardening Audit

The first deterministic implementation passed before manual production-hardening. The review then found and closed these gaps:

- Added a dedicated bounded active-turn/event gate instead of deriving a turn id from projection status.
- Reused `SelectedOperationProgress` rather than introducing a competing public state shape.
- Added goal/TUI-origin event coverage, projection-only rejection, two-thread isolation, terminal-history eviction, and contradictory-event rejection.
- Preserved early terminal and archive facts while the adapter request is in flight.
- Removed every post-wire clock read; a clock failure can no longer reopen an accepted mutation for duplicate dispatch.
- Distinguished known not-sent/remote rejection from possible-send ambiguity and blocked all automatic/duplicate retries for unknown outcomes.
- Tightened the shared turn client to require allowed mutation policy and plain JSON response objects for start, steer, and interrupt paths.
- Cleared stale event/operation state when a managed session disappears and retained bounded terminal state for later API/audit consumption.

## Real Boundary

`HOSTDECK_CODEX_BIN=<exact-0.144.0> pnpm smoke:codex-interrupt` passed repeatedly against an isolated authenticated app-server on a private Unix socket.

- Created two durable managed threads in separate temporary repositories.
- Started a long no-tools turn on thread A and proved a local interrupt rejected before HostDeck consumed matching `turn/started`.
- After consuming the exact start event, sent one `turn/interrupt` and treated `{}` as accepted only.
- Observed matching `turn/completed: interrupted`, then proved a terminal retry sent no second request.
- Read both threads back as idle and unarchived; thread B emitted no turn lifecycle event.
- Explicitly archived both threads only during cleanup, closed the connection/process, and removed temporary authentication/runtime/project state.
- Diagnostics retain bounded method/status shapes only; prompt content and runtime output are absent from this artifact.

## Host Sandbox Control

- Two exploratory command-backed interrupt probes failed before HostDeck reached `turn/interrupt`: the app-server selected bubblewrap and this host denied user-namespace setup.
- A rerun of the previously passing approval smoke failed at the same pre-callback boundary, proving this is not interrupt-service behavior.
- The exact binary still passes a direct legacy-Landlock `/bin/true` sandbox probe, while `unshare -Ur true` fails on this host.
- The final no-tools interrupt smoke avoids claiming tool/sandbox evidence it did not exercise. Resolving reproducible command-backed app-server sandboxing remains an explicit aggregate-runtime concern for `INT-V1-027`/`INT-V1-091`.

## Validation

- Focused turn-client/prompt-regression/interrupt-service matrix: 41 passed.
- Affected selected contracts: 28 passed.
- Exact interrupt smoke: 1 passed in 5.16 seconds, including 4.33 seconds of runtime assertions; repeated prior pass was 5.90 seconds.
- Unit: 611 passed; 25 explicit external tests skipped by default.
- Contract: 115 passed.
- Integration: 16 passed.
- Web: 14 passed.
- Root and all nine package typechecks, lint over 234 files, package exports, scaffold, planning, frozen offline install, and diff checks passed.
- Planning graph: 196 tasks, 84 requirements, 626 dependencies, 9 queued.
- Exact binding: Codex 0.144.0, 671 generated files, reviewed tree identity `e1a1a5cff3ab91862f9215dd06538eae1ea0b00bae48cbb7d87061faaee27e24`.
- `pnpm audit --prod`: no known vulnerabilities.

## Remaining Ownership

- `DAT-V1-023` owns durable accepted-to-terminal audit and crash outcomes.
- `INT-V1-027` owns assembled callback/event/control routing; `INT-V1-028`/`INT-V1-029` own disconnect generation and restart reconciliation.
- `IFC-V1-045` and `IFC-V1-061` own authenticated API/CLI dispatch and operation-progress exposure.
- `FE-V1-036`/`FE-V1-037` own mobile confirmation, interrupting/terminal presentation, and archive separation after visual selection.
