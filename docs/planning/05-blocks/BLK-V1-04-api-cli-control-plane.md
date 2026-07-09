# BLK-V1-04 Local API And CLI Control Plane

Owns the host-agent service boundary, typed local API, write pipeline, CLI surface, startup checks, and LAN/service controls.

## Summary

- Goal: Expose HostDeck through a local Fastify API and `codexdeck` CLI with schema-checked routes, stable failures, and safe write ordering.
- Required for V1: Yes.
- User/workflow value: The dashboard and terminal user can start/list/read/write/stop sessions and control safety state without guessing process internals.
- In scope: `codexdeck serve`, `status`, `start`, `list`, `send`, `attach`, `stop`, `pair`, `lock`, `unlock`, `lan enable/disable`, API route families, stream endpoint, dashboard serving, startup checks, write pipeline.
- Out / deferred: Hosted relay, multi-user/team auth, remote unlock, all-session write routes, native mobile app packaging.
- Requirement refs: `FR-001` to `FR-008`, `FR-011`, `FR-012`, `FR-015`, `NFR-001`, `NFR-005` to `NFR-007`, `PR-002` to `PR-004`, `PR-007`, `PR-008`, `SFR-003`, `SFR-005`.
- UX refs: `UX-001` to `UX-009`, `IR-005`, `IR-006`, `IR-008`, `IR-009`.
- Decision refs: `DEC-003`, `DEC-004`, `DEC-005`, `DEC-008`, `DEC-010`, `DEC-011`, `DEC-015`.

## Local Architecture

| Part | Responsibility | Inputs | Outputs | Failure states |
| --- | --- | --- | --- | --- |
| Server startup | Parse config, validate binaries/state/bind policy, open storage, reconcile sessions, start API/dashboard. | CLI flags, settings, storage, tmux adapter. | Ready API only after required checks pass. | Missing tmux, invalid state dir, invalid bind/port, duplicate or unavailable bind port, failed migration, unreconciled startup. |
| Route layer | Fastify route registration, request/response validation, auth checks, stream setup. | Contract schemas, application services. | Typed host/session/security/network API responses and streams. | Malformed request, permission denied, stale cursor/session, stream reader unavailable. |
| Write pipeline | Validate one-session request, cookie auth/CSRF trust, lock, session writability, audit preflight, tmux send, audit result. | Auth/storage, core write eligibility, tmux adapter. | Accepted/rejected write result without claiming command outcome. | Untrusted, missing/invalid CSRF, read-only, locked, stale/stopped/crashed/unknown, unsupported slash, audit unavailable. |
| CLI | Local user entrypoint for service, session, pairing, lock/unlock, LAN, and attach operations. | API client, local admin paths where allowed. | Stable commands, exit codes, and actionable messages. | Daemon unavailable, remote unlock attempt, duplicate name, invalid cwd, missing binary. |

## Contracts And Data

| Contract/data item | Owner | Rules | Validation |
| --- | --- | --- | --- |
| API route families | Server/contracts | Host status, sessions read, stream, writes, pairing/token, security/network must match blueprint semantics. | API contract tests for method, auth, schema, errors. |
| Write result | Server/contracts | Accepted means tmux send accepted after audit preflight; it does not claim Codex completed the command. | Write pipeline integration tests. |
| CLI exit families | CLI | Nonzero for failed preconditions or rejected writes; messages preserve true cause. | CLI contract tests. |
| Bind/LAN state | Server/CLI/storage | Default localhost; LAN enablement explicit, visible, reversible, and audited. | Startup/config tests and network smoke. |
| Unlock path | CLI/storage | Unlock remains CLI-only local admin path. | API negative test and CLI positive test. |

## Implementation Blueprint

