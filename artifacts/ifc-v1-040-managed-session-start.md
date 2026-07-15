# IFC-V1-040 Managed-Session Start

Date: 2026-07-15

Status: complete. Implementation `6ec6d39`.

## Scope

Implement the selected managed-session creation boundary from durable audit through the existing recoverable Codex-thread start saga, exact `/api/v1` HTTP registration, and local `codexdeck start` command. This leaf owns the `session_start` audit-catalog extension and the reusable accepted-to-terminal executor needed by selected non-security writes. It does not own aggregate route composition, cross-route idempotent response replay, runtime supervision, remote-phone UI, session list/detail, prompt dispatch, or release acceptance.

## Frozen Contract

- `POST /api/v1/sessions` accepts exactly `operation_id`, one bounded alias, and one absolute cwd. It accepts no thread id, import source, prompt, model, slash command, or raw runtime option.
- The success response is exactly `operation_id` plus one strict managed-session projection. HTTP success is `201`, no-store, and cannot expose recovery rows, audit records, internal adapter state, or legacy tmux fields.
- Session start audits `local_host` because no managed target exists before dispatch. The existing saga reserves the concrete HostDeck session id under the same operation id before it asks Codex to create a thread.
- The accepted audit summary is exactly schema version, alias length, and cwd-presence truth. Success records only that a durable managed session was created. Failed/incomplete records contain no path, alias, thread id, runtime response, or private cause; startup reconciliation may add only the fixed restart reason.
- The active and persisted audit catalogs gain exactly `session_start` through one forward-only migration. Every prior migration checksum and every existing row byte remains unchanged.
- The selected-write audit executor validates one exact active non-security write action, actor, target, summary, callbacks, and repository proof. It records accepted before one transition, prepares a successful response once, records one terminal outcome, and returns only after exact terminal proof. It never retries audit, transition, or response preparation.
- The route proves current runtime mutation eligibility and available `thread_lifecycle` capability before audit/dispatch. Disconnected runtime is unavailable; incompatible or mutation-blocked runtime is incompatible. A changed runtime version discovered after start cannot be returned as ordinary success.
- The existing managed-thread service remains the sole thread-start saga. It reserves before wire dispatch, persists a returned thread id before materialization, resumes known recovery without redispatch, and never accepts caller-supplied thread/session ids.
- `codexdeck start --name NAME --cwd PATH [--json]` generates one operation id internally and sends one bounded direct-loopback request to `/api/v1/sessions`. No CLI flag accepts an operation id or thread id. Output describes the selected Codex session and contains no tmux surface.

## Outcome Rules

| Condition | Required truth |
| --- | --- |
| Invalid body, alias, cwd shape, or invented field | Reject before authentication-owned state, audit, service, or Codex dispatch. |
| Unauthorized, read-only, stale CSRF, insecure, or locked request | Reject through the common gate before target resolution or dispatch as owned by that stage. |
| Missing/disconnected runtime | `runtime_unavailable`; no accepted audit and no saga reservation. |
| Incompatible, mutation-blocked, or missing lifecycle capability | `incompatible_runtime`; no accepted audit and no saga reservation. |
| Audit preflight unavailable, duplicate, conflicting, or unproven | No session reservation and no Codex request. |
| Duplicate alias or invalid filesystem cwd | Proven not-sent `failed` terminal with stable public `duplicate_session_name` or `invalid_cwd`. |
| Known adapter not-sent or rejected failure | `failed`; failed recovery remains explicit where the saga created one. No automatic retry. |
| Unknown adapter outcome or timeout/disconnect after dispatch starts | `incomplete`; reservation/recovery remains available and a repeated gate request cannot redispatch. |
| Codex thread created but identity/materialization/mapping/finalization is not fully proven | `incomplete`; preserve the strongest recovery identity and never label the operation as not sent. |
| Durable mapping and strict projection created | One succeeded terminal, one `201` response, and no remaining recovery row in the normal path. |
| Response preparation fails after creation | Durable audit remains succeeded, client delivery is unknown/non-retryable, and no second start occurs. |
| Terminal audit fails after a known mutation outcome | Suppress response, preserve pending/unproven audit truth and saga state, and do not compensate or redispatch. |
| Process dies after accepted audit | Startup orphan reconciliation appends one strict incomplete terminal without rewriting accepted identity. |
| Same operation id is retried | Existing audit/recovery truth prevents a second Codex start. Cross-route response replay remains `IFC-V1-049`. |

