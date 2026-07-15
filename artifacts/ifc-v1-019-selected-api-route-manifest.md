# IFC-V1-019 Selected API Route Manifest

Date: 2026-07-11

## Outcome

- `selectedApiRouteManifest` freezes the selected browser/API boundary at exactly 36 GET/POST routes under `/api/v1/` before any route handler is registered.
- Every entry owns an exact family, method, path, JSON/SSE transport, params/query/body/success/error contract ids, authentication mechanism, authority, CSRF policy, lock policy, target kind, selected operation kind where applicable, audit executor/action/catalog state, credential effect, handler id, and downstream leaf owner.
- The manifest covers liveness/readiness/status, sessions/events, every selected structured operation, approvals, access/device security, lock/unlock, and local-admin LAN operations.
- The historical 17-route tmux manifest remains unchanged but is explicitly deprecated and has no method/path overlap with the selected inventory. It remains nonproduction until `IFC-V1-067` removes or isolates it.
- Route payload ids are stable ownership slots, not fake implemented schemas. Each owning route leaf must bind its ids to actual local Zod request/response schemas before registration; `IFC-V1-046` proves the complete registry and production composition.
- `DAT-V1-027` subsequently made `csrf_bootstrap` a selected durable audit action. `IFC-V1-040` added `session_start`; every manifest audit action is now catalog-backed with no open extension.

Criteria: `72e6c34`. Implementation: `cd0d929`.

## Route Inventory

| ID | Method and path | Auth / authority | Owner |
| --- | --- | --- | --- |
| `health_liveness` | `GET /api/v1/health/live` | none / public | `IFC-V1-039` |
| `health_readiness` | `GET /api/v1/health/ready` | loopback or device cookie / host read | `IFC-V1-039` |
| `host_status` | `GET /api/v1/host/status` | loopback or device cookie / host read | `IFC-V1-039` |
| `session_list` | `GET /api/v1/sessions` | loopback or device cookie / session read | `IFC-V1-068` |
| `session_start` | `POST /api/v1/sessions` | local admin or device cookie / session write | `IFC-V1-040` |
| `session_detail` | `GET /api/v1/sessions/:session_id` | loopback or device cookie / session read | `IFC-V1-068` |
| `session_events` | `GET /api/v1/sessions/:session_id/events` | loopback or device cookie / session read | `IFC-V1-069` |
| `session_event_stream` | `GET /api/v1/sessions/:session_id/events/stream` | loopback or device cookie / session read | `IFC-V1-035` |
| `session_resume_metadata` | `GET /api/v1/sessions/:session_id/resume` | loopback or device cookie / session read | `IFC-V1-060` |
| `session_archive` | `POST /api/v1/sessions/:session_id/archive` | local admin or device cookie / session write | `IFC-V1-061` |
| `prompt_dispatch` | `POST /api/v1/sessions/:session_id/prompts` | local admin or device cookie / session write | `IFC-V1-041` |
| `model_read` | `GET /api/v1/sessions/:session_id/model` | loopback or device cookie / session read | `IFC-V1-042` |
| `model_select` | `POST /api/v1/sessions/:session_id/model` | local admin or device cookie / session write | `IFC-V1-042` |
| `goal_read` | `GET /api/v1/sessions/:session_id/goal` | loopback or device cookie / session read | `IFC-V1-062` |
| `goal_mutate` | `POST /api/v1/sessions/:session_id/goal` | local admin or device cookie / session write | `IFC-V1-062` |
| `plan_read` | `GET /api/v1/sessions/:session_id/plan` | loopback or device cookie / session read | `IFC-V1-063` |
| `plan_select` | `POST /api/v1/sessions/:session_id/plan` | local admin or device cookie / session write | `IFC-V1-063` |
| `usage_read` | `GET /api/v1/sessions/:session_id/usage` | loopback or device cookie / session read | `IFC-V1-043` |
| `compact_read` | `GET /api/v1/sessions/:session_id/compact` | loopback or device cookie / session read | `IFC-V1-064` |
| `compact_start` | `POST /api/v1/sessions/:session_id/compact` | local admin or device cookie / session write | `IFC-V1-064` |
| `skills_read` | `GET /api/v1/sessions/:session_id/skills` | loopback or device cookie / session read | `IFC-V1-065` |
| `approval_list` | `GET /api/v1/sessions/:session_id/approvals` | loopback or device cookie / session read | `IFC-V1-044` |
| `approval_respond` | `POST /api/v1/sessions/:session_id/approvals/:request_id/respond` | local admin or device cookie / session write | `IFC-V1-044` |
| `turn_interrupt` | `POST /api/v1/sessions/:session_id/turns/:turn_id/interrupt` | local admin or device cookie / session write | `IFC-V1-045` |
| `pair_request` | `POST /api/v1/access/pairing-codes` | local admin / local admin | `IFC-V1-028` |
| `pair_claim` | `POST /api/v1/access/pairing-claims` | pairing code / pair claim | `IFC-V1-028` |
| `csrf_bootstrap` | `POST /api/v1/access/csrf` | device cookie / CSRF rotate | `IFC-V1-027` |
| `access_state` | `GET /api/v1/access` | optional device cookie / access read | `IFC-V1-030` |
| `device_list` | `GET /api/v1/access/devices` | device cookie / device admin | `IFC-V1-029` |
| `device_revoke` | `POST /api/v1/access/devices/:device_id/revoke` | local admin or device cookie / device admin | `IFC-V1-059` |
| `host_lock` | `POST /api/v1/access/lock` | local admin or device cookie / host lock | `IFC-V1-030` |
| `host_unlock` | `POST /api/v1/access/unlock` | local admin / local admin | `IFC-V1-030` |
| `network_state` | `GET /api/v1/network` | optional device cookie / access read | `IFC-V1-031` |
| `network_configure` | `POST /api/v1/network/configure` | local admin / local admin | `IFC-V1-031` |
| `network_enable` | `POST /api/v1/network/enable` | local admin / local admin | `IFC-V1-031` |
| `network_disable` | `POST /api/v1/network/disable` | local admin / local admin | `IFC-V1-031` |

