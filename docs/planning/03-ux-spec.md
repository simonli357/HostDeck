# UX Spec

Owns active-version user flows, information architecture, screens, states, accessibility, responsive behavior, and visual implementation gates.

## Product Posture

- Primary device: a phone browser held in one hand.
- Primary job: scan several Codex threads, open the one needing attention, understand its current state, and take one safe action.
- Secondary device: a laptop or wide browser showing the same information architecture with more simultaneous context.
- Full-control fallback: the normal Codex TUI resumed on the laptop for the exact thread.
- Explicit non-surface: HostDeck V1 does not expose a phone shell, terminal emulator, file tree, code editor, Git review screen, dedicated approval inbox, or storage console.

## Reference Viewports

| Class | Required viewport | Purpose |
| --- | --- | --- |
| Primary phone | 390 x 844 CSS px | Main design and screenshot target. |
| Narrow phone | 360 x 800 CSS px | Long-label, wrapping, and minimum-width stress target. |
| Large phone | 412 x 915 CSS px | Larger mobile target and sticky-control validation. |
| Tablet | 768 x 1024 CSS px | Responsive expansion without changing navigation hierarchy. |
| Desktop | 1280 x 800 CSS px | Secondary two-pane enhancement of the mobile information architecture. |

No screen may require horizontal scrolling. Desktop-only affordances must not be required to complete a V1 journey.

## Information Architecture

| Level | Surface | Purpose |
| --- | --- | --- |
| 1 | Mission Control | Default route and session triage. |
| 2 | Session Detail | Conversation, current work, prompt, structured controls, and inline approval for one thread. |
| 2 | Host And Access sheet | Pairing state, lock, connection, runtime health, and device management. |
| 3 | Model, Goal, Plan, Utility sheets | Focused controls opened from Session Detail and dismissed back to the same thread. |
| 3 | Event details | Read-only structured diagnostic detail for an item, failure, or replay boundary. |
| External | Laptop TUI resume | Full local TUI for the selected thread; not embedded in the dashboard. |

Mission Control and Session Detail are the only full-page V1 product routes. Supporting controls use sheets/dialogs so phone navigation remains shallow and predictable.

## Surfaces And States

| Surface | Required states |
| --- | --- |
| App shell | Booting, ready, offline, host unavailable, incompatible Codex version, update required. |
| Mission Control | Empty, loading, mixed attention, all quiet, reconnecting, locked, read-only, remote unavailable, degraded runtime, fatal host error. |
| Session card | Running, waiting for input, approval needed, idle, completed, interrupted, failed, unknown, stale projection, unread activity. |
| Session Detail | Loading, ready, active turn, waiting for input, approval requested, interrupting, completed, failed, unknown, archived/not found, stream reconnecting. |
| Composer | Empty, composing, sending, accepted, failed, disabled by trust, disabled by lock, disabled by runtime/session state. |
| Structured controls | Loading, available, unsupported by installed Codex, submitting, succeeded, failed, conflict with active operation. |
| Pairing/access | Unpaired, QR/link claim in progress, paired read-only, paired write, expired, revoked, locked, Tailscale disconnected, laptop profile mismatch in local host status, Serve unavailable, external HTTPS/origin error, and generic remote-origin unreachable/offline. A phone with Tailscale stopped or on another profile receives a browser/network failure before HostDeck can diagnose the cause. |
| Event details | Complete event, truncated projection, replay boundary, redacted content, unsupported event type. |
| Confirmation | Interrupt turn, archive thread, approval decision, lock writes, revoke device. |

## Primary Flows

