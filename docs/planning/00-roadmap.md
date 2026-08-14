# Roadmap

Owns version scopes from the first useful release through the end goal. Do not duplicate task status here.

The root planning docs describe the active version, normally V1. When V2 or later becomes active, create versioned planning docs only for facts that change; stable facts can link back to the earlier owner.

## Version Plan

| Version | User-facing outcome | Major capabilities | Deferred to later | Exit criteria |
| --- | --- | --- | --- | --- |
| V1 | One Ubuntu 24.04 x64 user can supervise and steer the same ordinary local Codex sessions from a phone on another network while retaining the normal laptop TUI. | Exact Codex 0.147.0 integration through its standard user app-server Unix socket; automatic enrollment of loaded top-level interactive sessions; native Codex UUIDs as the visible identity; bounded history and live event projection; normal `codex`/`codex resume` laptop use; typed model, goal, plan, usage, compact, skills, approval, prompt, interrupt, and archive operations; live mobile Mission Control and Session Detail; paired read/write permissions; loopback-only HostDeck behind private Tailscale Serve HTTPS; unprivileged Ubuntu package lifecycle. | Windows, macOS, and ARM hosts; HostDeck-hosted or self-hosted relay; direct private-IP LAN/custom-CA mode; native mobile apps; voice; push; bulk operations; attaching a Codex process that was already running before the shared broker; transcript copying; phone raw-shell input; file browser; git diff UI; mobile editor; multi-user/team mode; app-store distribution. | After one broker start, ordinary `codex` and `codex resume <native-uuid>` sessions opened on the laptop appear on Mission Control without discover/adopt/handoff commands. Phone and laptop operate the same thread, updates appear without manual refresh, and work survives dashboard/Tailscale disconnects. A normal Ubuntu user installs, upgrades, rolls back, and uninstalls the package without Node, pnpm, root-owned application processes, lost user state, or owned residue. |
| V2 | Extend the proven one-user workflow to Windows and optional access without a phone Tailscale client. | Windows shared-runtime mechanism supported by upstream Codex behavior; native Windows package and lifecycle; outbound relay option; account/host enrollment; reconnect/routing; stronger device identity; notification triggers; confirmed voice-to-text; selected bulk operations; richer summaries. | Native app polish; team collaboration; advanced natural-language routing; repo-wide dashboards; full code/diff workflows. | Native Windows shared-session evidence passes without an experimental unsupported transport, and the optional relay preserves the V1 local-first trust model. |
| V3+ | HostDeck becomes a mature multi-surface Codex operations console. | Native Android/iOS apps; self-hosted relay; desktop tray app; session templates; approval queue; AI-generated labels and summaries; repo-aware dashboards; git branch/diff previews; watch/read-aloud modes; editor integrations; optional team permissions. | Features that conflict with local-first security or turn the product into a generic terminal/editor stay out of scope. | Aligns with `docs/planning/00-end-goal.md` |

## Active Version

- Version: V1
- Planning docs: Root planning docs describe V1 until a later version becomes active.
- Human-approved product scope: Remote different-network V1 approved on 2026-07-13 under `DEC-027`.
- Architecture/UX hardening: app-server/mobile rebaseline on 2026-07-09 under `REL-V1-011`; remote-ingress correction on 2026-07-13 under `REL-V1-012`; shared-session rebaseline on 2026-08-14 under `DEC-031` and `REL-V1-109`.
- Session interoperability correction: `DEC-031` supersedes the selected adoption/handoff workflow in `DEC-030` with automatic enrollment through Codex's standard shared Unix daemon. The completed adoption work remains historical evidence.
- Platform scope correction: `DEC-032` narrows V1 release support to Ubuntu 24.04 x64 and defers Windows until upstream Codex exposes a supported equivalent shared-daemon path.
