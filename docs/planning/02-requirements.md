# Requirements

Owns stable requirements for the active version. A requirement is not complete until its production path and listed validation route are proven.

## Functional

| ID | Requirement | Priority | Validation |
| --- | --- | --- | --- |
| FR-001 | The host must start a named HostDeck-managed Codex thread in a validated cwd through the selected app-server runtime and return the stable Codex thread id only after startup is proven. | Must | Version-gated adapter test plus real Codex start smoke without fake process output. |
| FR-002 | Mission Control, API, and CLI must list managed sessions with alias, thread id, cwd/project, branch when available, lifecycle/turn status, attention, last activity, model/goal cue, and bounded recent summary. | Must | Contract/API/UI tests with mixed real and fixture states. |
| FR-003 | The local CLI must resume the exact managed thread in the normal Codex TUI through the private app-server endpoint. | Must | Real `codex resume --remote unix://PATH <thread-id>` smoke. |
| FR-004 | The user must be able to interrupt an active turn and archive a managed thread as distinct, explicit, audited actions. | Must | Protocol/API/CLI/UI tests prove interrupt does not imply archive or deletion. |
| FR-005 | The dashboard must receive ordered structured thread, turn, item, status, and approval updates without reloading. | Must | Real event-stream integration test plus browser inspection. |
| FR-006 | The dashboard must send one normal text prompt to exactly one selected thread and distinguish accepted, running, completed, interrupted, and failed outcomes. | Must | Exact-target API/protocol test and real Codex event smoke. |
| FR-007 | `/model`, `/goal`, and `/plan` must be primary controls implemented through tested structured Codex operations, not blind terminal-text injection. | Must | Capability/version tests plus UI/API integration for each control. |
| FR-008 | `/usage`, `/compact`, and `/skills` must be available as structured utility surfaces when the installed Codex capability exists. | Must | Capability tests verify supported, unavailable, and failure states. |
| FR-009 | HostDeck must derive session status and attention primarily from structured runtime events, using conservative heuristics only for explicitly unstructured fallback fields. | Must | Event projection tests and unknown-state regression tests. |
| FR-010 | Session Detail must expose bounded read-only event diagnostics and replay/truncation boundaries without exposing arbitrary phone shell input. | Must | Responsive UI and API projection tests. |
| FR-011 | The V1 CLI must provide runnable `serve`, `status`, `start`, `list`, `send`, `resume`, `interrupt`, `archive`, `pair`, `devices`, `revoke`, `lock`, `unlock`, `remote enable`, `remote status`, `remote disable`, and `service` operations. | Must | Packaged CLI contract tests and clean-install command smoke. |
| FR-012 | The local HostDeck API must provide host/runtime status, session start/list/detail/events/stream, prompt, structured controls, approval response, interrupt/archive, pairing/device/security, lock, and read-only remote-ingress state; profile switching and remote-ingress mutation remain explicit local CLI operations. | Must | Route manifest, schema, auth, failure, and integration tests. |
| FR-013 | Event streaming must preserve per-session order with monotonic HostDeck cursors, replay markers, and an explicit boundary whenever continuity cannot be proved. | Must | Concurrent replay/live handoff and retention-boundary tests. |
| FR-014 | On HostDeck or app-server restart, the host must reconcile durable mappings with persisted Codex threads, identify interrupted/stale projections, resubscribe to events, and reject ambiguous writes. | Must | Multi-process restart and partial-failure integration tests. |
| FR-015 | Every V1 mutation must identify exactly one thread, approval request, device, or host action; bulk operations are deferred. | Must | Contract tests reject missing, ambiguous, and multi-target writes. |
| FR-016 | Session Detail must render structured approval requests and support approve/deny for exactly one pending request with visible scope and an audit result. | Must | Real approval request/response/expiry integration plus phone UI test. |
| FR-017 | Startup must negotiate and record Codex runtime version/capabilities and reject unsupported schema or required-operation drift before accepting session mutations. | Must | Generated-schema checksum/version tests and incompatible-runtime smoke. |
| FR-018 | Foreground and service modes must supervise one dedicated app-server runtime and one loopback HostDeck API service, observe but not own `tailscaled`, and manage one private Serve mapping only through explicit local enable/disable without exposing app-server or HostDeck directly to LAN/public interfaces. | Must | Process ownership, profile/Serve change, crash, restart, duplicate-owner, and listener-inventory tests. |

## Non-Functional

