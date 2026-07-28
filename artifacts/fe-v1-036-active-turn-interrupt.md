# FE-V1-036 Exact Active-Turn Interrupt

Date: 2026-07-27

Status: complete. `ATI-01` through `ATI-24` pass.

## Scope

Implement the selected Focus Rail mobile affordance for confirming one interrupt of one exact event-proven active turn, waiting for the terminal-only interrupt API, and presenting its strongest known result. The action remains distinct from archive, delete, prompt submission, approval decisions, and laptop resume. It adds no implicit current-turn endpoint, terminal, slash command, retry loop, or background control path.

Excluded: archive implementation, deletion, session stop aliases, arbitrary turn/session input, raw Codex protocol, terminal or shell input, polling, operation-history reads, automatic or manual resend of an attempted exact turn, browser persistence, runtime recovery, compatibility UI, laptop resume, complete-dashboard hardening, physical-phone release acceptance, and store packaging.

## Pre-Change Findings

- `IFC-V1-045` already owns strict `POST /api/v1/sessions/:session_id/turns/:turn_id/interrupt`. Its target-free body is exactly `{ operation_id, kind: "interrupt", confirm: true }`, and HTTP 200 is possible only after matching normalized `turn/completed: interrupted` proof plus terminal audit. The route never exposes internal accepted progress.
- The service admits only `in_progress`, `waiting_for_input`, and `waiting_for_approval`, and additionally requires the requested turn to match its normalized turn-start evidence. Missing, terminal, wrong, stale, archived, incompatible, locked, duplicate, and unresolved attempts fail closed before a second Codex dispatch.
- Session Detail exposes current session/thread/runtime identity and projection `turn_state`, but not an active `turn_id`. The only browser-owned exact turn identity is the validated, ordered, 100-event Session Detail feed. Projection-only activity is therefore insufficient to enable interrupt.
- The feed can contain multiple states for one turn, multiple historical turns, and replay boundaries. Exact browser admission must use the latest event per turn in the unbroken retained suffix, require one unique active turn, and require its latest state to agree with the current session projection.
- The generic protected coordinator already owns paired-writer, host readiness/lock, and CSRF admission. Interrupt must still add selected-session freshness, stream continuity, exact active-turn evidence, and immutable target checks before invoking that port.
- A pending interrupt request may already have reached Codex even when HTTP later times out, aborts, loses authority, fails audit, or returns a malformed response. Once the protected port is invoked, the browser cannot safely resend that exact turn. Later exact feed evidence may strengthen turn-outcome truth but cannot invent a successful API receipt.
- Current Session Detail puts routine model, goal, Plan, utility, and prompt controls in the bottom dock. The approved `mobile-session-detail-active.png` reserves one top-right vertical-ellipsis session menu, while `mobile-approval-boundary-states.png` defines the elevated confirmation sheet. Risky interrupt does not belong in the routine dock.
- The existing top-right button opens Host & access directly. Session actions need one mobile overflow that keeps Host & access reachable, avoids a second crowded app-bar icon, and gives later archive and laptop-resume leaves one stable location without rendering dead placeholders now.
- The backlog linked interrupt and archive to `UX-010`, which owns laptop resume. Their canonical risky-action requirement is `UX-008`; this criteria change corrects both references without changing either leaf's scope.

## Frozen Design

### Exact Target And Admission

- Add one strict headless interrupt owner for one immutable HostDeck session id. Its context contains only the current browser connection snapshot and already validated Session Detail feed; its injected mutation port can invoke only `turn_interrupt`.
- Derive the managed target from a current matching Session Detail response: exact session id, Codex thread id, runtime version, creation identity, active/unarchived/current session state, and the current projected turn state.
- Derive turn identity only from `type: "turn"` feed events for the same session. Reduce each turn to its latest event, ignore evidence at or before the latest retained or continuity-only replay boundary, require exactly one latest active turn, and require its state to equal the projection's `in_progress`, `waiting_for_input`, or `waiting_for_approval` state.
- Missing events, projection-only activity, multiple latest active turns, a latest terminal/idle/unknown state, a projection/event mismatch, a boundary newer than the proof, a foreign feed, or malformed/contradictory context disables the action and sends nothing. No heuristic may use timeline labels, activity rows, approvals, prompt state, elapsed time, or the last arbitrary turn id.
- Browser write eligibility, current selected-session read authority, connected live stream, proven contiguous-or-boundary continuity, ready page CSRF, and the exact active target are all required. Host-lock causes use the shared lock copy. Other denied states use bounded local explanations and do not expose raw coordinator/API detail.

