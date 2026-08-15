# Status

Current handoff only. Detailed scope, tasks, and evidence live in owning docs/artifacts.

## Snapshot

- Phase: V1 physical-device and release hardening; release remains no-go.
- Active task: `FE-V1-108` shared-session phone acceptance, blocked only because the Android phone is currently absent from ADB and offline in the laptop Tailscale peer set. `REL-V1-111` publication tooling is done.
- Direction: after one shared broker starts, normal `codex` and `codex resume <native-uuid>` sessions use that broker and HostDeck enrolls eligible loaded roots automatically. Discover/adopt/unmanage/handoff are superseded; native UUIDs are user-facing and `sess_...` ids remain internal compatibility state.
- Runtime: exact Codex 0.147.0 on `$CODEX_HOME/app-server-control/app-server-control.sock`; HostDeck API/dashboard and broker have independent lifecycle. An already-running client on another app-server needs one close and normal resume after broker readiness.
- Remote path: unchanged loopback HostDeck behind private Tailscale Serve HTTPS with HostDeck pairing/CSRF/lock/revoke and saved-profile noninterference.
- Platform: Ubuntu 24.04 x64 is V1. Windows shared-session/package release work is deferred to V2; completed Windows work remains historical evidence.
- Candidate: installed package `0.0.7` passed package, browser, service-host, real user-manager, supply-chain, privacy, retained-session recovery, and bidirectional ordinary-TUI coexistence gates. Immutable local package SHA-256: `edfde8bb4d51983e2e8cc4d3794477b594a03c477d143bdfd1905c85d6dcab62`.
- Publication: `REL-V1-111` now fail-closed verifies the 11-asset deterministic Ubuntu bundle and the SHA-pinned tag -> native checks -> package -> metadata -> attestation -> draft-release workflow. No tag or live attestation has been created.
- Next chain: connect/unlock Android -> exercise the installed frozen candidate in `FE-V1-108`; then run `REL-V1-110` and the human `REL-V1-010` go/no-go.
- Validation: full unit 3,282 with 32 device-gated skips, exact bidirectional ordinary-TUI coexistence, package 44 plus deterministic two-build acceptance, packaged Chromium `1/1`, supply-chain/release-bundle 8, release-workflow mutation 2, contract 309, integration 36, web 960, typecheck, 933-file lint/exports, scaffold/planning, lifecycle, verifier, privacy, and zero-residue checks pass.
- Git: shared-runtime implementation through installed `0.0.7` is committed and pushed on `feat/shared-codex-runtime`; the primary worktree remains untouched.

## Blockers

- A connected unlocked Android phone is required to install and run `FE-V1-108`; no device is currently visible.
- Final release requires `REL-V1-110` plus human go/no-go in `REL-V1-010`.
