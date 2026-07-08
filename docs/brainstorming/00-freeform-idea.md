# Freeform Idea

Use this for rough notes, pasted references, sketches, incomplete thoughts, or one paragraph describing the app idea.

Everything here is optional. Write naturally. It is okay to leave sections blank, write `idk`, paste messy notes, or ignore the headings.

In `/plan` mode, the AI should read this file, ask focused follow-up questions, suggest missing product details, recommend choices when the human is unsure, and turn the rough idea into the planning docs.

## Notes

# Brainstorm: Mobile Control App for Many Codex CLI Sessions on Ubuntu
name: HostDeck
target v1: android only

## 1. Core idea

We want to build a phone app that lets a user monitor and control multiple active Codex CLI sessions running on an Ubuntu laptop.

Today, the workflow is:

```text
Open several terminals on laptop
Run codex or codex resume in each terminal
Each terminal becomes a separate working Codex session
Switch between terminals manually
Watch outputs
Send prompts or slash commands like /usage, /compact, /skills
```

The desired workflow is:

```text
Open phone app
See all active Codex sessions
Know which sessions need attention
Tap into any session
Read output
Send prompts
Send slash commands
Use voice input
Continue working while away from laptop
```

The product should not feel like a generic SSH terminal app. It should feel like a **mobile mission-control interface for many Codex agents**.

The core product promise:

> Supervise and steer all your local Ubuntu Codex sessions from your phone, without needing your laptop in front of you.

## 2. Important context

Codex CLI runs locally on the user’s computer, and OpenAI’s Codex GitHub README lists Linux install targets, including x86_64 and arm64 Linux binaries.

OpenAI also has official Codex mobile/remote support, but the current remote setup is centered on the Codex App host flow. The official remote-connection docs say mobile setup supports Codex App hosts on macOS and Windows, and that mobile setup starts from the Codex App, not from Codex CLI or the IDE extension.

That creates a useful product gap:

```text
Ubuntu-first
CLI-native
Existing terminal-session oriented
Local Whisper-style voice transcription
Power-user focused
Many-session dashboard
```

This product should not try to compete with the official Codex app directly. It should focus on a different workflow:

> “I already run many Codex CLI sessions in terminals on Ubuntu. Give me a mobile control plane for them.”

## 3. Main architectural decision

The best architecture is:

```text
Phone app
   ⇅
Laptop host agent / daemon
   ⇅
Codex CLI sessions
```

Not:

```text
Phone app
   ⇅
Codex CLI sessions directly
```

The laptop-side component is essential because Codex sessions live inside the laptop’s local environment: terminals, shell state, working directories, git repos, files, credentials, approvals, local tests, and local commands.

The phone should be a **remote control and monitoring UI**.

The laptop agent should be the **local authority** that owns session discovery, session control, output streaming, voice transcription, auth, and connection management.

## 4. Product framing

Possible product names:

```text
Codex Deck
Codex Mission Control
Codex Remote
Codex Console
Codex Pilot
Codex Bridge
CodexHost
CodexBoard
```

The cleanest framing:

> A local Ubuntu Codex session manager with mobile clients.

Or:

> A phone-friendly control plane for many local Codex CLI sessions.

Avoid framing it as:

> A phone terminal app.

Because the winning UX is not “tiny terminal on phone.” The winning UX is:

> A dashboard that tells you what each Codex session is doing and which session needs you next.

## 5. Recommended system architecture

