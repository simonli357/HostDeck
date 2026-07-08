# Foundation / Contracts Backlog

Owns `BLK-V1-01`: workspace scaffold, core model, contracts, fixtures, and foundation hardening.

## EP-FND-01 Workspace And Command Skeleton

| ID | Status | Refs | Requires | Blocked by | Blocks | Description | Success criteria | Validation / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `FND-V1-001` | blocked | `BLK-V1-01`, `BLK-V1-06`, `NFR-007`, `04b:Planned Commands` | human acceptance | Implementation authorization | `FND-V1-002`, `DAT-V1-001`, `INT-V1-001`, `IFC-V1-001`, `REL-V1-001` | Scaffold the pnpm workspace, package boundaries, TypeScript config, and placeholder scripts for planned validation commands. | Repo has package layout for `core`, `contracts`, `test-fixtures`, `storage`, `tmux-adapter`, `server`, `cli`, and `web`; placeholder scripts fail loudly or run known checks without fake readiness. | `pnpm install`, `pnpm typecheck`, and script smoke output after scaffold; explicit gaps recorded for scripts not yet implemented. |
| `FND-V1-002` | todo | `BLK-V1-01`, `NFR-005`, `NFR-006` | none | `FND-V1-001` | `FND-V1-003`, `FND-V1-004`, `FND-V1-005` | Add shared strict TypeScript, lint, test runner, and package export conventions. | Shared commands run from repo root; invalid exports/type errors fail loudly; package boundaries are documented in repo guide later. | `pnpm typecheck`, `pnpm lint`, and root test runner output. |

## EP-FND-02 Core Model And Contracts

| ID | Status | Refs | Requires | Blocked by | Blocks | Description | Success criteria | Validation / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `FND-V1-003` | todo | `BLK-V1-01`, `FR-002`, `FR-009`, `DR-001`, `DR-002`, `NFR-003` | none | `FND-V1-002` | `FND-V1-004`, `FND-V1-006`, `DAT-V1-012`, `INT-V1-010`, `FE-V1-001` | Define session identity, lifecycle states, status, attention, timestamps, cwd/project metadata, and branch metadata types. | Stable ids are separate from names; unknown/stale/failed states are explicit; no adapter/UI owns hidden state shapes. | Unit tests for type guards, invalid ids/names, state transitions, and unknown advisory behavior. |
| `FND-V1-004` | todo | `BLK-V1-01`, `FR-006` to `FR-008`, `FR-015`, `SFR-001` to `SFR-005`, `SFR-009`, `SFR-010`, `DEC-003` | none | `FND-V1-003` | `IFC-V1-004`, `FE-V1-012`, `FE-V1-013` | Define command intents, V1 slash allowlist, write eligibility, and non-writable state denial codes. | `/model`, `/goal`, `/plan`, `/usage`, `/compact`, `/skills` are allowed; unsupported slash and multi-session writes reject; stale/stopped/crashed/unknown writes are denied. | Unit tests for allowed slash commands, unsupported commands, one-session write rules, lock/trust/session denial reasons. |
| `FND-V1-005` | todo | `BLK-V1-01`, `FR-012`, `NFR-005`, `NFR-006`, `SFR-005` | none | `FND-V1-002` | `FND-V1-006`, `IFC-V1-002`, `IFC-V1-010` | Define the shared API/CLI error envelope and bounded error detail rules. | Errors use stable `code`, `message`, optional bounded context, and retryability; sensitive or unbounded details reject in tests. | Unit and contract tests for error construction, serialization, and bounds. |
| `FND-V1-006` | todo | `BLK-V1-01`, `FR-012`, `DR-001` to `DR-010`, `PR-009` | none | `FND-V1-003`, `FND-V1-005` | `DAT-V1-010`, `IFC-V1-002`, `IFC-V1-003`, `IFC-V1-005`, `FE-V1-010` | Implement Zod schemas and inferred TypeScript types for API requests/responses, stream events, storage records, config, audit events, and UI fixtures. | Malformed request, stream, storage, config, and audit payloads reject with the shared error envelope; schemas are exported from `@hostdeck/contracts`. | `pnpm test:contract` output with malformed payload fixtures and bounded-detail assertions. |

## EP-FND-03 Fixtures And Classifiers

| ID | Status | Refs | Requires | Blocked by | Blocks | Description | Success criteria | Validation / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `FND-V1-007` | todo | `BLK-V1-01`, `SFR-011`, `NFR-007` | none | `FND-V1-006` | `FND-V1-008`, `INT-V1-001`, `FE-V1-001` | Create deterministic fake Codex output fixtures and fake session/host states. | Fixtures cover question waiting, approval waiting, command running, tests passed, tests failed, compact/context warning, idle/no-output, and unknown output. | Fixture inventory artifact or test snapshot proving every `SFR-011` category exists. |
| `FND-V1-008` | todo | `BLK-V1-01`, `FR-009`, `NFR-003`, `SFR-011` | none | `FND-V1-007` | `FE-V1-015`, `FND-V1-010` | Implement conservative status/attention classifier tests over fixtures. | Known patterns classify as expected; unrecognized output is `unknown` and never idle/success by default. | Unit test output for every fixture category plus unknown fallback case. |
| `FND-V1-009` | todo | `BLK-V1-01`, `FR-012`, `DR-010`, `NFR-006` | none | `FND-V1-006`, `FND-V1-007` | `DAT-V1-014`, `IFC-V1-010`, `FND-V1-010` | Add cross-package contract tests for schema rejection, API error shape, audit bounds, and UI fixture compatibility. | Invalid schemas fail loudly; fixture view models satisfy exported contracts; audit payload summaries stay bounded. | `pnpm test:contract` output and fixture snapshot diff. |

## EP-FND-04 Foundation Hardening

| ID | Status | Refs | Requires | Blocked by | Blocks | Description | Success criteria | Validation / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `FND-V1-010` | todo | `BLK-V1-01`, `04b:Regression Matrices`, `production-hardening` | none | `FND-V1-004`, `FND-V1-008`, `FND-V1-009` | `DAT-V1-010`, `INT-V1-010`, `IFC-V1-001`, `FE-V1-001`, `REL-V1-008` | Run a production-hardening pass on contracts, core state rules, write eligibility, and fixtures before adapters consume them. | Normal, boundary, invalid, impossible, unknown, and repeated-use cases are covered; hidden fallback and fake success states are absent. | Hardening artifact with criteria, commands run, failures found/fixed, remaining gaps, and block matrix update. |
| `FND-V1-011` | todo | `BLK-V1-01`, `BLK-V1-06`, `docs/tracking/backlog/00-index.md` | none | `FND-V1-010` | `REL-V1-008` | Record foundation completion evidence and update block/task links after the hardening pass. | `BLK-V1-01` completion row points to concrete artifacts and owning tasks; no stale backlog placeholders remain for the block. | Docs diff plus artifact links in `docs/planning/05-blocks/00-index.md` and this task card. |
