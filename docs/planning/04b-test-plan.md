# Test Plan

Owns active-version validation strategy, regression coverage, and release checks.

## Approval Criteria

This plan is not ready to approve unless these checks are true:

- Every V1 requirement group has an automated or manual evidence route.
- Every candidate V1 block has planned validation before it can be marked complete.
- Architecture and UX spikes have explicit proof artifacts and decision outputs.
- Failure, security, privacy, persistence, restart, and UI state coverage are planned before implementation tasks are decomposed.
- Planned commands are labeled as planned until the workspace scaffold creates real scripts and the command reference is updated.
- UI mockups remain blocked until state coverage exists and `SPK-UX-001` produces two human-reviewed visual directions.

## Validation Principles

- Validate headless contracts and core state rules before adapters or UI consume them.
- Use fake Codex/tmux/storage fixtures for deterministic coverage, then add Ubuntu tmux smoke tests for real process behavior.
- Treat status and attention classification as advisory; unrecognized output must become `unknown`, not success.
- Treat write paths as security-sensitive: request schema, trust, lock, session writability, audit preflight, tmux send, and result recording are all separate checks.
- Prove restart behavior with durable state and tmux reconciliation rather than assuming in-memory process state is enough.
- Record manual inspection for runtime behavior, responsive UI, failure surfaces, and release paths that automation cannot fully prove.
- Do not close tasks with hidden fallbacks, swallowed errors, fake success states, or evidence that only covers the happy path.

## Planned Commands

These root scripts now exist. `pnpm check:scaffold`, `pnpm typecheck`, `pnpm lint`, and `pnpm test:unit` run real checks; later-layer commands intentionally fail loudly until their owning tasks replace the placeholders.

| Purpose | Planned command after scaffold | Required for | Evidence |
| --- | --- | --- | --- |
| Install check | `pnpm install --frozen-lockfile` or project-equivalent frozen install | Workspace scaffold and release smoke | Terminal artifact from a clean checkout or documented local environment |
| Type and schema check | `pnpm typecheck` | Every product-code task | Command output in the owning task evidence |
| Lint/static check | `pnpm lint` | Shared packages, server, CLI, and web tasks | Command output in the owning task evidence |
| Core unit tests | `pnpm test:unit` | `core`, fixtures, write eligibility, classifiers, config parsing | Command output with covered requirement refs |
| Contract tests | `pnpm test:contract` | API, stream, storage, audit, and CLI schemas | Command output plus schema fixture snapshots when useful |
| Adapter integration tests | `pnpm test:integration` | Storage/auth/audit, fake tmux, fake Codex, API services | Command output and temporary-state cleanup notes |
| Real tmux smoke | `pnpm test:tmux` or a documented smoke script | Tmux lifecycle, attach, output reader, restart reconciliation | Artifact with Ubuntu version, tmux version, commands, and observed result |
| Web component/state tests | `pnpm test:web` | Dashboard states, trust/lock/permission surfaces, responsive components | Command output plus fixture names |
| Local E2E smoke | `pnpm test:e2e` | Fake vertical through daemon/API/web | Browser or API artifact with server logs |
| Build/package check | `pnpm build` | Release-readiness block and handoff | Build artifact path and command output |
| Release smoke | `pnpm smoke:local` or documented manual checklist | Clean local V1 handoff | Release-readiness artifact with pass/fail and known gaps |

## Coverage Matrix

