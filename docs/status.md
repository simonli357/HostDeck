# Status

Current handoff only. Detailed scope, tasks, and evidence live in owning docs/artifacts.

## Snapshot

- Phase: V1 release hardening; release remains no-go.
- Active task: `REL-V1-110` clean Ubuntu shared-session release acceptance is ready. `FE-V1-108` physical phone acceptance and `REL-V1-111` publication tooling are done.
- Direction: after one shared broker starts, normal `codex` and `codex resume <native-uuid>` sessions use that broker and HostDeck enrolls eligible loaded roots automatically. Discover/adopt/unmanage/handoff are superseded; native UUIDs are user-facing and `sess_...` ids remain internal compatibility state.
- Runtime: exact Codex 0.148.0 on `$CODEX_HOME/app-server-control/app-server-control.sock`; HostDeck API/dashboard and broker have independent lifecycle. An already-running client on another app-server needs one close and normal resume after broker readiness.
- Remote path: unchanged loopback HostDeck behind private Tailscale Serve HTTPS with HostDeck pairing/CSRF/lock/revoke and saved-profile noninterference.
- Platform: Ubuntu 24.04 x64 is V1. Windows shared-session/package release work is deferred to V2; completed Windows work remains historical evidence.
- Candidate: installed package `0.0.31` (`0.0.31-97f8dc889c08d6667c68bbde3d5092aeca72b1958759c57b417be5f94f569dae`) preserves shared broker PID `3524335`. Immutable package SHA-256: `a852c0d3dc75cff51b58cc07f37743ac5d6c569549832d9fd9b29d2488274df6`.
- Publication: `REL-V1-111` now fail-closed verifies the 11-asset deterministic Ubuntu bundle and the SHA-pinned tag -> native checks -> package -> metadata -> attestation -> draft-release workflow. No tag or live attestation has been created.
- Next chain: run `REL-V1-110`, then obtain the human `REL-V1-010` go/no-go.
- Validation: immutable `0.0.20` passed the cellular/Tailscale Xiaomi phone flow. Installed `0.0.31` additionally retains the large-session enrollment behavior, recovered MarketPilot's missed terminal answer, serves its restart-boundary event page, keeps all local components ready with mutation admission open, preserves the broker PID, and returns HTTPS 200 through Tailscale Serve. A real connected-phone prompt round trip displayed the retained reply and terminal completion. Sixty-four affected tests, full typecheck/lint, and deterministic packaging passed.
- Git: shared-runtime implementation and acceptance evidence are on `feat/shared-codex-runtime`. The primary worktree remains untouched.

## Blockers

- Final release requires `REL-V1-110` plus human go/no-go in `REL-V1-010`.
