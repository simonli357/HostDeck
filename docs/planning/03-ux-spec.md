# UX Spec

Owns active-version user flows, screens, states, accessibility, and UI contract decisions.

## Surfaces

| Surface | Purpose | States |
| --- | --- | --- |
| Mission Control | Default dashboard for scanning all managed sessions and deciding what needs attention first. | Empty, loading, ready, mixed attention, all idle, disconnected, locked, read-only, LAN-disabled, agent error |
| Session Detail | Phone-friendly control thread for one session with recent output, status, prompt composer, and slash-command controls. | Loading, ready, waiting for user, waiting for approval, running, failed, unknown, stale, stopped, permission denied, stream disconnected |
| Prompt And Slash Composer | Safe write surface for normal prompts and approved slash commands. | Empty, composing, sending, sent, failed, disabled by lock, disabled by read-only, disabled by stale session |
| Advanced Raw Fallback | Explicit lower-level session view for bounded terminal output and risky raw input controls. | Hidden by default, read-only, advanced enabled, confirmation required, sending, failed, stale/unwritable |
| Pairing And Trust | Local pairing/token flow and trust-state visibility for write access. | Unpaired, pairing code entry, paired read/write, token expired, revoked, locked, permission denied |
| Host Status And Safety | Host-level state for daemon health, startup checks, lock, LAN mode, and stream health. | Healthy, degraded, locked, LAN enabled, LAN disabled, tmux unhealthy, storage unhealthy, startup check failed |
| Confirmations | Confirmation surface for stop, raw input, lock, LAN changes, and any future risky action. | Open, confirming, success, failed |

## Flows

| ID | Flow | Entry | Exit |
| --- | --- | --- | --- |
| UX-001 | Pair a browser for write access. | User opens dashboard or runs `codexdeck pair`. | Dashboard shows trusted write state or a clear pairing failure. |
| UX-002 | Scan sessions by attention. | User opens Mission Control. | User identifies the highest-priority session or sees a truthful empty/all-idle state. |
| UX-003 | Read a session and send a prompt. | User taps a session card. | Prompt is sent to exactly one session, audited, and resulting output appears or a clear error is shown. |
| UX-004 | Send a primary slash command. | User taps `/model`, `/goal`, or `/plan` in Session Detail. | Literal slash command is sent to the selected session and output stream continues. |
| UX-005 | Send a utility slash command. | User taps `/usage`, `/compact`, or `/skills` in Session Detail. | Literal slash command is sent to the selected session and output stream continues. |
| UX-006 | Use advanced raw fallback. | User opens advanced controls from Session Detail. | User inspects bounded raw output or sends confirmed raw input; stale/untrusted sessions reject writes. |
| UX-007 | Stop a session. | User chooses stop from a session action area. | Confirmation appears, stop request is audited, and session state updates or error is shown. |
| UX-008 | Lock remote writes. | User triggers lock from Host Status/Safety or CLI. | Dashboard moves to locked state and all write controls become disabled. |
| UX-009 | Recover from disconnect or stale stream. | Stream or daemon connection fails. | UI shows disconnected/stale state, preserves last bounded output with replay boundary, and reconnects without fake success. |

## Screen Contracts

| Screen group | Required content | Interaction rules |
| --- | --- | --- |
| Mission Control | Host state banner, attention-sorted session list, session status/attention, cwd/project cue, branch when available, last activity, recent output cue, quick safe actions. | Attention ordering comes before alphabetical order. Cards must not resize unexpectedly when status/output changes. Write controls reflect trust/lock/session state. |
| Session Detail | Session header, status, attention, cwd/branch, recent Codex output, prompt input, primary slash commands, utility slash commands, stream/replay boundary, advanced entry. | Conversation/control view is default. Raw terminal is secondary. Sending is disabled until trust, lock, and writable-session checks pass. |
| Advanced Raw Fallback | Bounded raw output, cursor/truncation marker, raw input affordance, stop/control affordances, confirmation copy. | Hidden behind explicit advanced entry. Raw input requires confirmation and trusted write permission. |
| Pairing/Trust | Pairing code input or pairing instructions, current permission mode, token expiry/revocation message, locked/LAN state. | Never imply write access before token claim succeeds. Expired or revoked tokens show visible action guidance. |
| Host Status/Safety | Daemon health, tmux/storage health, bind mode, LAN state, lock state, stale session count, last classified host error. | Lock is easy to reach. Unlock is not available from remote dashboard in V1. LAN mutation is not a normal dashboard control unless later approved. |

## Content Rules

- Use "session", "attention", "locked", "read-only", "stale", and "unknown" consistently.
- Do not frame HostDeck as SSH, a terminal emulator, a code editor, or a Git UI.
- Status labels are advisory unless backed by explicit lifecycle state.
- Unknown or stale state must be visible and must not look like success.
- Slash-command labels use literal command text: `/model`, `/goal`, `/plan`, `/usage`, `/compact`, `/skills`.

## Visual Direction

- Gate: visual directions and generated mockups are required before UI implementation, but should be created after the UX contract, detailed design, state coverage, and validation plan are defined enough to make them useful implementation targets.
- Planned option A: dense operations console.
- Planned option B: calm control room.
- Recommended starting hypothesis: dense operations console, because V1 is a power-user operational dashboard where scanning density and status hierarchy matter more than spacious ambience.
- Selected option: Pending human selection.
- Approved mockups: Pending later image-generation/mockup pass.
- Known divergences: None approved yet.

## Accessibility

| Area | Requirement |
| --- | --- |
| Keyboard | All dashboard controls must be reachable by keyboard, with visible focus and predictable tab order across session list, detail, composer, and confirmations. |
| Screen reader | Session cards, statuses, attention levels, disabled write states, stream errors, and confirmation dialogs need semantic labels and live-region behavior where updates matter. |
| Contrast | Text, status chips, focus rings, disabled states, and error/warning indicators must meet WCAG AA contrast in selected theme tokens. |
| Motion | Avoid required animation. Respect reduced-motion preferences. Streaming output should update without scroll hijacking. |
| Touch targets | Primary phone controls should use stable target sizes of at least 44px where practical; compact metadata can be smaller only when not interactive. |
| Error recovery | Permission, lock, stale, disconnected, and startup-failure states must explain what changed and which controls are unavailable. |
