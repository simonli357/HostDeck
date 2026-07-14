# Option B Design System

## Theme

- Direction: Focus Rail.
- Product fit: action-grouped mobile triage and continuity-first structured supervision.
- Density: grouped but bounded; at least two `ACT NOW` items remain visible in the first 390 x 844 viewport.

## Tokens

| Token | Reference value | Usage |
| --- | --- | --- |
| `color.canvas` | `#121313` | App background. |
| `color.surface` | `#191b1c` | Repeated item, composer, and sheet surface. |
| `color.ink` | `#f5f3ee` | Primary text and icons. |
| `color.muted` | `#a9acb0` | Metadata, disabled, and historical context. |
| `color.divider` | `#414447` | Rails, item boundaries, and control separators. |
| `color.connected` | `#45c2b1` | Remote ready, live, running, current/confirmed state. |
| `color.attention` | `#f1b43c` | Needs input, approval, pending, local action required. |
| `color.danger` | `#ff675b` | Failure, boundary break, lock, destructive confirmation. |
| `color.focus` | `#4e8dff` | User node, focus ring, selected neutral action. |
| `type.page` | 24px/30px, 700 | Compact route heading only. |
| `type.title` | 18px/24px, 650 | Session/sheet/item title. |
| `type.body` | 16px/24px, 400 | Main copy. |
| `type.meta` | 12-14px/18px, 400-600 | Role, branch, age, timestamp, state. |
| `space` | 4, 8, 12, 16, 24px | Fixed scale; no viewport-scaled type. |
| `radius` | 0, 4, 6px | 6px maximum for controls/sheets. |
| `target` | 44px minimum | Touch controls and destructive choices. |
| `motion` | Short and optional | Rail/progress change only; reduced-motion safe. |

Colors are implementation references, not sampled guarantees from the raster assets. Final contrast must pass WCAG 2.2 AA.

## Components And Visible-Element Mapping

| Visible element | Component | Token/rule mapping |
| --- | --- | --- |
| HostDeck title, back, overflow/access icons | `AppBar` | `surface`, `ink`, 56px stable height, icon-only 44px targets. |
| Remote ready / permission / live row | `HostAccessRail` | Flat status row; `connected`, text plus icon/shape. |
| `ACT NOW`, `IN PROGRESS`, `QUIET` | `MissionQueueSection` | Heading/count plus continuous section rail; no separate route. |
| Session name, cue, branch, age, status | `RailSessionItem` | Repeated item tied to semantic `StateRail`; whole item is one target. |
| User, agent, tool, progress event | `EventTimelineItem` | Continuous vertical `EventRail`, role node, label, time, bounded content. |
| `/model`, `/goal`, `/plan`, More | `PrimaryActionDock` | Three equal controls plus icon-only overflow; fixed bottom divider. |
| Prompt target, editor area, send state/action | `PromptComposer` | `surface`, exact session target, safe-area inset, operation-state label. |
| Approval fields and response controls | `TimelineApprovalItem` | Attached `attention` node/rail; exact target/risk; duplicate disabled after submit. |
| Elevated approval/goal/model/plan | `RailBottomSheet` / `ConfirmationSheet` | Labelled title, close, exact target, internal state rail, safe area. |
| Lost history and reconnect | `BrokenTimelineBoundary` | `danger` break transitioning back to `connected`; remains visible. |
| Pair create/review/claim/result | `PairingProgressRail` | Local/phone owner label, finite stage nodes, illustrative QR only. |
| Locked/browser/local recovery examples | `RecoveryRailPanel` | Owner label plus bounded cause/recovery; unavailable remote action absent. |
| Tablet inspector | `HostAccessInspector` | Selected access facts only, no collaboration or route expansion. |
| Desktop grouped list/timeline split | `ResponsiveSplit` | Same queue and timeline components; no desktop-only command. |

Icons use the implementation's Lucide set. Status always combines text with icon/shape; color alone is insufficient.

## Responsive Rules

| Width | Rule |
| --- | --- |
| 360 | One grouped column; stable type; branch/age wrap; no horizontal scroll. |
| 390 | Primary target; host rail plus at least two `ACT NOW` items in first viewport. |
| 412 | Same hierarchy with more group separation; sticky dock remains bottom-anchored. |
| 768 | Wider grouped queue and optional bounded host/access inspector; no sidebar/new route. |
| 1280 | Grouped queue/timeline split; every action remains available through phone hierarchy. |

## Asset Mapping

| Screen group | Asset |
| --- | --- |
| Mission Control | `mobile-mission-control-mixed.png` |
| Writable detail | `mobile-session-detail-active.png` |
| Boundary and approval | `mobile-approval-boundary-states.png` |
| Pairing | `pairing-journey.png` |
| Access/recovery | `access-recovery-states.png` |
| Primary controls | `primary-controls.png` |
| Responsive | `responsive-continuum.png` |

## Fidelity Rules

- Preserve grouped queue hierarchy, continuous semantic rails, timeline continuity, and sticky action dock if selected.
- Do not turn rails into decoration; they encode state, group, or continuity and require non-color labels.
- Treat sample names/copy in raster assets as fixtures; exact runtime copy comes from typed view models.
- Do not implement the rejected `calm-control-room-board.png`.
- Record any approved structural drift before implementation screenshots are accepted.