For `local_admin_or_device_cookie` mutations, device-cookie execution additionally requires write authority, current CSRF, an unlocked host, exact target validation, and the selected accepted-to-terminal write gate. The local-admin branch is an explicit authority, never missing authentication.

`IFC-V1-029` corrected `device_list` to `device_cookie`: the selected authentication contract intentionally treats every safe no-Origin GET as unpaired, while explicit local-admin provenance exists only for unsafe loopback requests. Keeping the former union would advertise an unreachable local-admin arm. Local CLI device listing remains `IFC-V1-054` ownership and must use an explicit truthful local application path rather than elevate a safe GET.

## Hard Success Criteria

| Criterion | Evidence |
| --- | --- |
| Complete inventory | One independent expected-id list requires all 36 routes in stable order; family, id, and method/path uniqueness are checked. |
| Version/path safety | Every path matches one strict `/api/v1/` grammar with no wildcard, query fragment, duplicate separator, or trailing slash. Pairwise segment matching rejects static/dynamic ambiguity for the same method. |
| Contract ownership | Every params/query/body/success/error id belongs to one closed schema-id catalog, every catalog id is used, and every downstream owner task owns at least one route. |
| HTTP coherence | GET routes have no body, audit, or CSRF mutation policy. POST routes are JSON-only, have one body, no query, and one audit action. SSE is one named GET route. Dynamic path parameters require the exact matching params contract id. |
| Structured operations | The manifest covers all ten selected operation kinds. Read-only usage/skills and control reads are not audited as mutations; prompt/model/goal/plan/compact/approval/interrupt/archive are. |
| Exact mutation gate | Every selected mutation uses paired-write-or-local-admin auth, device CSRF, unlocked-host policy, exact target kind, selected write gate, and matching audit action. Session start uses an explicit new-session target. |
| Security mutations | Pair create/claim, CSRF bootstrap, revoke, lock/unlock, and LAN operations use the security executor with explicit authority and target. Revoke and lock remain available as recovery/security actions while host writes are locked. |
| Audit gaps owned | Every manifest audit action, including `csrf_bootstrap` and `session_start`, is catalog-backed. No owned extension remains open. |
| Credential effects | Pair claim alone sets the device cookie, CSRF bootstrap alone rotates CSRF, and revoke alone invalidates device authority. Every other route records `none`. |
| Legacy exclusion | No selected path or metadata contains tmux, output, raw input, slash command, stop, delete, import, or bulk surface. The historical 17 routes remain disjoint and deprecated. |
| Immutability | The manifest array, every entry, and every nested request/response/audit record are recursively frozen. |

## Validation

- Direct selected plus historical manifest matrix: 14 contract tests, including 8 selected inventory/invariant/absence tests.
- Unit: 742 passed; 28 explicit external tests skipped.
- Contract: 138 passed; integration: 16 passed; web: 14 passed.
- All 9 package typechecks passed. Lint/package exports checked 265 files and 9 packages.
- Scaffold reported 9 packages and 18 root scripts. Planning reported 196 tasks, 84 requirements, 631 dependencies, and 4 queued tasks before closure.
- Exact Codex 0.144.0 binding check verified 671 generated files at `e1a1a5cff3ab91862f9215dd06538eae1ea0b00bae48cbb7d87061faaee27e24`.
- Frozen offline install, production audit with no known vulnerabilities, manual route/auth/target/audit/credential/legacy review, and diff checks passed.
- No live listener or Codex smoke is claimed: this leaf freezes immutable route metadata only; route registration and production composition remain downstream evidence.

## Remaining Ownership

- The owner task on each manifest row must implement and bind its named request/response contracts without changing method/path/security semantics silently.
- `IFC-V1-040` completed the explicit durable `session_start` audit-catalog extension in migration 016.
- `IFC-V1-066` owns the shared selected mutation gate; `IFC-V1-032` owns the security mutation audit executor.
- `IFC-V1-046` registers and proves all selected routes through the production Fastify composition.
- `IFC-V1-067` removes or isolates the historical custom-listener/tmux route surface after selected acceptance.
