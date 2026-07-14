# FE-V1-002 Mobile Visual Direction Mockups

Date: 2026-07-13

## Outcome

The visual gate now has two complete, structurally distinct, mobile-first candidates generated from the selected `FE-V1-004` state/interaction contract:

- Option A, **Signal Ledger**: a bright, compact attention ledger with flat semantic feed bands.
- Option B, **Focus Rail**: a dark grouped action queue with continuous state and event rails.
- 14 current raster assets are stored in the repository: seven per option.
- Both options cover the five reference widths and all mandatory visual-gate states.
- The two prior desktop-led boards remain in place but are explicitly rejected legacy evidence.
- No option is selected by this task. `FE-V1-003` still requires a human choice before React implementation.

## Candidate Comparison

| Dimension | Option A: Signal Ledger | Option B: Focus Rail |
| --- | --- | --- |
| Mission hierarchy | One flat attention-sorted ledger with compact scope control. | Explicit `ACT NOW`, `IN PROGRESS`, and `QUIET` queue groups. |
| Detail hierarchy | Full-width semantic user/agent/tool/progress bands. | One continuous semantic event timeline. |
| State treatment | Narrow row rails, hairline dividers, light surfaces. | Continuous section/event/state rails on deep neutral surfaces. |
| Primary controls | Light equal-width control strip and conventional sheets. | Dark action dock and rail-backed current/next-turn sheets. |
| Density | Compact comparison-first. | Focused action/continuity-first. |
| Desktop expansion | Flat ledger plus selected detail. | Grouped queue plus selected timeline. |
| Main implementation risk | Large type or whitespace could erode first-viewport density. | Rails could become decorative or dark contrast could flatten hierarchy. |

These are structural differences, not theme-only variants.

## Asset Sets

| Screen group | Option A | Option B |
| --- | --- | --- |
| Phone Mission Control | `assets/ui-concepts/option-a/mobile-mission-control-mixed.png` | `assets/ui-concepts/option-b/mobile-mission-control-mixed.png` |
| Writable Session Detail | `assets/ui-concepts/option-a/mobile-session-detail-active.png` | `assets/ui-concepts/option-b/mobile-session-detail-active.png` |
| Replay/approval/confirmation | `assets/ui-concepts/option-a/mobile-approval-boundary-states.png` | `assets/ui-concepts/option-b/mobile-approval-boundary-states.png` |
| Pairing journey | `assets/ui-concepts/option-a/pairing-journey.png` | `assets/ui-concepts/option-b/pairing-journey.png` |
| Access and recovery | `assets/ui-concepts/option-a/access-recovery-states.png` | `assets/ui-concepts/option-b/access-recovery-states.png` |
| `/model`, `/goal`, `/plan` | `assets/ui-concepts/option-a/primary-controls.png` | `assets/ui-concepts/option-b/primary-controls.png` |
| Responsive continuum | `assets/ui-concepts/option-a/responsive-continuum.png` | `assets/ui-concepts/option-b/responsive-continuum.png` |

## Required State Coverage

| Contract state/group | Candidate evidence | Review result |
| --- | --- | --- |
| `mission_mixed_attention` | Both `mobile-mission-control-mixed.png` assets | Host transport, permission, and stream truth precede attention-sorted/grouped sessions; first two actionable rows are visible. |
| `detail_active_writable` | Both `mobile-session-detail-active.png` assets | Structured feed/timeline is primary; selected target, primary controls, and sticky composer remain visible. |
| `approval_pending` | Both `mobile-approval-boundary-states.png` assets | Exact action, command summary, scope, target, risk, expiry, deny, and review/approve are inline. |
| `approval_elevated_confirmation` | Both approval assets | Exact target/action/risk and one-time grant are isolated in a confirmation sheet. |
| `detail_replay_boundary` | Both approval/boundary assets | Lost continuity remains explicit before reconnected/live state; no complete-history claim. |
| `pair_fragment_ready` / `pair_claiming` / `pair_paired` | Both `pairing-journey.png` assets | Laptop-local link/QR ownership and phone review/in-flight/result states are separate; no session data appears before pairing. |
| `mission_locked`, `mission_read_only`, `access_locked` | Both `access-recovery-states.png` assets | Paired reads remain visible; writes disable; recovery belongs to the laptop; no remote unlock. |
| Pre-load remote origin failure | Both access/recovery assets | Generic browser failure contains no HostDeck chrome or laptop diagnosis. |
| Remote disabled | Both access/recovery assets | Laptop-local state and local-action guidance only. |
| Tailscale unavailable | Both access/recovery assets | Stopped/signed-out is bounded local diagnosis with no identity disclosure. |
| Laptop profile mismatch | Both access/recovery assets | Local switching guidance; no active company/profile name and no automatic/remote switch. |
| Serve conflict | Both access/recovery assets | Bounded local mapping conflict and no-change truth; no phone repair control. |
| `model_current`, `goal_current`, `plan_current` | Both `primary-controls.png` assets | Target/current state and action are explicit; model/plan use next-turn/runtime-confirmation semantics; active goal risk is visible. |
| Desktop expansion | Both `responsive-continuum.png` assets | Same list/detail hierarchy; no sidebar, editor, terminal, or desktop-only required action. |