### Confirmation And Dispatch

- Opening confirmation snapshots one exact session/thread/turn/runtime target and the latest feed cursor. Current context may advance only while it still proves that same active target and authority. Terminal state, target/runtime/authority replacement, continuity loss, archive, staleness, or contradiction disables confirmation before dispatch.
- Confirmation names the user-facing session and full exact turn id, states the current active state, and says precisely: interrupt stops only this active turn; it does not archive or delete the session or erase retained history.
- A secure `interrupt` operation id is created only after explicit confirmation. Confirm performs one synchronous final admission check and then invokes the protected port exactly once with exact URL params and exact target-free body. Duplicate click, Enter, rerender, StrictMode, or concurrent confirmation coalesces behind that one attempt.
- The pending surface says HostDeck sent one request and is waiting for exact terminal proof. It never labels the operation accepted, completed, cancelled, or interrupted before terminal evidence. Close, Cancel, Escape, outside interaction, session-menu navigation, and repeat submit remain disabled while the request is unsettled.
- Once the protected port has been invoked, this owner never resends the attempted exact turn, never generates a replacement operation id, and exposes no Retry action. Route/unmount/authority abort remains potentially post-dispatch and cannot be described as cancellation or made retry-safe.

### Result And Reconciliation Truth

- API success is accepted only after strict `interruptResponseSchema` parsing and exact operation/session/thread/turn correlation. It renders `Turn interrupted` as a confirmed result and retains the exact bounded server update time without exposing operation id or private target fields.
- Every post-invocation rejection is sanitized. Stable authority rejection may be called blocked; all timeout, transport, malformed response, protocol, audit, storage, runtime, stale/continuity, conflict, and unexpected cases remain `Outcome not confirmed` unless exact later turn evidence proves a stronger terminal state. Raw error messages, response bodies, retryable flags, causes, credentials, origins, and operation ids never render.
- Reconciliation considers only turn events for the attempted exact turn with cursor greater than the snapshotted baseline. `interrupted` proves that the turn ended interrupted but, without correlated HTTP 200, is labeled feed-confirmed rather than a confirmed request receipt. `completed` or `failed` proves the turn ended without a confirmed interrupt. Idle, another turn, activity/approval/control events, elapsed time, refresh, reconnect, or absence of events proves nothing.
- A replay boundary after dispatch preserves unknown outcome. A newer turn may establish that the attempted turn is no longer active but cannot invent its missing terminal reason. A response/event contradiction becomes an explicit consistency failure and never leaves a success surface.
- The attempted exact turn remains locally latched after result dismissal and cannot be submitted again. A later exact different active turn may become actionable only after the prior result is dismissed and current unbroken evidence and authority independently admit the new target. Backend duplicate and unresolved-attempt gates remain the cross-lifecycle authority.

### Mobile Session Surface

- Replace only Session Detail's top-right Host/access trigger with one 44 px vertical-ellipsis `Session actions` sheet. Mission Control retains its existing Host & access trigger. The session sheet has a flat action list with `Interrupt active turn` and `Host & access`; later leaves may add archive and laptop resume, but this leaf renders no placeholder or disabled future action.
- The same Radix sheet transitions between session menu, interrupt confirmation/pending/result, and Host & access subview. Interrupt does not open a nested dialog, leave hidden interactive content, or compete for a second scroll owner. Cancel returns safely, Done closes or returns to the menu, and focus returns to the app-bar trigger.
- The interrupt row remains visible with exact enabled/disabled/result status so missing evidence, inactive/completed/interrupted/failed state, read-only authority, host lock, reconnect, continuity loss, duplicate attempt, and unknown result do not disappear or look actionable.
- Preserve the routine bottom dock and prompt composer unchanged. Interrupt never appears in More utilities, timeline event details, approval controls, or a desktop-only toolbar and never changes pinned timeline, new-activity, refresh, or Host & access behavior.
- Use the selected Focus Rail dark canvas, flat dividers/rails, semantic danger and attention tones, Lucide icons, fixed type scale, six-pixel maximum radius, safe-area spacing, and one fixed action footer. No nested cards, decorative asset, terminal motif, raw-id badge, Signal Ledger borrowing, or desktop inspector layout is permitted.

