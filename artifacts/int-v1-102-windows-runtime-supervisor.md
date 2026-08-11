# INT-V1-102 Windows Runtime Supervisor

Date: 2026-08-11

## Result

Passed. Windows x64 now has one fail-closed Codex app-server supervisor over the accepted authenticated loopback transport.

## Contract

- One current-user-secured file lock owns the runtime. A stale endpoint or credential file is never authority, and duplicate owners fail before spawn.
- Codex starts without a shell using fixed `app-server --strict-config --listen ws://127.0.0.1:0 --ws-auth capability-token --ws-token-file <protected-path>` arguments and a case-insensitive allowlisted environment.
- Readiness requires an authenticated WebSocket handshake. The staging file is truncated and removed; the live credential remains only behind the generation-bound protected-environment source.
- Unexpected exit revokes readiness and credential access. Restart retains the claim while rotating token and port; repeated port reuse fails closed after a bounded retry.
- A Windows Job Object owns the child tree with kill-on-close semantics. Shutdown continues cleanup after individual failures, never releases the claim while a live child remains, and exposes only bounded secret-free state.

## Evidence

| Gate | Result |
| --- | --- |
| Focused | 14 deterministic core/process tests and 3 native-contract cases pass: exact argv/env/auth, stale files, duplicate ownership, invalid endpoints, crash/restart, rotation, cleanup retry, process truth, stderr bounds, and Job assignment. |
| Workspace | Root/server typecheck, 863-file lint plus eight-package exports, scaffold, planning, runtime boundary, unit 3,102 with 29 intentional skips, contract 275, and integration 36 pass. |
| Package | 43 direct checks and two deterministic 629-source builds pass with 6,285 entries, relocation/read-only execution, and runtime/config/static/integrity rejection. Frozen offline install and production audit pass with no known vulnerability. |
| Native | Run `31490136692`, source `4faaba3b12fcb4f2610464437e5ca06f9de7101f`: Windows 13/13 and Linux 13/13 checks pass. Both downloaded SHA-256 sidecars and native records verify; the exact Windows Codex 0.144.0 spike record also verifies. |
| Windows supervisor | Real exact Codex proves current-user authority, authenticated readiness, secret-file removal, duplicate rejection, unexpected process termination, held-claim recovery, token/port rotation, listener cleanup, and empty lock residue. A separate fork-owner crash proves root and descendant death from Job handle closure. |

Implementation: `711c452`; crash proof: `5b010a3`; native-CI admission: `4faaba3`. No phone evidence was required or used. Platform TUI execution remains `INT-V1-103`; the complete Windows runtime vertical remains `INT-V1-104`.