## Viewport Review

| Viewport | Option A result | Option B result |
| --- | --- | --- |
| 360 x 800 | Flat rows retain stable type and wrap bounded metadata without horizontal navigation. | Grouped rail items retain stable type and two actionable items before lower groups. |
| 390 x 844 | Dedicated portrait targets establish both core routes; host/access plus at least two sessions fit Mission Control. | Dedicated portrait targets establish grouped Mission Control and timeline detail with sticky dock. |
| 412 x 915 | Same hierarchy gains vertical room without larger type or a new surface. | Same queue hierarchy and target sizes; rail semantics remain intact. |
| 768 x 1024 | Wider ledger plus bounded access inspector; no navigation sidebar or new workflow. | Wider grouped queue plus the same five bounded access facts. |
| 1280 x 800 | Ledger/detail split reuses mobile routes and primary controls. | Grouped queue/timeline split reuses mobile routes and primary controls. |

The responsive boards are layout references, not browser screenshots or proof of CSS behavior. `FE-V1-016`, `FE-V1-039`, `FE-V1-040`, and `FE-V1-017` still own implemented responsive, accessibility, browser, and screenshot-diff evidence.

## Component And Token Mapping

Every visible category is mapped in the option design-system files:

- `assets/ui-concepts/option-a/design-system.md`
- `assets/ui-concepts/option-b/design-system.md`

The mappings cover app bars, access strips/rails, session rows/items, group/state rails, event bands/timeline nodes, primary control strips/docks, prompt composers, approvals, boundaries, sheets, pairing states, recovery states, tablet inspectors, desktop splits, icon policy, typography, color, spacing, radius, target size, and responsive behavior.

The token values are implementation references. Raster sampling does not replace contrast testing, browser rendering, safe-area behavior, focus behavior, or design-system implementation.

## Rejected Legacy Assets

| Asset | Rejection |
| --- | --- |
| `assets/ui-concepts/option-a/dense-operations-console-board.png` | Desktop Mission Control dominates; phone detail is write-disabled; LAN/tmux/raw fallback are obsolete selected-path contradictions. |
| `assets/ui-concepts/option-b/calm-control-room-board.png` | Same desktop-led hierarchy and obsolete surfaces; not a materially different phone-first implementation target. |

No current inventory or design-system mapping points to either legacy board as an implementation target.

## Generation And Review Log

- Built-in `image_gen` generated every current raster asset; project finals were copied from the Codex generated-image store into `assets/ui-concepts/`.
- Option A responsive output was regenerated after review found invented team/owner data, audit navigation, editor access, and desktop-only tabs.
- Option B Session Detail was corrected to remove invented file/tool mention behavior.
- Option B approval/boundary was corrected to remove desktop keyboard-shortcut copy and target the exact session.
- Option B responsive output was corrected to remove an app launcher, node/agent ownership cues, and generic command copy.
- Final manual review checked state ownership, first-viewport hierarchy, exact primary controls, approval risk, boundary persistence, pre-load disclosure, local-only recovery, responsive route parity, clipping, and overlap.

## Reference-Only Boundaries

- Generated QR patterns are illustrative, nonfunctional, and must never be shipped as pairing credentials.
- Sample session/event/model/goal content is fixture-like visual copy. Typed contracts own final values and mutation eligibility.
- Small raster text is not accessibility evidence. Semantic HTML, zoom/reflow, contrast, focus, live-region, keyboard, screen-reader, and touch testing remain downstream.
- Neither candidate authorizes a raster-only control. If an image conflicts with `FE-V1-004`, the typed contract wins and drift must be recorded.
- No physical-phone runtime behavior, Tailscale workflow, or built dashboard is claimed by this visual task.

## Human Selection Input

Inspect in this order:

1. Both `mobile-mission-control-mixed.png` assets.
2. Both `mobile-session-detail-active.png` assets.
3. Both `mobile-approval-boundary-states.png` and `primary-controls.png` assets.
4. Pairing/access ownership in both sets.
5. Both responsive continua.

`FE-V1-003` should record one exact option, any explicitly approved cross-option borrowing, and any approved drift. Silence is not approval.

## Validation

- All 14 current PNGs decode successfully with ImageMagick; portrait targets are approximately 852 x 1844 and review boards are 1672 x 941.
- Manual visual inspection covered every generated final and the targeted correction outputs.
- `pnpm check:planning` passes after task-state synchronization.
- `git diff --check` passes.

No application code, API behavior, command, setup, dependency, or release claim changed in `FE-V1-002`.