## Harsh Success Criteria

| ID | Requirement |
| --- | --- |
| `ATI-01` | One strict immutable-session headless owner validates exact options, context, one interrupt port, operation-id factory, subscriptions, close, and deep-frozen public views; malformed/accessor/foreign inputs fail loudly without React, direct HTTP, timers, storage, terminal, archive, or retry ports. |
| `ATI-02` | Exact target derivation requires one current matching active/unarchived selected session plus one unique latest active turn in the unbroken validated feed suffix, with exact session/thread/runtime identity and projection/event state agreement. |
| `ATI-03` | Missing/foreign/ambiguous/boundary-obscured turn evidence, projection-only activity, terminal/idle/unknown state, stale/archive/runtime drift, disconnected continuity, read-only/locked/uncertain host, or unavailable CSRF disables before operation-id generation and sends zero requests. |
| `ATI-04` | Confirmation freezes exact session/thread/turn/runtime/evidence identity; target, terminal state, authority, route, archive, freshness, continuity, or compatibility change invalidates confirm without retargeting or falling back to another active-looking row. |
| `ATI-05` | Explicit confirm creates one fresh valid `interrupt` operation id and sends exactly one `turn_interrupt` request with exact params and strict `{operation_id, kind: "interrupt", confirm: true}` body; no query, caller thread id, force, archive/delete flag, prompt, or extra field exists. |
| `ATI-06` | Duplicate click/Enter, rerender, StrictMode, concurrent confirmation, dismissal attempts, and late settlement cannot create a second request or operation id. Once the protected port is invoked, the exact turn has no UI resend or Retry path. |
| `ATI-07` | Confirmed success requires strict response schema plus exact operation/session/thread/turn correlation and null error; accepted/running/elapsed/projection-only/malformed/foreign results never render interrupted success. |
| `ATI-08` | Pending copy states one request is waiting for terminal proof and never fabricates internal accepted state, successful cancellation, eventual success, retry safety, archive, deletion, or stopped session history. |
| `ATI-09` | Idle/completed/interrupted/failed/missing active-turn, read-only, locked, stale, reconnecting, unsupported, duplicate, and inconsistent states each have deterministic bounded non-color copy and remain non-actionable without disappearing. |
| `ATI-10` | Post-invocation authority, API, timeout, transport, abort, protocol, audit, storage, runtime, conflict, malformed, and unexpected failures map to stable blocked or unknown truth; raw API text/body/cause/retryability, operation id, CSRF, device, origin, cwd, and private thread identity never render or persist. |
| `ATI-11` | Only a causally later exact-turn terminal event can strengthen an unsettled result: interrupted is feed-confirmed turn truth, completed/failed is not-interrupted terminal truth, and all other events/turns/time/refresh/reconnect/absence remain non-proof. |
| `ATI-12` | Response versus feed contradiction, duplicate terminal states, cursor regression/gap, boundary-after-attempt, and target/runtime replacement fail closed with explicit consistency or unknown status and never preserve a false success. |
| `ATI-13` | Busy close/Escape/outside/Cancel/menu navigation is locked; owner close/unmount/authority abort removes listeners and suppresses late publication but does not claim the already invoked request was cancelled or enable retry. |
| `ATI-14` | An attempted exact turn remains latched after dismissal and cannot be resubmitted. A different later turn becomes eligible only from new current unbroken exact evidence after prior result acknowledgement; backend remains authoritative across reload/restart. |
| `ATI-15` | Production interrupt code cannot archive/delete/stop a session, answer approvals, send prompt/slash/raw input, poll operation state, access filesystem/storage/runtime directly, open a terminal, mutate Tailscale, or call any route except `turn_interrupt`. |
| `ATI-16` | Session Detail owns one top-right vertical-ellipsis Session actions sheet with exactly current interrupt and Host & access entries; routine dock/composer and Mission Control app bar remain unchanged, and no future-action placeholder or crowded second app-bar icon appears. |
| `ATI-17` | Confirmation names exact session and turn, active state, one-turn effect, and explicit no-archive/no-delete/no-history-erasure consequence; its danger hierarchy and command labels cannot be confused with approval, host lock, compact, or archive. |
| `ATI-18` | One labelled modal sheet owns menu/confirmation/pending/result/Host-access transitions, focus trap/order/restore, deterministic Cancel focus, keyboard activation, visible focus, restrained live regions, non-color meaning, reduced motion, and 44 px targets without an interrupt nested dialog. |
| `ATI-19` | Confirmed HTTP success, feed-confirmed interrupted, exact completed/failed, stable blocked, unknown, duplicate, and consistency-failure results remain visibly distinct, dismissible only when settled, and offer no unsafe resend. |
| `ATI-20` | Focus Rail tokens, flat rails/dividers, fixed footer, one body scroll owner, safe areas, and six-pixel radii match approved assets at 320/360/390/412/768/1280, 390 x 420, long ids/session names, and actual 200 percent reflow without overlap, clipping, horizontal overflow, hidden action/status, or composer obstruction. |
| `ATI-21` | Headless tests cover strict construction/context, every active/terminal/missing/ambiguous/boundary state, exact authority/target freezing, one dispatch, operation-id timing, response correlation, feed reconciliation, contradictions, cancellation, new-turn reset, privacy, immutability, and no-retry ownership. |
| `ATI-22` | Component/API tests prove exact menu composition and POST shape/count, confirmation copy, pending dismissal lock, every result/disabled state, focus transitions, Host & access continuity, no bottom-dock duplication, no nested interrupt dialog, and production app-shell controller composition. |
| `ATI-23` | Deterministic Chromium captures and layout records cover ready menu, confirmation, pending, confirmed success, feed-confirmed success, completed/failed, missing evidence, read-only/locked/reconnecting/boundary, unknown/conflict, long/responsive/short/zoom states plus DOM/request/storage/history/privacy and no-resend inspection. |
| `ATI-24` | Focused and aggregate web/browser suites plus full unit/contract/integration/type/lint/scaffold/planning/runtime-boundary/build/package/install/audit/privacy/diff/residue checks, owner-doc evidence, clean commits, and pushes pass before closure. |

