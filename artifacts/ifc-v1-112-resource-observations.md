# IFC-V1-112 Resource Observations

Resolves the gap between what `docs/planning/04-technical-plan.md` claimed about resource
observability and what the code actually emitted.

## Problem

The plan gave all 99 entries in `resourceBudgetSchema` a `hostdeck.resource.<key>` observation
name. That string appeared in exactly three places in source — `resource-policy.ts:46`, `:68`,
and its contract test — and nowhere else. Nothing emitted.

Separately, `hostDeckFastifyResourceSnapshot` (`fastify-app.ts:255`) had been tracking five
real breach counters all along — aborted, in-flight, header-count-rejected,
overload-rejected and timed-out requests — but **no production code called it**. The counters
existed and were unreachable.

## Change

- The foreground serve snapshot now carries `resources`, read from the owning Fastify instance
  through the lifecycle. The reader never throws: these are diagnostic values and a snapshot
  must not fail because of them. A listener not owned by the app factory yields `null`, which
  is the truthful answer rather than a fabricated zero.
- The technical plan now states what is actually true: the `hostdeck.resource.<key>` names are
  a declared vocabulary, not a live telemetry feed; five real breach counters are emitted
  through the serve snapshot, and the remaining keys carry no runtime counter.

## Why the rest is deferred rather than implemented

The task allowed either emitting every declared observation or recording the deferral. Wiring
94 further counters has no consumer today: there is no metrics endpoint, no scrape target, and
no operator surface that would read them. Adding them would be unverifiable code whose only
test would assert that a number it just incremented went up.

The honest position is that the budget's *enforcement* is already well tested — the breach
families `request_too_large` (413), `rate_limited` (429), `service_overloaded` (503) and
`operation_timeout` (504) all have real failure paths and coverage — while its *observation*
layer is a vocabulary awaiting a consumer. The plan now says that, so the claim and the code
agree.

## Evidence

- A regression asserts `resources` is present on the serve snapshot and, when non-null,
  carries exactly the six expected keys.
- `pnpm check:planning` passes with 23 machine-checked technical-plan facts, including the
  99-limit count that this change did not alter.
- Unit 3,238 passed with 32 skipped, contract 297, typecheck, lint over 901 files.

## Limits

- Five of 99 declared observations are emitted. The other 94 remain a vocabulary.
- The counters are reachable from the serve snapshot only; no CLI command renders them yet.
  `IFC-V1-111` established that path for diagnostics, and the same seam would carry these.
