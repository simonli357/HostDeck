# INT-V1-021 Plan Control Evidence

## Scope

- Implements structured Plan/Default catalog and revisioned pending selection for one exact managed thread.
- Composes an optional pending model revision into one `turn/start.collaborationMode` request.
- Does not implement prompt routing, HTTP/CLI composition, restart rehydration, or UI.

## Proven Contract

- Catalog reads require exact Plan and Default entries, bounded unique names/modes, stable SHA-256 identity, strict payload keys, and pinned Plan capability.
- Selection is process-local pending next-turn state. It starts no turn and sends no `thread/settings/update` or slash text.
- Plan owns the outer per-session dispatch transaction. Model state is claimed first by exact revision; replacement is blocked until one accepted, known-rejected, or unknown settlement.
- A pending model overrides catalog model/effort inside `collaborationMode.settings`. Without a pending model, the exact mask preset and current model baseline resolve the settings.
- `turn/start` contains no top-level `model` or `effort` when collaboration mode is present.
- One matching `thread/settings/updated` event settles both revisions. Normalization rejects any contradiction between effective model/effort and nested collaboration settings.
- Catalog, control, event, and projection paths share one exported 160-character model-identity and 80-character effort bound, so an admitted selection cannot fail only because a downstream layer used a smaller limit.
- Plan update, plan item, or plan delta evidence is tracked separately from settings confirmation; terminal completion without plan-specific evidence remains unknown.
- Explicit Default is another pending selection applied only by a later turn.

## Failure And Race Semantics

| Boundary | Result |
| --- | --- |
| Invalid target, stale revision, active turn, catalog/capability drift | Not sent; explicit conflict/unavailable error. |
| Known remote rejection | Both controls return to pending; no success claim. |
| Timeout/disconnect or malformed mutation response | Both claimed revisions latch unknown; no retry. |
| Malformed read response | Protocol failure without a product-mutation claim. |
| Settings arrive before `turn/start` resolves | Early confirmation is retained; accepted, rejected, or unknown settlement cannot resurrect or asymmetrically revert either control. |
| Matching settings after unknown | Clears only when a changed baseline or known turn id makes confirmation distinguishable. |
| Contradictory settings | Both affected controls expose conflict. |
| Concurrent model selection after a no-model snapshot | New model revision remains pending for the following turn. |
| Archive/read or global-capacity race | No wire mutation; state/capacity is released. |

## Exact Runtime Proof

`HOSTDECK_CODEX_BIN=<exact-0.144.0> pnpm smoke:codex-plan` passed repeatedly against an isolated authenticated app-server on a private Unix socket.

The smoke proves exactly two bounded turns:

1. A visible non-current model and effort are carried only inside Plan collaboration settings; matching Plan/model/effort settings and a plan item/delta/update are observed before terminal state.
2. A later explicit Default collaboration turn emits matching Default settings.

The probe rejects a settings-update shortcut, top-level model/effort fields, literal `/plan`, extra turns, version drift, and incomplete archive/process/filesystem cleanup.

## Validation

- Focused adapter/control/event/resource tests: 64 passed.
- Unit: 539 passed; 22 external tests skipped by default.
- Contract: 114 passed.
- Integration: 16 passed.
- Web: 14 passed.
- Root and all-package typechecks, lint/export checks, scaffold, planning, exact binding identity, frozen offline install, and production audit passed.
- Exact Plan/Default smoke: passed repeatedly.

## Explicit Boundary

Exact Codex 0.144.0 has no read-only collaboration-mode endpoint. Process restart drops unapplied Plan intent and exposes mode as unknown until `INT-V1-029` rehydrates committed settings projection during reconciliation. HostDeck does not infer mode from plan text, model state, or the last request.