| ID | Flow | Success contract |
| --- | --- | --- |
| UX-001 | Pair a phone. | The local CLI verifies the selected HostDeck Tailscale profile and private Serve origin, then shows a QR/link. The phone opens it from another network, claims one time-bounded code without retaining it in URL history, sees the device permission, and can reload without losing a valid CSRF posture. |
| UX-002 | Scan sessions. | Mission Control puts approval, input, and failure attention before running/quiet work and identifies the session without opening every card. |
| UX-003 | Read and prompt. | Tapping a card opens the same thread; the user sees recent structured conversation context, sends one prompt, and sees accepted plus resulting progress or a truthful error. |
| UX-004 | Change model. | `/model` opens a model/effort selector sourced from the installed Codex runtime and marks the choice pending for the selected thread's next turn until runtime settings confirm it. |
| UX-005 | Manage goal or plan. | `/goal` distinguishes passive paused edits from agentic resume/active work; `/plan` selects Plan/Default for the next turn and waits for runtime settings. Unsupported behavior is disabled with an update requirement. |
| UX-006 | Use utilities. | `/usage`, `/compact`, and `/skills` open structured, task-specific surfaces; they are not sent as blind terminal text. |
| UX-007 | Handle approval. | An inline approval card shows the action and scope, then approve/deny targets exactly one pending request and produces an audit result. |
| UX-008 | Interrupt or archive. | Risky actions require explicit confirmation and update the selected thread without implying that conversation history was deleted. |
| UX-009 | Recover connectivity. | The UI keeps the last bounded projection, marks it stale, reconnects from a cursor, and shows a boundary if continuity cannot be proved. |
| UX-010 | Resume on laptop. | The dashboard/CLI provides the exact local resume command for the selected thread; no phone shell is exposed. |
| UX-011 | Lock or revoke. | Lock immediately disables all remote writes; a local admin path can revoke a paired device and restore or inspect access. |
| UX-012 | Switch Tailscale profiles safely. | Local status distinguishes HostDeck profile active, company/other profile active, signed out, stopped, Serve drift, and recovery. The dashboard never offers profile switching; local Codex work continues while remote access is unavailable. |

## Screen Contracts

### Mission Control

- First paint shows a compact host/access strip and the session list; no marketing hero, desktop toolbar, or empty decorative panel.
- The first viewport on a 390 x 844 phone shows the host state plus at least two normal-height session rows when data exists.
- Default ordering: approval needed, input needed, failed, interrupted/stale, running, quiet/completed; recency breaks ties.
- A session row shows name, project cue, status/attention, relative activity time, and one bounded meaningful summary. Branch is secondary and may wrap below the project cue.
- Status must use text plus icon/shape, not color alone.
- Tapping the row opens detail. Quick actions are limited to context-safe actions and must not crowd the scan path.

### Session Detail

- Header contains back, session identity, status, project cue, and an overflow menu for interrupt/archive/laptop-resume.
- The event/conversation feed is the main scroll region. User messages, agent messages, tool/command progress, approvals, failures, and boundaries have distinct semantic treatments.
- A sticky bottom composer remains reachable above the mobile browser safe area and on-screen keyboard.
- The primary control strip contains `/model`, `/goal`, and `/plan`. Utilities live in one overflow/sheet containing `/usage`, `/compact`, and `/skills`.
- Controls distinguish confirmed runtime state from pending next-turn state. Model and Plan selection do not claim an immediate loaded-thread change.
- Goal `Resume`/`Active` is presented as starting agentic work, not a passive toggle. `Pause` does not claim to interrupt an already active turn; interrupt remains separate.
- Compact shows `Accepted`/`Compacting` until authoritative context-compaction completion. The immediate request response never produces `Compacted` by itself.
- New events do not force-scroll when the user has scrolled away from the bottom; a new-activity affordance returns to live position.

### Inline Approval

- Show the requested command/action, working directory or affected scope, permission reason, and whether the request is one-time or changes ongoing policy.
- Approve and deny remain visually distinct. Elevated or broad approval requires a confirmation step.
- A decision disables duplicate submission immediately and remains pending until the server confirms the exact request id.
- Expired, superseded, or already-resolved approvals become read-only with a truthful result.

### Host And Access

- Show external origin, remote availability, paired device permission, lock state, Codex compatibility, stream health, and bounded last error.
- On the local laptop surface, show whether Tailscale is stopped/signed out, the selected HostDeck profile is active, another profile is active, or the HostDeck Serve entry is missing/drifted. Do not expose raw login, tailnet, company profile, node-key, or unrelated Serve details.
- On the remote phone surface, show only actionable connection/access state available after admission. Do not imply that a disconnected phone can switch or repair the laptop profile.
- Lock is available to a paired writer. Unlock and `remote enable/disable` remain local-admin operations.
- Device revocation is available through the paired writer and local-admin paths defined by the selected API/CLI and is reflected immediately.

