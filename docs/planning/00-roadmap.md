# Roadmap

Owns version scopes from the first useful release through the end goal. Do not duplicate task status here.

The root planning docs describe the active version, normally V1. When V2 or later becomes active, create versioned planning docs only for facts that change; stable facts can link back to the earlier owner.

## Version Plan

| Version | User-facing outcome | Major capabilities | Deferred to later | Exit criteria |
| --- | --- | --- | --- | --- |
| V1 | One Ubuntu user can supervise and steer multiple local Codex threads from a phone on another network while retaining the normal laptop TUI. | Version-gated Codex app-server integration over a user-private Unix socket; managed thread lifecycle and laptop TUI resume; typed event, status, model, goal, plan, usage, compact, skills, and approval projections; mobile Mission Control and conversation-first Session Detail; paired read/write permissions; loopback-only HostDeck listener exposed privately through Tailscale Serve on a dedicated saved personal profile; QR/link pairing; bounded local projection and audit storage; unprivileged foreground and user-service modes. | HostDeck-hosted or self-hosted relay; direct private-IP LAN/custom-CA mode; native mobile apps; voice; push; bulk operations; arbitrary terminal import; phone raw-shell input; file browser; git diff UI; mobile editor; multi-user/team mode; equal support for multiple Codex backends. | From an actual phone on cellular or unrelated Wi-Fi, the user reaches the laptop behind NAT through trusted HTTPS without a public HostDeck listener, router change, or manual CA; pairs, scans, prompts, controls, approves, reconnects, locks, and revokes; Codex work survives phone/Tailscale disconnects; switching between saved personal and company Tailscale profiles never mutates the other profile; returning to the HostDeck profile becomes ready only after the exact saved Serve mapping is observed, otherwise explicit local enable is required; the same thread resumes in the laptop TUI. |
| V2 | The same one-user workflow works without requiring the phone to run Tailscale. | Outbound laptop-to-HostDeck relay connection over common egress; account/host enrollment; reconnect and routing; stronger device identity; notification triggers; approval-focused controls; confirmed voice-to-text; selected bulk operations; richer summaries. | Native app polish; team collaboration; advanced natural-language routing; repo-wide dashboards; full code/diff workflows. | A signed-in phone browser can securely supervise and steer local Ubuntu Codex sessions through an outbound-only relay without exposing a public laptop port or depending on a phone VPN profile. |
| V3+ | HostDeck becomes a mature multi-surface Codex operations console. | Native Android/iOS apps; self-hosted relay; desktop tray app; session templates; approval queue; AI-generated labels and summaries; repo-aware dashboards; git branch/diff previews; watch/read-aloud modes; editor integrations; optional team permissions. | Features that conflict with local-first security or turn the product into a generic terminal/editor stay out of scope. | Aligns with `docs/planning/00-end-goal.md` |

## Active Version

- Version: V1
- Planning docs: Root planning docs describe V1 until a later version becomes active.
- Human-approved product scope: Remote different-network V1 approved on 2026-07-13 under `DEC-027`.
- Architecture/UX hardening: app-server/mobile rebaseline on 2026-07-09 under `REL-V1-011`; remote-ingress correction on 2026-07-13 under `REL-V1-012`.
