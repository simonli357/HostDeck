# Option A Design System

## Theme

- Direction: Signal Ledger.
- Product fit: compact mobile session triage and repeatable structured control.
- Density: high enough for two useful session rows in the first 390 x 844 viewport, without sub-44px primary targets.

## Tokens

| Token | Reference value | Usage |
| --- | --- | --- |
| `color.canvas` | `#f7f8fa` | App background. |
| `color.surface` | `#ffffff` | Composer, sheet, confirmation, and repeated-item surface. |
| `color.ink` | `#17191c` | Primary text and icons. |
| `color.muted` | `#626975` | Metadata and disabled explanation. |
| `color.divider` | `#d7dbe0` | Full-width separators and control boundaries. |
| `color.connected` | `#087d70` | Remote ready, live, running, confirmed current state. |
| `color.attention` | `#b56b12` | Needs input, approval, pending, local action required. |
| `color.danger` | `#c64032` | Failure, lock, destructive confirmation. |
| `color.focus` | `#3167c6` | Selection, focus ring, primary neutral action. |
| `type.page` | 24px/30px, 700 | Compact route heading only. |
| `type.title` | 18px/24px, 650 | Session/sheet/item title. |
| `type.body` | 16px/24px, 400 | Main copy. |
| `type.meta` | 12-14px/18px, 400-600 | Status, branch, age, timestamps. |
| `space` | 4, 8, 12, 16, 24px | Fixed spacing scale; no viewport-scaled type. |
| `radius` | 0, 4, 6px | Rows remain flat; 6px maximum for controls/sheets. |
| `target` | 44px minimum | Touch controls and destructive choices. |
| `elevation` | Border first | Shadow only for a sticky-region separation cue. |

Colors are implementation references, not sampled guarantees from the raster assets. Final contrast must pass WCAG 2.2 AA.

## Components And Visible-Element Mapping

| Visible element | Component | Token/rule mapping |
| --- | --- | --- |
| HostDeck title, back, overflow/access icons | `AppBar` | `surface`, `ink`, 56px stable height, icon-only 44px targets. |
| Remote ready / permission / live row | `HostAccessStrip` | Flat three-part strip; `connected`, `divider`, text plus icon. |
| Attention / running / quiet modes | `MissionScopeControl` | One segmented control; `focus` selected, stable 44px height. |
| Session name, cue, branch, age, status, chevron | `SessionLedgerRow` | `ink`, `muted`, `divider`; narrow semantic `StateRail`; whole row is one target. |
| User, agent, tool, progress event | `SemanticEventBand` | Full-width band, role icon/label/time, no terminal styling. |
| `/model`, `/goal`, `/plan`, More | `PrimaryControlStrip` | Three equal text actions plus icon-only overflow; fixed dimensions. |
| Prompt target, editor area, send state/action | `PromptComposer` | `surface`, exact session target, safe-area inset, operation-state label. |
| Pending action/scope/target/risk and responses | `InlineApproval` | `attention` boundary; deny/approve separated; duplicate disabled after submit. |
| Elevated approval/goal/model/plan surfaces | `BottomSheet` / `ConfirmationSheet` | Labelled title, close, focus trap, exact target, current/pending/result regions. |
| Replay loss and reconnect truth | `ReplayBoundaryBand` | Persistent `attention` boundary; never styled as normal success. |
| Laptop QR and phone review/claim/result | `PairingJourneyState` | Local ownership label, illustrative QR, no session disclosure. |
| Locked/browser/local recovery examples | `AccessStatePanel` | Owner label plus bounded cause/recovery; no unavailable remote action. |
| Tablet inspector | `HostAccessInspector` | Same access facts, no new route or collaboration data. |
| Desktop list/detail split | `ResponsiveSplit` | Same Mission Control and Session Detail components, no desktop-only command. |

Icons use the implementation's Lucide set. Status always combines text with icon/shape; color alone is insufficient.

## Responsive Rules

| Width | Rule |
| --- | --- |
| 360 | One column; metadata wraps/truncates; stable type and targets; no horizontal scroll. |
| 390 | Primary target; host strip plus at least two session rows in first viewport. |
| 412 | Same hierarchy with more feed/list breathing room; sticky controls remain bottom-anchored. |
| 768 | Wider ledger and optional bounded host/access inspector; no sidebar or new route. |
| 1280 | Session list/detail split; every action remains available through the phone hierarchy. |

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

- Preserve the flat ledger, semantic feed bands, useful first viewport, and sticky work area if selected.
- Treat sample names/copy in raster assets as fixtures; exact runtime copy comes from typed view models.
- Do not implement the rejected `dense-operations-console-board.png`.
- Record any approved structural drift before implementation screenshots are accepted.
