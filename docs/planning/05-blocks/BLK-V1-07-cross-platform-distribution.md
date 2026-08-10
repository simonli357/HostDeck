# BLK-V1-07 Cross-Platform Distribution

Owns native Ubuntu/Windows host portability, packaging, lifecycle, signing, publication, update, rollback, and clean-host proof.

## Outcome

- Ubuntu 24.04 x64 and Windows 11 x64 users install a versioned HostDeck package without a checkout, Node, pnpm, compiler, or administrator/root HostDeck process.
- Platform adapters own paths/security, daemon lease, Codex local transport, lifecycle registration, executable discovery, and command invocation; domain/API/UI behavior stays shared.
- Linux retains private Unix-socket plus systemd-user behavior. Windows uses an authenticated loopback Codex WebSocket and interactive-user startup agent; neither exposes HostDeck or Codex to LAN/public interfaces.
- Upgrade, rollback, repeated uninstall, data retention, artifact integrity, signing, SBOM/provenance, and native CI are fail-closed and evidenced on each supported platform.

Requirement refs: `NFR-009`, `NFR-013`, `NFR-014`, `PR-001`, `PR-002`, `PR-007` to `PR-010`, `PR-012` to `PR-018`, `SFR-015`.

## Platform Contract

| Boundary | Ubuntu 24.04 x64 | Windows 11 x64 |
| --- | --- | --- |
| HostDeck HTTP | Random or configured `127.0.0.1` port | Same |
| Codex transport | Owner-only Unix socket | Authenticated random-port `127.0.0.1` WebSocket |
| User data | XDG config/state/runtime roots | `%APPDATA%` config and `%LOCALAPPDATA%` state/runtime |
| Access control | UID ownership, no-follow, `0700`/`0600` | Current-user ACL, canonical path, reparse/hard-link rejection |
| Background lifecycle | systemd user units | Interactive-user startup agent registration |
| Distribution | Versioned native archive/package | Signed per-user MSIX; portable tree is test-only |
| Tailscale | Validated `tailscale` CLI | Validated `tailscale.exe` CLI |

## Security Rules

- Loopback is necessary but not sufficient for the Windows Codex endpoint; a fresh capability token is stored/passed only through current-user-protected boundaries, never argv, logs, diagnostics, manifests, or artifacts.
- Installer elevation is not an application authority boundary. HostDeck runs as the interactive user and never depends on a Session 0 Windows service.
- Package verification binds platform, architecture, Node ABI/runtime, native modules, Codex binding, source/output/web identities, version, and commit before install or launch.
- Public Windows artifacts must be signed. Unsigned output cannot be called a public release.
- Updates retain the current and previous verified release, preserve config/state, and restore the prior selector/lifecycle/readiness on failure.

## Evidence Gates

| Gate | Required evidence |
| --- | --- |
| Contracts | Platform capability/config fixtures reject unsupported OS/arch, mixed identities, unsafe paths/endpoints, and secret-bearing output. |
| Native runtime | Exact Codex start, handshake, thread/control/approval/events, reconnect, and TUI resume on each OS. |
| Storage/security | Native path, ownership/ACL, link/reparse, lock contention/crash, SQLite migration, and raw-secret inspection. |
| Package | Deterministic native closure with bundled Node/native modules; clean unrelated-cwd/read-only/tamper invocation. |
| Lifecycle | Install/start/status/restart/upgrade/rollback/stop/repeated-uninstall/reinstall and login-start behavior as the current user. |
| Remote | Native Tailscale profile/Serve observation, enable/disable, phone access, wrong-profile behavior, and foreign-state preservation. |
| Supply chain | Native CI, signatures, SHA-256, SBOM, provenance, tag/version agreement, and draft-on-failure publication. |
| Acceptance | Clean Ubuntu and Windows hosts plus one unrelated-network phone workflow against the release candidate. |

Owning backlog: `docs/tracking/backlog/cross-platform-distribution.md`.

## Done Criteria

- Every task in the owning backlog is done or explicitly deferred outside V1 with human approval.
- Native clean-host artifacts identify exact release commit, package/signature identity, versions, commands, failures, cleanup, and private-data inspection.
- `BLK-V1-06` consumes the Ubuntu/Windows evidence and final release gates report no hidden platform blocker.
