# Requirements

Owns stable requirements for the active version.

## Functional

| ID | Requirement | Priority | Validation |
| --- | --- | --- | --- |
| FR-001 | The host agent must start new HostDeck-managed Codex CLI sessions through a tmux-backed lifecycle with a required session name and working directory. | Must | Automated adapter test with a fake Codex command plus manual Ubuntu smoke test starting multiple sessions. |
| FR-002 | The host agent must list managed sessions with name, id, cwd, backend, lifecycle state, last activity, status, attention level, and recent output summary. | Must | API/CLI contract tests for list output and dashboard rendering with fixture sessions. |
| FR-003 | The host agent must attach or expose enough tmux metadata for the user to inspect a managed session from the laptop when phone/dashboard control is insufficient. | Must | Manual tmux attach smoke test and task evidence showing a live managed session remains reachable. |
| FR-004 | The host agent must stop a managed session through an explicit user action and record the stop event. | Must | Adapter test for stop behavior plus audit-log assertion. |
| FR-005 | The dashboard must stream or refresh recent session output without requiring the user to reload the page. | Must | WebSocket or polling integration test plus browser inspection with changing fake output. |
| FR-006 | The dashboard must send normal text prompts to one selected managed session only. | Must | API test verifies exact session targeting; manual smoke test shows prompt appears in the selected tmux session. |
| FR-007 | The dashboard must expose primary slash-command controls for `/model`, `/goal`, and `/plan`. | Must | UI test verifies controls exist and API test verifies literal command injection for selected session. |
| FR-008 | The dashboard must expose utility slash-command controls for `/usage`, `/compact`, and `/skills`. | Must | UI test verifies controls exist and API test verifies literal command injection for selected session. |
| FR-009 | The host agent must classify basic session status and attention using conservative heuristics, including waiting for user, waiting for approval, running, idle, failed, and unknown. | Should | Unit tests over captured/fixture terminal output patterns plus manual review of unknown fallback behavior. |
| FR-010 | The dashboard must provide an advanced raw terminal fallback for a selected session, separate from the default conversation/control view. | Should | Responsive browser inspection verifies raw output is reachable but not the default session detail surface. |
| FR-011 | The V1 CLI surface must provide operations equivalent to `codexdeck serve`, `status`, `start --name <name> --cwd <path>`, `list`, `send <session> <text>`, `attach <session>`, `stop <session>`, `pair`, `lock`, `unlock`, `lan enable`, and `lan disable`. | Must | CLI contract tests cover each operation with fake Codex/tmux adapters; command reference is updated when command names finalize. |
| FR-012 | The V1 local API must provide session list/detail/output, session stream, prompt input, slash command input, session stop, host status, pairing/token claim, lock state, dashboard lock, and LAN state operations; unlock remains constrained to a local CLI/admin path. | Must | API contract tests verify method, route, auth requirement, request schema, response schema, and error schema for each operation. |
| FR-013 | Session output streaming must preserve terminal output order per session and expose monotonically increasing output cursors or equivalent replay markers. | Must | Stream integration test injects ordered fake output, reconnects from a cursor, and verifies no reordering or duplicate replay beyond documented behavior. |
| FR-014 | The host agent must reconcile managed session registry state with tmux on agent restart; unrecoverable sessions must be marked unavailable or stale rather than silently recreated. | Must | Restart integration test creates sessions, restarts the agent, verifies tmux-backed sessions remain listed, and verifies stale-session write attempts fail explicitly. |
| FR-015 | V1 write actions must target exactly one selected session; bulk prompt, bulk slash-command, and all-session operations are deferred. | Must | API and UI tests reject or omit multi-session write requests. |

## Non-Functional

| ID | Requirement | Priority | Validation |
| --- | --- | --- | --- |
| NFR-001 | HostDeck V1 must be local-first and must not require a hosted relay, cloud account, or public laptop listener. | Must | Configuration review and network smoke test showing default localhost bind. |
| NFR-002 | Session supervision must remain usable if the phone/browser disconnects; managed sessions must continue running under tmux. | Must | Manual disconnect/reconnect test with a long-running fake or real Codex session. |
| NFR-003 | Status and attention indicators must be advisory and visibly fall back to unknown when the agent cannot classify terminal output confidently. | Must | Unit tests for unrecognized output and UI inspection of unknown state. |
| NFR-004 | The dashboard must remain usable on phone-sized screens without relying on raw terminal width as the primary experience. | Must | Responsive browser screenshot/inspection at phone and desktop widths. |
| NFR-005 | The implementation must fail loudly for missing required binaries, invalid cwd, duplicate session names, invalid session ids, and malformed write requests. | Must | Negative CLI/API tests for each invalid condition. |
| NFR-006 | V1 must avoid hidden fallback behavior that pretends a command, write, or session state succeeded when the host agent could not prove it. | Must | Test assertions for explicit errors and manual review of failure surfaces. |
| NFR-007 | The host agent and dashboard must be testable without a live Codex account or real Codex model call by using a fake Codex command and fake or isolated tmux adapter. | Must | CI or local test command runs core lifecycle, output, input, status, and UI fixtures against fakes. |
| NFR-008 | The system must clearly separate durable local state from ephemeral process state. | Must | Architecture review plus restart tests verify registry, audit log, and pairing/token state are durable while live stream subscriptions are ephemeral. |
| NFR-009 | V1 must not require privileged OS access, root permissions, or router/firewall changes. | Must | Setup smoke test runs as a normal Ubuntu user and verifies default localhost operation. |

