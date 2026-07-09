# UI Concepts

Owns generated visual direction options, selected direction notes, mockup references, and asset inventory.

## Gate

- Generate exactly two options: `option-a/` and `option-b/`.
- Each option needs mockups, `theme.md`, `design-system.md`, `asset-inventory.md`, and module notes when relevant.
- Store project-bound generated assets in the repo.
- Record the selected option in `docs/planning/07-decisions.md`.
- UI implementation needs approved screen-group references and screenshot/fidelity evidence.

## Structure

| Path | Purpose |
| --- | --- |
| `option-a/` | First visual direction |
| `option-b/` | Second visual direction |
| `approved/` | Selection notes and implementation references |
| `design-system-template.md` | Concise design-system checklist |

## Option Checklist

| Item | Option A | Option B |
| --- | --- | --- |
| Theme | `option-a/theme.md` | `option-b/theme.md` |
| Core mockups | `option-a/dense-operations-console-board.png` | `option-b/calm-control-room-board.png` |
| States/responsive coverage | Desktop Mission Control, phone Session Detail, host safety/trust, raw fallback | Desktop Mission Control, phone Session Detail, host safety/trust, raw fallback |
| Assets | `option-a/asset-inventory.md` | `option-b/asset-inventory.md` |
| Design-system mapping | `option-a/design-system.md` | `option-b/design-system.md` |

## FE-V1-002 Options

| Option | Direction | Mockup board | Notes |
| --- | --- | --- | --- |
| A | Dense operations console | `option-a/dense-operations-console-board.png` | Higher density, dark operator shell, strongest scan hierarchy. |
| B | Calm control room | `option-b/calm-control-room-board.png` | Lighter, quieter, phone-readable control-room framing. |

## Behavior Integrity

- These boards are visual-direction candidates, not an approved behavior spec.
- Host lock, LAN mode, pairing, and trust changes remain host-side/CLI-controlled in V1 unless a later decision changes the contract.
- Text such as "from host CLI" is guidance, not a remote dashboard action.
- UI implementation must preserve the existing contract that remote unlock and LAN mutation are rejected.

## Fidelity Evidence

| Screen/module | Reference | Implementation screenshot | Status |
| --- | --- | --- | --- |
|  |  |  |  |
