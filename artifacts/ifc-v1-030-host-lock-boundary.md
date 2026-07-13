# IFC-V1-030 Host Lock Boundary

Date: 2026-07-12

Status: complete on supported Linux; downstream production composition, aggregate browser/device acceptance, and UI remain separately owned.

## Purpose

Implement the selected access-state read, emergency-capable host lock, local-admin-only unlock, and reusable unlocked-host gate over the completed request trust, device authentication, CSRF, settings, route-manifest, and security-mutation audit boundaries.

This leaf owns lock state and chronology, lock/unlock HTTP orchestration, lock authority, emergency audit degradation, non-secret access-state projection, and the headless gate consumed by later selected writes. It does not implement session/control routes, aggregate write admission, active Codex cancellation, device revoke, LAN mutation, UI, production route composition, packaging, or physical-phone acceptance.

## Audit Findings And Resolutions

| Finding | Frozen resolution |
| --- | --- |
| Historical security handlers authorize raw bearer/CSRF inputs directly, have no selected audit ordering, expose a legacy trust response, and allow a non-atomic settings update. | They remain deprecated evidence only. Selected routes use request authentication, the completed CSRF verifier, the selected audit executor, strict new contracts, and an exact lock policy. |
| `SettingsRepository.setLocked` reads the whole row and writes it back. A concurrent network/settings change can be lost, repeated lock calls rewrite `updated_at`, and returned state does not prove the exact transition. | Add one immediate, lock-only transition. It validates the complete current row, rejects invalid/regressing time, leaves idempotent state and timestamp unchanged, updates only `locked` and `updated_at`, verifies one changed row, rereads the complete row, and returns an exact frozen before/after/changed receipt. |
| Lock is both a normal audited mutation and the only mutation allowed when audit storage is unavailable. | Use `emergency_lock_on_audit_unavailable: true` only for `lock`. Typed audit unavailable/write failure runs the same atomic transition with `audit_state: deferred`, never prepares a success response, and returns fixed non-retryable `503 audit_unavailable`; callers must reread state. Unknown, conflicting, or unproven audit failure does not run the transition. |
| Unlock must not become a browser recovery shortcut. | `unlock` requires exact local-admin request provenance, no cookie fallback, and no emergency audit bypass. A paired dashboard receives `403 permission_denied` before settings or audit work. |
| Lock must stop later remote mutation but must not block its own idempotent transition or safe reads. | Export a branded lock policy plus `requireHostDeckHostUnlocked`. Every later protected mutation calls it after trust/auth/CSRF and before target lookup, accepted audit, or dispatch. Access reads, pairing, CSRF bootstrap, device administration, lock, and local-admin unlock retain their manifest-specific policies. |
| Existing selected manifest ids have no concrete `access_state_response_v1`, `lock_request_v1`, `unlock_request_v1`, or `host_lock_state_response_v1` schemas. | Add strict selected contracts. Requests carry one operation id and literal `confirmed: true`; route identity determines lock versus unlock. Responses expose only bounded authentication/connection/lock/capability truth and no CSRF generation, last-used time, secret, hash, audit id, reason, or storage cause. |
| Lock does not cancel work already dispatched to Codex. | The response and audit claim only persisted admission state. Existing in-flight operations continue under their owning truth; later aggregate write gates and UI state must not claim cancellation. |

## Frozen Contracts

### Route Manifest

All three registrations assert their exact deeply frozen manifest entries before route registration.

| Route | Exact policy |
| --- | --- |
| `access_state` | `GET /api/v1/access`; no request body/query/params; response `access_state_response_v1`; optional device-cookie auth; `access_read`; no CSRF/lock/audit/credential effect; owner `IFC-V1-030`. |
| `host_lock` | `POST /api/v1/access/lock`; body `lock_request_v1`; response `host_lock_state_response_v1`; local-admin or device-cookie auth; `host_lock`; CSRF required for device authority; `lock_transition`; host target; audit `lock`; owner `IFC-V1-030`. |
| `host_unlock` | `POST /api/v1/access/unlock`; body `unlock_request_v1`; response `host_lock_state_response_v1`; local-admin auth/authority; no CSRF; `lock_transition`; host target; audit `unlock`; owner `IFC-V1-030`. |

All routes use the no-store marker and return `Cache-Control: no-store` plus `Pragma: no-cache` on success and selected errors. No route emits CORS headers.

### Request Contracts

