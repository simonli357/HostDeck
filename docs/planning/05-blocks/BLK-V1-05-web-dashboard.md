# BLK-V1-05 Web Dashboard UX

Owns the phone-responsive browser dashboard, state coverage, approved visual direction, screen groups, and UI fidelity evidence.

## Summary

- Goal: Deliver a browser-based Mission Control and Session Detail experience that consumes typed host state and safely controls one selected Codex session at a time.
- Required for V1: Yes.
- User/workflow value: The user can monitor many laptop Codex sessions from a phone and send focused prompts or slash commands without using a raw terminal as the primary UI.
- In scope: Mission Control, Session Detail, prompt composer, primary/utility slash commands, pairing/trust state, host safety state, disconnected/stale/error states, advanced raw fallback, responsive layout, accessibility, approved mockups.
- Out / deferred: Native Android/iOS app, push notifications, voice input, full terminal/editor replacement, bulk writes, team/multi-user UI.
- Requirement refs: `FR-005` to `FR-010`, `FR-015`, `IR-001` to `IR-009`, `NFR-003`, `NFR-004`, `PR-005`, `SFR-001` to `SFR-003`, `SFR-005`, `SFR-009`, `SFR-010`.
- UX refs: `UX-001` to `UX-009`.
- Decision refs: `DEC-003`, `DEC-004`, `DEC-005`, `DEC-009`, `DEC-010`, `DEC-011`.

## Local Architecture

| Part | Responsibility | Inputs | Outputs | Failure states |
| --- | --- | --- | --- | --- |
| Web app shell | Load host/session state, route between Mission Control and Session Detail, handle disconnected states. | API contracts, UI fixtures, host status. | Responsive browser UI with bounded state. | Loading failure, disconnected daemon, permission denied, agent error. |
| Mission Control | Attention-sorted session overview. | Session list API, status/attention model. | Cards with name, cwd/project cue, branch when available, status, attention, last activity, recent output. | Empty list, all idle, mixed attention, unknown/stale, LAN disabled, locked. |
| Session Detail | Recent Codex output, prompt composer, slash controls, stop action, raw fallback entry. | Session detail/output/stream/write APIs. | One-session control surface and output view. | Session not found, stale/stopped/crashed/unknown, output boundary, stream reconnecting. |
| Trust and safety UI | Reflect pairing/token, read-only/untrusted, locked, LAN state, advanced raw mode. | Security/network API state, token transport from `SPK-ARCH-003`. | Disabled or enabled controls before write attempts. | Expired token, revoked client, locked host, remote unlock rejected, raw input not confirmed. |
| Visual system | Approved generated mockups, state matrix, design-system mapping, screenshots. | `SPK-UX-001`, UX spec, test plan state matrix. | Implementation targets and drift evidence. | Missing mockups, unselected direction, responsive overlap, inaccessible controls. |

## Contracts And Data

| Contract/data item | Owner | Rules | Validation |
| --- | --- | --- | --- |
| Session card view model | Web/contracts | Attention sort first; shows required metadata and recent output summary. | Component tests with mixed fixture statuses. |
| Session detail view model | Web/contracts | Recent Codex output and safe prompt/slash controls precede raw terminal fallback. | Component tests and screenshots. |
| Write control state | Web/core contracts | Controls disabled for untrusted/read-only/locked/stale/stopped/crashed/unknown states before write attempt. | UI state tests and API integration tests. |
| Raw fallback state | Web/server contracts | Raw input hidden by default and requires advanced mode plus confirmation. | UI/API tests. |
| Mockup assets | `assets/ui-concepts/` | Two options generated, selected by human, stored in repo before UI implementation. | `SPK-UX-001` artifact and decision log entry. |

## Implementation Blueprint

| Slice | Goal | Epics/tasks | Dependencies | Exit evidence |
| --- | --- | --- | --- | --- |
| Foundation | Build UI state fixtures and a fake dashboard shell against typed contracts. | Backlog must create leaf tasks for web package shell, fixture states, Mission Control components, Session Detail components, composer/slash controls, trust state, disconnected/error states. | `BLK-V1-01`, fake API from `BLK-V1-04`. | Component/state test outputs. |
| Hardening | Prove responsive behavior, disabled write controls, failure states, accessibility, and UI fidelity. | Backlog must create hardening tasks for state matrix coverage, phone/desktop screenshots, accessibility pass, raw fallback gating, visual drift review. | `SPK-UX-001`, implemented screen groups. | Screenshot/fidelity artifact and UI-fidelity evidence. |
| Release readiness | Ensure dashboard behavior is documented and supportable through local service paths. | Backlog must create release tasks through `BLK-V1-06` for user guide and troubleshooting when behavior exists. | Stable API/CLI and selected mockups. | User guide/support evidence and release checklist. |

## Validation Plan

| Layer | What to prove | Evidence |
| --- | --- | --- |
| Unit | View-model helpers, sort order, disabled-control logic, raw mode gating. | Planned `pnpm test:web` or unit output. |
| Integration | Web components against fake API fixtures for trust, lock, stale, disconnected, output boundary, and write errors. | Component/integration test output. |
| System / E2E | Browser dashboard can read live/fake sessions, stream updates, send one-session writes, and recover from disconnect. | Planned local E2E artifact. |
| Manual / device | Approved mockup comparison plus phone/desktop screenshots for major screen states. | UI-fidelity screenshot artifact. |

## Backlog Links

| Epic | Leaf tasks | Status | Evidence |
| --- | --- | --- | --- |
| UI state coverage and visual direction | `FE-V1-001` to `FE-V1-003` | Planned | `docs/tracking/backlog/web-dashboard.md` |
| Dashboard screen groups | `FE-V1-010` to `FE-V1-015`, `FE-V1-019` to `FE-V1-021` | Planned | `docs/tracking/backlog/web-dashboard.md` |
| Responsive, accessibility, and fidelity | `FE-V1-016` to `FE-V1-018`, `FE-V1-090` | Planned | `docs/tracking/backlog/web-dashboard.md` |

## Done Criteria

- Mission Control and Session Detail consume typed API/contracts rather than parsing terminal output directly.
- All required UI states in the test-plan matrix have component/state coverage.
- Prompt and slash writes target exactly one selected session.
- Write controls are disabled before attempts when trust, lock, or session state forbids writes.
- Raw input remains hidden by default and requires advanced confirmation.
- Two visual directions are generated, one is selected by the human, and approved assets are stored in repo.
- Phone and desktop screenshots prove responsive layout and visual drift.
- Block evidence is recorded in this file, owning tasks, or artifacts.
- V1 completion matrix in `00-index.md` is updated.

## Open Questions / Spikes

| ID | Question | Owner | Exit evidence |
| --- | --- | --- | --- |
| `SPK-ARCH-003` | What token transport should dashboard pairing use? | Architecture/auth/API task | Dashboard trust-state model and API contract update. |
| `SPK-UX-001` | What visual direction and mockup set should UI implementation target? | UI-fidelity task | Assets under `assets/ui-concepts/`, selected direction decision, screenshot targets. |
