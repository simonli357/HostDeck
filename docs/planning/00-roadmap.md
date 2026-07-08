# Roadmap

Owns version scopes from the first useful release through the end goal. Do not duplicate task status here.

The root planning docs describe the active version, normally V1. When V2 or later becomes active, create versioned planning docs only for facts that change; stable facts can link back to the earlier owner.

## Version Plan

| Version | User-facing outcome | Major capabilities | Deferred to later | Exit criteria |
| --- | --- | --- | --- | --- |
| V1 | One Ubuntu user can manage multiple Codex CLI sessions from a reliable host agent and a phone-friendly local web dashboard. | Tmux-backed `codexdeck` session lifecycle; session registry and metadata; local HTTP/WebSocket API; mobile-responsive mission-control dashboard; session detail with recent output, prompt sending, safe slash-command buttons, and advanced raw terminal fallback; basic attention/status heuristics; one-user local/LAN access with explicit pairing or equivalent local trust gate; audit log for remote actions. | Hosted relay; native mobile apps; local voice transcription; push notifications; bulk operations; arbitrary existing terminal import; file browser; git diff UI; mobile code editor; multi-user/team mode; deep Codex internals integration. | On Ubuntu, the user can start and monitor several managed Codex sessions, identify which sessions need attention, send prompts and approved slash commands from a phone browser on a trusted local connection, inspect raw output when needed, and disable or audit remote control. |
| V2 | The same one-user workflow works away from the laptop with safer remote access and richer mobile control. | Outbound laptop-to-relay connection; reconnect handling; stronger device identity and permission modes; notification triggers; approval-focused controls; confirmed voice-to-text flow using laptop-side transcription; selected bulk slash or prompt operations with confirmations; richer summaries and status heuristics. | Native app polish; team collaboration; advanced natural-language routing; repo-wide dashboards; full code/diff workflows. | A paired phone can securely supervise and steer local Ubuntu Codex sessions over remote connectivity without exposing a public laptop port, and voice input remains review-before-send. |
| V3+ | HostDeck becomes a mature multi-surface Codex operations console. | Native Android/iOS apps; self-hosted relay options; desktop tray app; session templates; approval queue; AI-generated labels and summaries; repo-aware dashboards; git branch/diff previews; watch/read-aloud modes; VS Code or editor integrations; optional team permissions. | Features that conflict with local-first security or turn the product into a generic terminal/editor stay out of scope. | Aligns with `docs/planning/00-end-goal.md` |

## Active Version

- Version: V1
- Planning docs: Root planning docs describe V1 until a later version becomes active.
- Human-approved scope: Approved on 2026-07-08.