```text
                 ┌─────────────────────┐
                 │      Phone app       │
                 │                     │
                 │ Session list         │
                 │ Chat view            │
                 │ Voice capture        │
                 │ Notifications        │
                 │ Slash commands       │
                 └──────────┬──────────┘
                            │
                            │ HTTPS / WebSocket
                            │
                 ┌──────────▼──────────┐
                 │   Relay / Tunnel     │
                 │ Optional for remote   │
                 │ long-distance access  │
                 └──────────┬──────────┘
                            │
                            │ Outbound connection
                            │ from laptop
                            │
┌───────────────────────────▼───────────────────────────┐
│                 Ubuntu laptop host agent               │
│                                                       │
│ Session registry                                      │
│ tmux / PTY manager                                    │
│ Output streamer                                       │
│ Input injector                                        │
│ Slash command sender                                  │
│ Status detector                                       │
│ Local voice transcription                             │
│ Auth and pairing                                      │
│ Audit log                                             │
│ Local API                                             │
└───────────────┬───────────────────────┬───────────────┘
                │                       │
        ┌───────▼───────┐       ┌───────▼───────┐
        │ Codex session │       │ Codex session │
        │ backend-auth  │       │ frontend-bug  │
        └───────────────┘       └───────────────┘
```

## 6. Laptop host agent

The laptop host agent is the most important part of the product.

It should run on Ubuntu and manage all Codex sessions.

Possible command-line interface:

```bash
codexdeck start --name backend-auth --cwd ~/repo/backend
codexdeck start --name frontend-layout --cwd ~/repo/frontend
codexdeck list
codexdeck send backend-auth "run tests and fix failures"
codexdeck send backend-auth "/usage"
codexdeck attach backend-auth
codexdeck stop frontend-layout
codexdeck pair
```

The host agent should handle:

```text
- Starting Codex sessions
- Resuming Codex sessions
- Listing sessions
- Naming sessions
- Grouping sessions by project
- Streaming terminal output
- Sending prompts
- Sending slash commands
- Detecting whether a session needs attention
- Recording recent outputs
- Receiving voice audio from phone
- Running local transcription
- Sending transcripts into selected sessions
- Managing phone pairing
- Maintaining an audit log
```

The host agent can later expose a desktop tray app or GUI, but for v1, the important part is the daemon and API.

## 7. Session backend: tmux or PTY

There are two main implementation choices.

### Option A: tmux-backed sessions

This is probably the best v1 choice.

tmux is designed for long-running detachable terminal sessions. It lets terminal programs keep running in the background and later be reattached from another terminal.

tmux also has a control mode, which allows an application to talk to tmux through a text protocol rather than drawing a normal terminal UI.

That makes tmux attractive because you get:

```text
- Detachable sessions
- Persistence after phone disconnects
- Existing user familiarity
- Ability to attach from laptop manually
- Better debugging
- Compatibility with current terminal workflows
```

Possible model:

```text
tmux session: codexdeck
  window 1: backend-auth
  window 2: frontend-layout
  window 3: docs-update
```

The daemon can use tmux commands to capture output and send input.

### Option B: direct PTY-managed sessions

The daemon directly creates pseudo-terminals and runs `codex` inside them.

Advantages:

```text
- More control
- Cleaner internal architecture
- No tmux dependency
- Easier to model sessions as first-class objects
```

Disadvantages:

```text
- More work
- Harder to debug manually
- Need to implement session persistence carefully
- Less compatible with users’ existing habits
```

### Recommended choice

For v1:

```text
Use tmux first.
Add direct PTY support later if needed.
```

tmux gives you a strong prototype path and matches the user’s current “many terminals” workflow.

## 8. Should it support arbitrary existing terminals?

Eventually, maybe.

For v1, probably not.

Trying to attach to random existing GNOME Terminal windows, shell processes, and Codex sessions will be brittle. Instead, require sessions to be launched or imported through your system.

Recommended v1 rule:

```text
Sessions must be created by codexdeck or imported from tmux.
```

Examples:

```bash
codexdeck start --name api-refactor --cwd ~/project/api
codexdeck import-tmux --session my-existing-tmux-session
```

Later, you can add discovery:

```text
Detected possible Codex sessions:
- pid 1234 in ~/repo/backend
- pid 5678 in ~/repo/frontend

Import these?
```

But that should not be the foundation.

## 9. Session data model

Each session should have structured metadata.

Example:

