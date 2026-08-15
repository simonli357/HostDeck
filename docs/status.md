# Status

Current handoff only. Detailed scope, tasks, and evidence live in owning docs/artifacts.

## Snapshot

- Phase: V1 shared-session architecture implementation; release remains no-go.
- Active task: `IFC-V1-112` live Mission Control catalog SSE.
- Direction: after one shared broker starts, normal `codex` and `codex resume <native-uuid>` sessions use that broker and HostDeck enrolls eligible loaded roots automatically. Discover/adopt/unmanage/handoff are superseded; native UUIDs are user-facing and `sess_...` ids remain internal compatibility state.
- Runtime: exact Codex 0.147.0 on `$CODEX_HOME/app-server-control/app-server-control.sock`; HostDeck API/dashboard and broker have independent lifecycle. An already-running client on another app-server needs one close and normal resume after broker readiness.
- Remote path: unchanged loopback HostDeck behind private Tailscale Serve HTTPS with HostDeck pairing/CSRF/lock/revoke and saved-profile noninterference.
- Platform: Ubuntu 24.04 x64 is V1. Windows shared-session/package release work is deferred to V2; completed Windows work remains historical evidence.
- Next chain: `IFC-V1-112` -> `FE-V1-107` -> `INT-V1-114` -> `IFC-V1-113` -> `FE-V1-108` -> `REL-V1-110`.
- Validation: shared control plane passed unit 3,225, contract 308, integration 36, type/lint/static gates, four exact-Codex shared-runtime smokes, and deterministic 658-source package acceptance. Live catalog/UI consumption remains.
- Git: `IFC-V1-111` implementation is committed at `83a47c0` with package-harness hardening at `002a7c9` on `feat/shared-codex-runtime`; the primary dirty worktree remains untouched.

## Blockers

- Physical Android is required only for `FE-V1-108`, after the installed Ubuntu candidate exists.
- Final release requires `REL-V1-110` plus human go/no-go in `REL-V1-010`.