| ID | Requirement | Priority | Validation |
| --- | --- | --- | --- |
| NFR-001 | V1 is local-first and requires no HostDeck cloud account, HostDeck-hosted relay, HostDeck telemetry service, or public HostDeck listener. A supported Tailscale account, saved personal profile, and client on laptop and phone are explicit prerequisites. | Must | Configuration, dependency, network, and privacy review. |
| NFR-002 | Codex work continues across phone, Tailscale, profile, and HostDeck-service disconnects; any work interrupted by app-server failure is labeled honestly and recoverable from persisted thread history. | Must | Browser/Tailscale/profile disconnect and independent service restart tests. |
| NFR-003 | Status and attention never infer healthy/completed from missing, stale, disconnected, or unknown data. | Must | Projection and UI unknown-state tests. |
| NFR-004 | Every V1 journey is usable at 360 x 800 CSS px; desktop is a responsive expansion of the same information architecture. | Must | Playwright and real-device screenshot/interaction evidence. |
| NFR-005 | Missing binaries, incompatible Codex/Tailscale, invalid cwd/config/origin/profile/Serve state, duplicate owner/name, malformed protocol/API data, and impossible state fail loudly. | Must | Negative startup, adapter, contract, protocol, and CLI tests. |
| NFR-006 | No fallback may claim a prompt, control, approval, audit, or lifecycle action succeeded without proof from its owning boundary. | Must | Partial-failure and response/audit consistency tests. |
| NFR-007 | Contracts, projections, UI, and most orchestration must be testable without a live model call; a bounded real-Codex suite proves the external boundary. | Must | Fake protocol fixtures plus opt-in real integration command. |
| NFR-008 | Codex owns full thread history; HostDeck owns only mappings, bounded event projections, trust/settings, and audit. Durable and ephemeral state are explicit. | Must | Storage review and restart tests. |
| NFR-009 | After a supported system Tailscale client is installed, HostDeck V1 runs as a normal Ubuntu user without HostDeck root privileges, router changes, or a HostDeck public/privileged listener. | Must | Clean Ubuntu prerequisite/setup/service smoke. |
| NFR-010 | Startup, readiness, degradation, graceful shutdown, and restart each have one process owner and bounded timeouts; duplicate daemons for one state directory fail. | Must | Lifecycle and daemon-lease tests. |
| NFR-011 | Request bodies, headers, open connections, event queues, subscriber counts, retained data, protocol requests, and CLI calls are bounded. | Must | Limit, overload, timeout, and backpressure tests. |
| NFR-012 | Runtime/client compatibility is explicit: supported Codex versions are pinned or ranged, generated schemas are traceable, and upgrade failures are actionable. | Must | Compatibility matrix artifact and upgrade/downgrade tests. |
| NFR-013 | HostDeck state/runtime/config directories, database files, sockets, and application secrets are owner-only or startup fails/repairs them observably; HostDeck never reads or stores Tailscale node keys. | Must | Permission, path, process, and raw-storage inspection. |

## Interface And UX

| ID | Requirement | Priority | Validation |
| --- | --- | --- | --- |
| IR-001 | The default phone route is Mission Control with attention ordering: approval, input, failure, stale/interrupted, running, quiet/completed. | Must | Mixed-state phone screenshot and ordering test. |
| IR-002 | Each session row shows name, project cue, status/attention, last activity, and bounded summary; branch/model/goal cues are secondary. | Must | Long-content component and responsive tests. |
| IR-003 | Session Detail prioritizes structured conversation/events, inline approval, composer, and `/model`, `/goal`, `/plan` over diagnostics. | Must | 390 x 844 screenshot and interaction evidence. |
| IR-004 | Interrupt, archive, approval, lock, revoke, and other risky controls are separated from routine prompt/model/goal actions and confirmed according to risk. | Must | Component semantics and confirmation tests. |
| IR-005 | Remote clients must pair before reading session data; read-only, write, expired, revoked, locked, remote-unavailable, and loopback-local states have distinct UI behavior. | Must | Browser/API permission-state tests. |
| IR-006 | UI covers empty, loading, offline, incompatible runtime, Tailscale disconnected, locally observed laptop-profile mismatch, remote origin unreachable, Serve/HTTPS unavailable, permission denied, not found, stale, boundary, degraded, and fatal host states without inventing a HostDeck diagnosis before the app can load. | Must | State matrix and screenshots. |
| IR-007 | Copy frames HostDeck as mobile session mission control, never as SSH, a terminal emulator, editor, or generic desktop operations console. | Must | UX review against PRD non-goals. |
| IR-008 | External origin, remote-ingress/profile state, pairing permission, lock, Codex compatibility, and stream health are visible before a write; the UI never claims it can switch the laptop profile remotely. | Must | Host/access state tests and screenshots. |
| IR-009 | Projection truncation, replay boundaries, redaction, and stale timestamps are visible and never imply complete history. | Must | Boundary fixture and UI tests. |
| IR-010 | The phone first viewport shows host/access state and useful session content; desktop-only navigation or controls cannot gate a V1 flow. | Must | Reference viewport screenshot audit. |
| IR-011 | Approval cards expose action, scope, reason, request state, and exact approve/deny result without duplicate submission. | Must | Accessibility, concurrency, and expired-request tests. |
| IR-012 | Structured control surfaces show current value, loading, unsupported, conflict, success, and failure states rather than behaving as decorative slash chips. | Must | Per-control component/API tests. |

## Data

| ID | Requirement | Priority | Validation |
| --- | --- | --- | --- |
| DR-001 | Each managed session has a HostDeck id, human alias, and stable Codex thread id; identity never depends on display text. | Must | Storage/contract uniqueness tests. |
| DR-002 | Session mappings include cwd/project, branch when available, runtime source/version, lifecycle/turn state, attention, activity, summary, and last event cursor. | Must | Migration and serialization tests. |
| DR-003 | Branch capture is optional and cannot make non-git directories fail. | Should | Git/non-git/missing-git tests. |
| DR-004 | Event projections are bounded per session by event count and bytes; pruning creates a visible replay boundary. | Must | Production retention invocation and boundary tests. |
| DR-005 | Every remote mutation creates an audit record with actor/device, target, action, bounded summary, accepted/result state, and error when applicable. | Must | API/protocol mutation audit assertions. |
| DR-006 | HostDeck stores no cloud copy or redundant full Codex transcript. | Must | Storage/privacy inspection. |
| DR-007 | Durable mappings contain enough information to reconcile and resume managed Codex threads after restart without inventing a new thread. | Must | Restart and missing-thread tests. |
| DR-008 | Projected events contain session id, HostDeck cursor, Codex event identity/type when available, capture time, bounded payload, redaction, and boundary metadata. | Must | Contract/storage ordering tests. |
| DR-009 | Device/pairing records include hashed secrets, identity/label, permission, creation/expiry/last-used/revoked data, and CSRF rotation state without raw durable tokens. | Must | Raw-storage and lifecycle tests. |
| DR-010 | Audit storage is durable and bounded by count/age with explicit types for pair, claim, revoke, lock/unlock, remote-ingress enable/disable, prompt/control, approval, interrupt, and archive; historical LAN/certificate rows remain readable but are not selected V1 actions. | Must | Migration, retention, restart, and type-coverage tests. |
| DR-011 | Runtime compatibility metadata records the observed Codex version, protocol/schema identity, negotiated capabilities, and last compatibility result. | Must | Startup/restart/upgrade tests. |