## Interface And UX

| ID | Requirement | Priority | Validation |
| --- | --- | --- | --- |
| IR-001 | The default dashboard surface must show session cards sorted by attention before alphabetical or creation order. | Must | UI test or screenshot evidence with mixed fixture statuses. |
| IR-002 | Each session card must show session name, project/cwd cue, branch when available, status, attention level, last activity, and recent meaningful output. | Must | Component test with fixture data plus responsive screenshot. |
| IR-003 | Session detail must prioritize recent Codex output, prompt input, and slash-command actions over raw terminal display. | Must | Screenshot evidence for session detail at phone width. |
| IR-004 | Risky controls, including stop and raw terminal input, must be visually separated from safe prompt and slash-command controls. | Must | UI inspection and component test for control grouping. |
| IR-005 | Write-disabled or unpaired clients must be able to read allowed session state but must not see enabled write controls. | Must | Browser/API test with read-only or untrusted client state. |
| IR-006 | The dashboard must provide clear empty, loading, disconnected, permission-denied, session-not-found, and agent-error states. | Must | Component or integration tests covering each state. |
| IR-007 | V1 UI copy must frame the product as a session mission-control dashboard, not a generic SSH terminal or code editor. | Should | Manual UX review against PRD non-goals. |
| IR-008 | Pairing/token, locked, read-only, and LAN-disabled states must be visible in the dashboard before the user attempts a write. | Must | Component tests and screenshot evidence for trusted, untrusted, locked, and LAN-disabled states. |
| IR-009 | Output truncation or replay boundaries must be visible when the dashboard is not showing the full terminal buffer. | Must | Component test with oversized fixture output verifies truncation marker or replay boundary copy appears. |

## Data

| ID | Requirement | Priority | Validation |
| --- | --- | --- | --- |
| DR-001 | Each managed session must have a stable unique id and human-readable name. | Must | Unit/API tests for session creation and duplicate-name handling. |
| DR-002 | Session records must include cwd, backend type, tmux target metadata, lifecycle state, status, attention level, last activity time, and recent output buffer metadata. | Must | Contract tests over session serialization. |
| DR-003 | Branch information should be captured when the cwd is inside a git worktree, without making git a hard requirement for non-git directories. | Should | Unit tests for git and non-git cwd fixtures. |
| DR-004 | Recent output must be bounded so one noisy session cannot grow storage or memory without limit. | Must | Unit/integration test for output retention cap. |
| DR-005 | Remote write actions must create audit events with timestamp, client identity or trust mode, session id, action type, and sanitized payload summary. | Must | API tests for prompt, slash-command, and stop audit events. |
| DR-006 | V1 must not store long-term cloud session history or sync session content outside the local host agent. | Must | Architecture review and configuration inspection. |
| DR-007 | The local session registry must persist enough information to reconnect to tmux-managed sessions after host-agent restart, including session id, name, cwd, backend type, tmux target, created time, and last known lifecycle state. | Must | Restart test verifies registry reload and tmux reconciliation. |
| DR-008 | Recent output buffers must record cursor/order metadata, capture time when available, truncation state, and source session id. | Must | Output-buffer unit tests verify ordered append, capped retention, truncation marker, and cursor replay. |
| DR-009 | Pairing/token state must be stored locally with client identity, permission mode, created time, last-used time when available, and revoked/locked state. | Must | Auth-state unit tests cover create, read, revoke, lock, unlock, and restart persistence. |
| DR-010 | Audit logs must be durable local records with bounded payload fields, retention policy, and explicit action types for prompt, slash command, stop, raw input, pair, lock, unlock, LAN enable, and LAN disable. | Must | Audit tests verify required action types, bounded payloads, and persistence after agent restart. |

## Platform And Environment