`lock_request_v1` and `unlock_request_v1` are distinct strict schemas with the same exact fields:

- `operation_id`: selected bounded `op_` client operation id.
- `confirmed`: literal `true`.

Missing/false confirmation, extra keys, malformed ids, inherited/accessor values, body omission, wrong media type, query data, or oversized requests reject before CSRF, settings, audit, or transition work where Fastify can determine that safely. There is no caller-supplied desired state, device id, actor, origin, audit summary, reason, retry flag, or emergency flag.

### Access And Lock State

The strict response contains:

- `authentication_state`: selected request-authentication state.
- `device_id`: selected device id or `null` exactly as allowed by authentication state.
- `permission`: `local_admin`, `read`, `write`, or `null` exactly as allowed by authentication state.
- `device_expires_at`: canonical expiry only for a paired device, otherwise `null`.
- `configured_origin`: exact canonical trust-policy origin.
- `network_mode`: `loopback` or `lan`.
- `transport`: `http` or `https`, with LAN requiring HTTPS.
- `locked`: current durable lock state.
- `can_read_sessions`: true only for selected loopback-unpaired, paired, or local-admin read authority.
- `can_write_sessions`: true only for local-admin or paired-write authority while unlocked.
- `can_lock`: true only for local-admin or paired-write authority.
- `can_unlock`: true only for local-admin authority.

Capability flags are deterministic projections, not independent policy inputs. Invalid, expired, revoked, and read-only states remain distinguishable without exposing a credential or device identity that authentication did not prove. Lock responses use the same schema and the authenticated actor context from the request. The global settings `updated_at` value is not mislabeled or exposed as lock chronology; durable audit owns lock/unlock event time.

## Atomic Lock State

- The selected storage input is exactly `{ locked, now }`; `locked` is boolean and `now` is one valid finite `Date` copied before use.
- The complete current settings row is parsed before mutation. Missing/corrupt/closed/read-only/busy storage fails without a receipt.
- A requested state equal to current state is an idempotent success with `changed: false`; no SQL update occurs and `updated_at` is unchanged.
- A changed state requires `now >= current.updated_at`. Regression returns an explicit settings time conflict without mutation.
- The immediate transaction updates only `locked` and `updated_at` with current-state compare-and-set predicates, requires exactly one changed row, rereads the complete settings record, and proves unrelated fields are unchanged.
- The exact deeply frozen receipt is `{ before, after, changed }`; each state has only `locked` and internal `settings_updated_at`. Changed receipts require opposite booleans and `after.settings_updated_at` equal to the supplied time. No-op receipts require identical states. This timestamp is global settings compare-and-set chronology, not a public lock-change timestamp.
- There is no retry, fallback write, whole-row save, hidden clock substitution, process-only lock truth, or automatic unlock.

## Exact Operation Order

### Access Read

1. Apply no-store policy and validate the exact route shape.
2. Resolve optional request authentication once through the completed trust/cookie boundary.
3. Read and descriptor-validate one exact durable lock snapshot.
4. Derive and validate the strict access response; return no raw credential, CSRF posture, or audit data.

### Lock

1. Apply no-store policy and validate exact body/confirmation.
2. Require local-admin or paired-device authority. For a paired device, require write permission and exact current CSRF authorization once; local-admin performs no CSRF/storage authorization fallback.
3. Build the actor from proven authority only: local-admin CLI with no origin/device, or dashboard writer with exact device id and configured origin.
4. Execute audit action `lock`, host target, accepted summary `{ schema_version: 1, requested_locked: true }`, and emergency degradation enabled.
5. After accepted audit proof, or only the executor's typed deferred context, invoke atomic transition to locked exactly once.
6. Validate the exact receipt and return success summary `{ schema_version: 1, locked: true }`.
7. Prepare the strict response from the proven authenticated context and returned lock state.
8. Return success only after terminal audit proof. Deferred emergency execution always returns non-success and requires a subsequent access-state read.

### Unlock

1. Apply no-store policy and validate exact body/confirmation.
2. Require exact local-admin authority; device-cookie, browser Origin/fetch, Cookie ambiguity, or paired CSRF cannot become unlock authority.
3. Execute audit action `unlock`, host target, accepted summary `{ schema_version: 1, requested_locked: false }`, with emergency degradation disabled.
4. After accepted audit proof, invoke atomic transition to unlocked exactly once.
5. Validate the receipt, terminal summary `{ schema_version: 1, locked: false }`, and strict response.
6. Return only after terminal audit proof.