```json
{
  "id": "sess_123",
  "name": "backend auth bug",
  "project": "myapp/backend",
  "cwd": "/home/user/myapp/backend",
  "git_branch": "fix-auth-timeout",
  "status": "waiting_for_user",
  "last_activity": "2026-07-08T14:25:00",
  "last_output": "I found two possible causes...",
  "attention_level": "needs_input",
  "backend": "tmux",
  "tmux_session": "codexdeck",
  "tmux_window": "backend-auth"
}
```

Useful statuses:

```text
Idle
Thinking
Running command
Editing files
Waiting for approval
Waiting for user input
Tests running
Tests failed
Tests passed
Command failed
Compacting
Disconnected
Crashed
Unknown
```

Useful attention levels:

```text
No attention needed
Watch
Needs input
Needs approval
Failed
Completed
Stuck
```

This status model is one of the biggest product advantages over a raw terminal.

## 10. Phone app concept

The phone app should have three core surfaces:

```text
1. Mission Control
2. Session Detail
3. Voice Command
```

## 11. Mission Control screen

The home screen should show all sessions as cards.

Example:

```text
Backend API
  🟡 backend-auth        Waiting for input
  🟢 migration-cleanup   Running tests
  ⚪ docs-update         Idle

Frontend
  🔴 mobile-layout       Command failed
  🟢 dark-mode           Codex editing files

Infra
  🟡 deploy-script       Waiting for approval
```

Each card should show:

```text
- Session name
- Project/repo
- Branch
- Status
- Last meaningful output
- Last activity time
- Attention indicator
- Quick actions
```

Quick actions:

```text
Prompt
Voice
/usage
/compact
/skills
Terminal
Stop
Pin
```

Important UX rule:

```text
Sort by attention, not alphabetically.
```

The sessions that need the user should float to the top.

Suggested grouping options:

```text
Group by project
Group by status
Group by branch
Group by pinned sessions
Group by recent activity
```

## 12. Session Detail screen

The detail screen should feel more like a chat/control thread than a raw terminal.

Example:

```text
backend-auth
Status: Waiting for input
Branch: fix-auth-timeout
CWD: ~/myapp/backend

Codex:
I found two likely causes:

1. Session cookie expires too early.
2. Refresh endpoint rejects rotated tokens.

Which path should I try first?

[Type a reply...]

Buttons:
[Voice] [/usage] [/compact] [/skills] [Approve] [Terminal]
```

This view should show:

```text
- Recent Codex messages
- User prompts sent from phone
- Important terminal output
- Current status
- Quick slash commands
- Approval prompts
- Voice button
```

Then provide an advanced raw terminal mode:

```text
Advanced terminal
  Full terminal stream
  Send raw input
  Send Ctrl+C
  Copy last output
  Reconnect
```

The phone-first abstraction should be:

```text
Codex conversation first.
Raw terminal second.
```

## 13. Slash command support

Codex CLI supports slash commands for controlling interactive sessions. The official docs describe slash commands as keyboard-first controls that can switch models, adjust permissions, summarize long conversations, check status, and more.

Codex CLI also supports specialized workflows and reusable/custom prompts through slash commands.

For this product, slash commands should become native phone buttons.

Examples:

```text
/usage
/compact
/skills
/status
/model
/permissions
/review
/fork
/side
/stop
```

Implementation options:

### Simple v1

Phone sends the literal text:

```text
/usage\n
```

The laptop agent injects that into the terminal.

### Cleaner later version

Phone sends structured command:

```json
{
  "type": "slash_command",
  "session_id": "sess_123",
  "command": "usage"
}
```

Then the agent translates it into the correct terminal input.

Recommended v1:

```text
Send literal slash commands.
```

It is simpler and closer to how users already interact with Codex.

## 14. Voice mode

The voice mode idea is strong.

Recommended flow:

