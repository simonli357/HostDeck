# UI Concepts

Owns generated visual-direction options, implementation-target candidates, token/component mappings, and asset inventories.

## Gate

- Two complete current sets exist: `option-a/` and `option-b/`.
- Both sets are mobile-first and consume the executable `FE-V1-004` state/interaction contract.
- The human selected Focus Rail (`option-b/`) in `FE-V1-003` under `DEC-028`.
- All seven current Option B assets are exact implementation targets; no Option A borrowing or additional structural drift is approved.
- Generated images are visual references. Typed contracts own behavior, authority, state, and final copy.

## Selected Target And Alternative

| Option | Direction | Status | Structural idea | Start inspection with |
| --- | --- | --- | --- | --- |
| B | Focus Rail | Selected V1 target | Dark grouped action queue with continuous session/event/state rails. | `option-b/mobile-mission-control-mixed.png`, `option-b/mobile-session-detail-active.png` |
| A | Signal Ledger | Unselected alternative | Bright, compact, flat attention ledger with semantic feed bands. | `option-a/mobile-mission-control-mixed.png`, `option-a/mobile-session-detail-active.png` |

Each option also includes:

- inline approval, elevated confirmation, and replay-boundary targets;
- local QR/link creation plus phone review/claim/paired states;
- locked/read-only, browser-preload failure, remote-disabled, Tailscale-unavailable, wrong-profile, and Serve-conflict states;
- structured `/model`, `/goal`, and `/plan` sheets;
- one responsive continuum covering 360, 390, 412, 768, and 1280 CSS-pixel reference widths.

See each option's `asset-inventory.md` and `design-system.md` for exact paths and component mapping.

## Rejected Legacy Boards

| Asset | Status | Reason |
| --- | --- | --- |
| `option-a/dense-operations-console-board.png` | Rejected | Desktop-led; obsolete LAN/tmux/raw-fallback concepts; no phone Mission Control; write-disabled phone detail only. |
| `option-b/calm-control-room-board.png` | Rejected | Desktop-led; obsolete LAN/tmux/raw-fallback concepts; no phone Mission Control; write-disabled phone detail only. |

Legacy boards remain only as decision history. They are not implementation targets and must not be mixed with current assets.

## Inspection Order

1. Compare the two phone Mission Control screens for scanning hierarchy and density.
2. Compare active Session Detail for conversation structure and repeated prompt ergonomics.
3. Inspect approval/boundary boards for risk hierarchy and continuity truth.
4. Inspect `/model`, `/goal`, and `/plan` sheets for the primary control workflow.
5. Inspect pairing and access/recovery boards for ownership and disclosure boundaries.
6. Inspect responsive continua to verify that tablet/desktop add context without adding routes or required actions.

## Behavior Integrity

- Mission Control and Session Detail are the only full-page product routes.
- `/model`, `/goal`, and `/plan` are structured controls, not literal prompt text.
- A browser failure before document load contains no HostDeck diagnosis.
- Unlock, remote enable/disable, Tailscale profile switching, and Serve repair remain laptop-local.
- Tailscale transport readiness never implies HostDeck read/write authority.
- QR artwork is illustrative and nonfunctional; implementation must render the fragment-safe link created by the selected pairing contract.
- Image text is not a schema. `packages/test-fixtures/src/mobile-design-contract.ts` and `artifacts/fe-v1-004-mobile-state-interaction-contract.md` remain authoritative.

## Fidelity Evidence

| Screen group | Selected target | Implementation screenshot | Status |
| --- | --- | --- | --- |
| Mission Control | `option-b/mobile-mission-control-mixed.png` |  | Awaiting implementation |
| Session Detail | `option-b/mobile-session-detail-active.png` |  | Awaiting implementation |
| Approval and boundary | `option-b/mobile-approval-boundary-states.png` |  | Awaiting implementation |
| Pairing and access | `option-b/pairing-journey.png`, `option-b/access-recovery-states.png` |  | Awaiting implementation |
| Primary controls | `option-b/primary-controls.png` |  | Awaiting implementation |
| Responsive expansion | `option-b/responsive-continuum.png` |  | Awaiting implementation |