## Planned Evidence

- Headless tests own exact active-turn reduction, boundary handling, authority/target keys, confirmation recheck, operation-id timing, one invocation, strict response/result mapping, post-baseline reconciliation, contradiction, lifecycle suppression, new-turn admission, immutability, and privacy.
- Component tests own one mobile session menu, exact disabled/result rows, menu-to-confirmation transition, target/effect copy, pending lock, settled focus/dismissal, Host & access subview, routine-control separation, long content, and production composition.
- Production-shell Chromium owns the exact private-HTTPS-shaped protected POST, CSRF/header/body/count behavior, no prefetch/poll/resend, live event races, authority/continuity changes, responsive containment, 200 percent reflow, and DOM/storage/history/request privacy.
- Deterministic screenshots and layout JSON own approved Focus Rail fidelity across menu, confirmation, pending, terminal, blocked, unknown, boundary, long-target, narrow, short-height, tablet, desktop, and zoom states.
- Repository validation owns adjacent prompt/model/goal/Plan/utility/approval/Event-details/Host-access regressions, selected route/runtime boundaries, package/build/install/supply-chain truth, task diff/privacy review, residue cleanup, and pushed history.

## Reuse And Ownership

Reuse `interruptRequestSchema`, `interruptResponseSchema`, the typed `turn_interrupt` browser route, coordinator protected-write authority, validated bounded Session Detail feed, selected session projection, secure browser operation-id helper, shared host-lock copy, existing Host & access content, Radix Dialog, Lucide icons, Focus Rail sheet primitives, production browser fixture, and approved `mobile-session-detail-active.png`, `mobile-approval-boundary-states.png`, `primary-controls.png`, and Option B design system. Add no production dependency or generated asset.

