# PRD

Owns active-version product scope, user value, journeys, risks, and open human choices.

## Active Version

- Version: V1
- Roadmap link: `docs/planning/00-roadmap.md`
- Scope approval: Product outcome approved on 2026-07-08; app-server/mobile UX rebaselined on 2026-07-09 by `REL-V1-011`; different-network remote access restored to V1 on 2026-07-13 by `DEC-027` and `REL-V1-012`.

## Product Summary

- Problem: Power users can run several Codex sessions on Ubuntu, but supervising separate laptop terminals makes it hard to know which thread needs attention, respond away from the laptop, or handle routine controls and approvals safely from a phone.
- Users: One technical user who already runs Codex CLI locally on Ubuntu and is comfortable with terminals and local developer tools.
- Core value: HostDeck gives the user a mission-control dashboard for managed Codex CLI sessions, sorted around attention and safe steering instead of raw terminal juggling.
- Non-goals: HostDeck V1 is not a generic SSH terminal, native mobile app, HostDeck-hosted relay product, multi-user collaboration tool, mobile code editor, file browser, git review surface, or replacement for official Codex Remote on supported desktop hosts. It fills the Ubuntu/mobile remote-control gap through a private Tailscale ingress without exposing Codex app-server or a HostDeck public listener.

## Scope

| Area | In active version | Deferred version |
| --- | --- | --- |
| Core workflow | Start, list, resume in the laptop TUI, archive, monitor, interrupt, and steer HostDeck-managed Codex threads. The phone starts on Mission Control, opens conversation-first Session Detail, sends one prompt, uses structured `/model`, `/goal`, `/plan`, `/usage`, `/compact`, and `/skills` controls, and handles inline structured approvals. | Bulk operations, dedicated approval queue, phone raw-shell input, autonomous voice commands, AI-generated labels, and complex natural-language routing. |
| Data | HostDeck alias/project projection, Codex thread id and compatibility version, structured turn/item/status/approval projection, attention, last activity, permission mode, replay boundaries, and bounded audit events. Codex owns full conversation history. | Cloud sync, duplicate full conversation archive, repo file trees, code diffs, and team activity records. |
| Integrations | Dedicated Codex app-server over a user-private Unix socket; loopback-only typed HostDeck API/SSE; private Tailscale Serve HTTPS on one explicit saved personal profile; QR/link HostDeck pairing; laptop TUI resume against the same app-server. | HostDeck-hosted/self-hosted relay, direct private-IP LAN/custom CA, native mobile APIs, push providers, transcription, editor extensions, direct public app-server exposure, and multiple equal runtime backends. |
| Platforms | Ubuntu host service plus a phone-first responsive browser dashboard for paired personal devices. Supported Tailscale clients are required on laptop and phone; the HostDeck profile may coexist as a saved but not simultaneously active profile with a company profile. | Native Android/iOS apps, macOS/Windows HostDeck hosts, public internet listeners, simultaneous multi-tailnet operation, and team/shared deployments. |

## User Journeys

| ID | Journey | Success |
| --- | --- | --- |
| UJ-001 | User starts several managed Codex threads from Ubuntu with meaningful names and project directories. | Threads run through the dedicated Codex runtime, survive dashboard disconnects, and appear in Mission Control with structured status and useful metadata. |
| UJ-002 | User leaves the laptop on a home or company network, activates the saved HostDeck Tailscale profile, and later opens the dashboard from a phone on cellular or unrelated Wi-Fi. | The private HTTPS origin is reachable without router changes, a public HostDeck listener, or manual CA installation; attention-worthy sessions appear before idle or healthy sessions. |
| UJ-003 | User opens a session that needs input and reads recent Codex output in a phone-friendly detail view. | The user can understand the current question or failure without switching to the laptop terminal. |
| UJ-004 | User sends a prompt or uses `/model`, `/goal`, `/plan`, `/usage`, `/compact`, or `/skills` from Session Detail. | HostDeck invokes the tested structured operation for exactly one thread, records an audit event, and resulting events stream back without pretending literal TUI injection succeeded. |
| UJ-005 | A Codex command or tool requires approval. | Session Detail shows the structured request, scope, risk, and approve/deny controls; the decision targets exactly one pending request and is audited. |
| UJ-006 | User wants to stop remote control quickly. | A local disable, lock, or equivalent trust-control action prevents further phone-side writes and leaves an auditable state. |
| UJ-007 | User needs full terminal/TUI control. | HostDeck provides a local resume command for the exact Codex thread; the laptop TUI connects to the same local app-server without exposing raw shell input on the phone. |
| UJ-008 | User switches the laptop between saved HostDeck and company Tailscale profiles. | HostDeck never switches profiles automatically or changes company-tailnet settings; local host status reports the laptop mismatch and remote access becomes unreachable. Returning to the HostDeck profile restores access only when its exact Serve mapping is present; otherwise HostDeck stays unavailable until explicit local `remote enable`. |

## Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Codex app-server is currently experimental and its protocol can change. | A Codex upgrade could break lifecycle or controls. | Pin a tested CLI range, generate version-specific schemas, negotiate capabilities, reject incompatible versions, and keep the adapter isolated. |
| Remote actions can cause real shell/file changes. | A compromised or mistaken client could approve or trigger destructive work. | Require encrypted paired access, structured capability-gated operations, exact targets, confirmations for risky actions, lock/revoke controls, and truthful audit outcomes. |
| V1 could become a tiny terminal clone. | The product would lose its mission-control value on mobile. | Make cards, attention sorting, session summaries/recent output, and safe quick actions the primary UX; keep full terminal/TUI control on the laptop only. |
| Structured controls can drift from TUI slash-command behavior. | A button could imply a capability that is absent in the installed Codex version. | Every control maps to a version-tested protocol operation; unavailable controls are omitted or explicitly disabled, never emulated by unverified text injection. |
| Tailscale is unavailable, signed out, blocked by policy, or on the wrong profile. | The phone cannot reach HostDeck even though Codex may still be working. | Treat Tailscale as an explicit V1 prerequisite; detect the laptop's supported version, active profile, Serve state, and reconnect truth; never auto-switch; keep local HostDeck/Codex operation independent. A phone-side profile/routing failure remains a browser/Tailscale network error until a request can reach HostDeck. |
| HostDeck configuration could disturb company Tailscale state. | Company connectivity or policy could be affected. | Configure only the human-selected personal profile, preserve unrelated Serve/settings state, snapshot and test profile switching, and fail before mutation when ownership is ambiguous. |
| A tailnet member is not automatically a HostDeck-authorized controller. | Broad tailnet policy could expose sensitive Codex state. | Keep app-level pairing, permission, CSRF, lock, and revoke checks in addition to Tailscale transport identity; HostDeck remains loopback-only behind Serve. |

## Open Questions

| Question | Recommended default | Blocking? |
| --- | --- | --- |
| None | The selected remote product direction is recorded in `DEC-027`; exact Tailscale version, Serve coexistence, proxy metadata, and profile persistence are implementation spikes, not open product choices. | No |