| Requirement / flow | Automated coverage planned | Manual inspection planned | Evidence owner |
| --- | --- | --- | --- |
| `FR-001` to `FR-004`, `PR-006`: managed session lifecycle and laptop attach path | Core/session tests, fake adapter lifecycle tests, API/CLI start/list/stop contract tests | Ubuntu tmux smoke starts multiple named sessions, attaches or prints target metadata, stops one session, and verifies the other remains reachable | `BLK-V1-03`, `BLK-V1-04` task evidence |
| `FR-005`, `FR-013`, `DR-004`, `DR-008`, `IR-009`: output stream, cursor replay, ordering, retention, truncation | Ordered output fixture tests, reconnect-after-cursor integration test, retention boundary tests | Browser inspection shows live update and replay/truncation boundary without reload | `SPK-ARCH-001`, `SPK-ARCH-004`, `BLK-V1-03`, `BLK-V1-05` |
| `FR-006` to `FR-008`, `FR-015`: prompt and slash commands to one selected session | API/CLI write tests assert exact session id, literal command payload, slash allowlist, and multi-session rejection | Manual smoke verifies one selected tmux session receives the input and no other session changes | `BLK-V1-04`, `BLK-V1-05` |
| `FR-009`, `NFR-003`, `SFR-011`: status and attention heuristics | Unit tests cover Codex-like fixtures for questions, approvals, running commands, pass/fail, compact warnings, idle/no-output, and unknown output | UX review confirms unknown is visible and not styled as healthy success | `BLK-V1-01`, `BLK-V1-05` |
| `FR-010`, `IR-001` to `IR-009`, `NFR-004`, `PR-005`: dashboard and phone-responsive browser UX | Component/state tests for Mission Control, Session Detail, Host Status/Safety, pairing, empty/loading/disconnected/error states | Phone and desktop screenshots after approved mockups; visual drift recorded against selected direction | `SPK-UX-001`, `BLK-V1-05` |
| `FR-011`, `PR-008`: CLI surface and service modes | CLI contract tests cover each command, exit code family, daemon-unavailable behavior, and local admin-only unlock | Foreground and long-running local service smoke test on Ubuntu | `BLK-V1-04`, `BLK-V1-06` |
| `FR-012`: local API route families and error envelope | Route contract tests verify method, auth mode, request schema, response schema, stream event schema, and typed error envelope | API inspection with sample failures verifies actionable messages without leaking secrets | `BLK-V1-04` |
| `FR-014`, `NFR-002`, `NFR-008`, `DR-007`, `SFR-010`: restart, durable state, stale sessions, write rejection | Restart integration tests reload registry/auth/audit/settings, reconcile tmux targets, restart readers, and reject stale/stopped/crashed/unknown writes | Manual disconnect/reconnect and daemon restart smoke while tmux session continues | `BLK-V1-02`, `BLK-V1-03`, `BLK-V1-04` |
| `NFR-001`, `PR-001` to `PR-004`, `PR-007`, `PR-009`: local-first platform, startup checks, config, bind policy | Config/startup tests cover missing binaries, invalid state dir, invalid bind/port, default localhost bind, explicit LAN opt-in, and configurable state/port | Network smoke confirms no hosted relay/account/public listener and no root/router setup | `BLK-V1-04`, `BLK-V1-06` |
| `NFR-005`, `NFR-006`, `SFR-005`: loud failures and no fake success | Negative tests assert nonzero CLI exits, non-2xx API errors, typed UI errors, and no tmux send after failed preconditions | Failure-path review confirms messages preserve true cause and do not promise success before output proves it | All block hardening tasks |
| `DR-001` to `DR-010`: storage, audit, pairing/token, retention, payload bounds | Storage migration/repository tests, auth persistence tests, audit action type tests, bounded payload tests, retention cleanup tests | Local state inspection verifies raw tokens are not stored and audit entries are bounded | `BLK-V1-02`, `BLK-V1-06` |
| `SFR-001` to `SFR-009`: trust, lock, LAN, raw input, risky controls | Auth/API/UI tests cover trusted, read-only, untrusted, revoked, expired, locked, LAN-disabled, and advanced raw input states | Browser inspection verifies disabled controls are visible before write attempts and unlock is CLI-only | `BLK-V1-02`, `BLK-V1-04`, `BLK-V1-05` |

## Block Coverage

Use this as the overall validation map. Block-specific validation details live in `docs/planning/05-blocks/`.

| Block ID | Automated coverage | Manual/device coverage | Release evidence |
| --- | --- | --- | --- |
| BLK-V1-01 | Unit and contract tests for session identity, lifecycle states, attention/status model, error envelope, write eligibility, and required fixture categories | Fixture review confirms unknown/failure cases are not collapsed into healthy states | Core/contract test artifact referenced by block completion matrix |
| BLK-V1-02 | SQLite migration/repository tests, auth/token lifecycle tests, audit sanitization tests, retention tests, restart persistence tests | Local state inspection for hashed tokens, bounded audit payloads, and durable settings | Storage/auth/audit hardening artifact and selected SQLite/token/retention decisions |
| BLK-V1-03 | Fake tmux adapter tests, real tmux lifecycle smoke, output capture/replay tests, restart/stale tests | Ubuntu smoke with at least two managed sessions, attach path, send, stop, restart, and stale-target behavior | Tmux/output hardening artifact plus `SPK-ARCH-001` result |
| BLK-V1-04 | API route contract tests, write-pipeline ordering tests, CLI command tests, startup/config tests, LAN/lock tests | Foreground and service-mode smoke, daemon-unavailable CLI behavior, localhost/LAN network check | API/CLI hardening artifact and command-reference update after scripts/commands exist |
| BLK-V1-05 | Web component/state tests, UI integration tests against fake API fixtures, accessibility checks, write-disabled control tests | Approved mockup comparison, phone/desktop screenshots, disconnected/stale/error manual inspection | UI-fidelity artifact, selected visual-direction decision, and screenshot paths |
| BLK-V1-06 | Build/typecheck/lint/test aggregate, release smoke script, setup validation, security/privacy checklist | Clean Ubuntu user install/run path, local service start/stop/status, support/troubleshooting review | Release-readiness artifact with go/no-go, known gaps, and push/commit state |

