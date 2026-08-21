# Status

Current handoff only. Detailed scope, tasks, and evidence live in owning docs/artifacts.

## Snapshot

- Phase: V1 release hardening; release remains no-go.
- Active task: reopened `BUG-101` runtime projection recovery, followed by physical completion of `BUG-102`; `REL-V1-110` is blocked until both pass.
- Direction: after one shared broker starts, normal `codex` and `codex resume <native-uuid>` sessions use that broker and HostDeck enrolls eligible loaded roots automatically. Discover/adopt/unmanage/handoff are superseded; native UUIDs are user-facing and `sess_...` ids remain internal compatibility state.
- Runtime: exact Codex 0.148.0 on `$CODEX_HOME/app-server-control/app-server-control.sock`; HostDeck API/dashboard and broker have independent lifecycle. An already-running client on another app-server needs one close and normal resume after broker readiness.
- Remote path: unchanged loopback HostDeck behind private Tailscale Serve HTTPS with HostDeck pairing/CSRF/lock/revoke and saved-profile noninterference.
- Platform: Ubuntu 24.04 x64 is V1. Windows shared-session/package release work is deferred to V2; completed Windows work remains historical evidence.
- Candidate: installed `0.0.33` reached ready after bounded stale-history startup, then failed closed on a valid Codex item during active traffic. Corrected `0.0.34` is pending package installation and live validation; the shared broker/native sessions remain independent.
- Publication: `REL-V1-111` now fail-closed verifies the 11-asset deterministic Ubuntu bundle and the SHA-pinned tag -> native checks -> package -> metadata -> attestation -> draft-release workflow. No tag or live attestation has been created.
- Next chain: install and sustain-test `0.0.34`, complete repeated physical prompt-focus validation when the phone is available, then run `REL-V1-110` and obtain the human `REL-V1-010` go/no-go.
- Validation: immutable `0.0.20` passed the cellular/Tailscale Xiaomi phone flow. Installed `0.0.31` additionally retains the large-session enrollment behavior, recovered MarketPilot's missed terminal answer, serves its restart-boundary event page, keeps all local components ready with mutation admission open, preserves the broker PID, and returns HTTPS 200 through Tailscale Serve. A real connected-phone prompt round trip displayed the retained reply and terminal completion. Sixty-four affected tests, full typecheck/lint, and deterministic packaging passed.
- Git: shared-runtime implementation and acceptance evidence are on `feat/shared-codex-runtime`. The primary worktree remains untouched.

## Blockers

- `BUG-101` blocks runtime readiness; `BUG-102` still requires repeated physical-phone focus evidence.
- Final release requires both bug gates, `REL-V1-110`, and human go/no-go in `REL-V1-010`.
