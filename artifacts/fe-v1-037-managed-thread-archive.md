# FE-V1-037 Exact Managed-Thread Archive

Date: 2026-07-27

Status: complete. `MTA-01` through `MTA-24` pass.

## Scope

Implement the selected Focus Rail mobile affordance for confirming one archive of one exact current idle managed session, waiting for the terminal-backed archive API, and presenting the strongest proven remote/local persistence outcome. Archive removes the managed thread from the active-session set after a fresh authoritative read; it does not delete the Codex thread, erase retained conversation history, interrupt a turn, or stop a laptop process.

Excluded: archive from Mission Control rows, bulk archive, delete/unarchive/restore, archive of active/stale/unmanaged sessions, arbitrary thread input, active-turn interruption, operation-history reads, replayable response recovery, automatic or manual resend, optimistic list mutation, browser persistence, raw Codex protocol, terminal/shell input, compatibility UI, laptop resume, aggregate dashboard hardening, physical-phone release acceptance, and store packaging.

## Pre-Change Findings

- `IFC-V1-061` owns strict `POST /api/v1/sessions/:session_id/archive`. The body is exactly `{ operation_id, kind: "archive", confirm: true }`; the browser supplies no Codex thread id, alias, force/delete flag, query, or extra field.
- The server resolves the URL-scoped session to one immutable managed target only after authorization and lock admission. It revalidates matching mapping/projection/runtime identity and permits archive only for one selected, unarchived, current, idle session under a compatible runtime with `thread_lifecycle` capability.
- Exactly one Codex `thread/archive` may be dispatched. Remote success is then persisted as an irreversible retained mapping/projection transition; the row and event metadata remain durable while active-session reads exclude archived sessions.
- The generic response is a strict `selectedOperationDispatchSchema` accepted receipt, but this route withholds HTTP 202 until the archive service and terminal audit have both succeeded. The UI may therefore call one exactly correlated 202 a confirmed remote-and-local archive; it must not expose the generic word `accepted` as incomplete progress.
- A timeout, disconnect, abort, response loss, malformed acknowledgement, storage conflict, or terminal-audit failure may occur after possible Codex dispatch. In particular, remote archive may succeed while local persistence fails. The browser has no archive-operation read/replay endpoint and cannot safely infer or retry that outcome.
- A strict API authority rejection is blocked before target resolution. Strict `session_not_found`, `session_not_writable`, `stale_session`, and `incompatible_runtime` responses prove the requested archive did not complete. Other post-invocation failures remain outcome-unknown because their public code does not prove both remote and local state.
- The selected session detail response contains the exact current HostDeck session id, Codex thread id, name, runtime source/version, creation identity, archive state, freshness, and turn state needed for browser confirmation. Archive requires current `idle`; unlike interrupt, it does not derive a turn id from the retained event feed.
- Successful archive actively closes the selected session subscriber. Archived sessions are absent from successful session-list responses, and selected detail reads reject archived sessions. The browser must preserve its result sheet until human acknowledgement, then navigate to Mission Control and let the coordinator perform a fresh authoritative list read rather than deleting local rows.
- `FE-V1-036` already replaced Session Detail's top-right Host/access trigger with one Session actions sheet. The approved `mobile-session-detail-active.png` fixes that overflow location, and `mobile-approval-boundary-states.png` fixes the elevated confirmation pattern. This leaf extends that same sheet rather than adding an icon, nested dialog, utility command, or dead future row.

## Frozen Design

### Exact Target And Admission

- Add one strict headless archive owner for one immutable HostDeck session id. Its only live context is the current browser connection snapshot; its only mutation port can invoke `session_archive`.
- Derive the target from a current matching Session Detail response and retain exact session id, user-facing name, Codex thread id, runtime source/version, and creation identity. The private thread identity is used only for response correlation and never rendered, logged, stored, or sent in the request body.
- Archive is enabled only when the matching session is `active`, unarchived, `freshness: current`, and `turn_state: idle`; access, host, selected target, CSRF, write eligibility, current supported/degraded compatibility evidence, and connected contiguous-or-boundary session stream must all be current.
- Active/waiting/completed/interrupted/failed/unknown turn state, stale/incompatible/archived session, missing or foreign detail, route/epoch drift, read-only or rejected authority, host lock, non-current host/target, unavailable CSRF, reconnecting/failed stream, or unproven continuity disables before operation-id generation and sends nothing.
- Opening confirmation snapshots one exact target and one write-authority key. Name, thread/runtime/creation identity, archive/turn/freshness state, route epoch, compatibility, CSRF generation, or authority change invalidates confirmation; it never retargets a replacement session.

