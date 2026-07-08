# BLK-V1-01 Contracts, Core Model, And Fixtures

Owns the typed foundation that later storage, tmux, API, CLI, and UI work must consume.

## Summary

- Goal: Define stable contracts, core state rules, write eligibility, errors, and deterministic fixtures before adapters or UI exist.
- Required for V1: Yes.
- User/workflow value: Prevents later HostDeck behavior from drifting into ad hoc terminal parsing, fake success states, or UI-only truth.
- In scope: Workspace scaffold inputs, `@hostdeck/core`, `@hostdeck/contracts`, shared fixture package, lifecycle/status/attention model, API error envelope, write eligibility, Codex-like output fixtures.
- Out / deferred: Real tmux process control, SQLite persistence, browser visual design, release packaging.
- Requirement refs: `FR-002`, `FR-006` to `FR-009`, `FR-015`, `NFR-003`, `NFR-005` to `NFR-007`, `SFR-005`, `SFR-011`.
- UX refs: `IR-001`, `IR-002`, `IR-006`, `IR-008`, `UX-002` to `UX-005`, `UX-009`.
- Decision refs: `DEC-003`, `DEC-007`, `DEC-008`, `DEC-010`, `DEC-011`.

## Local Architecture

| Part | Responsibility | Inputs | Outputs | Failure states |
| --- | --- | --- | --- | --- |
| Core model | Session ids/names, lifecycle states, attention/status values, command intent, write eligibility. | Requirements, blueprint public interfaces. | Pure TypeScript types and functions with no filesystem, network, tmux, or browser dependency. | Impossible transitions, duplicate names, invalid ids, non-writable lifecycle states. |
| Contract schemas | Zod schemas and inferred types for API payloads, stream events, storage records, config, audit events, UI fixtures. | Core types and route families. | Runtime validators and shared TypeScript types. | Malformed payloads, invalid enum values, unbounded detail fields, schema mismatch. |
| Error model | Stable error envelope and code families shared by API, CLI, and UI. | Failure matrix and test-plan negative cases. | `code`, `message`, optional bounded context, and retryable flag. | Hidden fallback, swallowed error, fake success, sensitive details in error context. |
| Fixture package | Fake Codex outputs, fake session records, fake host states, fake stream events. | `SFR-011`, UI state matrix, output/status fixture matrix. | Deterministic fixtures used by unit, contract, integration, and UI tests. | Missing fixture category, fixture that implies unsupported V1 behavior, unknown output classified as healthy. |

## Contracts And Data

| Contract/data item | Owner | Rules | Validation |
| --- | --- | --- | --- |
| `SessionId` and `SessionName` | `@hostdeck/core` | Stable id is identity; display name is unique for V1 but not identity. | Unit tests for id/name validation and duplicate-name rejection helpers. |
| `LifecycleState`, `SessionStatus`, `AttentionLevel` | `@hostdeck/core` | Advisory status cannot make `unknown` appear healthy; writes require explicitly writable states. | Fixture classifier tests and write eligibility tests. |
| `CommandIntent` and slash command allowlist | `@hostdeck/core` | V1 slash commands are `/model`, `/goal`, `/plan`, `/usage`, `/compact`, `/skills`; other slash commands reject. | Unit tests for allowed and unsupported commands. |
| API error envelope | `@hostdeck/contracts` | Every API error uses stable code/message plus bounded optional context. | Contract tests reject malformed errors and unbounded details. |
| API and stream payloads | `@hostdeck/contracts` | Host status, sessions read, output read, stream, write, pairing, security, lock, and network payloads validate at runtime and reject malformed shapes. | `pnpm test:contract` covers valid and malformed API/stream fixtures. |
| Fixture suites | `@hostdeck/test-fixtures` | Include question, approval, command running, tests passed, tests failed, compact warning, idle/no-output, unknown output. | `SFR-011` fixture coverage tests. |

## Implementation Blueprint

| Slice | Goal | Epics/tasks | Dependencies | Exit evidence |
| --- | --- | --- | --- | --- |
| Foundation | Build the workspace, core model, contracts, and fixture suites. | Backlog must create leaf tasks for workspace scaffold, core state model, error envelope, contract schemas, fixture package, and baseline tests. | Approved requirements, architecture, blueprint, and test plan. | `pnpm typecheck`, `pnpm test:unit`, and `pnpm test:contract` equivalents once scaffold exists. |
| Hardening | Make invalid state, schema mismatch, unsupported slash commands, and unknown output fail loudly. | Backlog must create hardening tasks for write eligibility, error bounds, classifier unknowns, fixture completeness, and schema compatibility. | Foundation tasks in this block. | Negative-test artifact and fixture coverage artifact. |
| Release readiness | Prove every downstream block can consume contracts without duplicating state shapes. | Backlog must create release check for public contract export review and command-reference updates only after scripts exist. | Dependent blocks have started consuming contracts. | Contract compatibility note referenced from completion matrix. |

## Validation Plan

| Layer | What to prove | Evidence |
| --- | --- | --- |
| Unit | Core state, write eligibility, slash allowlist, classifier fixtures, impossible states. | Planned `pnpm test:unit` output and fixture coverage artifact. |
| Contract | API, stream, storage, audit, config, and UI fixture schemas reject malformed shapes. | Planned `pnpm test:contract` output. |
| System / E2E | Fake vertical can exchange typed session records and errors across packages. | Later `BLK-V1-04` and `BLK-V1-05` fake vertical evidence. |
| Manual / device | Unknown and failed fixture examples are reviewed for truthful user-facing interpretation. | Fixture review notes or artifact. |

## Backlog Links

| Epic | Leaf tasks | Status | Evidence |
| --- | --- | --- | --- |
| Workspace and command skeleton | `FND-V1-001`, `FND-V1-002` | Done | `artifacts/fnd-v1-001-scaffold.md`, `artifacts/fnd-v1-002-conventions.md` |
| Core model and contracts | `FND-V1-003` to `FND-V1-006`, `FND-V1-012`, `FND-V1-013` | In progress | `artifacts/fnd-v1-003-core-model.md`, `artifacts/fnd-v1-004-command-intents.md`, `artifacts/fnd-v1-005-errors.md`, `artifacts/fnd-v1-006-api-contracts.md`, `docs/tracking/backlog/foundation.md` |
| Fixtures and classifiers | `FND-V1-007` to `FND-V1-009` | Planned | `docs/tracking/backlog/foundation.md` |
| Foundation hardening | `FND-V1-010`, `FND-V1-011` | Planned | `docs/tracking/backlog/foundation.md` |

## Done Criteria

- Core and contract packages exist and are consumed by later packages.
- Required lifecycle, status, attention, command intent, write eligibility, and error states are typed and tested.
- All `SFR-011` fixture categories exist and are asserted.
- Malformed contracts fail with stable errors.
- Unknown output remains visibly unknown and does not become idle/success.
- Block evidence is recorded in this file, owning tasks, or artifacts.
- V1 completion matrix in `00-index.md` is updated.

## Open Questions / Spikes

| ID | Question | Owner | Exit evidence |
| --- | --- | --- | --- |
| None | No block-local spike is required; downstream spikes consume this block's contracts. | `BLK-V1-01` | Contract and fixture evidence. |
