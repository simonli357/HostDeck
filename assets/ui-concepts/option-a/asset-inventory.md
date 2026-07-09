# Option A Asset Inventory

| Asset | Path | Source | Notes |
| --- | --- | --- | --- |
| Dense operations console mockup board | `assets/ui-concepts/option-a/dense-operations-console-board.png` | Built-in `image_gen` on 2026-07-09 | Covers desktop Mission Control, phone Session Detail, host safety/trust, and gated raw fallback. |

## Coverage

- Mission Control: mixed attention, failed, unknown, stale, idle, locked, LAN disabled.
- Session Detail: phone framing, selected session output, slash controls, disabled write state, replay/output boundary.
- Host safety/trust: trusted, read-only, locked, LAN disabled, tmux/storage/stream health.
- Raw fallback: advanced, gated, confirmation-required.

## Behavior Notes

- Mockup labels that mention host-side changes are guidance only.
- Do not implement remote unlock, remote LAN mutation, remote pairing/trust mutation, or host-control mutation from this visual direction.
- Implement locked and LAN-disabled dashboard states as passive/disabled states backed by existing API/CLI contracts.