## Spike Validation

| Spike | Proof artifact must include | Decision output | Blocks |
| --- | --- | --- | --- |
| `SPK-ARCH-001` tmux output capture | Prototype commands, fake Codex fixture, captured ordered events, reader restart behavior, cursor/replay boundary behavior, observed failure modes | Chosen capture mechanism, reader supervision policy, cursor semantics, and test fixture plan | `BLK-V1-03`, `BLK-V1-04`, output coverage |
| `SPK-ARCH-002` SQLite driver | Install/build notes, license check, Node LTS compatibility, migration approach, test isolation behavior, failure handling | Chosen driver, migration library or local approach, setup impact | `BLK-V1-02`, developer setup when dependency is added |
| `SPK-ARCH-003` token transport | Same-origin localhost and LAN opt-in prototype notes, HttpOnly-cookie versus bearer-token comparison, CSRF/revocation posture | Chosen token transport, revocation behavior, dashboard state model, API contract update | `BLK-V1-02`, `BLK-V1-04`, `BLK-V1-05` |
| `SPK-ARCH-004` output/audit retention | Fixture size estimates, bounded append/replay test, cleanup timing, audit payload examples | Output cap, audit cap, truncation marker behavior, cleanup schedule | `BLK-V1-02`, `BLK-V1-03`, `BLK-V1-05` |
| `SPK-UX-001` visual direction/mockups | State matrix, two generated visual directions, Mission Control, Session Detail, trust/status, raw fallback, phone/desktop framing | Human-selected direction, assets copied under `assets/ui-concepts/`, decision log entry, UX spec update if contract changes | `BLK-V1-05` UI implementation |

## Regression Matrices

### Output And Status Fixtures

| Fixture suite | Required cases | Must assert |
| --- | --- | --- |
| Codex-like status text | Question waiting, approval waiting, command running, tests passed, tests failed, compact/context warning, idle/no-output, unknown output | Expected `SessionStatus`, `AttentionLevel`, and conservative `unknown` fallback |
| Output ordering | Interleaved lines, bursts, partial lines if supported, reconnect after cursor, retention boundary | Monotonic cursor order, no undocumented duplicate replay, visible boundary when older output is unavailable |
| Session summaries | Recent meaningful output, noisy output, empty output, stale output | Bounded summary, last activity update, no unbounded storage growth |

### Write Rejection Matrix

| Gate | Rejection cases | Must assert |
| --- | --- | --- |
| Request schema | Missing session id, malformed payload, unsupported action, unsupported slash command, multi-session request | Typed validation error, no audit success, no tmux send |
| Trust and permission | Untrusted, read-only, expired token, revoked token, pairing code expired/used | Permission error, UI write controls disabled, no ambient write grant |
| Host safety | Locked host, LAN mutation from dashboard, remote unlock attempt | Explicit rejection, CLI-only unlock preserved, audit event when required |
| Session writability | Stale, stopped, crashed, unknown, unreconciled, missing tmux target | Explicit denial, no buffering for later delivery |
| Audit preflight | Audit storage unavailable, payload summary cannot be bounded | Remote write rejected before tmux send |

### Startup And Config Matrix

| Area | Cases | Must assert |
| --- | --- | --- |
| Required binaries | Missing `tmux`, missing Codex executable for session start | `serve` or start fails loudly before claiming readiness or creating a successful registry record |
| Paths and state | Invalid cwd, invalid state dir, corrupt migration, read-only state dir | Nonzero CLI/API failure with typed cause and no fake success |
| Network | Default bind, explicit LAN enable, LAN disable, invalid port, duplicate port | Localhost by default, LAN visible/reversible, startup refuses invalid bind |
| Restart | Live target present, target missing, unknown HostDeck-looking target, output reader failure | Registry reconciliation marks truthfully running/stale/ignored/error state |