`FE-V1-036` owns browser exact-turn derivation, interrupt confirmation/one-attempt state, pending and strongest-known result truth, Session actions menu foundation, accessibility, responsive visual evidence, and adjacent Host & access integration. `IFC-V1-045` retains API/service/audit truth; `FE-V1-012` retains feed/timeline/SSE; `FE-V1-033` retains host lock; `FE-V1-035` retains compatibility UI; `FE-V1-037` adds archive to the menu; `FE-V1-038` adds laptop resume; `FE-V1-015`, `FE-V1-039`, `FE-V1-016`, and release leaves retain aggregate hardening, physical-phone acceptance, packaging, and go/no-go.

## Completion Evidence

### Behavior And Hardening

- One headless owner admits only one exact feed-proven active turn under current read/write/host/stream/continuity/CSRF authority, freezes confirmation, issues one correlated protected request, and exposes only bounded immutable view truth.
- Controller-lifetime attempted-turn ownership prevents an older turn from becoming resubmittable after a later distinct attempt. Unsettled runtime/thread replacement, cursor regression, repeated terminal evidence, and API/feed contradiction fail closed; a setup failure that sent nothing cannot acquire later feed-confirmed request truth.
- Session Detail now owns one 44 px vertical-ellipsis Session actions sheet with exactly `Interrupt active turn` and `Host & access`. Mission Control retains its direct Host/access trigger, and the routine dock/composer remains unchanged.
- The shared Host/access navigation, scroll-owner, close-focus, paired-device, lock, and recovery assertions now support both valid shells. No interrupt retry, archive/delete/session-stop, terminal, prompt, approval, polling, timer, storage, direct HTTP, or second route exists.

### Automated Validation

- Direct state tests: 21 passed. Focused state/component/production-composition tests: 57 passed. Aggregate web: 40 files and 721 tests passed.
- Dedicated Chromium: 21 passed. Affected Host/access and Session Detail regressions: 29 passed. Full production shell: 106 passed after correcting legacy tests that assumed the removed direct Session Detail Host/access trigger.
- Workspace unit: 2,598 passed with 28 intentional skips. Contract: 245 passed. Integration: 36 passed. Root and web typechecks pass.
- Biome/package exports pass over 694 files and eight packages. Scaffold passes at eight packages and 21 root scripts. Planning passes before closure at 220 tasks, 84 requirements, 683 dependencies, and four queued tasks. Selected runtime boundary passes at 614 production modules and 22 external modules.
- Exact isolated Codex 0.144.0 binding verifies 671 files at `e1a1a5cff3ab91862f9215dd06538eae1ea0b00bae48cbb7d87061faaee27e24`. The default 0.145.0 binary correctly refuses this exact gate and remains the already-recorded environment drift.
- Production build and package acceptance pass at 614 sources, 1,235 owned outputs, 6,449 entries, and SHA-256 `35f41f5daccab92d6ded30bf1de374d5451e1ce81282e1136a2452f7810a3ace`. Frozen offline install is current, and `pnpm audit --prod` reports no known vulnerabilities.

### Visual And Privacy Inspection

- Thirty-seven deterministic PNGs and 14 layout records cover menu, Host/access, confirmation, pending, every result family, disabled evidence/authority states, 320/360/390/412/768/1280 widths, 390 x 420 short height, long identifiers, and actual 200 percent zoom.
- Manual comparison against the selected Focus Rail mobile Session Detail and elevated-action references found no unapproved structural drift. The sheet remains bottom-anchored and phone-first, uses one body scroll owner and fixed action footer, keeps all controls at least 44 px, and has no clipping, overlap, or horizontal overflow.
- DOM/request/storage/history assertions and source review found no rendered operation id, thread id, device id, origin, cwd, CSRF value, raw error/body/cause, private fixture sentinel, or persisted interrupt state. Malformed and mismatched responses intentionally collapse to the same sanitized unknown surface.

### Remaining Scope

- The existing Vite chunk-size warning remains a downstream aggregate performance concern; it is not introduced by a dependency or a false package result in this leaf.
- Physical-phone acceptance, compatibility UI, archive, laptop resume, cross-screen hardening, packaged remote workflow, store delivery, and final go/no-go remain owned by their downstream leaves. No FE-V1-036 criterion remains open.
