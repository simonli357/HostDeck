# INT-V1-004 Codex Unix IPC And Broker Evidence

Status: complete for task scope on 2026-07-09.

## Scope

- Production target: `@hostdeck/codex-adapter` Unix-socket WebSocket transport, initialize/compatibility connection, request broker, protocol decoder, deterministic raw-protocol fake, and explicit reconnect foundation.
- Requirements: `FR-005`, `FR-013`, `FR-017`, `NFR-010`, `NFR-011`, `PR-010`, `SFR-017`.
- Evidence levels: L1 hostile unit tests and L2 real local IPC/process smoke. Real thread/event semantics remain owned by `INT-V1-005` to `INT-V1-007`.

## Harsh Criteria

| Area | Required evidence |
| --- | --- |
| Trust boundary | Only an absolute bounded Linux Unix-socket path is accepted; URL/TCP configuration has no fallback path; the real smoke uses a mode-0700 parent and inspects a socket inode. |
| Resource bounds | Inbound frame, outbound frame/queue, broker in-flight, unresolved server request, request deadline, handshake, heartbeat, and close behavior have explicit limits and hostile tests. |
| Handshake | Application requests remain blocked through `initialize`, `initialized`, live Plan/Default catalog validation, version/platform corroboration, and compatibility readiness. Pre-initialize messages and repeated/concurrent connect fail closed. |
| Correlation | Monotonic ids correlate out-of-order responses. Unknown ids, duplicate terminal responses, malformed envelopes, and stale generations cannot resolve current work. Late retired responses are visible degradation. |
| Outcome truth | Reads remain policy-retryable after disconnect. A dispatched mutation timeout/disconnect is unknown and non-retryable. No reconnect path automatically repeats a mutation. |
| Server requests | Supported requests are bounded and connection-generation scoped. Exactly one response can win; provably unsent responses remain retryable, while unknown sends retire ownership. Unsupported requests receive an explicit bounded protocol error and degrade readiness. |
| Lifecycle | Close aborts an active handshake, drains pending work truthfully, and is bounded. Explicit reconnect creates a new generation and repeats all compatibility gates. Liveness loss closes the transport. |
| Real boundary | Pinned Codex 0.144.0 starts on a private Unix socket and reaches `ready` through production transport/connection code without a model call; cleanup removes child and runtime directory. |

## Implementation

- Added exact `ws` 8.21.0 plus `@types/ws` 8.18.1 only inside `@hostdeck/codex-adapter`; optional native acceleration packages are not installed.
- Generated immutable method catalogs from all four reviewed protocol unions with the pinned TypeScript scanner API: 125 client requests, 1 client notification, 69 server notifications, and 11 server requests. Binding identity remains `e1a1a5cff3ab91862f9215dd06538eae1ea0b00bae48cbb7d87061faaee27e24` across 671 files.
- Added strict envelope decoding, bounded errors, a Unix-only WebSocket transport, explicit outbound reservations, ping/pong liveness, request correlation, deadline/abort handling, server-request ownership, and a deterministic raw-frame transport fake.
- Added a connection state machine for version preflight, `initialize`/`initialized`, live Plan/Default catalog validation, readiness/degradation, terminal close, and explicit reconnect. Unknown semantics block writes; a late retired response is visible degradation but does not automatically disable future safe dispatch.
- Public exports contain normalized adapter/connection/transport types only. Raw generated Codex types remain private.

## Reuse Review

- Upstream `ws` review on 2026-07-09 confirmed maintained Unix IPC support through `ws+unix:`, MIT licensing, Node compatibility below the pinned Node 22 runtime, disabled redirects/compression options, `maxPayload`, close/terminate, and ping/pong support.
- HostDeck owns limits and state semantics instead of relying on undocumented library options.
- `pnpm audit --prod --audit-level high` reported no known vulnerabilities.

## Hardening Findings