### Confirmation And Dispatch

- The Session actions menu order is `Interrupt active turn`, `Archive session`, then `Host & access`. Archive remains visible while unavailable and states the exact bounded reason. Interrupt and archive are mutually exclusive under active-turn versus idle admission, but neither disappears or substitutes for the other.
- Archive confirmation names the session and states all consequences: the managed Codex thread leaves active sessions; retained conversation history is preserved; no turn is interrupted; no files, history, or thread are deleted; archive cannot be undone from HostDeck V1.
- A secure `archive` operation id is created only after explicit confirmation. Confirm performs one synchronous final admission check and invokes exactly one protected `session_archive` request with the immutable path session id and strict target-free body.
- Duplicate click, Enter, rerender, StrictMode, concurrent confirmation, or late settlement coalesces behind one request and operation id. Pending locks Close, Back, Cancel, Escape, outside interaction, Host/access navigation, other action selection, and repeat submit.
- Pending copy says one archive request is waiting for laptop confirmation. It never says accepted, archived, deleted, removed, persisted, cancelled, safe to retry, or eventually successful before exact correlated 202 proof.
- Once the protected port is invoked, this controller lifetime never sends another archive for the exact session and exposes no Retry action. Abort/unmount suppresses late publication but cannot claim cancellation or restore retry safety.

### Result And Persistence Truth

- Success requires strict `selectedOperationDispatchSchema` parsing with `state: accepted`, `kind: archive`, exact operation id, exact managed-session type/id/thread correlation, valid accepted time, and bounded audit receipt. Any extra, malformed, rejected, foreign, or mismatched response is not success.
- A correlated 202 renders `Session archived`: the laptop confirmed Codex archive and local archived-state persistence, retained history was not deleted, and the session can leave active sessions after a fresh list read. Audit id, operation id, private thread id, cwd, and internal accepted state do not render.
- Confirmed success remains in the sheet until the human chooses `Back to sessions`. That command closes the archive owner and navigates to Mission Control; the mounted Mission Control coordinator performs the authoritative list read. No browser-side splice, archived placeholder, fabricated list response, or automatic history replacement is allowed.
- Strict authority errors render `Archive blocked`. Strict `session_not_found`, `session_not_writable`, `stale_session`, or `incompatible_runtime` render `Archive not completed`. Both retain the current detail/list truth, disclose only bounded local copy, and offer no same-lifecycle resend.
- Timeout, transport loss, abort, malformed/mismatched response, `operation_conflict`, `runtime_unavailable`, `storage_error`, audit/internal/service failure, or unexpected error renders `Archive outcome not confirmed`. Copy explicitly says the laptop may have archived the thread or may still need local reconciliation, the current session remains on screen, and HostDeck sent no retry.
- Missing detail, stream closure, elapsed time, Mission Control absence, stale retained state, another event, or reload is never proof of archive. A current same-id replacement with different immutable target identity during an attempt makes the result inconsistent/unknown and can never preserve false success.
- Settled blocked, not-completed, unknown, and inconsistent results close back to the retained Session Detail. Only correlated success offers navigation. No result exposes Retry, Delete, Restore, Unarchive, Interrupt, terminal access, raw diagnostics, or an operation-history lookup.

### Mobile Session Surface

- Reuse the one Session actions Radix sheet and one dialog/overlay/scroll owner. It transitions among menu, Host/access, interrupt states, and archive confirmation/pending/result without nesting dialogs or leaving hidden interactive content.
- The archive menu row uses the Lucide archive symbol and restrained danger semantics. The elevated confirmation and fixed footer follow approved Focus Rail risk hierarchy; they remain visually distinct from interrupt's stop icon/copy, approval decisions, host lock, compact, and routine controls.
- Menu autofocus chooses the first enabled session mutation in order, then Host/access. Back from either confirmation returns to the menu and the originating row; settled Done/Back-to-sessions behavior restores a deterministic focus target when the route remains mounted.
- Preserve the app bar, routine `/model`, `/goal`, `/plan`, utility sheet, prompt composer, timeline, refresh, Host/access content, and Mission Control trigger unchanged. Archive appears nowhere else and no laptop-resume placeholder is rendered.
- Use the selected Focus Rail dark canvas, flat rails/dividers, fixed type scale, six-pixel maximum radius, safe-area spacing, one fixed action footer, 44 px targets, visible focus, reduced motion, and non-color status meaning. No card nesting, desktop inspector, raw-id badge, terminal motif, or cross-option borrowing is permitted.

