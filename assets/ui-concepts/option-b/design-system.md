# Option B Design System

## Theme

- Mood: calm control room.
- Product fit: readable, safe session supervision from desktop and phone browser.
- Must avoid: marketing layout, decorative visual noise, and relaxed states that look like success when unknown/stale.

## Tokens

| Token | Value | Usage |
| --- | --- | --- |
| Color | White, graphite, soft mint, teal, amber, red, blue | Light control-room base with clear safety accents. |
| Type | System UI with slightly larger row labels | Readable state labels and phone controls. |
| Space | 8px to 16px inner rhythm | Breathable cards, status rows, and phone controls. |
| Radius | 6px to 8px | Panels, chips, buttons, input fields. |
| Shadow | Subtle border-first elevation | Keep hierarchy quiet and implementation-friendly. |

## Layout

| Surface | Grid/spacing | Responsive notes |
| --- | --- | --- |
| Mission Control | Sidebar plus card/table hybrid | Desktop overview remains scan-friendly with calmer density. |
| Session Detail | Phone-first stacked panels | Output, composer, slash controls, and disabled-state explanation are prominent. |
| Host Safety | Modular status tiles | Lock, LAN, trust, tmux/storage/stream state remain visible. |
| Advanced Raw Fallback | Warning panel plus confirmation | Secondary surface with explicit risk copy and proceed gate. |

## Components

| Component | States | Rules |
| --- | --- | --- |
| Button | Default, hover, active, disabled | Disabled buttons include adjacent reason text. |
| Input | Empty, focused, filled, disabled | Composer should remain visible when writes are disabled. |
| Session card/row | Needs input, needs approval, failed, unknown, stale, idle | Use soft surfaces but strong chips for priority. |
| Safety tile | Trusted, locked, LAN disabled, storage/tmux/stream health | Tile layout should support quick inspection. |
| Raw fallback panel | Hidden, open, confirmation required | Strong red warning boundary; never primary. |

## Assets

| Asset | File | Usage |
| --- | --- | --- |
| Option B mockup board | `calm-control-room-board.png` | Visual-direction reference for human selection and later UI implementation. |

## Fidelity Rules

- Preserve calm spacing, visible disabled states, and phone-first readability if this option is selected.
- Do not let the light palette weaken failed, unknown, stale, locked, or LAN-disabled states.
- Treat any "from host CLI" guidance as passive help text; dashboard implementation must not add remote unlock, LAN mutation, pairing mutation, or host-control mutation.
- Use mockup as a target after human approval; record any drift in later UI-fidelity artifacts.