### UI State Matrix

| Surface | States requiring tests/screenshots | Evidence |
| --- | --- | --- |
| Mission Control | Empty, loading, all idle, mixed attention, disconnected, permission-denied, agent-error, LAN-disabled, locked | Component/state tests first; screenshots after selected mockups |
| Session Detail | Running, waiting for input, waiting for approval, failed, unknown, stale, stopped, output boundary, stream reconnecting | Component/state tests first; phone screenshot after selected mockups |
| Composer and slash controls | Trusted writable, read-only, untrusted, locked, unsupported slash, prompt error, accepted write pending output | Component/API integration tests plus browser inspection |
| Advanced raw fallback | Hidden by default, advanced mode entered, raw input confirmation, raw write rejected, raw write accepted and audited | UI/API test and screenshot after selected mockups |
| Pairing and Host Status/Safety | Pairing pending, trusted, expired/used code, revoked client, lock active, LAN enabled/disabled | Component/API integration tests plus manual browser inspection |

## Validation Layers

| Layer | Applies to | Purpose | Evidence |
| --- | --- | --- | --- |
| Unit | Core, contracts, classifiers, write eligibility, config parsing, storage helpers | Prove pure logic and boundary behavior without tmux/network/browser | Planned unit command output linked from leaf task |
| Contract | API, stream events, CLI output/exit families, storage/audit records | Keep cross-module behavior typed and stable | Planned contract command output and fixture snapshots |
| Integration | Storage, auth, audit, API services, fake tmux/Codex, output readers | Prove module boundaries and failure ordering | Planned integration command output and temp-state cleanup notes |
| System / E2E | Local daemon/API/web fake vertical, CLI against daemon | Prove complete workflows before real Codex dependence | Local E2E artifact with server log and browser/API evidence |
| Real adapter smoke | Ubuntu tmux, local service, filesystem, network bind | Prove environment assumptions not covered by fakes | Smoke artifact with OS/tool versions and commands |
| Visual fidelity | Web UI after `SPK-UX-001` approval | Compare implementation against selected mockups and state matrix | Screenshots or visual diffs with drift notes |
| Accessibility/responsive | Phone browser, keyboard/focus, readable status/error controls | Prove V1 is usable without terminal-width assumptions | Screenshot/checklist artifact |
| Security/privacy | Pairing/token, lock/unlock, LAN, audit bounds, no secret storage | Prove trust gate and local-first safety posture | Test output plus security checklist |
| Release packaging | Clean local setup, service start/stop/status, support docs, command reference | Prove handoff path from a normal Ubuntu user environment | Release-readiness artifact and go/no-go |

## Manual Inspection

| Area | What to inspect | Evidence |
| --- | --- | --- |
| Real tmux behavior | Start, list, attach, send, stop, restart, stale target handling with HostDeck-managed sessions | Ubuntu smoke artifact with versions, commands, result, and gaps |
| Local-first networking | Default localhost bind, explicit LAN enable/disable, dashboard visibility of LAN state | Network smoke artifact |
| Browser UX | Mission Control and Session Detail on phone and desktop widths, including trust, lock, unknown, stale, disconnected, and output-boundary states | Screenshot set after visual direction approval |
| Failure paths | Missing binaries, invalid cwd, daemon unavailable, audit unavailable, expired pairing, locked host, stale session, unsupported slash command | Failure-path notes or artifact with exact visible/API/CLI behavior |
| Security/privacy | Token storage, audit payload bounds, revoked/expired trust, CLI-only unlock, no hosted relay/account assumption | Security checklist and targeted test output |
| Release | Clean install/run/build, foreground and service mode, support docs, command reference, known gaps | Release-readiness checklist and status update |

## Evidence Policy

- Store durable command logs, smoke notes, screenshots, and spike results under `artifacts/` when they are more detailed than a task card should carry.
- Each leaf task must reference requirement IDs, block IDs, command names run, pass/fail result, and artifact paths or explicit validation gaps.
- Screenshots are required for UI screen groups after mockup selection; component tests alone do not prove responsive layout or visual drift.
- Spike results must record the rejected options, chosen option, commands or prototypes used, and docs/tasks changed by the decision.
- A release blocker must be visible in status, release tracking, or the owning backlog task; it cannot live only inside an artifact.
- Planned commands become real documentation only after scripts exist and have been run at least once.
