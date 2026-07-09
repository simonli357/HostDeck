# FE-V1-002 Visual Direction Mockups

Date: 2026-07-09

## Scope

Generated two image-based visual direction/mockup sets from the approved `FE-V1-001` UI state coverage. The boards are repo-stored candidates for human selection in `FE-V1-003`; they are not yet approved implementation targets.

## Assets

| Option | Direction | Board | Supporting docs |
| --- | --- | --- | --- |
| A | Dense operations console | `assets/ui-concepts/option-a/dense-operations-console-board.png` | `theme.md`, `design-system.md`, `asset-inventory.md`, `prompt-notes.md` |
| B | Calm control room | `assets/ui-concepts/option-b/calm-control-room-board.png` | `theme.md`, `design-system.md`, `asset-inventory.md`, `prompt-notes.md` |

## Coverage

- Mission Control desktop: attention-sorted sessions, Needs Input, Needs Approval, Failed, Unknown, Stale, Idle, locked, LAN-disabled, and health/status metadata.
- Session Detail phone: recent output, output boundary, composer, disabled send state, and slash controls for `/model`, `/goal`, `/plan`, `/usage`, `/compact`, and `/skills`.
- Host safety/trust: trusted/read-only state, host lock state, LAN disabled state, tmux/storage/stream health, and passive host-side guidance.
- Advanced raw fallback: visually secondary, warning-heavy, confirmation-gated surface.

## Inspection Notes

- Option A uses a dark, dense, operator-style layout with stronger row density and high-contrast status hierarchy.
- Option B uses a lighter, calmer control-room layout with more spacing and stronger phone readability.
- Both boards were regenerated once after inspection because the first pass implied remote host mutation controls.
- The committed boards keep host unlock, LAN enable, pairing/trust changes, and host controls as passive/host-side guidance. UI implementation must preserve the V1 behavior that remote unlock and LAN mutation are rejected.
- Text such as "from host CLI" should be interpreted as help text, not a remote dashboard action.

## Validation

- Built-in `image_gen` produced the visual mockup boards.
- Manual visual inspection checked both boards for required panels, required states, phone/desktop framing, and V1 safety-contract drift.
- `identify assets/ui-concepts/option-a/dense-operations-console-board.png assets/ui-concepts/option-b/calm-control-room-board.png`
- `git diff --check`
- `pnpm lint`