## Platform And Environment

| ID | Requirement | Priority | Validation |
| --- | --- | --- | --- |
| PR-001 | V1 supports Ubuntu with a locally authenticated, supported Codex CLI; tmux is not a product runtime requirement after migration. | Must | Clean Ubuntu compatibility smoke. |
| PR-002 | HostDeck and Codex app-server bind only user-private loopback/Unix transports. The separately installed `tailscaled` process may expose the configured private Serve endpoint, but HostDeck opens no LAN/public listener. | Must | Process/listener ownership and inventory tests. |
| PR-003 | Different-network V1 access requires an explicitly selected saved personal Tailscale profile and private Tailscale Serve HTTPS origin. HostDeck never switches profiles automatically, never configures the company profile, and offers no plaintext or manual-CA remote fallback. | Must | Profile-switch, Serve coexistence, origin, remote connectivity, and noninterference smoke. |
| PR-004 | The production host service serves the built dashboard and typed API from one origin. | Must | Packaged browser smoke. |
| PR-005 | V1 phone access uses a responsive browser through the selected Tailscale profile, including a real Android or iOS pass while the phone has no LAN route to the laptop. | Must | Cellular or unrelated-Wi-Fi device evidence. |
| PR-006 | V1 supports new HostDeck-managed threads and resuming those exact threads; arbitrary import remains deferred. | Must | Start/resume/import-rejection tests. |
| PR-007 | Startup validates Codex version/capabilities, HostDeck paths/socket/storage/listener ownership, and configured remote-ingress state. Wrong/disconnected Tailscale profile degrades remote availability without stopping local Codex work or mutating profile state. | Must | Startup, profile-change, degradation, and recovery matrix. |
| PR-008 | Foreground development and unprivileged long-running user-service modes share the same runtime contracts and have documented lifecycle commands. | Must | Foreground/service parity smoke. |
| PR-009 | State/runtime/config directories, loopback port, external Serve origin/port, selected-profile identity, retention, and timeouts have documented defaults and validated overrides; company profile metadata is not persisted beyond bounded comparison identity. | Must | Config/privacy tests and command reference. |
| PR-010 | App-server communicates only through a user-private local transport and is never the browser-facing trust boundary. | Must | Socket/listener inspection and architecture test. |
| PR-011 | Supported release browsers include current Chromium mobile/desktop and one second engine or an explicit release limitation. | Should | Browser matrix evidence. |
| PR-012 | V1 produces a runnable `codexdeck` package/binary entry, built web assets, and install/uninstallable user-service definitions. | Must | Clean build/package/install/uninstall smoke. |

## Safety And Failure

| ID | Requirement | Priority | Validation |
| --- | --- | --- | --- |
| SFR-001 | Every remote session read and mutation requires both admitted private Tailscale Serve ingress and a valid HostDeck-paired device with the required permission. | Must | Remote-ingress plus app-authorization tests. |
| SFR-002 | Read-only, unpaired, expired, revoked, locked, CSRF-invalid, wrong-profile, or untrusted-ingress clients cannot mutate; unauthorized remote clients cannot read metadata or events. | Must | Permission/profile/ingress matrix. |
| SFR-003 | Approval, interrupt, archive, lock, revoke, and other risky actions use explicit intent and risk-appropriate confirmation. | Must | UI/API/protocol confirmation tests. |
| SFR-004 | A paired writer or local CLI can lock remote mutations immediately; unlock remains local-admin only. | Must | Lock race and emergency-path tests. |
| SFR-005 | API/UI/CLI errors preserve the bounded true cause and whether retry is safe; success and audit results cannot contradict the owning operation. | Must | Partial-failure consistency tests. |
| SFR-006 | Audit summaries exclude raw secrets and unbounded prompt, output, command, or approval payloads. | Must | Sanitization and raw-storage inspection. |
| SFR-007 | Pairing codes are high-entropy, one-time, short-lived, rate-limited, and revocable without deleting session data. | Must | Brute-force/rate/lifecycle tests. |
| SFR-008 | Remote status is explicit, visible, and read-only. Remote enable/disable changes are explicit, reversible, and audited; they target only the currently active locally selected personal profile, preserve unrelated Serve configuration, and refuse ambiguity instead of switching profiles, repairing automatically, or resetting Tailscale globally. Disable closes HostDeck remote admission even when ownership-safe Serve cleanup cannot complete. | Must | CLI/config/profile/Serve/audit/fail-closed-disable and noninterference tests. |
| SFR-009 | V1 phone APIs and UI do not accept arbitrary raw shell/terminal input. | Must | Route manifest and UI absence tests. |
| SFR-010 | Mutations to missing, archived, stale, incompatible, unresolved, or non-writable targets reject instead of buffering for later delivery. | Must | State rejection matrix. |
| SFR-011 | Fixtures cover structured running, user input, approval, completed, interrupted, failed, compacting, rate limit, incompatible/unknown event, disconnect, and replay boundary cases. | Must | Fixture inventory test. |
| SFR-012 | Browser requests enforce the exact configured external HTTPS Host/Origin and a narrowly validated Tailscale Serve proxy context. Unknown or contradictory forwarding/identity headers, direct non-loopback access, DNS rebinding, wildcard credentialed CORS, and cross-origin mutations fail. Processes with access to the host loopback namespace are inside V1's explicit single-user host boundary; imitated proxy headers or Tailscale identity cannot manufacture paired remote authority, and local-admin request forms remain a separate policy. | Must | Direct-loopback, proxied Host/Origin/header/CORS/app-authorization security tests. |
| SFR-013 | Pair claim and mutation endpoints have bounded per-trusted-source/device rate and concurrency limits through the proxy; device list/revoke remains user accessible and proxy collapse cannot merge every remote caller silently. | Must | Trusted-source derivation, rate, concurrency, and revocation tests. |
| SFR-014 | A paired browser reload can obtain a fresh CSRF posture without exposing the device bearer token to JavaScript-readable durable storage. | Must | Reload/rotation/revocation browser tests. |
| SFR-015 | HostDeck state, application-secret, database, and socket permissions are owner-only, and one daemon lease protects each state directory; Tailscale state/key ownership remains external and untouched. | Must | Permission, process-boundary, and duplicate-daemon tests. |
| SFR-016 | Pair request/claim, revoke, lock/unlock, remote-ingress change, prompt/control, approval, interrupt, and archive record accepted plus terminal outcome or an explicit incomplete outcome after crash. | Must | Audit state-machine, migration, and crash tests. |
| SFR-017 | HTTP/SSE/protocol clients enforce body/header/request/idle/shutdown timeouts, backpressure, heartbeat, subscriber cleanup, and bounded queues. | Must | Slow-client, disconnect, overload, and shutdown tests. |
| SFR-018 | Remote cookies are Secure, HttpOnly, host-only, and SameSite=Strict where compatible; no write credential is issued through direct HTTP, untrusted proxy context, wrong origin, or non-HTTPS external transport. | Must | Browser/proxy header, cookie, and transport-rejection tests. |

