# BLK-V1-06 Hardening, Setup, And Release

Owns cross-module production proof, clean Ubuntu delivery, security/privacy, browser/phone/real-Codex evidence, documentation, and go/no-go.

## Outcome

- A normal Ubuntu user can install/build/run/uninstall HostDeck and its user services from a clean checkout.
- The selected app-server/Fastify/HTTPS/mobile path passes L1-L4 validation; superseded tmux evidence is not used as release proof.
- Security/privacy review confirms no plaintext LAN, unauthenticated LAN read, raw durable secrets, direct app-server exposure, unbounded storage/queues, or hidden fallback.
- User/developer/command/repo docs match verified behavior.
- Completion matrix and final artifact state an explicit go/no-go with blockers and known gaps.

Requirement refs: all `NFR-*`, `PR-*`, `SFR-*` release gates and all requirements requiring L3/L4 evidence.

## Release Gates

| Gate | Required evidence |
| --- | --- |
| Planning | Audit resolved, `pnpm check:planning` passes, current queue/dependencies/traceability truthful. |
| Module hardening | `FND-V1-091`, `DAT-V1-091`, `INT-V1-091`, `IFC-V1-091`, `FE-V1-090`. |
| Build/package | Production build, runnable `codexdeck`, web assets, package manifest, user-unit install/uninstall. |
| Real Codex | Versioned thread/turn/control/approval/TUI/restart vertical. |
| Security/privacy | HTTPS/auth/origin/rate/CSRF/permissions/retention/listener/storage inspection. |
| Browser/device | Supported desktop browser plus real Android/iOS phone workflow. |
| Clean Ubuntu | Frozen install, foreground/service lifecycle, restart/recovery, no root/router changes. |
| Documentation | Verified setup, commands, troubleshooting, access/cert/recovery/support boundaries. |
| Aggregate | All required commands and manual evidence on release commit. |
| Acceptance | Human reviews exact build/assets/evidence and records go/no-go. |

## Task Map

| Work | Tasks | Status |
| --- | --- | --- |
| Historical validation/developer/command wiring | `REL-V1-001` to `REL-V1-003` | Retained; docs must be refreshed after selected path exists. |
| User guide | `REL-V1-004` | Blocked by completed UI/production service. |
| Security/privacy review | `REL-V1-005` | Blocked by current module hardening and phone transport. |
| Clean Ubuntu/package/service/phone smoke | `REL-V1-006` | Blocked by build/service/UI. |
| Aggregate validation | `REL-V1-007` | Blocked by module/device smoke. |
| Completion matrix and delivery truth | `REL-V1-008`, `REL-V1-009` | Blocked by aggregate evidence. |
| Go/no-go | `REL-V1-010` | Blocked by all release gates and human acceptance. |
| System hardening audit/rebaseline | `REL-V1-011` | In progress. |
| Next-version gate | `REL-V1-999` | Blocked by V1 acceptance. |

Owning backlog: `docs/tracking/backlog/hardening-release.md`.

## No-Go Conditions

- Any required block remains reopened/blocked.
- App-server version/control/approval/restart behavior lacks real evidence.
- LAN can start plaintext, leak unpaired reads, or issue insecure write credentials.
- CLI/build/service works only from source tests or requires undocumented manual repair.
- Production event fanout/retention/health/shutdown remains test-injected or unbounded.
- Replacement visual direction is unselected or phone workflows lack screenshot/device evidence.
- Secrets/transcripts appear in HostDeck storage/logs/artifacts beyond documented bounded projection.
- Required commands are skipped, flaky without root cause, or placeholder successes.

## Done Criteria

- Every block is complete in `00-index.md` with current selected-path evidence.
- Clean install/service/browser/phone and real Codex artifacts identify exact release commit and environment.
- Security/privacy and release-readiness skills produce no unresolved release blocker.
- Owner docs and support commands match actual package behavior.
- `docs/status.md` contains concise release truth, validation, blockers, next action, and push state.
- Final go/no-go and human acceptance are recorded; completed work is committed and pushed.
