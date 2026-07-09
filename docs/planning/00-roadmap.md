# Roadmap

Owns version scopes from the first useful release through the end goal. Do not duplicate task status here.

The root planning docs describe the active version, normally V1. When V2 or later becomes active, create versioned planning docs only for facts that change; stable facts can link back to the earlier owner.

## Version Plan

| Version | User-facing outcome | Major capabilities | Deferred to later | Exit criteria |
| --- | --- | --- | --- | --- |
| V1 | One Ubuntu user can supervise and steer multiple Codex threads from a secure phone-first local web dashboard while retaining the normal laptop TUI. | Version-gated Codex app-server integration over a user-private Unix socket; managed thread lifecycle and laptop TUI resume; typed event, status, model, goal, plan, usage, compact, skills, and approval projections; mobile Mission Control and conversation-first Session Detail; paired read/write permissions; loopback default plus encrypted LAN opt-in; bounded local projection and audit storage; unprivileged foreground and user-service modes. | Hosted relay; native mobile apps; voice transcription; push notifications; bulk operations; arbitrary terminal import; phone raw-shell input; file browser; git diff UI; mobile code editor; multi-user/team mode; equal support for multiple Codex backends. | On Ubuntu, a clean install can run several real Codex threads, survive browser disconnects and HostDeck service restart, identify attention and approval needs from structured events, accept prompts and approved controls from an actual phone over encrypted paired access, resume the same thread in the laptop TUI, and lock, revoke, or audit remote control. |
| V2 | The same one-user workflow works away from the laptop with safer remote access and richer mobile control. | Outbound laptop-to-relay connection; reconnect handling; stronger device identity and permission modes; notification triggers; approval-focused controls; confirmed voice-to-text flow using laptop-side transcription; selected bulk slash or prompt operations with confirmations; richer summaries and status heuristics. | Native app polish; team collaboration; advanced natural-language routing; repo-wide dashboards; full code/diff workflows. | A paired phone can securely supervise and steer local Ubuntu Codex sessions over remote connectivity without exposing a public laptop port, and voice input remains review-before-send. |
| V3+ | HostDeck becomes a mature multi-surface Codex operations console. | Native Android/iOS apps; self-hosted relay options; desktop tray app; session templates; approval queue; AI-generated labels and summaries; repo-aware dashboards; git branch/diff previews; watch/read-aloud modes; VS Code or editor integrations; optional team permissions. | Features that conflict with local-first security or turn the product into a generic terminal/editor stay out of scope. | Aligns with `docs/planning/00-end-goal.md` |

## Active Version

- Version: V1
- Planning docs: Root planning docs describe V1 until a later version becomes active.
- Human-approved product scope: Approved on 2026-07-08.
- Architecture/UX hardening rebaseline: 2026-07-09 under `REL-V1-011`; V1 outcome is unchanged, while terminal scraping and phone raw-shell input are removed from the primary path.
