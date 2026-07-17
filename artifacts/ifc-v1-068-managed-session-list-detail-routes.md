# IFC-V1-068 Managed-Session List And Detail Routes

Date: 2026-07-16
Status: in progress

## Selected Boundary

- Bind exactly the existing `session_list` and `session_detail` manifest entries: `GET /api/v1/sessions` and `GET /api/v1/sessions/:session_id`. Add no alias, wildcard, import, transcript, approval, control, archive-history, or raw-runtime surface.
- Both routes require current `loopback_or_device_cookie` read authority before query/parameter validation reaches storage. They are no-store JSON GETs, reject request bodies, disable implicit HEAD, and revalidate paired-device plus remote-ingress authority before publishing any post-authentication response.
- List returns only non-archived durable HostDeck-managed sessions. Archived rows remain durable but are omitted. Detail returns 404 for an unknown managed id and 409 for an archived or recovery-required mapping; it never substitutes another thread or imports an unmanaged Codex thread.
- A contract-valid `stale`, `disconnected`, `incompatible`, or `unknown` projection remains readable with that exact state. This is required for offline/recovery UX. Identity disagreement, impossible event-window metadata, recovery disposition, malformed persistence, and a changed pagination ordering snapshot fail instead of being relabeled as a valid stale projection.
- List/detail consume only the dedicated durable session-read repository. They do not call Codex, read rollout files, enumerate unmanaged threads, fetch projected events, read pending approvals, infer live runtime health, or mutate storage. Event bodies remain owned by `IFC-V1-069`; pending approvals remain owned by `IFC-V1-044`; final host write eligibility remains owned by `IFC-V1-039` and the selected write gate.

## Wire Contracts

| Contract | Exact public shape |
| --- | --- |
| List query | Optional canonical decimal `limit` from 1 to 100, default 50; optional versioned opaque cursor. Unknown, repeated, noncanonical, oversized, or malformed fields reject. |
| Session read item | One existing `managedSessionProjection` plus `event_window`. The projection carries HostDeck/session/thread identity, bounded public cwd/branch/model/settings/goal/summary cues, lifecycle/turn/attention/freshness truth, activity/update times, and last event cursor. |
| Event window | `state` is `empty`, `contiguous`, or `bounded`; retained count, earliest retained cursor, and nullable boundary cursor must agree exactly with the projection's last cursor. No event array, bytes, payload, or transcript is present. |
| Request access | Request authority mode (`local_admin`, `loopback_read`, `paired_read`, or `paired_write`), network mode, and transport only. Device identity, cookie, CSRF state, source key, ingress generation, lock, and final write eligibility are absent. |
| List response | Access snapshot, zero to 100 strictly ordered session-read items, nullable next cursor, and `has_more`. Continuation exists exactly when a full validated lookahead proves another item. |
| Detail response | Access snapshot and exactly one non-archived session-read item. Approvals and events are fetched through their separately authorized bounded routes. |

The selected Mission Control order is descending attention rank: approval 60, input 50, failure 40, stuck/unknown 30, running/watch 20, quiet/none 0. Equal ranks use non-null newest `last_activity_at` first, then null activity, then ascending HostDeck session id. The shared comparator, cursor key, repository order, route checks, and mobile view-model contract must agree.

The cursor carries one ordering-snapshot digest plus the final row's exact rank/activity/id key. The repository recomputes the bounded active-set ordering snapshot in the same SQLite read transaction. Any new/archive/attention/activity change, missing cursor row, or cursor-key mismatch returns a stale-cursor conflict and requires a first-page refresh; it cannot skip or duplicate rows silently. Summary/model/goal changes that do not affect membership or order do not invalidate continuation.

## Hard Success Criteria

