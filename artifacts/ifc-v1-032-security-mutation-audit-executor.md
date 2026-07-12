# IFC-V1-032 Security Mutation Audit Executor

Date: 2026-07-11

Status: hard success criteria frozen before implementation.

## Scope

Implement one headless application executor for the exact ten selected security actions. The executor owns strict pre-dispatch rejection records, accepted-before-mutation ordering, one injected mutation attempt, one terminal outcome, response-preparation handoff, sanitized failure metadata, and the technical-plan emergency-lock exception when durable audit preflight is unavailable. It does not register routes, authenticate requests, verify CSRF, rate-limit, mutate pairing/device/lock/network state itself, issue credentials, send HTTP replies, run startup reconciliation, or implement UI behavior.

## Current Gaps

- The selected audit repository strictly stores all ten security actions, but no application boundary composes accepted, one mutation attempt, and one terminal result.
- Route owners would otherwise construct audit records independently, making actor/target continuity, callback count, failure precedence, record ids, timestamps, and secret handling inconsistent.
- A repository call can succeed yet return a forged or corrupt trail through an injected port. Mutation must not start until the returned pending trail exactly proves the accepted record.
- Mutation adapters can fail explicitly, return an unknown outcome, throw an arbitrary secret-bearing error, or return a malformed/secret-bearing summary after state may have changed.
- A response can fail preparation after the mutation succeeds. Durable operation truth must remain succeeded while client delivery remains explicitly unknown and non-retryable.
- A terminal write can fail after mutation. The accepted row must remain pending for startup reconciliation; the executor must not send success, retry the mutation, or roll state back.
- The technical plan permits only emergency host lock to proceed after an audit availability failure. That exception currently has no exact trigger, callback context, result, or observable degradation contract.

## Frozen Selected Contract

### Exact Headless Port

- `createSecurityMutationAuditExecutor` requires one exact selected-audit repository port, one clock, and one record-id factory. Construction rejects null, array, non-plain-prototype, missing, extra, accessor, or non-function port members before retaining the port.
- The returned executor is frozen and exposes only `execute`, `reject`, and a frozen count-only `snapshot`.
- `execute` accepts exact static operation identity, actor, action, target, accepted summary, an explicit emergency-lock boolean, one transition callback, and one response-preparation callback. `reject` accepts exact operation identity, actor, action, target, rejected summary, and selected error code.
- All static fields and callback shapes validate before clock, id factory, repository, transition, or response-preparation work. Every record is validated with the strict current security-audit contract before repository invocation.
- Repository return values are revalidated as exact trails and compared with the records supplied. A missing, forged, partial, contradictory, or nonterminal return is a failure even if the port did not throw.

### Normal Accepted-To-Terminal Order

For every non-emergency execution, the order is fixed:

1. Validate the exact input and construct one strict accepted record.
2. Persist and verify that exact accepted record as one pending trail.
3. Invoke the transition callback exactly once with a frozen `accepted` audit context.
4. Validate one exact `succeeded`, `failed`, or `incomplete` transition descriptor.
5. For success only, invoke response preparation exactly once without exposing the response to audit construction.
6. Persist and verify one strict terminal record with the original operation, actor, action, and target.
7. Return one frozen result only after terminal audit is proven.

No callback runs when accepted persistence or proof fails. The executor does not retry a repository call or transition, substitute a new operation id, infer idempotence, or serialize executions for different operation ids. The repository and mutation owner retain their existing transaction/concurrency responsibilities.

### Transition And Result Truth

- A successful transition returns an action-valid success summary plus an opaque response value. Only the injected response preparer may inspect that value; the executor returns the prepared value only after terminal proof and never copies it into records, error metadata, snapshots, or diagnostics.
- An explicit failed or incomplete transition returns one selected error code and an action-valid terminal summary. The executor records that exact outcome and returns only the bounded outcome/error metadata.
- A thrown transition or an invalid transition descriptor means the mutation outcome cannot be trusted. The executor discards the cause/value, appends fixed `incomplete/internal_error` with only `schema_version: 1`, and throws one cause-free executor error after terminal proof.
- A secret-bearing, oversized, nested, wrong-action, or wrong-phase summary is an invalid transition descriptor. It is never truncated or reflected and never reaches SQLite.
- Accepted and terminal clocks are read separately. Invalid or regressing terminal time cannot fabricate chronology; it leaves the accepted operation pending and becomes a terminal-audit failure.