| Gap | Risk | Result |
| --- | --- | --- |
| `initialized` was marked only after the send callback. | A fast server notification could be misclassified as pre-initialize. | Phase is set before dispatch, rolled back on failure, and covered by a synchronous notification race. |
| Unsupported server requests bypassed the pre-initialize observer. | An illegal early request could receive a normal unsupported response. | Every server request is observed before classification; supported and unsupported early requests are fatal. |
| Degraded protocol issues did not change connection compatibility. | Unknown semantics could leave mutations falsely enabled. | Compatibility becomes validated `degraded`; unknown semantics and unsupported requests block writes until explicit reconnect. |
| Server-response ownership was removed before write outcome. | A provably unsent approval decision could not be retried, while concurrent sends were not modeled. | One responder claims ownership; only `not_sent` restores it, unknown outcome retires it, and concurrent/duplicate responses reject. |
| Transport queue/liveness depended on library state alone. | Concurrent sends or a half-open peer could evade HostDeck bounds. | HostDeck reserves outbound bytes and enforces ping/pong deadlines; undocumented `ws` options were removed. |
| Unix path accepted ambiguous/control characters. | URL/path interpretation could differ from the configured filesystem path. | Absolute path validation rejects TCP/URL forms, delimiters, percent escapes, controls, and paths over the Linux byte limit. |
| Explicit close retained listeners to permit reconnect. | Repeated composition could leak subscriptions. | Involuntary disconnect remains reconnectable; explicit close is terminal and releases broker/transport subscriptions. |
| Method catalogs used regex extraction. | Structural generator drift could be silently misclassified. | Pinned TypeScript lexical parsing requires one literal discriminator per union member. |
| Handshake close diagnostics were overwritten by a later send error. | Operators could see `not open` instead of the actual close. | Cleanup awaits the close event and preserves its generation/reason; the real smoke includes bounded child and transport diagnostics. |

## Validation

| Command / inspection | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | Pass; all 10 workspace projects already matched the lockfile. |
| `pnpm check:scaffold` | Pass; 9 packages and 17 required root scripts. |
| `pnpm check:planning` | Pass; 104 tasks, 84 requirements, 262 dependencies, 5 queued. |
| `pnpm check:codex-bindings` | Pass; exact 0.144.0 identity, 671 files, immutable method catalog. |
| Root and all-package typechecks | Pass. |
| `pnpm lint` | Pass; 152 files and all 9 package exports. |
| `pnpm test:unit` | Pass; 329 passed, 3 intentionally skipped external smokes. |
| Adapter-only suite | Pass; 96 passed, 2 intentionally skipped external smokes. |
| `pnpm test:contract` | Pass; 104 tests. |
| `pnpm test:integration` | Pass; 15 tests. |
| `pnpm test:web` | Pass; 14 tests. |
| `pnpm smoke:codex-compatibility` | Pass against installed `codex-cli 0.144.0`, no model call. |
| `pnpm smoke:codex-ipc` | Pass against installed `codex-cli 0.144.0`; mode-0700 parent, Unix socket inode, production handshake, terminal close, child exit, and directory cleanup. No model call. |
| Repetition | Unix IPC passed 5/5 isolated runs; stdio then Unix passed 4 consecutive serialized cycles. |
| `pnpm audit --prod --audit-level high` | Pass; no known vulnerabilities. |

## Runtime Observation

- An initial all-at-once validation run and one immediate stdio-to-Unix run observed the Unix peer begin closing after `initialize` while its child remained alive with empty stderr. The adapter rejected readiness and never retried a mutation. The deterministic close-after-initialize regression now preserves the close reason.
- Repeated isolated and serialized runs passed after diagnostic hardening. This task does not hide the observation with an automatic retry; capped supervisor backoff, runtime crash recovery, and process ownership remain explicit `INT-V1-007` work.

## Remaining Ownership

- `INT-V1-005`: typed thread lifecycle, durable mapping/reconciliation, and exact TUI resume.
- `INT-V1-006`: required notification payload normalization, real turns/controls/approvals, and event projection.
- `INT-V1-007`: process supervision, bounded reconnect backoff, multi-client behavior, and crash/restart reconciliation.
- `DAT-V1-019`: production runtime-directory/socket ownership and daemon lease enforcement.
