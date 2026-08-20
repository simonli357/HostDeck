# Status

Current handoff only. Detailed scope, tasks, and evidence live in owning docs/artifacts.

## Snapshot

- Phase: V1 release hardening; release remains no-go.
- Active task: `REL-V1-110` clean Ubuntu shared-session release acceptance is ready. `FE-V1-108` physical phone acceptance and `REL-V1-111` publication tooling are done.
- Direction: after one shared broker starts, normal `codex` and `codex resume <native-uuid>` sessions use that broker and HostDeck enrolls eligible loaded roots automatically. Discover/adopt/unmanage/handoff are superseded; native UUIDs are user-facing and `sess_...` ids remain internal compatibility state.
- Runtime: exact Codex 0.148.0 on `$CODEX_HOME/app-server-control/app-server-control.sock`; HostDeck API/dashboard and broker have independent lifecycle. An already-running client on another app-server needs one close and normal resume after broker readiness.
- Remote path: unchanged loopback HostDeck behind private Tailscale Serve HTTPS with HostDeck pairing/CSRF/lock/revoke and saved-profile noninterference.
- Platform: Ubuntu 24.04 x64 is V1. Windows shared-session/package release work is deferred to V2; completed Windows work remains historical evidence.
- Candidate: installed package `0.0.20` (`0.0.20-05817c7853eb79e2ddfeb8dadc555f241f7982125f6070a3c2717724962ff169`) preserves shared broker PID `1470166`. Immutable package SHA-256: `2bd48548a01688926a2e3ded95ca134e784b5471838b4dbfcec83c4a2c49521e`.
- Publication: `REL-V1-111` now fail-closed verifies the 11-asset deterministic Ubuntu bundle and the SHA-pinned tag -> native checks -> package -> metadata -> attestation -> draft-release workflow. No tag or live attestation has been created.
- Next chain: run `REL-V1-110`, then obtain the human `REL-V1-010` go/no-go.
- Validation: immutable `0.0.20` passed a cellular/Tailscale Xiaomi phone flow covering fresh ordinary `codex` auto-enrollment, bidirectional laptop/phone turns, stock native-UUID resume, HostDeck restart with broker/TUI continuity, post-restart prompting, and 60 ms live catalog removal. Focused regressions and deterministic production build/install passed; cleanup restored phone Wi-Fi and removed test state/tunnels.
- Git: six implementation commits and this acceptance evidence are local on `feat/shared-codex-runtime`, pending the required handoff push. The primary worktree remains untouched.

## Blockers

- Final release requires `REL-V1-110` plus human go/no-go in `REL-V1-010`.
