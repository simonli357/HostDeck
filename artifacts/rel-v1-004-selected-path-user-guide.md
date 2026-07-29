# REL-V1-004 Selected-Path User Guide

Date: 2026-07-29
Status: complete

## Objective

Replace the empty user-guide template with one usable, evidence-bounded procedure
for the selected Ubuntu-host/Android-Chrome/Tailscale-Serve workflow. The guide
must cover setup, service and remote ownership, pairing, daily controls, saved
profile switching, failure recovery, privacy, safe shutdown, and V1 limitations
without claiming release readiness or reviving a rejected ingress path.

## Evidence Trace

| User-guide area | Accepted owner |
| --- | --- |
| Verified package, exact Codex path, current-user install/start/status/stop/uninstall, preserved state, and Tailscale noninterference | `artifacts/ifc-v1-056-service-lifecycle-install.md`, `artifacts/ifc-v1-058-clean-environment-parity.md` |
| Loopback-only listener, explicit remote enable/status/disable, private Serve HTTPS, saved-profile away/return, foreign-Serve preservation, lock/unlock, pair/reload/revoke, and cleanup conflict | `artifacts/ifc-v1-079-remote-ingress-acceptance.md`, `artifacts/ifc-v1-091-selected-production-interface-hardening.md` |
| Android Chrome pairing, fragment scrub, paired confirmation, Mission Control, Host and access, write/read-only authority, and reload continuity | `artifacts/fe-v1-013-pairing-host-access.md` |
| Phone-unreachable boundary, wrong-profile diagnosis, observation-only return, stopped/signed-out/Serve recovery ownership, and no automatic repair | `artifacts/fe-v1-034-remote-connection-recovery.md` |
| Mission Control, Session Detail, prompt, model, goal, plan, usage, compact, skills, approval, diagnostics, interrupt, archive, laptop resume, device revoke, and host lock copy/workflow | `artifacts/fe-v1-018-copy-workflow-review.md` and its linked leaf evidence |
| Exact private Unix-socket TUI resume and current runtime compatibility boundary | `artifacts/fe-v1-038-laptop-tui-resume.md`, `artifacts/int-v1-091-selected-runtime-hardening.md`, `artifacts/ifc-v1-087-production-compatibility-diagnostics.md` |

## Issue And Fix Inventory

| ID | Finding | Resolution |
| --- | --- | --- |
| `UG-I01` | `docs/delivery/08-user-guide.md` was an empty three-row template despite a complete selected workflow. | Added supported setup, first-run sequence, 16 core workflows, profile switching, shutdown, 19 troubleshooting cases, privacy boundaries, limitations, and direct evidence owners. |
| `UG-I02` | User commands were scattered across developer/test material and did not provide one install-to-uninstall sequence. | Added an `Installed User Workflow` command-reference section covering service, profile, remote, pair, session, device, lock, recovery inspection, switching, and shutdown commands. |
| `UG-I03` | Developer notes still said no installed workflow was claimed and grouped implemented E2E with the unimplemented release smoke. | Pointed the developer guide to the selected user workflow and limited the placeholder statement to `REL-V1-006`/`pnpm smoke:local`. |
| `UG-I04` | The earlier direct-LAN/custom-CA direction could be inferred from historical evidence. | The user guide permits only private Tailscale Serve HTTPS and explicitly rejects CA enrollment, certificate bypass, LAN fallback, Funnel, router exposure, automatic Serve repair, and company-profile mutation. |
| `UG-I05` | Pairing instructions could force repeated QR scans or blur tailnet reachability with app authorization. | Documented QR or the equivalent private `Open instead` link, one-time fragment-safe claim, clean reload continuity, bounded read/write authority, expiry, and exact revoke behavior. |

## Validation

| Gate | Result |
| --- | --- |
| Planning graph | `pnpm check:planning` passed five checker tests and the 220-task/84-requirement/683-dependency graph. |
| CLI grammar contract | The selected CLI contract passed 12 cases, including service, remote, pair, session, device, lock, and global-option grammar. |
| Focused behavior | Seven CLI test files passed 72 lifecycle, pairing, remote, start, device-list/revoke, and lock cases. |
| Actual Tailscale commands | Read-only `tailscale switch --list` and `tailscale serve status --json` both exited zero on the target laptop; private output was not retained. |
| Documentation integrity | `git diff --check` passed. Every linked evidence file and delivery path exists. No command introduces LAN bind, custom CA, Funnel, router, automatic profile switching, automatic Serve reset, or remote unlock. |
| Protected user work | All 18 pre-existing modified PNGs remained unstaged and were not read, rewritten, or included in the guide commit. |

## Disposition

`REL-V1-004` is complete at implementation commit `13bb1f4`, which is pushed to
`origin/main`. The guide describes verified selected-path behavior and clearly
marks the browser, runtime, profile, relay, native-app, and remote-unlock limits.
It does not complete `FE-V1-090`, the clean aggregate release smoke, or the final
V1 go/no-go.
