# IFC-V1-069 Projected-Event Diagnostic Read Route

Date: 2026-07-15

## Target

Implement the selected `GET /api/v1/sessions/:session_id/events` boundary over the retained projected-event repository. This is a bounded read of normalized HostDeck projections, not a Codex transcript, terminal, shell, or mutation surface.

## Pre-Change Findings

- The selected route manifest already freezes method, path, schema ids, `loopback_or_device_cookie` authentication, session-read authority, handler id, and `IFC-V1-069` ownership.
- `selectedProjectionEventSchema` and `selectedSessionEventStreamSchema` already own redacted event and replay-boundary semantics, but no selected HTTP query/page contract or route registration binds them to the manifest.
- `SelectedStateRepository.require` and `listEvents` already validate persisted projection aggregates, cursor order, future cursors, and retention-boundary placement. The HTTP boundary still needs explicit archived/recovery policy, error mapping, response-size enforcement, and no-partial-response behavior.
- The selected Fastify factory supplies one frozen resource budget and stable request authentication/error handling. No new dependency or product decision is required.

## Hard Success Criteria

| Area | Required evidence |
| --- | --- |
| Manifest | Registration refuses drift from the one `session_events` row, including method/path, request/response ids, auth, authority, target, handler, and owner. `HEAD`, trailing-slash, case, and method variants remain absent. |
| Request contract | Params accept one valid managed session id. Query accepts only canonical optional decimal `after` and `limit`, defaults to a bounded page, rejects duplicates, leading zeroes, signs, exponent/decimal forms, unsafe integers, unknown keys, and values outside the selected range. |
| Authorization | Authentication runs before params/query validation and before any state read. Safe loopback reads and paired read/write devices are admitted; unpaired remote, malformed/duplicate cookies, expired/revoked devices, and authentication failures expose no event or storage data. |
| Session policy | The route requires one identity-consistent selected mapping/projection before and after page materialization. Missing sessions return `session_not_found`; recovery-required, archived, or future-cursor requests return bounded stale-session errors without reading or returning another session. |
| Pagination | Returned events belong to exactly one session, are strictly contiguous and ascending after the requested cursor, never exceed the requested limit, and advance `next_cursor` exactly to the final event. Empty/current, exact-limit, multi-page, and cursor-zero behavior are explicit. |
| Retention | A request crossing a pruned range returns exactly one first `replay_boundary` matching durable retention metadata and sets `truncated`; later pages do not repeat it. Missing, misplaced, duplicate, or contradictory boundaries fail without partial data. |
| Integrity failures | Corrupt mapping/projection/event rows, impossible aggregate/page shapes, storage exceptions, and state changing across a bounded consistency bracket produce stable sanitized errors. No private cause, malformed row, or partial event array reaches the response. |
| Resource bound | The exact serialized success body is checked against the resolved response-byte ceiling before send. Exact-boundary output succeeds; over-bound output returns `service_overloaded` with no events and no hidden fallback or limit widening. |
| Privacy and scope | Response schemas reject extra raw frame, transcript, shell, credential, token, cookie, and storage fields. Reads create no mutation audit, runtime call, subscriber, queue, timer, or durable write. Returned objects are detached and deeply immutable. |
| Validation | Direct contract and route tests, real SQLite retention/corruption tests, Fastify injection plus a real loopback listener probe, affected package/full workspace gates, manual security/order/privacy review, and clean diff checks pass. |

## Planned Scope

- Add selected event-page params/query/response contracts under `@hostdeck/contracts`.
- Add one selected Fastify route registration under `@hostdeck/server` using only the existing authentication, resource-budget, manifest, and selected-state repository contracts.
- Add focused L1/L2 tests and record final command evidence here.
- Do not add CLI, SSE, UI, runtime, storage migration, transcript, raw-shell, production composition, or phone behavior; those remain with their owning tasks.

## Evidence

### Outcome

- `@hostdeck/contracts` now exports strict selected event-page params, canonical query parsing, bounded internal input, and contiguous response contracts. The page defaults to and caps at 100 events; duplicate, noncanonical, unknown, unsafe, or out-of-range query values reject.
- `@hostdeck/server` now exports one frozen `session_events` registration. It asserts every selected manifest field, disables implicit `HEAD`, authenticates before validation and storage, requires an open identity-consistent selected session, brackets the repository read up to three times, and validates the detached page against durable cursor/retention metadata.
- The route returns only normalized selected projection events. Missing, archived, recovery-required, future-cursor, corrupt-state, corrupt-row, inconsistent-retention, unstable-read, storage-failure, and oversized-response paths return bounded sanitized errors with no partial event array.
- Exact serialized success bytes are checked against the existing bounded client-response ceiling before Fastify sends the body. Exact-boundary output succeeds; one byte less returns `service_overloaded` without an event payload.
- No dependency, storage migration, runtime call, mutation, audit action, subscriber, timer, CLI, UI, setup, command, or phone behavior was added.

### Automated Validation

- Direct route suite: 9 tests pass, including exact manifest/surface, auth ordering, paired local and admitted Tailscale Serve reads, real SQLite pagination/retention/corruption, hostile mapping/projection/layout shapes, bounded consistency retries, exact response bytes, and a raw loopback listener.
- Direct contract suite: 4 tests pass across canonical query, bounds, continuity, replay-boundary, mixed-session, raw-field, and extra-field rejection.
- Full workspace: unit 130 files/1,252 tests pass with 22 files/36 external-device tests skipped; contract 29 files/253 pass; integration 2 files/16 pass; web 3 files/33 pass.
- Root typecheck, lint plus nine-package export validation over 394 files, and scaffold validation over nine packages/18 scripts pass.
- The reviewed Codex 0.144.0 binding check passes over 671 generated files through the isolated exact binary. The default 0.144.3 binary correctly fails the exact-version gate and was not used as release evidence.

### Inspection And Limits

- Manual review confirms the registration snapshots an exact accessor-free two-method state port; invokes methods without receiver authority; exposes no mapping, runtime, retained-byte, SQLite-row, raw-frame, transcript, shell, cookie, token, or private-cause fields; and closes all test apps, listeners, databases, and temporary roots.
- The physical Android device is intentionally not required for this headless L1/L2 route leaf. Aggregate remote-phone behavior remains owned by `IFC-V1-078` and `IFC-V1-079`.
- `pnpm audit --prod` could not obtain an advisory result because the configured registry's legacy audit endpoint returned HTTP 410. This task changes no dependency or lockfile; the unavailable external audit is recorded rather than reported as a pass.