```text
Phone records audio
   → sends audio packet to laptop
   → laptop runs local transcription
   → transcript returns to phone
   → user reviews/edits transcript
   → user taps Send
   → laptop agent sends text into selected Codex session
```

This is better than sending voice directly into Codex without confirmation.

Whisper is a general-purpose speech recognition model that supports multilingual speech recognition, translation, and language identification.

For local laptop inference, whisper.cpp is also relevant because it provides a C/C++ implementation of Whisper-style ASR with Linux support and CPU-only inference support.

Recommended v1 voice interaction:

```text
Hold to talk
Release to transcribe
Review transcript
Tap Send
```

Do not auto-send voice commands in v1.

Reasons:

```text
- Transcription can be wrong
- Coding commands can be destructive
- Codex may run shell commands
- User should confirm intent
```

Useful voice commands later:

```text
“Send this to backend-auth.”
“Ask the frontend session to run tests.”
“Compact all idle sessions.”
“Show sessions waiting for me.”
“Read me the last answer from deploy-script.”
“Approve that command.”
“Stop the session that is stuck.”
```

For v1, keep it simple:

```text
Voice input becomes editable text.
The user chooses the session.
The user confirms Send.
```

## 15. Remote long-distance connection

For one user, the safest design is:

```text
Laptop makes outbound connection to relay.
Phone connects to relay.
Relay links phone and laptop.
```

Avoid requiring the laptop to expose a public port.

Recommended model:

```text
Laptop agent  →  secure relay  ←  phone app
```

The laptop should initiate the connection outward. This avoids router setup, port forwarding, and direct public exposure.

Possible connection options:

```text
1. Hosted relay
2. Self-hosted relay
3. Tailscale / WireGuard-style private network
4. SSH reverse tunnel
5. Local-only mode
```

Recommended for v1:

```text
Start with local-only mode.
Then add relay mode.
```

Development sequence:

```text
1. Localhost API
2. Local web dashboard
3. LAN access
4. Auth and pairing
5. Relay access
6. Native phone app
```

## 16. Pairing flow

Pairing should be simple.

Laptop:

```bash
codexdeck pair
```

Laptop displays:

```text
Scan this QR code with the phone app.
Code expires in 2 minutes.
```

Phone scans QR code.

Pairing creates:

```text
- Device identity
- Public/private key pair
- Laptop identity
- Session token
- Relay routing ID
```

After pairing:

```text
Phone appears in laptop settings:
- Simon’s iPhone
- Paired July 8, 2026
- Last connected 2 minutes ago
- Permissions: Read + Write
```

The laptop should have a panic command:

```bash
codexdeck lock
codexdeck unpair-all
```

## 17. Security requirements

Security must be part of v1 because the app can send input into real terminals.

Minimum v1 security:

```text
- Pairing required before phone can connect
- Device-specific keys
- TLS for network traffic
- No unauthenticated public listener
- Laptop agent binds to localhost by default
- Explicit opt-in for relay mode
- Audit log of remote actions
- Read-only mode
- Write mode
- Confirm risky actions
- Easy disable button
```

Useful permission modes:

```text
Read only
  Phone can view sessions but cannot send input.

Prompt mode
  Phone can send normal prompts.

Slash mode
  Phone can send approved slash commands.

Raw terminal mode
  Phone can send arbitrary terminal input.

Admin mode
  Phone can start/stop sessions and change settings.
```

For v1, default to:

```text
Read + prompt + safe slash commands.
Raw terminal input hidden under advanced mode.
```

Risky inputs should require confirmation:

```text
- Ctrl+C
- stop session
- approve command
- send raw shell input
- bulk command to many sessions
```

## 18. Notifications

Notifications are one of the most valuable features.

The phone should notify when:

```text
- A session needs user input
- Codex asks for approval
- Tests passed
- Tests failed
- A command failed
- A session has been idle/stuck for too long
- A long task completed
- Context is high and compact may be useful
```

Notification examples:

```text
backend-auth needs input:
“Which fix should I try first?”

mobile-layout failed:
“npm test failed with 3 failing tests.”

deploy-script needs approval:
“Codex wants to run ./deploy-check.sh.”
```

This makes the app more useful than SSH.

## 19. Session intelligence layer

The biggest differentiator is not terminal streaming.

The biggest differentiator is:

```text
Session intelligence.
```

The app should answer:

```text
Which sessions need me?
Which sessions are running?
Which sessions are stuck?
Which sessions failed?
Which sessions completed?
Which sessions should be compacted?
Which sessions are safe to ignore?
```

Even simple heuristics can make this useful.

Possible v1 heuristics:

```text
- If last output contains a question mark, mark “waiting for input”
- If output contains approval prompt, mark “waiting for approval”
- If no output for 10+ minutes while process active, mark “possibly stuck”
- If output contains test failure patterns, mark “failed”
- If output contains “tests passed”, mark “passed”
- If output contains compact/context warnings, suggest /compact
```

Later, the laptop agent can use a small local or remote summarizer to create session summaries:

```text
backend-auth:
Codex found the failing auth test and is editing refresh-token logic.

frontend-layout:
Tests failed because the mobile breakpoint snapshot changed.

docs-update:
Idle. Last task completed successfully.
```

But v1 can start with regexes and terminal-state tracking.

## 20. Bulk operations

A powerful feature for users running many sessions:

```text
Send command to one session
Send command to selected sessions
Send command to all idle sessions
Send /usage to all sessions
Send /compact to selected sessions
Stop all stuck sessions
```

Examples:

```text
Compact all sessions with high context.
Ask all sessions to summarize current status.
Run /usage in all active sessions.
Stop every session marked stuck.
```

Bulk operations should require confirmation.

Example confirmation:

```text
Send "/compact" to 6 sessions?

backend-auth
frontend-layout
docs-update
deploy-script
api-tests
mobile-ui

[Cancel] [Send]
```

## 21. Local web dashboard before native phone app

Recommended development path:

```text
Build the laptop host agent first.
Then build a local web dashboard.
Then build the phone app.
```

Why local web dashboard first?

```text
- Faster to prototype
- Easier to debug
- Works on laptop immediately
- Lets you test UX before native app
- Can become a PWA
- Same API can power the phone app later
```

Development path:

```text
Phase 1: CLI daemon + local API
Phase 2: Local web dashboard
Phase 3: Mobile-responsive web app
Phase 4: Remote relay
Phase 5: Native mobile app
Phase 6: Voice mode
```

The local dashboard might run at:

```text
http://localhost:3737
```

It should show the same session cards the phone app will eventually show.

## 22. API design sketch

Laptop agent API:

```http
GET /sessions
GET /sessions/:id
GET /sessions/:id/output
WS  /sessions/:id/stream
POST /sessions/:id/input
POST /sessions/:id/slash
POST /sessions/:id/stop
POST /sessions/:id/voice
POST /sessions/:id/name
POST /pair
GET /status
```

Example session list response:

```json
[
  {
    "id": "sess_123",
    "name": "backend-auth",
    "project": "myapp/backend",
    "branch": "fix-auth-timeout",
    "status": "waiting_for_user",
    "attention": "needs_input",
    "last_activity": "2026-07-08T14:25:00",
    "summary": "Codex found two possible auth bugs and is asking which to try first."
  }
]
```

Send input:

```json
{
  "text": "Try the refresh-token path first. Run tests after the change."
}
```

Send slash command:

```json
{
  "command": "usage"
}
```

Send voice:

```http
POST /sessions/sess_123/voice
Content-Type: audio/webm
```

Response:

```json
{
  "transcript": "Check the failing auth test and fix the refresh token path.",
  "confidence": 0.91
}
```

## 23. Laptop app versus direct phone-to-Codex

The answer is clear:

```text
Build laptop host agent first.
Make the phone app talk to that.
Do not try to make the phone app talk directly to Codex CLI sessions.
```