## Failure Contract

| Boundary | Public result | Side-effect truth |
| --- | --- | --- |
| Invalid route/body/confirmation | `400 validation_error` or existing route/media error | No auth-side write, lock read/transition, or audit. |
| Unpaired/invalid/expired/revoked lock actor | Fixed `401 permission_denied` | No CSRF authorization, lock transition, or audit. |
| Read-only lock actor | `403 read_only` | No CSRF authorization, lock transition, or audit. |
| Missing/stale/malformed CSRF | Fixed `403 permission_denied` | Completed verifier semantics only; no lock transition or audit. |
| Any dashboard unlock attempt | Fixed `403 permission_denied` | No settings or audit work. |
| Already requested state | `200` with current strict state after accepted/terminal audit | No settings timestamp rewrite; operation remains auditable. |
| Regressing transition clock | `409 operation_conflict` | No state change; accepted plus failed terminal audit. |
| Settings missing/corrupt/unavailable | Fixed `500 storage_error` | Failed/incomplete terminal audit when accepted exists; no fabricated state. |
| Audit unavailable before normal mutation | Fixed executor result; no transition | No state change, except the typed emergency-lock case below. |
| Typed audit unavailable for lock | `503 audit_unavailable`, non-retryable, refresh-state message | Lock transition runs once; response preparation never runs; executor snapshot records deferred audit. |
| Terminal audit failure after transition | Fixed non-success, non-retryable | Durable lock truth is not reversed; accepted trail may remain pending. |
| Response preparation/send failure | Fixed non-success or transport failure | Durable settings and proven audit remain authoritative; no transition retry. |
| Protected write while locked | `423 host_locked`, non-retryable | No target lookup, accepted audit, dispatch, queue, or fallback. |

No public error contains settings fields beyond selected access state, operation/audit ids beyond the normal request envelope, device secrets, CSRF values/generation, cookie text, SQL/native error, or emergency transition internals.

## Hard Success Criteria

| Criterion | Required evidence |
| --- | --- |
| Shared contracts | Exact/extra/missing/accessor/inherited/boundary tests for both requests and both response ids; all state/capability invariants and secret-field absence pass. Legacy lock/trust schemas remain distinct. |
| Atomic storage | Normal lock/unlock, no-op timestamp preservation, unrelated-field preservation, regressing/invalid clock, missing/corrupt/read-only/closed state, two-connection contention, restart, and exact frozen receipt tests pass. |
| Construction/manifest | Branded exact detached ports, invalid/mutable/duplicate registration, resource context, and all three exact manifest entries fail closed before listen. Frozen count-only diagnostics retain no actor/device/origin/time/id/cause. |
| Access read | Every authentication state, loopback/LAN, HTTP/HTTPS constraint, permission/capability projection, settings failure, no-store behavior, and no-auth-side-effect behavior pass. |
| Lock authority | Local-admin HTTP/HTTPS and paired-writer HTTPS succeed; paired writer requires current CSRF once. Unpaired/invalid/expired/revoked/read-only, malformed/duplicate headers, cross-origin/plaintext LAN, and wrong method/body invoke no transition/audit. |
| Unlock isolation | Only exact loopback local-admin provenance reaches audit/transition. Every paired/browser/cookie/Origin/proxy ambiguity fails before settings/audit regardless of valid writer/CSRF. |
| Audit truth | Lock/unlock success, no-op, failed/incomplete transition, accepted failure, terminal failure, response preparation failure, duplicate operation id, crash-pending, and actor/target/summary continuity pass. Only typed lock audit availability failure uses deferred context; unlock and unknown/unproven failures never do. |
| Lock gate | Unlocked passes one exact read. Locked returns fixed 423 before target/audit/dispatch. Missing/corrupt/unavailable state fails closed. Repeated/concurrent checks retain no snapshot cache or unlocked fallback. |
| Race/restart | Opposing distinct operations serialize to one durable final order, same operation id transitions once, restart preserves state, and lock does not claim cancellation of already-dispatched work. |
| Privacy/runtime | Injection plus real TLS/raw HTTP prove no CORS/cache/secret leakage. SQLite main/WAL/SHM and observer/error/snapshot inspection retain only expected settings/audit data. No timer/listener/request-private state survives completion. |
| Ownership | No session/control dispatch, device revoke, LAN mutation, UI, production composition, physical-phone, package, or release acceptance is claimed. |

