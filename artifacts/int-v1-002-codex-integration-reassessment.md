# INT-V1-002 Codex Integration Reassessment

Date: 2026-07-09

## Question

Should HostDeck V1 continue controlling one Codex TUI per tmux pane and infer state from terminal output, or move to the Codex app-server protocol intended for rich clients?

## Decision Status

- Recommendation: use Codex app-server as the primary V1 integration behind a HostDeck adapter.
- Transport: local Unix socket between HostDeck and app-server; do not expose app-server directly to LAN clients.
- Laptop control: resume the same Codex thread through the normal TUI with `codex resume --remote unix://PATH <thread-id>`.
- Existing tmux adapter: retain as legacy/fallback code until the structured vertical slice passes; do not build new V1 behavior on terminal scraping.
- Final migration gate: a real app-server turn, approval, interrupt, reconnect, process-restart, schema-drift, and multi-client test must pass before the tmux runtime is removed or declared deferred.

## Why The Previous Proof Is Insufficient

- `INT-V1-001` and `INT-V1-016` proved tmux mechanics with a fake Codex producer. They did not prove the actual interactive Codex TUI, alternate-screen behavior, slash-command menus, approvals, structured status, or compatibility across Codex releases.
- Terminal text is a presentation surface. Parsing it duplicates state already exposed by Codex and makes correctness depend on copy, layout, ANSI behavior, and terminal width.
- The current production service does not supervise or fan out live tmux output without test-only injection, so the apparent tmux completion is package-level rather than a working product path.

## Official Interface Findings

The current Codex documentation describes app-server as the interface for rich clients and exposes authentication, thread history, approvals, structured runtime status, and streamed agent events. The protocol includes thread start/list/read/resume, turn start/steer/interrupt, item deltas, approval requests, model listing, goal operations, compact operations, skills, account usage, and version-specific schema generation.

The CLI still labels `app-server` experimental. HostDeck must therefore pin and probe a supported Codex version, commit or checksum generated protocol bindings, reject incompatible versions, and keep the adapter boundary narrow.

## Local Compatibility Evidence

Environment:

- Ubuntu 24.04.4 LTS
- `codex-cli 0.144.0`
- Node.js 22.22.2

Validated without a model call:

1. `codex app-server generate-ts --out <temp-dir>` generated version-specific protocol bindings.
2. A stdio client completed `initialize` / `initialized` and successfully called `model/list` and `thread/list`.
3. A persisted empty thread was created with `thread/start`, given a goal with `thread/goal/set`, read with `thread/goal/get`, and removed with `thread/delete`.
4. `codex --remote ws://127.0.0.1:<port>` opened the normal Codex TUI against the same app-server process.
5. `codex --remote unix:///run/user/<uid>/<socket>` opened the normal Codex TUI over a user-private Unix socket.
6. The npm-installed Codex CLI could not use `codex app-server daemon start`; that daemon command currently requires the standalone Codex installation. HostDeck cannot make the managed daemon a universal prerequisite.

## Recommended V1 Runtime

### Foreground Development

- `codexdeck serve` starts one dedicated `codex app-server --listen unix://...` child process in the user runtime directory.
- HostDeck connects through a dedicated app-server client adapter and normalizes protocol events into HostDeck contracts.
- Shutdown closes HostDeck clients and the child app-server explicitly; active-turn interruption is visible.

### Long-Running Local Service

- Install two unprivileged user services: one for the dedicated app-server process and one for HostDeck.
- HostDeck depends on the app-server Unix socket but does not own app-server termination during a HostDeck-only restart.
- The app-server unit uses the user runtime directory for the socket and the normal Codex home for authenticated thread state.
- A packaged service command must install, inspect, start, stop, and uninstall these units without root.

### Session Model

- A HostDeck managed session maps to a Codex thread id and app-server runtime metadata, not to a tmux pane.
- Codex remains the source of truth for conversation history, turn status, approvals, model, goal, and thread lifecycle.
- HostDeck stores only its alias/project projection, bounded event/output projection, attention state, trust/audit data, and compatibility metadata.
- Laptop fallback resumes the exact thread by id through the local Unix socket.

## Required Follow-Up Proof

- Generate and validate bindings for the pinned Codex version in CI/local validation.
- Prove a real turn streams ordered item deltas and reaches a terminal status.
- Prove approval request, approval response, denial, interrupt, and reconnect behavior.
- Prove one app-server process supports HostDeck plus a TUI client without event loss or thread corruption.
- Prove app-server process restart preserves persisted thread history and exposes interrupted/stale active work honestly.
- Define upgrade policy for additive and breaking schema changes.
- Map `/model`, `/goal`, `/plan`, `/usage`, `/compact`, and `/skills` to structured protocol operations; block or omit any control without a tested semantic equivalent.
- Measure event volume and choose bounded replay/projection retention.

## Rejected Alternatives

| Alternative | Reason |
| --- | --- |
| Keep tmux/TUI scraping as the primary V1 runtime | Brittle presentation parsing, duplicate status inference, fake-Codex evidence, and missing production live integration. |
| Expose app-server WebSocket directly to the phone | App-server is not HostDeck's public trust boundary; direct exposure bypasses HostDeck pairing, audit, rate limits, and transport policy. |
| Depend on `codex app-server daemon` | The local npm installation failed the daemon prerequisite, and the command remains experimental. |
| Support app-server and tmux as equal V1 backends | Doubles lifecycle, write, stream, test, and failure-state scope before one production path is complete. |
| Use a hosted relay for V1 | Conflicts with the approved local-first V1 scope. |

## Consequences

- Previously completed tmux tasks remain valid engineering evidence but no longer prove the selected product integration.
- Requirements, block 03, the implementation blueprint, and downstream API/UI tasks must be rebaselined around structured thread/turn events.
- UI mockups must be regenerated only after the mobile information architecture and structured state model are updated.
- V1 remains no-go until the follow-up structured vertical slice and encrypted phone transport decision pass.