## Traceability

| Requirement | Block refs | Task refs | Evidence route |
| --- | --- | --- | --- |
| FR-001 | `BLK-V1-01`, `BLK-V1-03`, `BLK-V1-04` | `FND-V1-015`, `INT-V1-003` to `INT-V1-006`, `INT-V1-027`, `IFC-V1-040` | Generated-schema, adapter, API/CLI, and real Codex start evidence. |
| FR-002 | `BLK-V1-01` to `BLK-V1-05` | `FND-V1-015`, `DAT-V1-018`, `INT-V1-017`, `IFC-V1-068`, `FE-V1-011` | Projection/API/UI tests and phone screenshots. |
| FR-003 | `BLK-V1-03`, `BLK-V1-04`, `BLK-V1-05` | `INT-V1-005`, `INT-V1-031`, `IFC-V1-060`, `FE-V1-038` | Exact-thread remote TUI and coexistence evidence. |
| FR-004 | `BLK-V1-03` to `BLK-V1-05` | `INT-V1-026`, `IFC-V1-045`, `IFC-V1-061`, `FE-V1-036`, `FE-V1-037` | Interrupt/archive protocol, audit, and UI tests. |
| FR-005 | `BLK-V1-03` to `BLK-V1-05` | `INT-V1-004`, `INT-V1-017`, `INT-V1-027`, `IFC-V1-023`, `IFC-V1-018`, `IFC-V1-034` to `IFC-V1-038`, `IFC-V1-078`, `IFC-V1-079`, `FE-V1-012`, `FE-V1-023` | Real event stream, remote SSE/profile-switch, and browser evidence. |
| FR-006 | `BLK-V1-01`, `BLK-V1-03` to `BLK-V1-05` | `FND-V1-015`, `INT-V1-018`, `INT-V1-027`, `IFC-V1-041`, `FE-V1-020` | Exact-thread prompt lifecycle tests. |
| FR-007 | `BLK-V1-01`, `BLK-V1-03` to `BLK-V1-05` | `FND-V1-015`, `INT-V1-019` to `INT-V1-021`, `IFC-V1-042`, `IFC-V1-062`, `IFC-V1-063`, `FE-V1-021`, `FE-V1-026`, `FE-V1-027` | Model/goal/plan capability and UI tests. |
| FR-008 | `BLK-V1-03` to `BLK-V1-05` | `INT-V1-022` to `INT-V1-024`, `IFC-V1-043`, `IFC-V1-064`, `IFC-V1-065`, `FE-V1-028` to `FE-V1-030` | Usage/compact/skills capability tests. |
| FR-009 | `BLK-V1-01`, `BLK-V1-03`, `BLK-V1-05` | `FND-V1-015`, `FND-V1-016`, `FND-V1-018`, `INT-V1-017`, `IFC-V1-036`, `FE-V1-015` | Structured projection, remote-health, and unknown-state tests. |
| FR-010 | `BLK-V1-04`, `BLK-V1-05` | `IFC-V1-069`, `FE-V1-014` | Read-only diagnostic projection and route-absence tests. |
| FR-011 | `BLK-V1-04`, `BLK-V1-06` | `IFC-V1-040` to `IFC-V1-045`, `IFC-V1-051`, `IFC-V1-054`, `IFC-V1-058` to `IFC-V1-065`, `IFC-V1-075`, `IFC-V1-076`, `REL-V1-003`, `REL-V1-006` | Packaged CLI, remote command, and clean-install matrix. |
| FR-012 | `BLK-V1-01`, `BLK-V1-04` | `FND-V1-015`, `FND-V1-018`, `IFC-V1-019`, `IFC-V1-022`, `IFC-V1-023`, `IFC-V1-026` to `IFC-V1-046`, `IFC-V1-059` to `IFC-V1-069`, `IFC-V1-073` to `IFC-V1-078`, `IFC-V1-091` | Route manifest, remote ingress/auth, failure, and hardening evidence. |
| FR-013 | `BLK-V1-01` to `BLK-V1-04` | `FND-V1-015`, `DAT-V1-020`, `DAT-V1-022`, `INT-V1-017`, `IFC-V1-023`, `IFC-V1-018`, `IFC-V1-034`, `IFC-V1-038`, `IFC-V1-078`, `IFC-V1-079`, `FE-V1-023` | Replay/live race, remote reconnect, retention, and cursor tests. |
| FR-014 | `BLK-V1-02` to `BLK-V1-04` | `DAT-V1-018`, `DAT-V1-024`, `DAT-V1-030`, `DAT-V1-031`, `INT-V1-028` to `INT-V1-032`, `IFC-V1-036` to `IFC-V1-038`, `IFC-V1-078` | Host/app-server/remote-ingress restart and reconciliation matrix. |
| FR-015 | `BLK-V1-01`, `BLK-V1-04`, `BLK-V1-05` | `FND-V1-015`, `IFC-V1-019`, `IFC-V1-040` to `IFC-V1-045`, `IFC-V1-059`, `IFC-V1-061` to `IFC-V1-064`, `IFC-V1-066`, `FE-V1-020` to `FE-V1-022`, `FE-V1-026` to `FE-V1-030`, `FE-V1-036`, `FE-V1-037` | Target-identity contract tests. |
| FR-016 | `BLK-V1-03` to `BLK-V1-05` | `INT-V1-025`, `INT-V1-027`, `IFC-V1-044`, `FE-V1-022` | Real approval and phone UI evidence. |
| FR-017 | `BLK-V1-01`, `BLK-V1-03` | `FND-V1-015`, `INT-V1-003`, `INT-V1-006`, `INT-V1-021`, `INT-V1-027`, `INT-V1-091` | Schema/version compatibility matrix. |
| FR-018 | `BLK-V1-03`, `BLK-V1-04`, `BLK-V1-06` | `INT-V1-007`, `INT-V1-028` to `INT-V1-032`, `IFC-V1-025`, `IFC-V1-037`, `IFC-V1-055`, `IFC-V1-058`, `IFC-V1-071`, `IFC-V1-072`, `IFC-V1-076`, `IFC-V1-078`, `REL-V1-006` | Process/listener/Tailscale ownership and service smoke. |
| NFR-001 | `BLK-V1-04`, `BLK-V1-06` | `IFC-V1-070`, `IFC-V1-079`, `REL-V1-005`, `REL-V1-006` | No-HostDeck-cloud/public-listener and prerequisite review. |
| NFR-002 | `BLK-V1-03`, `BLK-V1-04`, `BLK-V1-06` | `INT-V1-028` to `INT-V1-032`, `IFC-V1-034`, `IFC-V1-037`, `IFC-V1-038`, `IFC-V1-070`, `IFC-V1-071`, `IFC-V1-078`, `IFC-V1-079`, `REL-V1-006` | Runtime/Tailscale/profile disconnect and restart evidence. |
| NFR-003 | `BLK-V1-01`, `BLK-V1-05` | `FND-V1-016`, `FE-V1-015`, `FE-V1-090` | Unknown/stale tests and screenshots. |
| NFR-004 | `BLK-V1-05` | `FE-V1-002` to `FE-V1-004`, `FE-V1-016`, `FE-V1-039`, `FE-V1-040`, `FE-V1-017`, `FE-V1-090` | Reference viewport and real-device evidence. |
| NFR-005 | `BLK-V1-01` to `BLK-V1-04` | `FND-V1-016`, `FND-V1-018`, `INT-V1-003`, `INT-V1-091`, `IFC-V1-022`, `IFC-V1-019`, `IFC-V1-047`, `IFC-V1-070` to `IFC-V1-079`, `IFC-V1-091` | Negative startup/protocol/API/Tailscale/profile/Serve tests. |
| NFR-006 | `BLK-V1-01` to `BLK-V1-06` | `FND-V1-016`, `DAT-V1-020`, `DAT-V1-023`, `DAT-V1-032`, `INT-V1-017` to `INT-V1-032`, `IFC-V1-049`, `IFC-V1-050`, `IFC-V1-066`, `IFC-V1-072`, `IFC-V1-076`, `INT-V1-091`, `IFC-V1-091`, `REL-V1-007` | Partial-failure, Serve ownership, and aggregate hardening evidence. |
| NFR-007 | `BLK-V1-01`, `BLK-V1-03`, `BLK-V1-06` | `FND-V1-015`, `INT-V1-006`, `INT-V1-027`, `REL-V1-007` | Fake plus bounded real-Codex suites. |
| NFR-008 | `BLK-V1-02`, `BLK-V1-03` | `DAT-V1-018`, `DAT-V1-020`, `DAT-V1-022` to `DAT-V1-024`, `INT-V1-029`, `INT-V1-030` | Storage ownership and restart tests. |
| NFR-009 | `BLK-V1-04`, `BLK-V1-06` | `IFC-V1-021`, `IFC-V1-053` to `IFC-V1-058`, `IFC-V1-070`, `IFC-V1-079`, `REL-V1-006` | Normal-user install/Tailscale-prerequisite/service smoke. |
| NFR-010 | `BLK-V1-02` to `BLK-V1-04` | `DAT-V1-019`, `DAT-V1-024`, `DAT-V1-030`, `INT-V1-007`, `INT-V1-028` to `INT-V1-032`, `IFC-V1-025`, `IFC-V1-035` to `IFC-V1-038`, `IFC-V1-020`, `IFC-V1-047` to `IFC-V1-052`, `IFC-V1-071`, `IFC-V1-078` | Ownership, lease, observer, timeout, and shutdown tests. |
| NFR-011 | `BLK-V1-02` to `BLK-V1-04` | `DAT-V1-022`, `DAT-V1-024`, `DAT-V1-030`, `IFC-V1-022`, `IFC-V1-023`, `IFC-V1-035`, `IFC-V1-020`, `IFC-V1-047` to `IFC-V1-052`, `IFC-V1-071`, `IFC-V1-074`, `IFC-V1-079` | Resource/overload/remote-source matrix. |
| NFR-012 | `BLK-V1-03`, `BLK-V1-06` | `INT-V1-003`, `INT-V1-006`, `INT-V1-021`, `INT-V1-028`, `INT-V1-091`, `REL-V1-006` | Codex compatibility artifact. |
| NFR-013 | `BLK-V1-02`, `BLK-V1-04` | `DAT-V1-019`, `DAT-V1-031`, `DAT-V1-032`, `IFC-V1-070` to `IFC-V1-072`, `IFC-V1-079`, `REL-V1-005` | Permission/process boundary and raw-storage/log inspection. |
| IR-001 | `BLK-V1-04`, `BLK-V1-05` | `IFC-V1-068`, `FE-V1-004`, `FE-V1-011` | Attention-order fixture, API ordering, component test, and phone screenshot. |
| IR-002 | `BLK-V1-01`, `BLK-V1-02`, `BLK-V1-04`, `BLK-V1-05` | `FND-V1-015`, `DAT-V1-017`, `DAT-V1-018`, `IFC-V1-068`, `FE-V1-011` | Session-row contract and long-content screenshots. |
| IR-003 | `BLK-V1-05` | `FE-V1-004`, `FE-V1-012`, `FE-V1-020` to `FE-V1-030`, `FE-V1-022` | Session Detail component/API/screenshots. |
| IR-004 | `BLK-V1-04`, `BLK-V1-05` | `IFC-V1-030`, `IFC-V1-044`, `IFC-V1-045`, `IFC-V1-059`, `IFC-V1-061`, `IFC-V1-064`, `IFC-V1-066`, `FE-V1-022`, `FE-V1-029`, `FE-V1-036`, `FE-V1-037` | Risk grouping and confirmation tests. |
| IR-005 | `BLK-V1-02`, `BLK-V1-04`, `BLK-V1-05` | `DAT-V1-025`, `DAT-V1-026`, `DAT-V1-028`, `IFC-V1-026` to `IFC-V1-030`, `IFC-V1-059`, `IFC-V1-074`, `IFC-V1-077`, `IFC-V1-079`, `FE-V1-013`, `FE-V1-032`, `FE-V1-033` | Remote-ingress plus app-permission matrix and UI evidence. |
| IR-006 | `BLK-V1-01`, `BLK-V1-04`, `BLK-V1-05` | `FND-V1-018`, `IFC-V1-071`, `IFC-V1-078`, `FE-V1-004`, `FE-V1-015`, `FE-V1-019`, `FE-V1-023`, `FE-V1-025`, `FE-V1-034`, `FE-V1-035` | Complete local/runtime/remote/profile state-matrix tests/screenshots. |
| IR-007 | `BLK-V1-05`, `BLK-V1-06` | `FE-V1-018`, `REL-V1-004` | UX copy/non-goal review. |
| IR-008 | `BLK-V1-01`, `BLK-V1-04`, `BLK-V1-05` | `FND-V1-018`, `IFC-V1-026` to `IFC-V1-036`, `IFC-V1-039`, `IFC-V1-076`, `IFC-V1-078`, `FE-V1-013`, `FE-V1-033` to `FE-V1-035` | Host/access/remote state contract and screenshots. |
| IR-009 | `BLK-V1-02`, `BLK-V1-04`, `BLK-V1-05` | `DAT-V1-022`, `IFC-V1-034`, `IFC-V1-069`, `FE-V1-012`, `FE-V1-014`, `FE-V1-015`, `FE-V1-023` | Boundary/redaction/staleness tests. |
| IR-010 | `BLK-V1-05` | `FE-V1-002` to `FE-V1-004`, `FE-V1-010`, `FE-V1-011`, `FE-V1-016` | Reference-viewport mockup and implementation audit. |
| IR-011 | `BLK-V1-03` to `BLK-V1-05` | `INT-V1-025`, `IFC-V1-044`, `FE-V1-022` | Approval semantics, concurrency, accessibility, screenshots. |
| IR-012 | `BLK-V1-03` to `BLK-V1-05` | `INT-V1-019` to `INT-V1-024`, `IFC-V1-042`, `IFC-V1-043`, `IFC-V1-062` to `IFC-V1-065`, `FE-V1-021`, `FE-V1-026` to `FE-V1-030` | Per-control capability/state tests. |
| DR-001 | `BLK-V1-01`, `BLK-V1-02` | `FND-V1-015`, `DAT-V1-018` | Mapping identity and uniqueness tests. |
| DR-002 | `BLK-V1-01`, `BLK-V1-02`, `BLK-V1-04` | `FND-V1-015`, `DAT-V1-018`, `IFC-V1-068` | Migration/serialization/projection/API tests. |
| DR-003 | `BLK-V1-02`, `BLK-V1-05` | `DAT-V1-017`, `DAT-V1-018`, `FE-V1-011` | Git/non-git capture and session-row tests. |
| DR-004 | `BLK-V1-02`, `BLK-V1-04` | `DAT-V1-018`, `DAT-V1-022`, `DAT-V1-024`, `DAT-V1-091`, `IFC-V1-069` | Production retention, boundary, and read-route tests. |
| DR-005 | `BLK-V1-02`, `BLK-V1-04` | `DAT-V1-023`, `DAT-V1-032`, `IFC-V1-032`, `IFC-V1-040` to `IFC-V1-045`, `IFC-V1-059`, `IFC-V1-061` to `IFC-V1-064`, `IFC-V1-066`, `IFC-V1-072`, `IFC-V1-076` | Runtime and remote mutation accepted/result assertions. |
| DR-006 | `BLK-V1-02`, `BLK-V1-06` | `DAT-V1-018`, `DAT-V1-031`, `DAT-V1-032`, `REL-V1-005` | Transcript/Tailscale-secret absence inspection. |
| DR-007 | `BLK-V1-02`, `BLK-V1-03`, `BLK-V1-04` | `DAT-V1-018`, `DAT-V1-031`, `INT-V1-029`, `INT-V1-030`, `IFC-V1-078` | Restart mapping, remote-state, and missing-thread tests. |
| DR-008 | `BLK-V1-01`, `BLK-V1-02`, `BLK-V1-04` | `FND-V1-015`, `DAT-V1-018`, `DAT-V1-020`, `DAT-V1-022`, `INT-V1-017`, `IFC-V1-069` | Event contract/order/redaction/read tests. |
| DR-009 | `BLK-V1-02` | `DAT-V1-021`, `DAT-V1-025`, `DAT-V1-026`, `DAT-V1-028`, `DAT-V1-029` | Device/pairing/CSRF raw-storage and lifecycle tests. |
| DR-010 | `BLK-V1-02`, `BLK-V1-04` | `DAT-V1-023`, `DAT-V1-024`, `DAT-V1-027`, `DAT-V1-030`, `DAT-V1-032`, `IFC-V1-032`, `IFC-V1-075`, `IFC-V1-076` | Audit type/migration/outcome/retention/restart tests. |
| DR-011 | `BLK-V1-02`, `BLK-V1-03` | `DAT-V1-018`, `INT-V1-003` | Compatibility persistence tests. |
| PR-001 | `BLK-V1-03`, `BLK-V1-06` | `INT-V1-003`, `INT-V1-006`, `INT-V1-027`, `INT-V1-032`, `REL-V1-006` | Ubuntu real-Codex smoke. |
| PR-002 | `BLK-V1-04`, `BLK-V1-06` | `IFC-V1-017`, `IFC-V1-025`, `IFC-V1-058`, `IFC-V1-070`, `IFC-V1-073`, `IFC-V1-079`, `REL-V1-006` | Loopback/socket/Tailscale listener ownership inventory. |
| PR-003 | `BLK-V1-04`, `BLK-V1-06` | `IFC-V1-070`, `IFC-V1-072`, `IFC-V1-073`, `IFC-V1-076`, `IFC-V1-079`, `REL-V1-006` | Saved-profile/Serve HTTPS/noninterference and no-fallback evidence. |
| PR-004 | `BLK-V1-04`, `BLK-V1-06` | `IFC-V1-022`, `IFC-V1-024`, `IFC-V1-025`, `IFC-V1-046`, `IFC-V1-053`, `IFC-V1-058`, `IFC-V1-067`, `REL-V1-006` | Built same-origin dashboard smoke. |
| PR-005 | `BLK-V1-04` to `BLK-V1-06` | `IFC-V1-070`, `IFC-V1-079`, `FE-V1-016`, `FE-V1-040`, `FE-V1-017`, `FE-V1-090`, `REL-V1-006` | No-LAN-route real phone/browser evidence. |
| PR-006 | `BLK-V1-03`, `BLK-V1-04`, `BLK-V1-05` | `INT-V1-005`, `INT-V1-031`, `IFC-V1-040`, `IFC-V1-060`, `IFC-V1-061`, `FE-V1-038` | Managed start/resume/archive and import rejection. |
| PR-007 | `BLK-V1-02` to `BLK-V1-04` | `DAT-V1-019`, `DAT-V1-024`, `DAT-V1-030`, `DAT-V1-031`, `INT-V1-003`, `INT-V1-007`, `INT-V1-028`, `INT-V1-029`, `IFC-V1-025`, `IFC-V1-036`, `IFC-V1-071`, `IFC-V1-072`, `IFC-V1-078` | Local startup and remote-degradation/recovery matrix. |
| PR-008 | `BLK-V1-04`, `BLK-V1-06` | `IFC-V1-055` to `IFC-V1-058`, `REL-V1-006` | Foreground/user-service parity smoke. |
| PR-009 | `BLK-V1-02`, `BLK-V1-04`, `BLK-V1-06` | `DAT-V1-019`, `DAT-V1-031`, `IFC-V1-020`, `IFC-V1-054`, `IFC-V1-056`, `IFC-V1-070`, `IFC-V1-076`, `REL-V1-003` | Remote config defaults/override/privacy and command-reference tests. |
| PR-010 | `BLK-V1-03`, `BLK-V1-04` | `INT-V1-004`, `INT-V1-007`, `INT-V1-031`, `INT-V1-032`, `IFC-V1-025` | Private socket and listener inspection. |
| PR-011 | `BLK-V1-05`, `BLK-V1-06` | `FE-V1-040`, `REL-V1-007` | Browser matrix. |
| PR-012 | `BLK-V1-04`, `BLK-V1-06` | `IFC-V1-021`, `IFC-V1-053` to `IFC-V1-058`, `REL-V1-006` | Build/package/install/uninstall smoke. |
| SFR-001 | `BLK-V1-02`, `BLK-V1-04` | `DAT-V1-025`, `DAT-V1-026`, `DAT-V1-028`, `DAT-V1-029`, `IFC-V1-026`, `IFC-V1-028`, `IFC-V1-073`, `IFC-V1-074`, `IFC-V1-077`, `IFC-V1-079`, `IFC-V1-059`, `REL-V1-005` | Admitted Serve ingress plus paired-device authorization tests. |
| SFR-002 | `BLK-V1-02`, `BLK-V1-04`, `BLK-V1-05` | `DAT-V1-028`, `DAT-V1-029`, `IFC-V1-026`, `IFC-V1-029`, `IFC-V1-030`, `IFC-V1-059`, `IFC-V1-073`, `IFC-V1-074`, `IFC-V1-079`, `FE-V1-013` | Ingress/profile/permission/revocation/lock matrix. |
| SFR-003 | `BLK-V1-04`, `BLK-V1-05` | `IFC-V1-026`, `IFC-V1-027`, `IFC-V1-030`, `IFC-V1-044`, `IFC-V1-045`, `IFC-V1-059`, `IFC-V1-061`, `IFC-V1-064`, `IFC-V1-066`, `FE-V1-022`, `FE-V1-029`, `FE-V1-036`, `FE-V1-037` | Intent/confirmation/API/UI tests. |
| SFR-004 | `BLK-V1-02`, `BLK-V1-04`, `BLK-V1-05` | `DAT-V1-023`, `DAT-V1-027`, `IFC-V1-030`, `FE-V1-033` | Lock race and local unlock tests. |
| SFR-005 | `BLK-V1-01`, `BLK-V1-02`, `BLK-V1-04` | `FND-V1-016`, `DAT-V1-023`, `IFC-V1-049`, `IFC-V1-050`, `IFC-V1-066`, `IFC-V1-091` | Failure cause/response/audit consistency tests. |
| SFR-006 | `BLK-V1-02`, `BLK-V1-04`, `BLK-V1-06` | `DAT-V1-023`, `DAT-V1-027`, `DAT-V1-032`, `IFC-V1-032`, `IFC-V1-072`, `IFC-V1-076`, `IFC-V1-077`, `IFC-V1-059`, `REL-V1-005` | HostDeck/Tailscale/pairing sanitization and raw-storage/log inspection. |
| SFR-007 | `BLK-V1-02`, `BLK-V1-04` | `DAT-V1-026`, `DAT-V1-027`, `DAT-V1-028`, `DAT-V1-032`, `IFC-V1-028`, `IFC-V1-032`, `IFC-V1-074`, `IFC-V1-077`, `IFC-V1-059` | Pair entropy/fragment/one-time/expiry/rate/revoke tests. |
| SFR-008 | `BLK-V1-02`, `BLK-V1-04`, `BLK-V1-05` | `DAT-V1-031`, `DAT-V1-032`, `IFC-V1-070`, `IFC-V1-072`, `IFC-V1-075`, `IFC-V1-076`, `IFC-V1-079`, `FE-V1-034` | Profile-safe remote CLI/audit/Serve ownership/UI evidence. |
| SFR-009 | `BLK-V1-04`, `BLK-V1-05` | `FND-V1-015`, `IFC-V1-019`, `IFC-V1-046`, `IFC-V1-067`, `IFC-V1-069`, `FE-V1-014`, `FE-V1-038` | Route manifest and UI absence checks. |
| SFR-010 | `BLK-V1-01`, `BLK-V1-03`, `BLK-V1-04` | `FND-V1-016`, `INT-V1-018`, `INT-V1-026`, `IFC-V1-041`, `IFC-V1-045`, `IFC-V1-061`, `IFC-V1-064`, `IFC-V1-066` | Non-writable target rejection matrix. |
| SFR-011 | `BLK-V1-01`, `BLK-V1-03` | `FND-V1-015`, `INT-V1-006`, `INT-V1-017` | Structured fixture inventory and real-event comparison. |
| SFR-012 | `BLK-V1-04` | `IFC-V1-017`, `IFC-V1-070`, `IFC-V1-073`, `IFC-V1-079` | Direct/proxied Host/Origin/header/CORS/DNS-rebinding/app-authorization tests, including the explicit host-local-process boundary. |
| SFR-013 | `BLK-V1-02`, `BLK-V1-04` | `DAT-V1-025`, `DAT-V1-026`, `DAT-V1-028`, `IFC-V1-028`, `IFC-V1-029`, `IFC-V1-048`, `IFC-V1-049`, `IFC-V1-059`, `IFC-V1-070`, `IFC-V1-074`, `IFC-V1-079` | Trusted-source pair/mutation rate, concurrency, and revoke tests. |
| SFR-014 | `BLK-V1-02`, `BLK-V1-04`, `BLK-V1-05` | `DAT-V1-021`, `DAT-V1-028`, `IFC-V1-027`, `IFC-V1-059`, `IFC-V1-074`, `IFC-V1-077`, `FE-V1-024`, `FE-V1-031` | CSRF reload/rotation/revocation/profile-switch browser tests. |
| SFR-015 | `BLK-V1-02`, `BLK-V1-04` | `DAT-V1-019`, `DAT-V1-031`, `IFC-V1-071`, `IFC-V1-072`, `IFC-V1-055`, `IFC-V1-057`, `IFC-V1-079` | Filesystem/socket/lease and external-Tailscale ownership tests. |
| SFR-016 | `BLK-V1-02`, `BLK-V1-04` | `DAT-V1-023`, `DAT-V1-024`, `DAT-V1-027`, `DAT-V1-030`, `DAT-V1-032`, `IFC-V1-032`, `IFC-V1-037`, `IFC-V1-040` to `IFC-V1-045`, `IFC-V1-049`, `IFC-V1-059`, `IFC-V1-061` to `IFC-V1-064`, `IFC-V1-066`, `IFC-V1-072`, `IFC-V1-076` | Runtime/remote audit outcome and crash matrix. |
| SFR-017 | `BLK-V1-04`, `BLK-V1-06` | `IFC-V1-022`, `IFC-V1-023`, `IFC-V1-025`, `IFC-V1-035`, `IFC-V1-037`, `IFC-V1-047` to `IFC-V1-052`, `IFC-V1-070`, `IFC-V1-078`, `IFC-V1-079`, `REL-V1-005` | Slow-client, remote disconnect, overload, heartbeat, and shutdown tests. |
| SFR-018 | `BLK-V1-04`, `BLK-V1-05`, `BLK-V1-06` | `IFC-V1-027`, `IFC-V1-028`, `IFC-V1-070`, `IFC-V1-073`, `IFC-V1-077`, `IFC-V1-079`, `FE-V1-034`, `REL-V1-005` | External HTTPS/proxy/Secure-cookie and direct-HTTP rejection tests. |
