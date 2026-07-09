# Option B Asset Inventory

| Asset | Path | Source | Notes |
| --- | --- | --- | --- |
| Calm control room mockup board | `assets/ui-concepts/option-b/calm-control-room-board.png` | Built-in `image_gen` on 2026-07-09 | Covers desktop Mission Control, phone Session Detail, host safety/trust, and gated raw fallback. |

## Coverage

- Mission Control: attention-sorted sessions, needs input, needs approval, failed, unknown, stale, idle, locked, LAN disabled.
- Session Detail: phone framing, recent output, prompt composer, slash controls, read-only/locked disabled state.
- Host safety/trust: trusted, locked, LAN disabled, tmux/storage/stream health.
- Raw fallback: advanced, confirmation-gated, visually secondary.

## Behavior Notes

- Mockup labels that mention host-side changes are guidance only.
- Do not implement remote unlock, remote LAN mutation, remote pairing/trust mutation, or host-control mutation from this visual direction.
- Implement locked and LAN-disabled dashboard states as passive/disabled states backed by existing API/CLI contracts.
