# Option A Design System

## Theme

- Mood: dense operations console.
- Product fit: high-density session triage for many Codex sessions.
- Must avoid: decorative dashboard chrome, terminal-first layouts, and hidden safety states.

## Tokens

| Token | Value | Usage |
| --- | --- | --- |
| Color | Charcoal, near-black, off-white, amber, red, green, cyan, violet | Dark operator shell with vivid state accents. |
| Type | Compact system UI, tabular numeric metadata | Session rows, counters, ages, health metrics. |
| Space | 4px to 12px inner rhythm | Dense row groups and stable toolbar controls. |
| Radius | 4px to 8px | Rows, cards, status chips, panels. |
| Shadow | Minimal, mostly borders and glow accents | Avoid decorative depth; use contrast for hierarchy. |

## Layout

| Surface | Grid/spacing | Responsive notes |
| --- | --- | --- |
| Mission Control | Sidebar plus dense table/list; attention filters above rows | Desktop-first overview, phone should collapse into session cards. |
| Session Detail | Phone-first vertical stack | Recent output, composer, slash controls, then secondary tabs. |
| Host Safety | Horizontal status band | Preserve locked/LAN/trust visibility near the top. |
| Advanced Raw Fallback | Explicit modal/panel | Requires warning, confirmation, and advanced framing. |

## Components

| Component | States | Rules |
| --- | --- | --- |
| Button | Default, hover, active, disabled | Icon plus short label where useful; disabled must stay visible. |
| Input | Empty, focused, filled, disabled | Composer shows disabled reason before write attempts. |
| Session row | Needs input, needs approval, failed, unknown, stale, idle | Attention sort first; status chip plus recent output cue. |
| Safety chip | Trusted, read-only, locked, LAN disabled, healthy/degraded | Signal color with concise label and icon. |
| Raw fallback panel | Hidden, warning, confirmation required | Never visually primary; warning and typed confirmation are mandatory. |

## Assets

| Asset | File | Usage |
| --- | --- | --- |
| Option A mockup board | `dense-operations-console-board.png` | Visual-direction reference for human selection and later UI implementation. |

## Fidelity Rules

- Preserve row density, state color hierarchy, and safety visibility if this option is selected.
- Keep desktop Mission Control information-dense without making phone controls cramped.
- Treat any "from host CLI" guidance as passive help text; dashboard implementation must not add remote unlock, LAN mutation, pairing mutation, or host-control mutation.
- Use mockup as a target after human approval; record any drift in later UI-fidelity artifacts.
