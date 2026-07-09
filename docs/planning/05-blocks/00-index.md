# V1 Blocks

Owns the active-version capability block map and V1 completion matrix. Blocks are the middle layer between global planning docs and backlog leaf tasks.

Use blocks for meaningful V1 capabilities, workflows, screen groups, native capabilities, infrastructure areas, or release paths. Do not create a separate block for every epic.

## Rules

- Block IDs use `BLK-V1-01`, `BLK-V1-02`, and so on.
- The global planning docs own cross-block scope, architecture, UX contracts, validation strategy, and release truth.
- Block specs own local architecture, detailed design, implementation sequence, validation, epics, and task links.
- Every active-version requirement must map to a block, explicit spike, or explicit release deferral.
- Every backlog group and epic should reference one or more block IDs.
- V1 is not complete until every required block has completion evidence.

## Block Map

| Block ID | Block | Required for V1? | Spec | Requirements | Depends on | Backlog groups | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| BLK-V1-01 | Contracts, core model, and fixtures | Yes | `BLK-V1-01-contracts-core-fixtures.md` | `FR-002`, `FR-006` to `FR-009`, `FR-015`, `NFR-003`, `NFR-005` to `NFR-007`, `SFR-005`, `SFR-011` | Approved requirements, architecture, and test plan | `docs/tracking/backlog/foundation.md` | Complete |
| BLK-V1-02 | Local state, auth, audit, and config | Yes | `BLK-V1-02-local-state-auth-audit.md` | `DR-001` to `DR-010`, `SFR-001`, `SFR-002`, `SFR-004`, `SFR-006` to `SFR-008`, `PR-009` | `BLK-V1-01`; `SPK-ARCH-002` resolved by `DEC-014`, `SPK-ARCH-003` resolved by `DEC-015`, `SPK-ARCH-004` resolved by `DEC-016` | `docs/tracking/backlog/local-state-auth-audit.md` | Complete for storage-owned scope |
| BLK-V1-03 | Tmux session lifecycle and output ingestion | Yes | `BLK-V1-03-tmux-output.md` | `FR-001`, `FR-003` to `FR-005`, `FR-013`, `FR-014`, `NFR-002`, `PR-001`, `PR-006`, `SFR-010` | `BLK-V1-01`, `BLK-V1-02`, `SPK-ARCH-001`; `SPK-ARCH-004` resolved by `DEC-016` | `docs/tracking/backlog/tmux-output.md` | Backlog mapped |
| BLK-V1-04 | Local API and CLI control plane | Yes | `BLK-V1-04-api-cli-control-plane.md` | `FR-006` to `FR-008`, `FR-011`, `FR-012`, `FR-015`, `PR-002` to `PR-004`, `PR-007`, `PR-008`, `SFR-003`, `SFR-005` | `BLK-V1-01` to `BLK-V1-03`; `SPK-ARCH-003` resolved by `DEC-015` | `docs/tracking/backlog/api-cli-control-plane.md` | Backlog mapped |
| BLK-V1-05 | Web dashboard UX | Yes | `BLK-V1-05-web-dashboard.md` | `FR-005` to `FR-010`, `IR-001` to `IR-009`, `PR-005`, `SFR-001` to `SFR-003`, `SFR-009` | `BLK-V1-01`, `BLK-V1-04`, `SPK-UX-001`; `SPK-ARCH-003` resolved by `DEC-015` | `docs/tracking/backlog/web-dashboard.md` | Backlog mapped |
| BLK-V1-06 | Hardening, setup, and release readiness | Yes | `BLK-V1-06-hardening-release.md` | `NFR-001` to `NFR-009`, `PR-001` to `PR-009`, release gates | `BLK-V1-01` to `BLK-V1-05` | `docs/tracking/backlog/hardening-release.md` | Backlog mapped |

## V1 Completion Matrix