## Harsh Success Criteria

| ID | Requirement |
| --- | --- |
| `MTA-01` | One strict immutable-session headless owner validates exact options, snapshot context, one archive port, operation-id factory, subscriptions, close, and deeply frozen public views; malformed/accessor/foreign inputs fail loudly without React, direct HTTP, timers, storage, feed, terminal, interrupt, delete, or retry ports. |
| `MTA-02` | Exact target derivation requires one current matching active/unarchived/idle selected session with exact name/thread/runtime/creation identity plus current readable target/access/host/compatibility/CSRF/write/stream continuity authority. |
| `MTA-03` | Active/waiting/terminal/unknown turn, stale/incompatible/archived/missing/foreign detail, route drift, read-only/rejected authority, lock, host/CSRF/write failure, reconnect, or unproven continuity disables with deterministic bounded copy before operation-id creation and sends zero requests. |
| `MTA-04` | Confirmation freezes exact target and authority; name/thread/runtime/creation/route/epoch/archive/turn/freshness/compatibility/CSRF/permission change invalidates confirm without retarget, fallback, or dispatch. |
| `MTA-05` | Explicit confirm creates one fresh valid `archive` operation id and sends exactly one `session_archive` request with exact path id and strict `{operation_id, kind: "archive", confirm: true}` body; no query, thread id, alias, force/delete/interrupt flag, prompt, or extra field exists. |
| `MTA-06` | Duplicate click/Enter, rerender, StrictMode, concurrent confirmation, dismissal attempts, and late settlement cannot create a second request or operation id; an invoked exact-session attempt has no UI resend or Retry path for the controller lifetime. |
| `MTA-07` | Confirmed success requires strict accepted-dispatch parsing and exact operation/kind/managed-target session/thread correlation; rejected, malformed, extra, foreign, mismatched, delivery-only, elapsed, stream-close, or list-absence evidence never renders archived success. |
| `MTA-08` | Pending copy states one request awaits laptop confirmation and never fabricates accepted/completed/archive/persistence/delete/removal/cancellation/retry truth; Close/Back/Cancel/Escape/outside/menu changes remain locked until settlement. |
| `MTA-09` | Correlated 202 alone renders remote-and-local `Session archived` truth, retained-history/no-delete consequence, and human-controlled `Back to sessions`; it never renders the generic accepted state, operation/audit/private target fields, or optimistic local mutation. |
| `MTA-10` | Strict authority failures, strict non-writable/stale/not-found/incompatible failures, and possible-send/remote-success-local-failure uncertainty remain three visibly distinct blocked/not-completed/unknown result classes with bounded non-color copy. |
| `MTA-11` | Timeout, transport, abort, malformed/mismatch, operation conflict, runtime/storage/audit/internal/service, response-loss, and unexpected failures preserve explicit unknown remote/local persistence truth, retain the session on screen, send no retry, and never infer from retryable/status/message text. |
| `MTA-12` | Target replacement during dispatch, contradictory current identity, malformed snapshot progression, late settlement after close, and success/context contradiction fail closed without preserving false success, publishing stale state, or mutating navigation/list state. |
| `MTA-13` | Success navigation occurs only on human acknowledgement and only through the existing Mission Control route/coordinator fresh-load lifecycle; browser code never splices a row, fabricates archived detail/list state, treats stale absence as proof, or navigates on blocked/failed/unknown result. |
| `MTA-14` | Owner close/unmount aborts and removes listeners exactly once and suppresses late publication; route/authority changes cannot claim an invoked request was cancelled, generate a replacement id, or reopen retry safety. |
| `MTA-15` | Production archive code cannot interrupt/delete/unarchive/stop, answer approvals, send prompt/slash/raw input, poll operation state, access filesystem/storage/runtime directly, open a terminal, mutate Tailscale, or call any route except `session_archive`. |
| `MTA-16` | Session Detail retains one top-right vertical-ellipsis sheet whose exact menu order is Interrupt, Archive, Host/access; Mission Control and routine dock/composer remain unchanged, and no future laptop-resume placeholder or second app-bar icon appears. |
| `MTA-17` | Confirmation names the exact session and accurately distinguishes leaving active sessions from delete/history erasure, states no active-turn interruption and no V1 undo, and cannot be confused with interrupt, approval, lock, compact, or laptop resume. |
| `MTA-18` | One labelled modal sheet owns menu/confirmation/pending/result/Host-access transitions, focus trap/order/restore, origin-row return, keyboard activation, visible focus, restrained live regions, non-color meaning, reduced motion, and 44 px targets without a nested archive dialog. |
| `MTA-19` | Idle-ready, active-turn disabled, read-only, locked, stale, reconnecting, incompatible, not-found, blocked, not-completed, success, malformed, conflict, storage uncertainty, and generic unknown states remain visibly distinct and disclose no unsafe control. |
| `MTA-20` | Focus Rail tokens, flat dividers, fixed footer, one body scroll owner, safe areas, and six-pixel radii match approved assets at 320/360/390/412/768/1280, 390 x 420, longest session name/reason, and actual 200 percent reflow without overlap, clipping, horizontal overflow, hidden consequence/action, or composer obstruction. |
| `MTA-21` | Headless tests cover strict construction/context, every admission/identity/authority transition, confirmation recheck, operation-id timing, one dispatch, exact response correlation, every result class, no-retry latch, close/late settlement, immutability, privacy, and navigation signal ownership. |
| `MTA-22` | Component/API tests prove exact menu order and POST shape/count, archive-versus-interrupt eligibility, consequence copy, pending dismissal lock, every result, no local row mutation, success-only navigation callback, focus transitions, Host/access continuity, no nested dialog, and production app-shell composition. |
| `MTA-23` | Deterministic Chromium captures and layout records cover menu idle/active, confirmation, pending, success, blocked, not-completed, unknown storage/transport/malformed/conflict, read-only/locked/stale/reconnecting, long/narrow/short/tablet/desktop/zoom states plus DOM/request/history/storage/privacy and no-resend inspection. |
| `MTA-24` | Focused and aggregate web/browser suites plus full unit/contract/integration/type/lint/scaffold/planning/runtime-boundary/build/package/install/audit/privacy/diff/residue checks, owner-doc evidence, clean commits, and pushes pass before closure. |