## Hard Success Criteria

| Criterion | Required evidence |
| --- | --- |
| Catalog migration | Fresh and prior databases gain `session_start`; prior rows, indexes, triggers, provenance, checksums, rollback, and corruption behavior remain intact. SQLite rejects unsupported actions and invalid provenance. |
| Strict audit contract | Current write, stored read, accepted/succeeded/failed/incomplete, restart reconciliation, actor, host target, and secret-free summary cases validate exactly. Alias/cwd/thread/recovery/private error sentinels never reach audit rows or public errors. |
| Audit executor | Exact accessor-free construction/input; accepted proof before one transition; all terminal outcomes; throw/malformed transition; response failure; terminal failure; same-operation contention; restart; frozen bounded diagnostics; no retry. |
| Route composition | Identity-matched manifest row, branded audit/CSRF/lock policies, exact runtime/session ports, once-only registration, strict `201` schema, and no-store behavior. Local-admin and paired HTTPS writer success use the same gate. |
| Runtime admission | Ready/degraded allowed runtime with exact lifecycle capability proceeds. Null, disconnected, incompatible, blocked, unavailable/unknown capability, malformed state, read failure, and version drift are explicit without premature dispatch. |
| Saga truth | Normal creation, duplicate alias, invalid cwd, known no-thread failure, unknown start, recovered reservation, post-thread storage/materialization failure, conflicting marker/input, and cleanup behavior each dispatch at most once and preserve exact durable state. |
| HTTP failure matrix | Validation, permission, lock, audit, conflict, cwd, runtime, protocol/storage partial outcome, timeout/abort, malformed service result, response preparation, and terminal-audit failures expose stable bounded status/code/message without private causes. |
| CLI client | Exact loopback URL, one POST, bounded request/response, no retry, strict success/error parsing, sanitized failures, generated operation id, invalid local input before fetch, and no remote/basic-auth/path/query/fragment URL. |
| CLI shell/render | Receiverless selected client call, text and JSON output, terminal-control escaping, no legacy client/local-admin access, no tmux wording, and stable exit families. Help exposes only the selected start syntax. |
| Ownership | No aggregate production registration, remote browser write, phone run, UI, session listing, prompt/control implementation, runtime process ownership, arbitrary import, or legacy removal is claimed. |

## Validation Plan

- Focused contract, migration, repository, audit-executor, route, managed-saga, client, parser, shell, and renderer tests.
- Adjacent selected write-gate, authentication, CSRF, lock, Fastify error/timeout, orphan reconciliation, retention, and runtime-contract regressions.
- Full unit, contract, integration, web, all-package typecheck, lint/exports, scaffold, planning, frozen install, exact Codex binding, and production audit gates.
- A bounded exact-0.144.0 smoke starts and archives one isolated managed thread when the environment gate is enabled; ordinary tests use no fake readiness claim for that smoke.
- Manual staged-diff, migration SQL, audit privacy, failure-order, route surface, CLI output/control-character, and no-legacy-fallback inspection.

## Implemented Boundary

- Migration 016 promotes `session_start` into the active and persisted selected audit catalogs without changing prior migration bytes. It rebuilds the append-only table, preserves prior record JSON byte-for-byte, restores both indexes and all four triggers, requires null security provenance, and rejects unsupported actions, invalid provenance, unsafe summaries, and standalone start rejections.
- A branded selected-write audit executor now covers `session_start` plus the eight selected non-security mutations. It proves accepted and terminal repository trails exactly, dispatches once, never retries, records throws or malformed transitions as incomplete, preserves succeeded mutation truth across response-preparation failure, and suppresses unproven responses.
- The managed-thread start saga now reports every post-thread branch as `remote_succeeded`, including recovery identity, materialization, mapping, branch capture, finalization, and persisted-identity failures. Known no-thread outcomes remain failed even when failed-recovery persistence itself fails.
- `POST /api/v1/sessions` is an exact standalone selected registration over the common write gate. It admits loopback local admin and paired HTTPS writers, proves unlocked host and current lifecycle-capable runtime before audit, calls the recoverable service receiverlessly once, returns only strict `201` session-start data, and maps partial outcomes to bounded non-retryable errors.
- `codexdeck start --name NAME --cwd PATH [--json]` now uses a dedicated direct-loopback client before legacy client/local-admin construction. It generates the operation id internally, sends one exact POST, requires exact `201` and correlated output, sanitizes failures, escapes terminal controls, and exposes no tmux, import, caller-supplied operation/thread id, remote URL, or retry path.
- One real vertical composes the source CLI, bounded HTTP listener, selected route/gate/audit executor, SQLite repositories, managed saga, and protocol-shaped Codex thread client. Repeating the same operation id cannot issue a second start.

