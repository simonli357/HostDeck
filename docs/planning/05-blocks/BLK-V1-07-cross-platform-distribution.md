# BLK-V1-07 Ubuntu Distribution

Owns Ubuntu 24.04 x64 host packaging, independent shared-broker/HostDeck lifecycle, signature policy, publication, update, rollback, and clean-host proof. Completed Windows groundwork is retained for V2 but is not V1 evidence.

## Outcome

- An Ubuntu 24.04 x64 user installs a versioned HostDeck package without a checkout, Node, pnpm, compiler, or root-owned HostDeck process.
- The package pins exact Codex 0.147.0 compatibility, uses the standard current-user control socket, and installs independent broker and HostDeck systemd user units.
- HostDeck-only stop/restart leaves the broker and ordinary Codex TUI sessions running; explicit broker stop is separate and ownership-checked.
- Upgrade, rollback, repeated uninstall, data retention, artifact integrity, signature policy, SBOM/provenance, and native CI are fail-closed and evidenced on Ubuntu.

Requirement refs: `NFR-009`, `NFR-013`, `NFR-014`, `PR-001`, `PR-002`, `PR-007` to `PR-010`, `PR-012` to `PR-018`, `SFR-015`.

## Platform Contract

| Boundary | Ubuntu 24.04 x64 |
| --- | --- |
| HostDeck HTTP | Random or configured `127.0.0.1` port |
| Codex transport | `$CODEX_HOME/app-server-control/app-server-control.sock`, current-user controlled |
| User data | XDG config/state/runtime roots; Codex control directory remains Codex-owned |
| Access control | UID ownership, no-follow, owner-only modes, path/socket identity |
| Background lifecycle | Independent `hostdeck-codex.service` and `hostdeck.service` user units |
| Distribution | Versioned native Ubuntu x64 archive/package with bundled Node/native modules |
| Tailscale | Validated `/usr/bin/tailscale` CLI and private Serve HTTPS |

## Evidence Gates

| Gate | Required evidence |
| --- | --- |
| Contracts | Exact OS/arch, paths, standard endpoint, lifecycle, package, and unsupported-platform rejection. |
| Native runtime | Exact 0.147.0 standard-socket start/attach, ordinary TUI implicit reuse, controls/events, reconnect, and auto-enrollment. |
| Storage/security | Native path/socket ownership, lock contention/crash, SQLite migration, and raw-secret inspection. |
| Package | Deterministic closure with bundled Node/native modules; clean unrelated-cwd/read-only/tamper invocation. |
| Lifecycle | Install/broker start/HostDeck start/status/independent restart/upgrade/rollback/stop/repeated-uninstall/reinstall/login behavior. |
| Remote | Tailscale profile/Serve observation, enable/disable, phone access, wrong-profile behavior, and foreign-state preservation. |
| Supply chain | Ubuntu CI, selected signature policy, SHA-256, SBOM, provenance, tag/version agreement, and draft-on-failure publication. |
| Acceptance | Clean Ubuntu host plus one unrelated-network physical-phone workflow against the release candidate. |

Owning backlog: `docs/tracking/backlog/cross-platform-distribution.md`.

## Done Criteria

- `IFC-V1-113`, `FE-V1-108`, and `REL-V1-110` pass on one exact candidate.
- Clean-host evidence identifies exact commit/package/signature-policy/version/commands/failures/cleanup and private-data inspection.
- No Windows task is counted as a V1 blocker or completion claim.
- `BLK-V1-06` consumes the Ubuntu evidence and final release gates report no hidden platform blocker.