| Slice | Goal | Epics/tasks | Dependencies | Exit evidence |
| --- | --- | --- | --- | --- |
| Foundation | Build service startup, API skeleton, CLI skeleton, and fake vertical path. | Backlog must create leaf tasks for Fastify app, config/startup checks, route contracts, CLI command shell, fake session list/detail/write flow, stream skeleton. | `BLK-V1-01`, early fake portions of `BLK-V1-02` and `BLK-V1-03`. | API/CLI contract tests and fake vertical smoke. |
| Hardening | Prove failure ordering, trust/lock gates, LAN controls, daemon-unavailable behavior, and schema errors. | Backlog must create hardening tasks for every write rejection gate, startup failure, route error envelope, CLI exit family, and LAN/default bind behavior. | Storage/auth and tmux integration. | Negative-test artifact and network smoke. |
| Release readiness | Finalize command reference and local service docs after commands are runnable. | Backlog must create delivery-doc tasks through `BLK-V1-06` for command reference and developer guide updates. | Implemented commands and validated service modes. | Command-reference update and release smoke artifact. |

## Validation Plan

| Layer | What to prove | Evidence |
| --- | --- | --- |
| Unit | Config parsing, write pipeline precondition ordering, API error mapping. | Planned `pnpm test:unit` output. |
| Contract | API routes, stream events, CLI outputs/exit families, error envelope. | Planned `pnpm test:contract` output. |
| System / E2E | CLI talks to daemon; dashboard can load served API; fake vertical can start/list/read/write. | Planned `pnpm test:e2e` artifact. |
| Manual / device | Foreground/service mode, daemon-unavailable CLI behavior, localhost/LAN network check. | Service smoke and network smoke artifacts. |

## Backlog Links

| Epic | Leaf tasks | Status | Evidence |
| --- | --- | --- | --- |
| Server startup and route contracts | `IFC-V1-001` to `IFC-V1-003`, `IFC-V1-010` | Startup readiness, read routes, one-session stream routes, and aggregate route/stream contracts done | `artifacts/ifc-v1-001-startup-readiness.md`; `artifacts/ifc-v1-002-read-routes.md`; `artifacts/ifc-v1-003-stream-routes.md`; `artifacts/ifc-v1-010-api-route-contracts.md`; `docs/tracking/backlog/api-cli-control-plane.md` |
| Write pipeline and trust routes | `IFC-V1-004`, `IFC-V1-005` | Security routes and headless write route pipeline done; broader failure-path hardening remains planned | `artifacts/ifc-v1-004-write-routes.md`; `artifacts/ifc-v1-005-security-routes.md`; broader write rejection/failure-path coverage remains in `IFC-V1-014`. |
| CLI surface and service controls | `IFC-V1-006` to `IFC-V1-014` | CLI shell/API client, CLI session commands, and localhost/LAN network smoke done; `IFC-V1-008` and `IFC-V1-012` are ready; remaining CLI/service tasks remain planned | `artifacts/ifc-v1-006-cli-shell.md`; `artifacts/ifc-v1-007-cli-session-commands.md`; `artifacts/ifc-v1-011-network-smoke.md`; `docs/tracking/backlog/api-cli-control-plane.md` |
| Interface hardening | `IFC-V1-090` | Planned | `docs/tracking/backlog/api-cli-control-plane.md` |

## Done Criteria

- API route families exist with runtime request/response validation and stable error envelope.
- CLI commands match the V1 command list and have contract-tested exits.
- Startup refuses broken config, missing binaries, and invalid state before claiming ready.
- Write pipeline enforces validation, trust, lock, session writability, audit preflight, and tmux send ordering.
- Default bind is localhost; LAN access is explicit, visible, reversible, and audited.
- Unlock is not available from the dashboard or remote API path.
- Block evidence is recorded in this file, owning tasks, or artifacts.
- V1 completion matrix in `00-index.md` is updated.

## Open Questions / Spikes

| ID | Question | Owner | Exit evidence |
| --- | --- | --- | --- |
| `SPK-ARCH-003` | What token transport should dashboard pairing use? | Resolved by `DEC-015` / `DAT-V1-002` | `artifacts/dat-v1-002-token-transport-spike.md` and API contract update. |