## Planned Evidence

- Headless tests own exact idle target and authority derivation, confirmation freezing, operation-id timing, one protected invocation, strict accepted response correlation, error taxonomy, no-retry lifetime, close/late settlement, immutable views, navigation signal, and private-data exclusion.
- Component tests own the three-row Session actions menu, mutual interrupt/archive eligibility, explicit consequences, pending lock, result actions, Host/access transitions, focus behavior, no nested dialog, no local list mutation, and exact production hook composition.
- Production-shell Chromium owns the private-HTTPS-shaped protected POST, CSRF/header/body/count behavior, no prefetch/poll/resend, subscriber-close/response races, authority changes, success-only navigation with fresh list read, uncertain-detail retention, responsive containment, 200 percent reflow, and DOM/storage/history/request privacy.
- Deterministic screenshots and layout JSON own approved Focus Rail fidelity across ready/disabled menu, confirmation, pending, confirmed, blocked/not-completed/unknown, long target, narrow, short-height, tablet, desktop, and zoom states.
- Repository validation owns adjacent interrupt/prompt/model/goal/Plan/utility/approval/Event-details/Host-access regressions, selected route/runtime boundaries, package/build/install/supply-chain truth, task diff/privacy review, residue cleanup, and pushed history.

## Reuse And Ownership

Reuse `archiveSessionRequestSchema`, `selectedOperationDispatchSchema`, the typed `session_archive` browser route, coordinator protected-write authority, selected Session Detail projection, secure browser operation-id helper, shared host-lock copy, `FE-V1-036` Session actions sheet, existing Host/access content, Radix Dialog, Lucide icons, Focus Rail sheet primitives, production browser fixture, and approved `mobile-session-detail-active.png`, `mobile-approval-boundary-states.png`, `primary-controls.png`, and Option B design system. Add no production dependency or generated asset.

