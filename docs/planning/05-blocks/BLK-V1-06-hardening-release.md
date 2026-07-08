# BLK-V1-06 Hardening, Setup, And Release Readiness

Owns aggregate validation, setup/support docs, command reference, release readiness, and go/no-go evidence for V1.

## Summary

- Goal: Prove HostDeck V1 can be installed, run, validated, locked down, documented, and handed off from a clean Ubuntu workflow.
- Required for V1: Yes.
- User/workflow value: The project is not considered ready just because core tests pass; runtime setup, failure states, UI evidence, and support paths must be inspectable.
- In scope: Aggregate validation commands, clean install/build smoke, foreground/service mode smoke, command reference, developer guide, user guide, security/privacy checklist, release checklist, known gaps, final status.
- Out / deferred: App-store signing, native app distribution, hosted relay operations, team support runbooks.
- Requirement refs: `NFR-001` to `NFR-009`, `PR-001` to `PR-009`, release gates, all block hardening evidence.
- UX refs: All UI screenshot/fidelity evidence from `BLK-V1-05`.
- Decision refs: `DEC-002`, `DEC-005`, `DEC-006`, `DEC-008`, `DEC-009`, `DEC-010`, `DEC-011`.

## Local Architecture

| Part | Responsibility | Inputs | Outputs | Failure states |
| --- | --- | --- | --- | --- |
| Aggregate validation | Run typecheck, lint, unit, contract, integration, web, E2E, tmux smoke, build, and release smoke commands when they exist. | Scripts from implementation blocks. | Pass/fail artifacts and known gaps. | Missing script, flaky test, skipped manual inspection, hidden release blocker. |
| Setup and command docs | Document real install/run/service/CLI commands only after validated. | Implemented CLI/server commands and smoke results. | Developer guide, command reference, repo guide updates where owned facts change. | Documented command not runnable, setup assumptions untested, stale env values. |
| Security/privacy review | Confirm local-first defaults, token storage, audit bounds, LAN opt-in, CLI-only unlock, no secret leakage. | Auth/storage/API/UI evidence. | Security checklist and release notes. | Ambient write access, raw token persistence, unbounded audit payloads, exposed listener. |
| Release readiness | Produce go/no-go artifact and current status. | All block evidence and unresolved gaps. | Release-readiness artifact, status update, blockers visible. | Release blocker buried in notes, missing UI screenshots, incomplete smoke path. |

## Contracts And Data

| Contract/data item | Owner | Rules | Validation |
| --- | --- | --- | --- |
| Command reference | Delivery docs | Commands are documented only after scripts/CLI commands exist and have run. | Command smoke artifacts. |
| Developer guide | Delivery docs | Setup/env facts appear only when validated or marked as a gap. | Clean install/run smoke. |
| Release checklist | Release artifact/status | Go/no-go must reference block evidence and known gaps. | Release-readiness review. |
| Security/privacy checklist | Release artifact | Local-first, token, audit, LAN, unlock, and secret handling are checked. | Targeted test output and manual inspection. |

## Implementation Blueprint

| Slice | Goal | Epics/tasks | Dependencies | Exit evidence |
| --- | --- | --- | --- | --- |
| Foundation | Define aggregate validation and release-readiness task shapes before implementation starts. | Backlog must create leaf tasks for validation command wiring, smoke artifact template, setup doc skeleton, and release checklist skeleton. | Block specs and backlog decomposition. | Planning evidence and later runnable commands. |
| Hardening | Run module-hardening tasks for each block and close visible gaps. | Backlog must create hardening tasks for contracts, storage/auth/audit, tmux/output, API/CLI, web UI, security/privacy, setup. | `BLK-V1-01` to `BLK-V1-05`. | Block hardening artifacts and updated completion matrix. |
| Release readiness | Prove clean local handoff and record go/no-go. | Backlog must create release-readiness tasks for clean checkout install, foreground/service smoke, command docs, user/dev guides, security/privacy checklist, final status, commit/push state. | Completed implementation and hardening blocks. | Release-readiness artifact and status update. |

## Validation Plan

| Layer | What to prove | Evidence |
| --- | --- | --- |
| Unit | Aggregate commands include required unit/contract scopes and fail on missing scripts. | Validation wiring evidence. |
| Integration | Storage/API/tmux/web integration commands run in a known order with cleanup. | Aggregate validation artifact. |
| System / E2E | Clean local V1 path works through CLI, daemon, dashboard, and tmux smoke. | Release smoke artifact. |
| Manual / device | Clean Ubuntu setup, phone-width browser evidence, failure-path review, security/privacy checklist, go/no-go. | Release-readiness artifact. |

## Backlog Links

| Epic | Leaf tasks | Status | Evidence |
| --- | --- | --- | --- |
| Validation command wiring | Pending backlog decomposition. | Planned | Evidence defined in this block. |
| Setup and command docs | Pending backlog decomposition. | Planned | Evidence defined in this block. |
| Module hardening gates | Pending backlog decomposition. | Planned | Evidence defined in this block and each required block. |
| Security/privacy release review | Pending backlog decomposition. | Planned | Evidence defined in this block. |
| Go/no-go and handoff | Pending backlog decomposition. | Planned | Evidence defined in this block. |

## Done Criteria

- Every required V1 block has completion evidence or an approved release deferral.
- Aggregate validation commands exist, run, and have recorded results.
- Clean Ubuntu setup and local service smoke are proven from documented commands.
- Command reference, developer guide, user guide, and repo guide match actual behavior where facts exist.
- Security/privacy review covers local-first defaults, token storage, audit bounds, LAN, lock/unlock, and secret handling.
- UI screenshot/fidelity evidence exists for approved mockups and required states.
- Release blockers and known gaps are visible in status, release tracking, or release artifacts.
- Completed work is committed and pushed, or the blocker is recorded.
- V1 completion matrix in `00-index.md` is updated.

## Open Questions / Spikes

| ID | Question | Owner | Exit evidence |
| --- | --- | --- | --- |
| None | No release-specific spike is required yet; release readiness depends on implementation and block hardening evidence. | `BLK-V1-06` | Release-readiness artifact and go/no-go decision. |
