# PRD

Owns active-version product scope, user value, journeys, risks, and open human choices.

## Active Version

- Version: V1
- Roadmap link: `docs/planning/00-roadmap.md`
- Scope approval: Product outcome approved on 2026-07-08; app-server/mobile UX rebaselined on 2026-07-09 by `REL-V1-011`; different-network remote access restored to V1 on 2026-07-13 by `DEC-027` and `REL-V1-012`; shared ordinary Codex sessions and Ubuntu-only V1 release scope approved on 2026-08-14 by `DEC-031`, `DEC-032`, and `REL-V1-109`.

## Product Summary

- Problem: Power users can run several Codex sessions on Ubuntu, but supervising separate host terminals makes it hard to know which thread needs attention, respond away from the host, or handle routine controls and approvals safely from a phone.
- Users: One technical user who already runs Codex CLI locally on Ubuntu 24.04 x64 and is comfortable with terminals and local developer tools.
- Core value: HostDeck gives the user one mission-control dashboard for ordinary Codex CLI sessions and preserves the same thread when work moves between laptop TUI and phone. There is no HostDeck-only session namespace or adoption ceremony.
- Non-goals: HostDeck V1 is not a generic SSH terminal, native mobile app, HostDeck-hosted relay product, multi-user collaboration tool, mobile code editor, file browser, git review surface, or replacement for official Codex Remote. It provides one Ubuntu mobile-control path through private Tailscale ingress without exposing Codex app-server or a HostDeck public listener.

## Scope

| Area | In active version | Deferred version |
| --- | --- | --- |
| Core workflow | Start or resume Codex normally on the laptop after the shared broker is running; HostDeck automatically tracks loaded top-level interactive sessions by native Codex UUID. List, archive, monitor, interrupt, and steer the same threads from phone or laptop. The phone starts on Mission Control, opens Session Detail, sends one prompt, uses structured `/model`, `/goal`, `/plan`, `/usage`, `/compact`, and `/skills`, and handles inline approvals. | Bulk operations, attaching a process that was already connected to an independent app-server, child/subagent sessions, dedicated approval queue, phone raw-shell input, autonomous voice commands, AI-generated labels, and complex natural-language routing. |
| Data | HostDeck alias/project projection, Codex thread id and compatibility version, structured turn/item/status/approval projection, attention, last activity, permission mode, replay boundaries, and bounded audit events. Codex owns full conversation history. | Cloud sync, duplicate full conversation archive, repo file trees, code diffs, and team activity records. |
| Integrations | One exact Codex 0.147.0 app-server on `$CODEX_HOME/app-server-control/app-server-control.sock`, shared automatically by ordinary Unix Codex TUI clients and HostDeck; loopback-only typed HostDeck API/SSE; private Tailscale Serve HTTPS on one explicit saved personal profile; QR/link HostDeck pairing. | HostDeck-hosted/self-hosted relay, direct private-IP LAN/custom CA, native mobile APIs, push providers, transcription, editor extensions, direct public app-server exposure, and multiple equal runtime backends. |
| Platforms | Ubuntu 24.04 x64 per-user host package plus a phone-first responsive browser dashboard. Supported Codex 0.147.0 and Tailscale clients are prerequisites; the HostDeck profile may coexist as a saved but not simultaneously active profile with a company profile. | Windows, macOS and ARM hosts, native Android/iOS apps, public internet listeners, simultaneous multi-tailnet operation, app stores, and team/shared deployments. |

## User Journeys

| ID | Journey | Success |
| --- | --- | --- |
| UJ-001 | User installs HostDeck on Ubuntu, starts the broker, and opens or resumes several Codex threads normally. | The package requires no source checkout, Node, or pnpm; normal Codex TUI clients share the broker and loaded top-level sessions appear automatically in Mission Control with structured status and useful metadata. |
| UJ-002 | User leaves the laptop on a home or company network, activates the saved HostDeck Tailscale profile, and later opens the dashboard from a phone on cellular or unrelated Wi-Fi. | The private HTTPS origin is reachable without router changes, a public HostDeck listener, or manual CA installation; attention-worthy sessions appear before idle or healthy sessions. |
| UJ-003 | User opens a session that needs input and reads recent Codex output in a phone-friendly detail view. | The user can understand the current question or failure without switching to the laptop terminal. |
| UJ-004 | User sends a prompt or uses `/model`, `/goal`, `/plan`, `/usage`, `/compact`, or `/skills` from Session Detail. | HostDeck invokes the tested structured operation for exactly one thread, records an audit event, and resulting events stream back without pretending literal TUI injection succeeded. |
| UJ-005 | A Codex command or tool requires approval. | Session Detail shows the structured request, scope, risk, and approve/deny controls; the decision targets exactly one pending request and is audited. |
| UJ-006 | User wants to stop remote control quickly. | A local disable, lock, or equivalent trust-control action prevents further phone-side writes and leaves an auditable state. |
| UJ-007 | User needs full terminal/TUI control. | The user runs normal `codex resume <native-uuid>`; the laptop TUI reconnects to the shared app-server and operates the same thread without exposing raw shell input on the phone. |
| UJ-008 | User switches the laptop between saved HostDeck and company Tailscale profiles. | HostDeck never switches profiles automatically or changes company-tailnet settings; local host status reports the laptop mismatch and remote access becomes unreachable. Returning to the HostDeck profile restores access only when its exact Serve mapping is present; otherwise HostDeck stays unavailable until explicit local `remote enable`. |
| UJ-009 | User has an existing persisted Codex thread and wants to continue it on phone and laptop. | After the one-time transition that closes any pre-broker client, normal `codex resume <native-uuid>` loads the exact thread into the shared daemon. HostDeck enrolls it automatically, projects bounded recent history with a visible boundary, and receives subsequent laptop and phone activity without a discover/adopt/unmanage command. |

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
| Native packaging can drift by platform or ship unsigned/tampered artifacts. | Installation can fail, weaken trust, or strand user data during upgrade. | Build native artifacts on pinned platform runners, bundle the runtime, sign public artifacts, publish checksums/SBOM/provenance, and test install/upgrade/rollback/uninstall with user-data preservation. |
| A TUI was already connected to an independent app-server before the HostDeck broker started. | HostDeck cannot intercept that existing transport and would show stale or missing activity. | V1 states the one-time boundary explicitly: close that client, start/verify the shared broker, then run normal `codex resume <native-uuid>`. New normal TUI clients probe the standard socket automatically; no attach success is fabricated. |
| Codex changes or bypasses its implicit standard-socket behavior. | Ordinary TUI sessions could escape HostDeck observation. | Pin exact 0.147.0, verify the standard socket and client probe with real process evidence, reject known bypass modes, and fail compatibility visibly. |

## Open Questions

| Question | Recommended default | Blocking? |
| --- | --- | --- |
| None | The selected remote product direction is recorded in `DEC-027`; exact Tailscale version, Serve coexistence, proxy metadata, and profile persistence are implementation spikes, not open product choices. | No |