`FE-V1-037` owns browser archive admission/confirmation/one-attempt state, strict result and remote/local persistence truth, Session actions integration, success-only route handoff, accessibility, and responsive visual evidence. `IFC-V1-061` retains API/service/audit/persistence truth; `FE-V1-036` retains interrupt and the shared menu foundation; `FE-V1-012` retains detail/feed/SSE; `FE-V1-033` retains host lock; `FE-V1-035` retains compatibility UI; `FE-V1-038` adds laptop resume; `FE-V1-015`, `FE-V1-039`, `FE-V1-016`, and release leaves retain aggregate hardening, physical-phone acceptance, packaging, and go/no-go.

## Completion Evidence

### Implemented Behavior

- One strict headless archive owner derives and freezes the exact current idle managed-session identity and write authority, invokes only `session_archive`, parses the exact correlated accepted receipt, and permanently prevents resend after invocation.
- Admission fails closed for every missing, foreign, stale, archived, active-turn, incompatible, disconnected, reconnecting, read-only, locked, CSRF-invalid, or continuity-unproven state before operation-id creation.
- The shared Session actions sheet now presents Interrupt, Archive, and Host/access in the approved order. Archive owns explicit confirmation, dismissal-locked pending, blocked, not-completed, unknown, inconsistent, and confirmed states without nesting another dialog.
- Confirmed archive remains visible until `Back to sessions`; that acknowledgement performs replace navigation to Mission Control and relies on its fresh authoritative list read. No optimistic row removal, local archive fabrication, operation polling, browser persistence, or retry path exists.
- Public UI copy distinguishes archive from deletion and interruption, preserves retained-history truth, states the V1 no-undo boundary, and never renders operation, audit, thread, path, or other private identifiers.

### Automated Validation

| Gate | Result |
| --- | --- |
| Focused archive state/component | 46 tests pass, including 32 direct headless cases. |
| Final affected web unit slice | 88 tests pass across archive, interrupt, browser-runtime, and Session Detail files. |
| Aggregate web | 42 files and 768 tests pass. |
| Aggregate unit | 235 files pass, 27 files skip explicitly; 2,645 tests pass and 28 skip explicitly. |
| Contract and integration | 34 contract files/245 tests and 21 integration files/36 tests pass. |
| Chromium | 17 dedicated archive scenarios, 38 affected archive/interrupt scenarios, and the full 123-scenario production shell pass. |
| Static and boundary | Scaffold, planning, TypeScript, Biome lint, diff check, selected-runtime boundary, and exact Codex 0.144.0 binding pass. The binding inspects 671 files at `e1a1a5cff3ab91862f9215dd06538eae1ea0b00bae48cbb7d87061faaee27e24`. |
| Build and package | Production build, shell help/version, six structural package tests, deterministic and relocated package acceptance, and independent package verification pass. The verified 6,449-entry package hash is `35f41f5daccab92d6ded30bf1de374d5451e1ce81282e1136a2452f7810a3ace`. |
| Supply chain | Frozen offline install succeeds, production audit reports no known vulnerabilities, and all 172 production packages have permissive recorded licenses. |

### Visual, Accessibility, And Privacy Inspection

- `artifacts/fe-v1-037-managed-thread-archive/` contains 36 inspected screenshots and 14 layout records covering the menu, all result classes, disabled authority/continuity states, confirmed Mission Control return, 320/360/390/412/768/1280 widths, 390 x 420 short height, and actual 200 percent reflow.
- Layout records show no horizontal overflow or sheet escape, one bounded body scroller, fixed-footer containment, and no target below 44 px. The short-height and zoom scrolled captures prove the full consequence text and terminal actions remain reachable.
- Keyboard/focus, modal ownership, pending dismissal lock, success-only navigation, history replacement, storage, DOM, request-shape/count, no-resend, and private-sentinel assertions pass. Manual source/artifact review found no rendered or persisted thread, audit, operation, filesystem, credential, or user-secret value.
- The shared sheet remains visually consistent with the selected Focus Rail assets and does not alter Mission Control, the prompt composer, primary `/model`, `/goal`, `/plan` controls, or the compact utility surface.

### Remaining Scope

- Physical-phone aggregate acceptance, cross-screen state hardening, final responsive/accessibility/browser matrices, package/service release acceptance, and go/no-go remain owned by their downstream leaves; this task does not claim release readiness.
- Laptop resume remains `FE-V1-038`; compatibility/update-required presentation remains `FE-V1-035`. No placeholder or fallback for either was added.
- Vite retains its existing large-chunk advisory. This leaf adds no production dependency; aggregate bundle/performance disposition remains downstream hardening work.