| Block ID | Required outcome | Task coverage | Automated evidence | Manual/device evidence | Release impact | Status |
| --- | --- | --- | --- | --- | --- | --- |
| BLK-V1-01 | Stable typed contracts, core state model, errors, write eligibility, and Codex-like fixtures exist before adapters/UI. | `FND-V1-001` to `FND-V1-013` in `foundation.md`. | `artifacts/fnd-v1-001-scaffold.md` through `artifacts/fnd-v1-010-foundation-hardening.md`; completion rollup in `artifacts/fnd-v1-011-foundation-completion.md`. | Fixture review in `artifacts/fnd-v1-010-foundation-hardening.md` confirms unknown/failure states are not treated as healthy success. | Downstream storage, tmux fake-adapter, API/CLI, and UI state tasks can consume foundation contracts. | Complete on 2026-07-08; product workflow behavior remains unproven until later blocks complete |
| BLK-V1-02 | Durable local state, pairing/token trust, lock/LAN settings, audit records, retention, config rules, and optional branch metadata work locally. | `DAT-V1-001` to `DAT-V1-017`, `DAT-V1-090` in `local-state-auth-audit.md`. | `DAT-V1-001` spike evidence in `artifacts/dat-v1-001-sqlite-driver-spike.md`; `DAT-V1-002` token transport evidence in `artifacts/dat-v1-002-token-transport-spike.md`; `DAT-V1-003` retention evidence in `artifacts/dat-v1-003-retention-caps-spike.md`; `DAT-V1-010` migration/base-schema evidence in `artifacts/dat-v1-010-sqlite-migration-runner.md`; `DAT-V1-011` settings repository evidence in `artifacts/dat-v1-011-settings-repository.md`; `DAT-V1-012` session repository evidence in `artifacts/dat-v1-012-session-repositories.md`; `DAT-V1-013` auth repository evidence in `artifacts/dat-v1-013-auth-repositories.md`; `DAT-V1-014` audit repository evidence in `artifacts/dat-v1-014-audit-repository.md`; `DAT-V1-015` retention repository evidence in `artifacts/dat-v1-015-retention-repository.md`; `DAT-V1-016` restart persistence evidence in `artifacts/dat-v1-016-restart-persistence.md`; `DAT-V1-017` branch metadata evidence in `artifacts/dat-v1-017-branch-metadata.md`; `DAT-V1-090` hardening evidence in `artifacts/dat-v1-090-storage-hardening.md`. | Token/code/CSRF row inspection exists in `DAT-V1-013`; bounded audit payload tests exist in `DAT-V1-014`; retention boundary tests exist in `DAT-V1-015`; restart persistence tests exist in `DAT-V1-016`; git/non-git branch metadata tests exist in `DAT-V1-017`; local raw-secret/audit-payload inspection exists in `DAT-V1-090`; visible lock/LAN release inspection remains planned. | Enables safe writes, restart truth, and release privacy posture. | Complete for storage-owned scope on 2026-07-08; API write preflight, live tmux reconciliation, and release privacy docs remain in later blocks |
| BLK-V1-03 | HostDeck can manage tmux-backed Codex sessions, ingest ordered output, reconnect streams, attach locally, and reconcile stale sessions. | `INT-V1-001`, `INT-V1-010` to `INT-V1-016`, `INT-V1-090` in `tmux-output.md`. | Output capture spike evidence in `artifacts/int-v1-001-tmux-capture-spike.md`; fake adapter evidence in `artifacts/int-v1-010-fake-tmux-adapter.md`; real target primitive evidence in `artifacts/int-v1-011-real-tmux-targets.md`; real managed start evidence in `artifacts/int-v1-012-real-tmux-start.md`; real send/stop/attach evidence in `artifacts/int-v1-013-real-tmux-operations.md`; output reader, restart service, and stale write rejection tests remain planned. | User-local tmux smoke for output capture exists; isolated real tmux target discovery, managed-start, send, stop, and attach tests exist; full Ubuntu tmux smoke with multiple sessions, attach, send, stop, restart, and stale target behavior remains planned. | Enables the core host-agent workflow and real-process evidence. | In progress: fake adapter, output capture spike, real target primitives, managed start, send, stop, and attach done; output, restart, smoke, and hardening remain |
| BLK-V1-04 | Typed local API and `codexdeck` CLI expose host status, sessions, writes, pairing state, lock/LAN state, and service modes with loud failures. | `IFC-V1-001` to `IFC-V1-014`, `IFC-V1-090` in `api-cli-control-plane.md`. | Pairing/security route evidence in `artifacts/ifc-v1-005-security-routes.md`; remaining API/CLI contract tests, startup/config tests, write-ordering tests, and negative failure tests are planned. | Foreground/service-mode smoke, daemon-unavailable CLI behavior, localhost/LAN network check remain planned. | Owns user/operator control plane and command reference updates. | In progress: pairing/security route foundation done; startup, sessions, streams, writes, CLI, and hardening remain planned or blocked |
| BLK-V1-05 | Phone-responsive dashboard delivers Mission Control, Session Detail, trust/safety states, prompt/slash controls, and raw fallback against approved mockups. | `FE-V1-001` to `FE-V1-021`, `FE-V1-090` in `web-dashboard.md`. | Component/state tests, UI integration tests, accessibility checks, disabled-write control tests. | Human-selected mockup comparison, phone/desktop screenshots, drift notes, failure-state inspection. | Owns visible V1 user experience and UI-fidelity release evidence. | Not started |
| BLK-V1-06 | V1 can be installed, run, validated, documented, and judged go/no-go from a clean Ubuntu workflow. | `REL-V1-001` to `REL-V1-010`, `REL-V1-999` in `hardening-release.md`. | Validation command wiring evidence in `artifacts/rel-v1-001-validation-wiring.md`; full typecheck/lint/test/build aggregate, release smoke script, and setup checks remain planned. | Clean Ubuntu install/run, service start/stop/status, support docs review, and go/no-go checklist remain planned. | Owns release readiness, handoff truth, and known-gap visibility. | In progress: validation wiring done; release validation and handoff remain planned or blocked |

