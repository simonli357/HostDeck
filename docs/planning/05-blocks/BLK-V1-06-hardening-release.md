# BLK-V1-06 Hardening, Setup, And Release

Owns cross-module production proof, clean native delivery, security/privacy, browser/phone/real-Codex evidence, documentation, and go/no-go.

## Outcome

- Normal Ubuntu and Windows users can verify, install, run, upgrade/rollback, and uninstall native HostDeck artifacts without a source checkout or development toolchain.
- The selected app-server/loopback-Fastify/Tailscale-Serve/mobile path passes L1-L4 validation; superseded tmux and direct-LAN evidence are not used as release proof.
- Security/privacy review confirms no LAN/public HostDeck listener, unauthenticated remote read, raw durable HostDeck/Tailscale secrets, direct app-server exposure, unbounded storage/queues, company-profile mutation, or hidden fallback.
- User/developer/command/repo docs match verified behavior.
- Completion matrix and final artifact state an explicit go/no-go with blockers and known gaps.

Requirement refs: all `NFR-*`, `PR-*`, `SFR-*` release gates and all requirements requiring L3/L4 evidence.

## Release Gates

| Gate | Required evidence |
| --- | --- |
| Planning | Audit resolved, `pnpm check:planning` passes, current queue/dependencies/traceability truthful. |
| Module hardening | `FND-V1-092`, `DAT-V1-092`, `INT-V1-091`, `IFC-V1-091`, `FE-V1-090`. |
| Build/package | Native Ubuntu/Windows builds, bundled runtime, runnable `codexdeck`, web assets, package manifests, per-user lifecycle, signing, upgrade/rollback/uninstall. |
| Real Codex | Versioned thread/turn/control/approval/TUI/restart vertical. |
| Security/privacy | Tailscale Serve HTTPS, app auth, proxy/origin/rate/CSRF, permissions/retention, loopback listener, profile noninterference, and storage inspection. |
| Browser/device | Supported desktop browser plus real Android phone over cellular or unrelated Wi-Fi, with saved-profile switching and no custom CA. |
| Clean hosts | Clean Ubuntu and Windows artifact verification/install, Tailscale prerequisite/profile setup, foreground/per-user lifecycle, restart/recovery, no root/admin HostDeck process, router changes, or public listener. |
| Supply chain | Native CI, public signatures/checksums/SBOM/provenance, version/commit agreement, fail-closed draft publication. |
| Documentation | Verified setup, commands, troubleshooting, remote profile/Serve/pairing/recovery/support boundaries. |
| Aggregate | All required commands and manual evidence on release commit. |
| Acceptance | Human reviews exact build/assets/evidence and records go/no-go. |

## Task Map

| Work | Tasks | Status |
| --- | --- | --- |
| Historical validation/developer/command wiring | `REL-V1-001` to `REL-V1-003` | Retained; docs must be refreshed after selected path exists. |
| User guide | `REL-V1-004` | Complete for the selected Tailscale-first path. |
| Security/privacy review | `REL-V1-005` | Complete; `SPR-01` to `SPR-24` pass with zero unresolved security/privacy blocker. |
| Final native release-candidate phone smoke | `REL-V1-006` | Blocked by `REL-V1-108`, which includes aggregate Android and clean native-host evidence. |
| Aggregate validation | `REL-V1-007` | Blocked by module/device smoke. |
| Completion matrix and delivery truth | `REL-V1-008`, `REL-V1-009` | Blocked by aggregate evidence. |
| Go/no-go | `REL-V1-010` | Blocked by all release gates and human acceptance. |
| System hardening audit/rebaseline | `REL-V1-011` | Done; rebaseline commit `2e06d4b` pushed. |
| Remote-access direction rebaseline | `REL-V1-012` | Done; Tailscale-first V1 decision, planning chain, and dependency graph recorded. |
| Cross-platform distribution | `REL-V1-100` to `REL-V1-108` | Planning complete; native implementation, signing, clean-host acceptance, and release-candidate evidence remain. |
| Next-version gate | `REL-V1-999` | Blocked by V1 acceptance. |

Owning backlog: `docs/tracking/backlog/hardening-release.md`.

## No-Go Conditions

- Any required block remains reopened/blocked.
- App-server version/control/approval/restart behavior lacks real evidence.
- HostDeck binds a LAN/public address, tailnet membership bypasses pairing, proxy headers are trusted without the proven boundary, or the company profile/foreign Serve state can be changed.
- CLI/build/service works only from source tests or requires undocumented manual repair.
- Either supported host lacks a native verified package, current-user lifecycle, clean-host proof, signed public artifact policy, upgrade/rollback, or exact uninstall cleanup.
- Production event fanout/retention/health/shutdown remains test-injected or unbounded.
- Replacement visual direction is unselected or phone workflows lack screenshot/device evidence.
- The phone workflow requires the laptop LAN, custom CA enrollment, manual router exposure, or an unrecorded Tailscale profile state.
- Secrets/transcripts appear in HostDeck storage/logs/artifacts beyond documented bounded projection.
- Required commands are skipped, flaky without root cause, or placeholder successes.

## Done Criteria

- Every block is complete in `00-index.md` with current selected-path evidence.
- Clean install/service/browser/phone and real Codex artifacts identify exact release commit and environment.
- Native artifacts, signatures, checksums, SBOM, provenance, and clean Ubuntu/Windows evidence identify one exact release candidate.
- Security/privacy and release-readiness skills produce no unresolved release blocker.
- Owner docs and support commands match actual package behavior.
- `docs/status.md` contains concise release truth, validation, blockers, next action, and push state.
- Final go/no-go and human acceptance are recorded; completed work is committed and pushed.