## Implementation Result

- Strict selected request/access-state contracts and invariant tests landed in `d74329c`.
- The immediate lock-only settings transition landed in `1855c23`. It preserves unrelated settings and no-op chronology, rejects regressing time and invalid storage state, and returns one frozen before/after receipt.
- Detached access, lock, unlock, and unlocked-host gate registrations landed in `d642be9`; authority/order/audit hardening landed in `d15c580`.
- Fastify schema validation now precedes authentication and its durable last-used side effect. Paired-cookie lock requires admitted HTTPS before authentication; cookie-free loopback local-admin HTTP remains valid.
- Each policy can be registered once, each registration can run once, and duplicate operation ids cannot transition settings twice.
- Typed emergency audit unavailability may still persist the lock, but the non-success response is neutral and requires access-state refresh; it never claims a transition that was not proven.
- Real TLS proves paired write authority, Host/Origin/cookie/CSRF handling, no-store/no-CORS framing, and plaintext paired-cookie refusal. Real migrated SQLite proves route persistence, restart truth, transition/audit ordering, response-failure truth, and main/WAL/SHM secret absence.
- The unrelated lazy daemon-lease workaround from the reviewed colleague branch was excluded from `main`; daemon lease behavior remains the previously proven eager implementation.

## Validation Evidence

| Layer | Result |
| --- | --- |
| Direct implementation | Host-lock route plus settings transition: 24 tests; the route matrix contains 13 injection/real-TLS/SQLite/race/failure cases. |
| Focused regressions | Host lock, authentication, CSRF, security audit executor, and settings: 58 unit tests; selected host-lock/auth/security/manifest contracts: 19 tests. |
| Workspace | 100 unit files passed with 931 tests passed and 29 external tests skipped; contract 171, integration 16, and web 14 passed. |
| Static/planning | Root and all nine package typechecks, lint plus nine package-export checks, scaffold (nine packages/18 scripts), planning after closure (196 tasks/84 requirements/633 dependencies/six queued), and diff checks passed. |
| Supply chain | Frozen offline install, zero-vulnerability production audit over 140 production dependencies, and permissive-license inventory passed. No dependency or migration was added. |
| Selected runtime binding | Isolated exact `@openai/codex` 0.144.0 binding check passed over 671 generated files with hash `e1a1a5cff3ab91862f9215dd06538eae1ea0b00bae48cbb7d87061faaee27e24`. The default 0.144.1 installation remains a separate explicit release mismatch. |
| Manual review | Authority, validation/auth side-effect order, audit/state/response truth, gate fail-closed behavior, registration ownership, SQLite privacy, and scope exclusions were inspected on supported Linux. |

## Validation Plan

- Direct contracts, atomic settings transition, audit-executor regression, and route/gate suites.
- Real migrated SQLite with two connections, forced failures, restart, audit pending/deferred behavior, and raw main/WAL/SHM inspection.
- Fastify injection plus a real loopback TLS/raw-HTTP check for exact authority, CSRF, cache, CORS, errors, and non-secret response framing.
- Focused server/storage/contracts regression, then root/all-package typecheck, lint/exports, scaffold, unit, contract, integration, web, planning, exact Codex binding, frozen offline install, production audit/license inventory, and `git diff --check`.
- Manual descriptor/order/authority/emergency/privacy review. Physical-phone lock acceptance remains `IFC-V1-033` and frontend lock behavior remains `FE-V1-013`/`FE-V1-033`.

## Reuse And Ownership

Reuse Fastify, Zod, the selected request-trust/authentication context, the completed CSRF verifier, selected settings/audit repositories, security-mutation audit executor, no-store/error policies, and the manifest. Add no dependency. Do not reuse the historical security route, legacy trust-state response, raw browser-auth inputs, full-row `setLocked` behavior, or historical write route as a selected gate.

Downstream ownership remains:

- `IFC-V1-066`: compose the lock gate into every exact-target mutation.
- `IFC-V1-033`: aggregate browser/security matrix and physical-phone lock acceptance.
- `FE-V1-013`/`FE-V1-033`: Host And Access UI, confirmation, locked/read-only states, and visual/device evidence.
- `IFC-V1-059`: device revocation and active authority invalidation.
- `IFC-V1-031`: LAN settings and listener/certificate transitions.