## Hardening Outcome

| Area | Outcome |
| --- | --- |
| Catalog and restart | Pass: fresh/prior migration, rollback, prior-row bytes, index/trigger restoration, provenance, strict current/stored records, rejection denial, and reopen/orphan reconciliation pass. The accepted row remains byte-identical after restart. |
| Audit and dispatch | Pass: all nine common actions, accessor/forgery rejection, exact accepted/terminal proofs, explicit failed/incomplete, throw/malformed conversion, preparation failure, same-operation contention, terminal failure, bounded counters, and no retry pass. |
| Saga truth | Pass: invalid cwd and duplicate alias pre-dispatch, known no-thread rejection, unknown start, recovered reservation, concrete-thread contradiction, post-thread materialization/storage/mapping/finalization failure, and persisted recovery paths retain the strongest known outcome and dispatch at most once. |
| Route and authority | Pass: exact manifest/factory/port construction, local loopback and real paired HTTPS writer success, stale CSRF/read-only/lock rejection, complete runtime-state matrix, strict response identity/version, audit failure, malformed service output, and operation replay pass. |
| CLI | Pass: exact loopback URL and POST, exact `201`, request/response correlation, local operation-id generation, parser/help exclusions, text/JSON output, terminal escaping, sanitized errors, no retry, and legacy/local-admin isolation pass. |
| Ownership | Pass: no aggregate production registration, browser UI, phone run, package/bin claim, runtime supervision, prompt/control route, or legacy removal was added. |

## Validation Evidence

| Gate | Result |
| --- | --- |
| Focused start boundary | Pass: 7 files, 65 tests; strict start contracts add 3 contract tests. |
| `pnpm test:unit` | Pass: 146 files and 1,378 tests; 22 opt-in device/smoke files and 36 tests skipped. |
| `pnpm test:contract` | Pass: 31 files, 260 tests. |
| `pnpm test:integration` | Pass: 3 files, 17 tests, including the new start vertical. |
| `pnpm test:web` | Pass: 3 files, 33 tests. |
| Static/repository gates | Root and all-package typechecks, lint/export checks over 425 files and 9 packages, scaffold, planning, frozen offline install, staged diff, migration SQL, privacy/failure-order, and forbidden-surface review pass. |
| Exact runtime | The isolated Codex 0.144.0 binary verifies all 671 generated binding files at SHA-256 `e1a1a5cff3ab91862f9215dd06538eae1ea0b00bae48cbb7d87061faaee27e24`; the real no-model thread lifecycle start/materialize/TUI/archive smoke passes. The default 0.144.3 installation was not changed or accepted as exact evidence. |
| Supply chain | Frozen offline install passes and the production inventory contains permissive license categories only. `pnpm audit --prod` is unavailable because npm's retired legacy endpoint returns HTTP 410; no dependency or lockfile changed. |
| Packaging | The source command is proven, but `pnpm exec codexdeck --help` still reports command not found. Runnable packaging remains downstream. |

## Downstream Ownership

- `IFC-V1-046` owns aggregate production registration and selected remote vertical acceptance; `IFC-V1-049` owns replayable operation idempotency and concurrency limits.
- `IFC-V1-021` and packaging/release leaves own an installed `codexdeck` executable. `FE-V1-019` owns dashboard consumption after the recorded visual selection.
- This headless leaf required no connected phone. Physical remote-phone behavior remains owned by the aggregate mobile and release gates.