### Pre-Accept Rejection

- `reject` records one standalone strict `terminal/rejected` trail and invokes no transition or response preparer.
- It covers a parsed operation with truthful actor/action/target identity that is denied before dispatch. Transport/authentication failures that cannot establish a valid selected actor remain with their owning request gate and are not assigned a false audit identity.
- Duplicate operation/record ids, corrupt storage, invalid summaries, and unavailable storage are explicit. Rejection persistence is never reported when the exact returned trail cannot be proven.

### Response-Preparation Handoff

- Response preparation occurs after a proven state success but before terminal persistence and before the caller receives sendable output.
- If preparation fails, the executor discards the cause and response, still records the truthful `succeeded` terminal from the state result, and throws a fixed `response_preparation_failed` error with mutation outcome `succeeded`, audit state `terminal`, and `retry_safe: false`.
- If preparation and terminal audit both fail, terminal-audit failure takes precedence. No prepared response is returned and no caller may automatically repeat the operation.
- The executor sends no bytes. Route owners must use the prepared value without re-running the mutation and must preserve the explicit unknown-client-delivery error if the later transport itself fails.

### Terminal Audit Failure And Crash Truth

- Any terminal record construction, repository call, or returned-trail proof failure after acceptance produces a fixed `terminal_audit_failed` error with audit state `pending` and the known mutation outcome when available.
- The executor returns no success response, retries neither audit nor mutation, and performs no compensating reverse mutation. Security state changes, especially lock/revoke, are not undone merely to make audit look successful.
- The accepted row remains append-only and discoverable. `DAT-V1-030` may later append only `incomplete/runtime_unavailable`; this executor does not rewrite accepted truth or race a startup owner.
- A process death after accepted persistence naturally leaves the same pending trail. Fixture evidence composes the executor barrier with real reopen/orphan reconciliation rather than claiming in-process exception handling proves a crash.

### Emergency Lock Degradation

- The emergency bypass must be explicitly enabled and is valid only for action `lock`. All other actions reject the flag before any side effect.
- It activates only when a valid accepted record reaches the real audit port and that port reports `audit_unavailable` or `audit_write_failed`. Invalid input, secret summary, duplicate/conflicting id, forged return, corrupt trail, record collision, clock/id failure, and arbitrary exceptions never activate it.
- The lock transition runs exactly once with a frozen `deferred` audit context so the lock owner can persist/project degraded truth with the lock state. Unlock and every other security mutation remain blocked.
- No accepted row is fabricated after the mutation and no standalone incomplete terminal is legal without acceptance. The executor returns no normal response and throws a fixed `emergency_lock_audit_deferred` error carrying only mutation outcome, audit state `deferred`, `audit_unavailable`, and `retry_safe: false`.
- A succeeded emergency result must still satisfy the exact `lock` success summary (`schema_version: 1`, `locked: true`). Explicit failed/incomplete results remain bounded; throw or invalid output becomes incomplete. No response preparation runs on the degraded path.
- A sticky count-only snapshot makes emergency audit degradation visible for the process lifetime. Downstream lock/readiness owners must surface/persist the deferred context; this leaf does not claim that unfinished route or settings behavior.

### Errors, Diagnostics, And Privacy

- Executor errors are frozen, bounded, cause-free, and expose only fixed code, selected API error code, stage, mutation outcome, audit state, and retry safety. Raw repository/native/callback messages and values are never copied.
- Explicit mutation failure results contain only `failed` or `incomplete` plus one selected error code. Audit records/trails and response values are not returned as public execution metadata.
- Saturating diagnostics retain only counts for accepted, rejected, succeeded, failed, incomplete, transition-contract failure, response-preparation failure, terminal-audit failure, and emergency-lock audit deferral.
- No operation id, record id, actor, origin, target id, summary, response, code/token/CSRF value, cookie/header, key/certificate material, native error, path, or message is retained in diagnostics.

## Hard Success Criteria