Direct phone-to-Codex sounds simpler, but it is not actually simpler.

A running Codex CLI session is a local terminal process. The phone cannot naturally interact with it unless something on the laptop captures output and injects input.

So any serious solution eventually becomes:

```text
Phone → laptop bridge → terminal session
```

Therefore, make the bridge explicit and productize it.

## 24. What the laptop agent should own

The laptop agent should own:

```text
- Session lifecycle
- Session naming
- Session registry
- Terminal backend
- Input/output bridging
- Slash commands
- Local voice transcription
- Local security
- Remote pairing
- Audit log
- Notification triggers
- Optional local web UI
```

The phone app should own:

```text
- User interface
- Session browsing
- Reading outputs
- Sending prompts
- Voice recording
- Push notifications
- Quick actions
```

This separation keeps the system clean.

## 25. MVP definition

A realistic v1:

### Laptop agent

```text
- Runs on Ubuntu
- Starts Codex sessions under tmux
- Lists active sessions
- Streams recent output
- Sends text input
- Sends slash commands
- Tracks basic status
- Provides local HTTP/WebSocket API
- Supports one paired phone
- Provides local web dashboard
```

### Phone app or mobile web app

```text
- Shows session list
- Shows session detail
- Streams output
- Sends text prompt
- Sends common slash commands
- Has basic voice recording
- Shows transcript before sending
```

### Remote access

```text
- Local-only first
- Relay or tunnel second
- One user only
```

### Voice

```text
- Phone records audio
- Laptop transcribes locally
- Phone shows transcript
- User confirms send
```

## 26. Explicitly not in v1

Do not build these yet:

```text
- Multi-user collaboration
- Team permissions
- Full file browser
- Full git diff UI
- Mobile code editor
- Cloud sync of all session history
- Perfect arbitrary terminal import
- Fully autonomous voice commands
- Complex natural-language routing
- App-store polish
- Deep integration with Codex internals
```

These can come later.

## 27. V1 user story

A good v1 demo:

```text
User starts 4 sessions on Ubuntu:

codexdeck start --name backend-auth --cwd ~/app/backend
codexdeck start --name frontend-layout --cwd ~/app/frontend
codexdeck start --name docs-update --cwd ~/app/docs
codexdeck start --name deploy-check --cwd ~/app/infra

User opens phone.

Phone shows:
- backend-auth: waiting for input
- frontend-layout: running tests
- docs-update: idle
- deploy-check: needs approval

User taps backend-auth.
Reads Codex question.
Uses voice:
“Try the refresh-token path first and run the auth tests.”
Phone shows transcript.
User taps Send.

User taps deploy-check.
Sees approval request.
Approves from phone.

User sends /usage to all sessions.
User sends /compact to two sessions.
User closes phone.
Notifications arrive when tests pass or fail.
```

That demo would clearly show the product value.

## 28. Later features

After v1, consider:

```text
- Native iOS and Android apps
- Push notifications
- Session summaries
- AI-generated session labels
- Natural-language session routing
- Bulk commands
- Session templates
- Repo-aware dashboards
- Git branch and diff previews
- Approval queue
- Watch mode
- Read-aloud mode
- Voice reply without opening session
- Session handoff between laptop and desktop
- Self-hosted relay
- Team mode
- Web dashboard for desktop
- VS Code extension integration
```

## 29. Approval queue

A very useful future screen:

```text
Approvals

deploy-check wants to run:
./scripts/check-deploy.sh

backend-auth wants to edit:
src/auth/session.ts

frontend-layout wants to run:
npm test -- --updateSnapshot

[Approve] [Reject] [Ask why]
```

This could become one of the most important phone-native workflows.

## 30. Session summaries

Every session card should eventually have a concise summary:

```text
backend-auth
Waiting for input
Codex found two possible causes for token expiry and wants direction.

frontend-layout
Running tests
Codex changed mobile CSS and is checking snapshots.

deploy-check
Needs approval
Codex wants to run the deployment validation script.
```

