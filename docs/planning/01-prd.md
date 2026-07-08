# PRD

Owns active-version product scope, user value, journeys, risks, and open human choices.

## Active Version

- Version: V1
- Roadmap link: `docs/planning/00-roadmap.md`
- Scope approval: Approved on 2026-07-08.

## Product Summary

- Problem: Power users can run several Codex CLI sessions on Ubuntu, but supervising them through separate laptop terminals makes it hard to know which session needs attention, respond while away from the laptop, or safely send common controls from a phone-sized interface.
- Users: One technical user who already runs Codex CLI locally on Ubuntu and is comfortable with terminals, tmux-style workflows, and local developer tools.
- Core value: HostDeck gives the user a mission-control dashboard for managed Codex CLI sessions, sorted around attention and safe steering instead of raw terminal juggling.
- Non-goals: HostDeck V1 is not a generic SSH terminal, native mobile app, remote relay product, multi-user collaboration tool, mobile code editor, file browser, git review surface, or replacement for official Codex remote workflows.

## Scope

| Area | In active version | Deferred version |
| --- | --- | --- |
| Core workflow | Start, list, attach to, stop, monitor, and send input to Codex CLI sessions managed by HostDeck. Show a mobile-friendly session list, session detail, prompt sender, safe slash-command buttons, recent output, and advanced raw terminal fallback. | Bulk operations, approval queue as a dedicated screen, autonomous voice commands, AI-generated session labels, and complex natural-language routing. |
| Data | Session identity, name, project/cwd, branch when available, backend metadata, recent output, status, attention level, last activity, permission mode, and audit events for remote actions. | Long-term cloud sync, full session-history archive, repo file trees, code diffs, and team activity records. |
| Integrations | Codex CLI through tmux-managed sessions; local HTTP/WebSocket API consumed by the web dashboard; basic local or LAN trust gate for one user. | Hosted relay, self-hosted relay, native mobile APIs, push notification providers, local transcription, editor extensions, and deep Codex internals. |
| Platforms | Ubuntu host agent plus mobile-responsive browser dashboard for one phone or laptop browser on a trusted local connection. | Native Android/iOS apps, macOS/Windows host support, public internet access, and team/shared deployments. |

## User Journeys

| ID | Journey | Success |
| --- | --- | --- |
| UJ-001 | User starts several managed Codex sessions from Ubuntu with meaningful names and project directories. | Sessions run under the HostDeck tmux backend, survive dashboard disconnects, and appear in the session list with useful metadata. |
| UJ-002 | User opens the dashboard from a phone browser on a trusted local connection and scans active sessions. | Sessions are grouped or sorted so attention-worthy work is visible before idle or healthy sessions. |
| UJ-003 | User opens a session that needs input and reads recent Codex output in a phone-friendly detail view. | The user can understand the current question or failure without switching to the laptop terminal. |
| UJ-004 | User sends a prompt or primary safe slash command such as `/model`, `/goal`, `/plan`, `/usage`, `/compact`, or `/skills` from the dashboard. | The host agent injects the intended input into the selected session, records an audit event, and the resulting output streams back. |
| UJ-005 | User needs lower-level control for a session. | Advanced raw terminal fallback exposes recent terminal output and explicit risky controls without making raw terminal mode the default experience. |
| UJ-006 | User wants to stop remote control quickly. | A local disable, lock, or equivalent trust-control action prevents further phone-side writes and leaves an auditable state. |

## Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Terminal parsing may be unreliable because Codex CLI output and prompts can change. | Status and attention indicators could mislead the user. | Treat heuristics as advisory, keep raw output available, fail visibly for unknown states, and avoid promising perfect detection in V1. |
| Remote input controls a real shell. | A compromised or mistaken client could send destructive commands. | Default to local/trusted access, require a trust gate before writes, limit safe slash commands, confirm risky actions, and maintain an audit log. |
| V1 could become a tiny terminal clone. | The product would lose its mission-control value on mobile. | Make cards, attention sorting, session summaries/recent output, and safe quick actions the primary UX; keep raw terminal as advanced fallback. |
| Existing terminal import is brittle. | Supporting arbitrary current terminals could delay core workflow and reduce reliability. | V1 supports HostDeck-managed sessions; arbitrary terminal discovery/import is deferred. |
| Networking scope can expand quickly. | Relay and internet access could dominate V1. | Keep V1 local/trusted connection only; define relay as V2. |

## Open Questions

| Question | Recommended default | Blocking? |
| --- | --- | --- |
| None | Approved defaults recorded in `docs/planning/07-decisions.md`. | No |