| Boundary | Required proof |
| --- | --- |
| Exact contracts | Shared schemas reject missing/extra/symbol/accessor/prototype-invalid objects, sparse/forged arrays, invalid timestamps/ids, public cwd above 4,096 characters, impossible event windows, archived list/detail success, duplicate/out-of-order rows, contradictory cursor/`has_more`, and noncanonical query/cursor forms. Parsed outputs are detached and recursively frozen. |
| Repository snapshot | A dedicated repository performs one bounded read transaction per call. Detail joins mapping/projection in one statement. List scans at most 4,097 active ordering rows, rejects above 4,096 with overload, validates every active row's managed disposition and ordering fields before returning any page, then fully validates page plus lookahead rows. No existing unbounded N+1 `SelectedStateRepository.list()` path is used by these routes. |
| Identity/integrity | Mapping and projection id/name/thread/cwd/runtime/version/created/archive facts agree. Event count, earliest/boundary/last cursor, JSON settings/goal, chronology, archive state, and public field bounds agree. Missing projection, malformed JSON, raw-column drift, duplicate result identity, and impossible retention layout produce one bounded storage failure with no partial sessions. |
| Stable pagination | Empty, one-item, exact-limit, limit-plus-one, maximum-page, multi-page, equal-rank/equal-time/null-activity, all attention levels, and 4,096-row traversal preserve exact order with no duplicate or omission in an unchanged snapshot. Cursor tampering, old snapshot, moved row, new/archive row, and attention/activity movement reject rather than continue ambiguously. |
| Archive/recovery policy | Archived rows are absent from every list page and do not affect the active ordering digest. Archived detail is 409 after authentication. Recovery-required active state fails the whole list/detail as unavailable; it is never hidden among otherwise successful active rows or presented as an ordinary unknown session. |
| Honest degraded reads | Valid stale/disconnected/incompatible/unknown projections return 200 with explicit freshness/reason/state and no writable claim. The route performs zero runtime/health calls and therefore cannot turn an unavailable runtime into a false 503 or false current state; clients combine this durable read with host status and SSE truth. |
| Authentication lifetime | Unpaired remote/LAN, malformed/unknown/expired/revoked cookies, read-auth storage failure, and wrong ingress reject before repository access. Paired revocation or ingress-generation closure before serialization suppresses success and error bodies that could disclose session existence. Local browser, explicit local admin, paired read, and paired write stay distinct in the bounded access projection. |
| HTTP surface | Exact paths return typed 200 bodies; malformed params/query/body, trailing slash, HEAD, wrong method, and unknown route use existing stable errors. Responses are no-store, bounded by the configured response-byte ceiling, and never expose a partial page if response preparation or serialization fails. |
| Privacy | Contract/object/raw-listener scans find no event payload, prompt, command, full transcript, approval action, audit payload, token/cookie/hash/CSRF, device id, source key/generation, raw runtime/Tailscale response, exception cause, SQL, or foreign/unmanaged thread. Public cwd/thread id remain intentional FR-002 managed-session identity fields and are bounded. |
| Ownership | Registration and repository ports are exact, receiver-independent, immutable, and single-owner. The selected manifest is asserted field-for-field. This leaf does not claim production route composition, CLI `list`, React state coordination, SSE behavior, phone screenshots, packaging, or release readiness. |

## Validation Plan

- Contract tests cover canonical query/cursor round trips, hostile objects/arrays/proxies, every event-window state, every attention ordering tie, archived rejection, maximum content, deep freeze, and privacy sentinels.
- Repository tests use real migrated SQLite for empty/detail/archive/recovery, mixed attention, null/equal activity, 4,096-row traversal, snapshot mutation, cursor tampering, page lookahead, concurrent-connection commits, restart, missing/corrupt rows/JSON/counters, query bounds, receiver-independent calls, and raw-row privacy.
- Route tests cover exact manifest/path/method/query/body behavior, auth-before-storage, all access modes, no-store headers, list/detail policy, response-size failure, hostile port results, no partial body, and paired/ingress invalidation before response publication.
- Adjacent selected-state, request-authentication, Fastify error/resource, host-health, event, approval, archive, mobile-fixture, and manifest suites run with all workspace tests/typechecks plus lint/exports, scaffold, planning, runtime-boundary, frozen install, exact binding, supply-chain, privacy, diff, process/listener/temp cleanup, and manual source/output inspection before closure.

## Explicit Non-Goals

- No live runtime read, reconciliation, projection mutation, event replay, SSE subscription, approval aggregation, transcript reconstruction, or fallback to Codex list/read.
- No archived-session browser/history surface and no `include_archived` query in V1 Mission Control.
- No final write eligibility, lock/CSRF/capability merge, quick action, CLI list renderer, production composition root, React implementation, visual drift approval, or physical-phone claim.
