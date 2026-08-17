# Status

Current handoff only. Detailed scope, tasks, and evidence live in owning docs/artifacts.

## Snapshot

- Phase: V1 physical-device and release hardening; release remains no-go.
- Active task: `FE-V1-108` shared-session phone acceptance, blocked because no Android device is currently visible in ADB. `REL-V1-111` publication tooling is done.
- Direction: after one shared broker starts, normal `codex` and `codex resume <native-uuid>` sessions use that broker and HostDeck enrolls eligible loaded roots automatically. Discover/adopt/unmanage/handoff are superseded; native UUIDs are user-facing and `sess_...` ids remain internal compatibility state.
- Runtime: exact Codex 0.147.0 on `$CODEX_HOME/app-server-control/app-server-control.sock`; HostDeck API/dashboard and broker have independent lifecycle. An already-running client on another app-server needs one close and normal resume after broker readiness.
- Remote path: unchanged loopback HostDeck behind private Tailscale Serve HTTPS with HostDeck pairing/CSRF/lock/revoke and saved-profile noninterference.
- Platform: Ubuntu 24.04 x64 is V1. Windows shared-session/package release work is deferred to V2; completed Windows work remains historical evidence.
- Candidate: installed package `0.0.14` (`0.0.14-82e8cde56f5382aa42b475a6257ef9e3bb9e484844bc37416689b5279e01d71b`) preserves shared broker PID `801536`. Immutable local package SHA-256: `7e0b9cfce550e80dae719b93c679327266250de39dfa9d8492c6cfdbdf157711`.
- Publication: `REL-V1-111` now fail-closed verifies the 11-asset deterministic Ubuntu bundle and the SHA-pinned tag -> native checks -> package -> metadata -> attestation -> draft-release workflow. No tag or live attestation has been created.
- Next chain: connect/unlock Android -> exercise installed `0.0.14` in `FE-V1-108`; then run `REL-V1-110` and the human `REL-V1-010` go/no-go.
- Validation: the `0.0.13` baseline passed 3,299 unit tests with 32 device-gated skips, 309 contract, 36 integration, typecheck, lint, verifier, and deterministic package acceptance. `0.0.14` additionally passed typecheck, targeted formatting, production build/install, and a real ordinary-Codex auto-enroll -> detach -> one-shot archive flow while HostDeck stayed ready and the broker PID remained unchanged.
- Git: shared-runtime implementation through installed `0.0.14` is committed on `feat/shared-codex-runtime`; push is the next action. The primary worktree remains untouched.

## Blockers

- A connected unlocked Android phone is required to run `FE-V1-108`; no device is currently visible in ADB.
- Final release requires `REL-V1-110` plus human go/no-go in `REL-V1-010`.
