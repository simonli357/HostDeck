# Status

Current handoff only. Detailed scope, tasks, and evidence live in owning docs/artifacts.

## Snapshot

- Phase: V1 physical-device and release hardening; release remains no-go.
- Active task: `REL-V1-111` deterministic release publication tooling. `FE-V1-108` remains blocked only because the Android phone is currently absent from ADB and the laptop Tailscale peer set.
- Direction: after one shared broker starts, normal `codex` and `codex resume <native-uuid>` sessions use that broker and HostDeck enrolls eligible loaded roots automatically. Discover/adopt/unmanage/handoff are superseded; native UUIDs are user-facing and `sess_...` ids remain internal compatibility state.
- Runtime: exact Codex 0.147.0 on `$CODEX_HOME/app-server-control/app-server-control.sock`; HostDeck API/dashboard and broker have independent lifecycle. An already-running client on another app-server needs one close and normal resume after broker readiness.
- Remote path: unchanged loopback HostDeck behind private Tailscale Serve HTTPS with HostDeck pairing/CSRF/lock/revoke and saved-profile noninterference.
- Platform: Ubuntu 24.04 x64 is V1. Windows shared-session/package release work is deferred to V2; completed Windows work remains historical evidence.
- Candidate: `IFC-V1-113` passed package, browser, service-host, real user-manager, supply-chain, privacy, and ordinary-TUI coexistence gates. Immutable local package SHA-256: `eaca440f4029f6131bf118b1f333a9ebea07e410acb9eba8a18e62d1f27ba9db`.
- Next chain: finish `REL-V1-111`; independently connect/unlock Android -> install the frozen candidate -> `FE-V1-108`; then run `REL-V1-110`.
- Validation: full unit 3,279, exact coexistence `1/1`, package 43 plus deterministic two-build acceptance, packaged Chromium `1/1`, supply-chain 6, executable/service-host/systemd smokes, typecheck, lint/exports, verifier, privacy, and zero-residue checks pass.
- Git: shared-runtime implementation and coexistence evidence through `9aa3531` are pushed on `feat/shared-codex-runtime`; `IFC-V1-113` closure is committed and pushed with this handoff. The primary worktree remains untouched.

## Blockers

- A connected unlocked Android phone is required to install and run `FE-V1-108`; no device is currently visible.
- Final release requires `REL-V1-110` plus human go/no-go in `REL-V1-010`.
