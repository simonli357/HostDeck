# Release / Hardening Backlog

Owns `BLK-V1-06`: cross-system audit/rebaseline, release documentation, security/privacy, clean Ubuntu/package/service/browser/phone/real-Codex validation, completion matrix, and go/no-go.

## EP-REL-00 System Rebaseline

| ID | Status | Refs | Requires | Blocked by | Blocks | Description | Success criteria | Validation / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `REL-V1-011` | done | `BLK-V1-01` to `BLK-V1-06`, `production-hardening`, `docs-sync`, `ui-fidelity`, `DEC-018` to `DEC-020` | full repo/code/evidence audit; official Codex docs; local compatibility smoke | none | `FND-V1-015`, `IFC-V1-015`, all selected-path implementation | Audit and rebaseline V1 direction, architecture, contracts, security, implementation truth, mobile UX, blocks, backlog, queue, and release gates before further feature work. | Confirmed findings are recorded; owner docs agree; stale completion claims are reopened; app-server/HTTPS/mobile direction and dependency-aware leaf tasks are explicit; baseline tests and `pnpm check:planning` pass; old mockups are rejected targets. | Rebaseline commit `2e06d4b` pushed to `origin/main`; full evidence in `artifacts/rel-v1-011-v1-system-hardening-audit.md` and `artifacts/int-v1-002-codex-integration-reassessment.md`. |

## EP-REL-01 Documentation And Validation Wiring

| ID | Status | Refs | Requires | Blocked by | Blocks | Description | Success criteria | Validation / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `REL-V1-001` | done | `BLK-V1-06`, historical command wiring | none | `FND-V1-001` | `REL-V1-007` | Wire original aggregate command names and loud placeholders. | Historical placeholders do not fake success. | `artifacts/rel-v1-001-validation-wiring.md`. |
| `REL-V1-002` | done | `BLK-V1-06`, historical developer guide | none | `DAT-V1-001`, `IFC-V1-012` | `REL-V1-006` | Document original validated setup/service facts and explicit gaps. | Historical guide does not claim unavailable binary/service wrapper. It must be refreshed after `IFC-V1-021`. | `artifacts/rel-v1-002-developer-guide.md`. |
| `REL-V1-003` | done | `BLK-V1-06`, historical command reference | none | `IFC-V1-013` | `REL-V1-006` | Record original verified commands and explicit gaps. | Historical reference avoids fake commands. It must be refreshed after `IFC-V1-021`. | `artifacts/rel-v1-003-command-reference.md`. |
| `REL-V1-004` | todo | `BLK-V1-06`, `IR-007`, `UX-001` to `UX-011` | complete packaged user workflow | `FE-V1-018`, `IFC-V1-021` | `REL-V1-010` | Write/update user guide and troubleshooting from verified selected-path behavior. | Covers HTTPS/certificate enrollment, pair/reload/revoke, scan/prompt/controls/approval, lock, TUI resume, failures, recovery, and limitations with tested commands/screens. | Docs diff linked to device/system evidence. |

## EP-REL-02 Release Validation

| ID | Status | Refs | Requires | Blocked by | Blocks | Description | Success criteria | Validation / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `REL-V1-005` | todo | `BLK-V1-06`, `NFR-001`, `NFR-013`, `SFR-001` to `SFR-018`, `release-readiness` | selected production path and phone HTTPS | `DAT-V1-091`, `INT-V1-091`, `IFC-V1-015`, `IFC-V1-091`, `FE-V1-013` | `REL-V1-010` | Run security/privacy release review. | No plaintext LAN, unpaired LAN data, direct app-server exposure, insecure cookie/CSRF/origin/rate path, raw secrets/transcript copy, unsafe permissions, unbounded resources, hidden fallback, or contradictory audit remains. | Security/privacy artifact with test/inspection links and zero unresolved release blocker. |
| `REL-V1-006` | todo | `BLK-V1-06`, `PR-001` to `PR-012`, `NFR-001`, `NFR-009`, `release-readiness` | clean Ubuntu, supported Codex, phone/browser | `INT-V1-091`, `IFC-V1-021`, `FE-V1-090`, `REL-V1-002`, `REL-V1-003` | `REL-V1-007`, `REL-V1-010` | Run clean checkout/build/package/user-service/real-Codex/browser/phone install and recovery smoke. | Normal user installs/runs/uninstalls; app-server and HostDeck ownership/restart pass; phone HTTPS/pair/reload/prompt/approval/lock works; no root/router/manual source execution required; docs updated to actual commands. | Redacted L4 artifact with exact versions/commit, commands, screenshots/logs, cleanup. |
| `REL-V1-007` | todo | `BLK-V1-06`, `04b:Commands`, `release-readiness` | release candidate commit | `FND-V1-091`, `DAT-V1-091`, `INT-V1-091`, `IFC-V1-091`, `FE-V1-090`, `REL-V1-006` | `REL-V1-008`, `REL-V1-010` | Run aggregate validation and inspect flaky/skipped/manual gaps. | Planning/scaffold/type/lint/unit/contract/integration/web/Codex/E2E/build/local smoke all pass; every skip/gap is approved or blocks release; no stale tmux path is counted as selected proof. | Aggregate command artifact and rerun/root-cause notes. |
| `REL-V1-008` | todo | `BLK-V1-01` to `BLK-V1-06`, `docs/planning/05-blocks/00-index.md` | current evidence | `FND-V1-091`, `DAT-V1-091`, `INT-V1-091`, `IFC-V1-091`, `FE-V1-090`, `REL-V1-007` | `REL-V1-009`, `REL-V1-010` | Update block completion matrix from current selected-path evidence. | Each required outcome links tasks and L1-L4 evidence or remains explicitly blocked; no qualified completion language masks gaps. | Block-matrix diff and `pnpm check:planning`. |
| `REL-V1-009` | todo | `BLK-V1-06`, `docs/tracking/05-delivery-plan.md`, `release-readiness` | current block matrix | `REL-V1-008` | `REL-V1-010` | Update delivery plan and concise handoff truth. | Milestones, module maturity, release gates, blockers, docs/support, validation, and push state match evidence. | Delivery/status diff. |
| `REL-V1-010` | blocked | `BLK-V1-06`, `release-readiness`, human acceptance | exact release candidate and evidence | `REL-V1-004` to `REL-V1-009`, human acceptance | `REL-V1-999` | Produce final V1 go/no-go and handoff. | Explicit release-ready or no-go; blockers/known gaps visible; human decision and commit/push state recorded. | Release-readiness artifact and status/decision update. |

## EP-REL-99 Next Version Gate

| ID | Status | Refs | Requires | Blocked by | Blocks | Description | Success criteria | Validation / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `REL-V1-999` | blocked | `BLK-V1-06`, `docs/planning/00-roadmap.md`, `REL-V1-010` | V1 human acceptance | `REL-V1-010`, human acceptance | V2 planning pipeline | Review V1 outcome and choose the next active version only after accepted V1. | Roadmap/decision/status reflect acceptance; V2 planning starts through the full workflow. | Decision log and roadmap/status update. |