This is much better than showing raw terminal output only.

## 31. Voice-first future

Eventually, the app could support:

```text
“Show me sessions that need me.”
“Summarize backend-auth.”
“Tell frontend-layout to run the tests again.”
“Compact all idle sessions.”
“Approve deploy-check.”
“Read the last answer.”
```

But v1 should avoid fully autonomous voice actions.

The safe v1 approach:

```text
Voice → transcript → user confirms → send
```

## 32. Differentiation

The product can differentiate from official Codex mobile support by focusing on:

```text
- Ubuntu support
- CLI-native workflow
- tmux sessions
- many-session power-user dashboard
- local voice transcription
- self-hostable architecture
- raw terminal fallback
- existing terminal habits
- local-first security
- one-user hacker workflow
```

The key positioning:

> Official Codex mobile is for Codex App remote workflows. This is for Ubuntu users running many local Codex CLI sessions.

## 33. Main risks

### Risk 1: Terminal parsing is messy

Codex output may change. Terminal state can be hard to parse.

Mitigation:

```text
Start simple.
Capture raw output.
Use heuristics.
Do not overpromise perfect status detection.
```

### Risk 2: Security

The app can control a real shell.

Mitigation:

```text
Pairing, device keys, read-only mode, audit log, risky-action confirmations.
```

### Risk 3: Existing session import

Attaching to arbitrary existing terminals is hard.

Mitigation:

```text
Require sessions to be started through codexdeck in v1.
Add import later.
```

### Risk 4: Mobile UX becomes too terminal-like

If the app is just terminal streaming, it will feel bad.

Mitigation:

```text
Build cards, summaries, statuses, notifications, and quick actions.
Terminal view is advanced fallback.
```

### Risk 5: Remote networking complexity

Long-distance phone-to-laptop connection can be tricky.

Mitigation:

```text
Local dashboard first.
Relay later.
One user only.
No public laptop listener by default.
```

## 34. Opinionated implementation plan

### Milestone 1: Local session manager

Build:

```text
codexdeck start
codexdeck list
codexdeck send
codexdeck attach
```

Use tmux.

### Milestone 2: Local API

Build:

```text
GET /sessions
GET /sessions/:id/output
POST /sessions/:id/input
WS /sessions/:id/stream
```

### Milestone 3: Local dashboard

Build browser UI:

```text
Session cards
Session detail
Prompt box
Slash command buttons
Raw terminal output
```

### Milestone 4: Mobile-responsive UI

Make the dashboard work well on phone browser.

This may already be useful before building a native app.

### Milestone 5: Pairing and auth

Add:

```text
QR pairing
Device keys
Read/write permissions
Audit log
```

### Milestone 6: Remote relay

Add:

```text
Laptop outbound connection
Phone connection
Secure routing
Reconnect handling
```

### Milestone 7: Voice

Add:

```text
Phone audio capture
Laptop local transcription
Transcript review
Send to session
```

### Milestone 8: Native app

Build native app after the workflow is proven.

## 35. Best v1 shape

The best v1 is not:

```text
A polished native mobile app.
```

The best v1 is:

```text
A reliable Ubuntu host agent plus mobile-friendly web dashboard.
```

That lets you validate the core workflow quickly.

Then, once the UX is obviously useful, build the native phone app.

## 36. Final recommendation

Build the product as:

```text
Ubuntu laptop host agent first.
Local web dashboard second.
Remote phone client third.
Voice mode fourth.
Native phone app fifth.
```

The core insight:

> The laptop agent is the product foundation. The phone app is a client.

Trying to connect the phone directly to Codex CLI sessions will eventually force you to invent the laptop agent anyway. So build the agent intentionally from the start.

The strongest product direction:

> A mobile mission-control dashboard for many Ubuntu Codex CLI sessions, powered by a secure local laptop agent.

