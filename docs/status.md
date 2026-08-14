# Status

Current handoff only. Detailed scope, tasks, and evidence live in owning docs/artifacts.

## Snapshot

- Phase: V1 shared-session architecture implementation; release remains no-go.
- Active task: `INT-V1-110` exact Codex 0.147.0 standard-socket and ordinary-TUI behavior spike.
- Direction: after one shared broker starts, normal `codex` and `codex resume <native-uuid>` sessions use that broker and HostDeck enrolls eligible loaded roots automatically. Discover/adopt/unmanage/handoff are superseded; native UUIDs are user-facing and `sess_...` ids remain internal compatibility state.
- Runtime: exact Codex 0.147.0 on `$CODEX_HOME/app-server-control/app-server-control.sock`; HostDeck API/dashboard and broker have independent lifecycle. An already-running client on another app-server needs one close and normal resume after broker readiness.
- Remote path: unchanged loopback HostDeck behind private Tailscale Serve HTTPS with HostDeck pairing/CSRF/lock/revoke and saved-profile noninterference.
- Platform: Ubuntu 24.04 x64 is V1. Windows shared-session/package release work is deferred to V2; completed Windows work remains historical evidence.
- Next chain: `INT-V1-110` -> `FND-V1-103` -> `INT-V1-111`/`DAT-V1-106` -> `INT-V1-112` -> `INT-V1-113` -> `IFC-V1-111` -> `IFC-V1-112` -> `FE-V1-107` -> `INT-V1-114` -> `IFC-V1-113` -> `FE-V1-108` -> `REL-V1-110`.
- Validation: `pnpm check:planning` passes with 289 tasks, 94 requirements, 777 dependencies, and one ready task; no product implementation or release evidence for the new path exists yet.
- Git: implementation is isolated on `feat/shared-codex-runtime`; the primary dirty worktree remains untouched. Planning push is pending.

## Blockers

- Physical Android is required only for `FE-V1-108`, after the installed Ubuntu candidate exists.
- Final release requires `REL-V1-110` plus human go/no-go in `REL-V1-010`.