| Criterion | Required evidence |
| --- | --- |
| Exact port and inputs | Constructor and both methods reject missing/extra/inherited/accessor/wrong-type fields before side effects. The executor, callback contexts, results, errors, and snapshots are frozen and exact. |
| Complete action matrix | Real migrated SQLite evidence executes accepted-to-succeeded fixtures for all ten selected security actions, including catalog-only `certificate_rotate`, with action-valid actors, targets, intent summaries, and result summaries. |
| Accepted-before-mutation | Event order and real repository state prove accepted commit and exact returned pending trail before one transition call. Accepted throw/forged return/duplicate/conflict/corruption invokes neither transition nor response preparation. |
| Terminal outcomes | Succeeded, explicit failed, and explicit incomplete transitions append exactly one coherent terminal record and return only after exact terminal-trail proof. A second terminal or mutation retry is absent. |
| Rejection | Truthfully identified pre-dispatch rejection creates one standalone rejected trail and no callback. Invalid/unavailable/forged rejection persistence fails without claiming a record. |
| Transition corruption | Throw, malformed descriptor, unknown key/outcome/error, wrong action summary, and sensitive/oversized/nested summary append fixed incomplete when possible, expose no cause, and never persist attacker material. |
| Response handoff | Preparation runs only after success and at most once. Preparation failure records state success, returns no response, reports unknown non-retryable delivery, and never changes the audit outcome to failed. |
| Terminal failure | Clock/id/repository/returned-trail failure after mutation leaves exactly the accepted row, suppresses response, reports pending audit with known mutation outcome, and does not retry or compensate. |
| Crash/restart | A barrier after real accepted commit proves pending durability; reopen plus the existing orphan reconciler appends one incomplete terminal while preserving the accepted bytes and actor/action/target identity. |
| Emergency lock | Only explicit `lock` plus typed audit availability/write failure invokes one deferred-context transition. Success/failure/incomplete/throw cases remain observable; no normal response, response preparation, fabricated row, unlock, or non-lock bypass occurs. |
| Concurrency | Two real executor calls with one operation id produce one accepted owner, one transition, one terminal, and one non-dispatch conflict without executor retry. Independent operation ids remain the mutation owner's concern. |
| Privacy | Raw pairing/device/CSRF/key/certificate/cookie/header sentinels in summaries, transition errors, preparation errors, repository errors, and forged returns are absent from errors, non-success results, snapshots, rows, and main/WAL/SHM bytes. A response sentinel appears only in the explicitly prepared successful response after terminal proof. |
| Ownership boundaries | No selected route, auth/CSRF/rate/lock/network adapter, HTTP status mapping, credential issue/revoke behavior, startup runner, readiness projection, Android/browser flow, or UI behavior is implemented or claimed. |

## Validation Plan

- Direct executor tests over real migrated SQLite for all ten actions, exact ordering, strict inputs, accepted/terminal proof, rejected/failed/incomplete paths, callback throw/corruption, response preparation, terminal failure, same-operation contention, and emergency lock degradation.
- Real reopen plus orphan reconciliation composition for accepted-before-crash truth and append-only incomplete recovery.
- Raw database main/WAL/SHM and public error/result/snapshot inspection with synthetic secret sentinels.
- Adjacent selected audit contract/repository/security-action/orphan/retention and route-manifest regression suites.
- Full server/storage/unit/contract/integration/web, typecheck/lint/exports, scaffold/planning/exact-binding, frozen offline install, production audit, manual lifecycle/failure/privacy/ownership review, and diff checks.

## Reuse Assessment

Reuse the selected security-audit schemas, append-only `SelectedAuditRepository`, existing error-code catalog, and orphan reconciler. Add one small server-owned orchestrator because no maintained dependency can encode HostDeck's accepted-first state machine, strict action summaries, response handoff, or emergency-lock degradation policy. Do not reuse the historical route audit code or add a queue/transaction framework.

## Remaining Ownership

- `IFC-V1-027`, `IFC-V1-028`, `IFC-V1-030`, `IFC-V1-031`, and `IFC-V1-059` provide concrete security transitions, response preparation, request rejection mapping, and degraded lock/readiness projection.
- `IFC-V1-066` reuses the same durable state-machine principles for non-security selected writes but owns its separate exact-target gate.
- `IFC-V1-036`, `IFC-V1-037`, and `DAT-V1-030` own startup, shutdown, readiness, and orphan reconciliation around pending accepted work.
- `IFC-V1-033` owns aggregate browser/LAN/security acceptance; `DAT-V1-091` owns aggregate selected storage/auth/audit hardening.