### Event Details

- Read-only details can expose bounded stdout/stderr, tool arguments/results, error metadata, and replay boundaries when allowed by the server projection.
- Redaction and truncation are explicit. This surface never accepts arbitrary terminal input.

## Content Rules

- Use `thread` only for Codex/runtime detail; use `session` in primary user-facing navigation and labels.
- Use `Needs approval`, `Needs input`, `Running`, `Quiet`, `Interrupted`, `Failed`, `Unknown`, and `Stale` consistently.
- Do not call an accepted prompt completed. Completion follows a terminal turn event.
- Do not call a disconnected or unknown session healthy.
- Literal labels `/model`, `/goal`, `/plan`, `/usage`, `/compact`, and `/skills` are retained because they match the user's Codex mental model, but each invokes a structured operation.
- Error copy states what failed, whether retry is safe, and whether laptop action is required. When laptop status is actually available, `Wrong Tailscale profile` instructs local switching without naming the active company account; an unreachable phone origin remains a generic browser/Tailscale connection failure. Copy does not expose secrets or unbounded server details.

## Responsive Rules

- Phone is one column. Desktop may use a session-list/detail split only after both routes work independently at phone width.
- No viewport-width font scaling. Use stable type tokens and allow labels to wrap.
- Interactive targets are at least 44 x 44 CSS px where practical and never below 40 x 40.
- Sticky regions account for safe-area insets and keyboard resizing.
- Session rows, command controls, and approval actions use stable min/max dimensions so streaming content cannot shift controls under the pointer.
- Long repository names, paths, model names, and localized error text wrap or truncate with an accessible full label; they never overlap adjacent controls.

## Accessibility

| Area | Requirement |
| --- | --- |
| Semantics | Use landmarks, a real list for sessions, headings for feed groups, buttons for commands, and dialogs/sheets with labelled titles. |
| Keyboard | All flows work by keyboard with visible focus, logical order, escape-to-dismiss, and focus restoration. |
| Screen reader | Status changes and newly requested approvals use restrained live regions; streaming token deltas are not announced character by character. |
| Contrast | Text, icons, focus, status, disabled, and error states meet WCAG 2.2 AA in both selected themes if two themes ship. |
| Motion | Respect reduced motion; no required animation or scroll hijacking. |
| Touch | Primary actions meet target size and spacing requirements; destructive controls are not adjacent to send/approve. |
| Zoom/reflow | Core flows remain usable at 200 percent zoom and 320 CSS px reflow without horizontal scrolling. |

## Visual Direction Gate

- The existing Option A and Option B boards are rejected as implementation targets because both are desktop-led, omit phone Mission Control, and show only write-disabled phone detail.
- `FE-V1-002` is reopened after this UX rebaseline and the structured state-contract update.
- Each replacement option must show, at minimum: phone Mission Control mixed-attention state; phone Session Detail active/writable state with composer and primary controls; inline approval; locked/read-only state; remote-disconnected/replay-boundary state; Host/access remote-ready and laptop-action-required state; and a desktop expansion of the same design.
- The two options must differ in information hierarchy, density, navigation, and component treatment, not only color/theme.
- Mockup notes must map every visible element to a design-system token/component and identify generated imagery that is reference-only.
- Human selection in `FE-V1-003` remains required before React screen implementation.

## Acceptance Evidence

- Mockup review at every reference viewport before selection.
- Implemented Playwright screenshots for required states at 360 x 800, 390 x 844, 412 x 915, 768 x 1024, and 1280 x 800.
- Real-browser inspection with mobile keyboard open, long labels, slow/disconnected stream, approval arrival, lock transition, expired pairing, wrong-profile recovery, and Tailscale reconnect.
- At least one actual Android or iOS browser pass through private Tailscale Serve while the phone has no LAN route to the laptop, including personal-to-company-to-personal laptop profile switching with no company-profile mutation.
