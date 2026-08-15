# Status

Current handoff only. Detailed scope, tasks, and evidence live in owning docs/artifacts.

## Snapshot

- Phase: V1 shared-session architecture implementation; release remains no-go.
- Active task: none; `IFC-V1-113` Ubuntu shared-runtime packaging is ready.
- Direction: after one shared broker starts, normal `codex` and `codex resume <native-uuid>` sessions use that broker and HostDeck enrolls eligible loaded roots automatically. Discover/adopt/unmanage/handoff are superseded; native UUIDs are user-facing and `sess_...` ids remain internal compatibility state.
- Runtime: exact Codex 0.147.0 on `$CODEX_HOME/app-server-control/app-server-control.sock`; HostDeck API/dashboard and broker have independent lifecycle. An already-running client on another app-server needs one close and normal resume after broker readiness.
- Remote path: unchanged loopback HostDeck behind private Tailscale Serve HTTPS with HostDeck pairing/CSRF/lock/revoke and saved-profile noninterference.
- Platform: Ubuntu 24.04 x64 is V1. Windows shared-session/package release work is deferred to V2; completed Windows work remains historical evidence.
- Next chain: `IFC-V1-113` -> `FE-V1-108` -> `REL-V1-110`.
- Validation: `INT-V1-114` passed one clean-commit aggregate with 32 files/443 tests and an exact three-project ordinary-Codex lifecycle; full unit 3,266, contract 309, integration 36, web 960, focused browser `2/2`, static/binding/runtime-boundary, deterministic package, supply-chain, packaged-browser, privacy, and zero-residue checks pass.
- Git: `INT-V1-114` code is evidence-bound to `4296e26` on `feat/shared-codex-runtime`; implementation, closure evidence, and owner-doc updates are committed and pushed. The primary worktree remains untouched.

## Blockers

- Physical Android is required only for `FE-V1-108`, after the installed Ubuntu candidate exists.
- Final release requires `REL-V1-110` plus human go/no-go in `REL-V1-010`.