| ID | Requirement | Priority | Validation |
| --- | --- | --- | --- |
| PR-001 | The supported V1 host platform is Ubuntu with local Codex CLI and tmux installed. | Must | Developer-guide setup check and manual Ubuntu smoke test. |
| PR-002 | The host service must bind to localhost by default. | Must | Startup/config test verifying default bind address. |
| PR-003 | LAN access must require an explicit opt-in setting or command. | Must | Config/API test showing LAN bind is rejected or absent unless enabled. |
| PR-004 | The web dashboard must be served locally by the host agent or a documented local dev command. | Must | Manual smoke test opening the dashboard locally. |
| PR-005 | Phone access in V1 is through a mobile-responsive browser on a trusted local/LAN connection, not a native app. | Must | Responsive browser evidence and roadmap trace. |
| PR-006 | New managed `codex` sessions are required in V1; `codex resume`, arbitrary terminal discovery, and arbitrary existing terminal import are deferred unless later planning explicitly adds them. | Must | CLI/API tests cover new-session start; backlog defers resume/import work. |
| PR-007 | Startup must validate required binaries and configuration before accepting session start or write requests. | Must | Startup/config tests cover missing `tmux`, missing Codex executable, invalid state directory, invalid bind address, and duplicate ports. |
| PR-008 | The host agent must provide a documented foreground development mode and a documented long-running local service mode. | Must | Developer-guide commands and smoke tests cover starting, stopping, and checking host status in both modes. |
| PR-009 | V1 must support configurable local state directory and port values, with documented defaults. | Should | Config tests verify defaults and override behavior. |

## Safety And Failure

| ID | Requirement | Priority | Validation |
| --- | --- | --- | --- |
| SFR-001 | Write actions must require a one-user local pairing/token trust gate before the dashboard can send prompts, slash commands, stop requests, or raw terminal input. | Must | API authorization tests for trusted and untrusted clients. |
| SFR-002 | Read-only or untrusted clients must not be able to mutate session state. | Must | API tests reject write attempts without trust token. |
| SFR-003 | Stop session and raw terminal input must require explicit confirmation or advanced-mode entry. | Must | UI test verifies confirmation/advanced gate; API records risky action type. |
| SFR-004 | The agent must expose a local disable or lock action that blocks further dashboard writes until re-enabled. | Must | Integration test toggles lock and verifies write rejection. |
| SFR-005 | API and UI errors must preserve the true failure reason without swallowing command failures or reporting fake success. | Must | Negative tests assert non-2xx/API error payloads and visible UI error state. |
| SFR-006 | Sensitive data in audit logs must be minimized; prompt/slash audit payloads should use summaries or bounded snippets rather than full unbounded terminal content. | Should | Audit-log unit tests for truncation/sanitization. |
| SFR-007 | Pairing/token creation must produce a time-bounded local secret or equivalent trust artifact that can be revoked without deleting session history. | Must | Auth tests cover token expiry or one-time use, revocation, and continued read access where permitted. |
| SFR-008 | LAN enablement must be explicit, visible, and reversible through CLI/API controls. | Must | Config and audit tests verify LAN enable/disable changes bind behavior and records audit events. |
| SFR-009 | Raw terminal input must be disabled by default and require both trusted write permission and advanced-mode confirmation. | Must | UI/API tests verify default rejection and accepted advanced-mode writes are audited separately from prompt writes. |
| SFR-010 | The host agent must reject writes to stale, stopped, crashed, unknown, or unreconciled sessions instead of buffering them for possible later delivery. | Must | Negative API tests cover each non-writable session state. |
| SFR-011 | Test fixtures must include representative Codex-like outputs for questions, approval prompts, command running, tests passed, tests failed, compact/context warnings, idle/no-output, and unknown output. | Must | Heuristic unit tests cover every fixture category and assert expected status/attention classification. |

## Traceability

| Requirement | Block refs | Owner doc/section | Task refs | Test refs/evidence |
| --- | --- | --- | --- | --- |
| FR-001 through FR-015 | Pending block decomposition | Functional | Pending backlog | Planned in `docs/planning/04b-test-plan.md` |
| NFR-001 through NFR-009 | Pending block decomposition | Non-Functional | Pending backlog | Planned in `docs/planning/04b-test-plan.md` |
| IR-001 through IR-009 | Pending block decomposition | Interface And UX | Pending backlog | Planned in `docs/planning/04b-test-plan.md` |
| DR-001 through DR-010 | Pending block decomposition | Data | Pending backlog | Planned in `docs/planning/04b-test-plan.md` |
| PR-001 through PR-009 | Pending block decomposition | Platform And Environment | Pending backlog | Planned in `docs/planning/04b-test-plan.md` |
| SFR-001 through SFR-011 | Pending block decomposition | Safety And Failure | Pending backlog | Planned in `docs/planning/04b-test-plan.md` |
