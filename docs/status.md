# Status

Current handoff only. Detailed scope, tasks, and evidence live in owning docs/artifacts.

## Snapshot

- Phase: V1 release hardening; release remains no-go.
- Active task: `REL-V1-110` clean Ubuntu shared-session release acceptance is ready. `FE-V1-108` physical phone acceptance and `REL-V1-111` publication tooling are done.
- Direction: after one shared broker starts, normal `codex` and `codex resume <native-uuid>` sessions use that broker and HostDeck enrolls eligible loaded roots automatically. Discover/adopt/unmanage/handoff are superseded; native UUIDs are user-facing and `sess_...` ids remain internal compatibility state.
- Runtime: exact Codex 0.148.0 on `$CODEX_HOME/app-server-control/app-server-control.sock`; HostDeck API/dashboard and broker have independent lifecycle. An already-running client on another app-server needs one close and normal resume after broker readiness.
- Remote path: unchanged loopback HostDeck behind private Tailscale Serve HTTPS with HostDeck pairing/CSRF/lock/revoke and saved-profile noninterference.
- Platform: Ubuntu 24.04 x64 is V1. Windows shared-session/package release work is deferred to V2; completed Windows work remains historical evidence.
- Candidate: installed package `0.0.25` (`0.0.25-bf6018f4e7a6f800cf32791546dff668057947c8983a72740d1ff193e640a50d`) preserves shared broker PID `3524335`. Immutable package SHA-256: `2f77ddbec69be5c3a7bc9c802656ba01dc623f51f02c4d4f959f6f5cac15281a`.
- Publication: `REL-V1-111` now fail-closed verifies the 11-asset deterministic Ubuntu bundle and the SHA-pinned tag -> native checks -> package -> metadata -> attestation -> draft-release workflow. No tag or live attestation has been created.
- Next chain: run `REL-V1-110`, then obtain the human `REL-V1-010` go/no-go.
- Validation: immutable `0.0.20` passed the cellular/Tailscale Xiaomi phone flow. Installed `0.0.25` additionally passed large-history enrollment and restart reconciliation: stopped ScandyControl, SideCue, MicroForge, and MarketPilot sessions are current after temporary clients exited; local/remote health, broker, service, TLS, and retained Xiaomi write pairing are ready. Focused adapter/lifecycle tests, affected typechecks, formatting, and deterministic packaging passed.
- Git: shared-runtime implementation and acceptance evidence are committed and pushed on `feat/shared-codex-runtime`. The primary worktree remains untouched.

## Blockers

- Final release requires `REL-V1-110` plus human go/no-go in `REL-V1-010`.