## Requirement Coverage

| Requirement group | Coverage route |
| --- | --- |
| `FR-001` to `FR-004`, `FR-013`, `FR-014` session lifecycle/output/restart | `BLK-V1-03` with API/CLI exposure in `BLK-V1-04` |
| `FR-005` output refresh/streaming | Output ownership in `BLK-V1-03`, API stream in `BLK-V1-04`, dashboard rendering in `BLK-V1-05` |
| `FR-006` to `FR-008`, `FR-015` prompt/slash writes | Core write eligibility in `BLK-V1-01`, API/CLI write path in `BLK-V1-04`, dashboard controls in `BLK-V1-05` |
| `FR-009`, `SFR-011` status and fixture heuristics | `BLK-V1-01`, with UI representation in `BLK-V1-05` |
| `FR-010`, `IR-001` to `IR-009`, `PR-005` dashboard UX | `BLK-V1-05` |
| `FR-011`, `FR-012`, `PR-002` to `PR-004`, `PR-007`, `PR-008` API/CLI/service | `BLK-V1-04`, with release docs in `BLK-V1-06` |
| `DR-001` to `DR-010`, `SFR-001`, `SFR-002`, `SFR-004`, `SFR-006` to `SFR-008` data/auth/audit | `BLK-V1-02`, with write enforcement in `BLK-V1-04` and UI state in `BLK-V1-05` |
| `NFR-001` to `NFR-009`, `PR-001` to `PR-009`, `SFR-003`, `SFR-005`, `SFR-009`, `SFR-010` safety/platform/failure | Distributed across blocks with aggregate proof in `BLK-V1-06` |

## Backlog Decomposition Rules

- Create backlog group files that correspond to the block map rather than broad feature buckets.
- Every epic and leaf task must reference at least one block ID and requirement ID.
- Architecture spikes from `docs/planning/04a-implementation-blueprint.md` become leaf tasks before dependent implementation tasks.
- `SPK-UX-001` must be represented as a blocked UI-fidelity task before UI implementation tasks.
- Each block needs a foundation epic, at least one hardening epic, and validation evidence tasks before it can be marked complete.
- Do not add implementation tasks that require deciding product scope, route semantics, storage policy, trust model, visual direction, or validation strategy during coding.

## Coverage Checks

- Every user journey and critical failure state maps to a required block.
- Every native capability, integration, datastore, credential, platform, and store-release dependency maps to a block or explicit deferral.
- Every mobile screen group has a block or is covered inside a larger workflow block.
- Every block has at least one hardening task before V1 completion.
- Every block has validation evidence before it is marked complete.
