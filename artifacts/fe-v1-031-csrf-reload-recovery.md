# FE-V1-031 CSRF Reload And Stale-Session Recovery

Date: 2026-07-26

Status: criteria frozen; implementation pending.

## Scope

Implement the selected Focus Rail page-authority and recovery workflow inside the persistent Host & access surface. A clean browser reload must visibly regain a page-memory CSRF posture from the paired HttpOnly cookie, and an explicit recovery action must safely recheck stale access/session authority and bootstrap one current writer without replaying any product mutation.

Excluded: pairing-link creation or claim changes, cookie issuance or clearing, durable browser credentials, device listing/revocation controls, host lock mutation, Tailscale/profile/Serve diagnosis or repair, Codex compatibility detail, event-stream retry policy, server/storage/API changes, product-mutation retry, a fake logout action, physical-phone release acceptance, and complete-dashboard hardening owned by later leaves.

## Pre-Change Findings

- `IFC-V1-027` already owns exact `POST /api/v1/access/csrf`: paired-cookie authentication, one audited rotation, no prior CSRF header, strict no-store/no-cache response, durable hash-only state, and denial for invalid, expired, or revoked authority. Read and write devices may bootstrap; the response exposes one raw token only to page memory.
- `FE-V1-024` already owns the only browser CSRF client. A bootstrap clears old page authority before dispatch, is single-flight, never restores an old token after failure, and injects the token/generation only into one protected request. Public state is immutable and token-free; no browser storage, URL, cookie API, retry, React, or diagnosis belongs there.
- `FE-V1-025` already owns one production coordinator and exact access, host, target, stream, and CSRF epochs. A clean writer load automatically bootstraps once only from initial `idle/not_bootstrapped`; read-only, unpaired, invalid, expired, and revoked authority never starts writer bootstrap.
- The coordinator intentionally keeps a failed bootstrap degraded until `bootstrapCsrf()` is called explicitly. A refresh alone does not loop another rotation. Pair replacement or remote-authority invalidation can leave a current writer with an idle non-initial CSRF state that also requires explicit bootstrap.
- A protected mutation rejected as stale generation or authority rejected clears the credential, closes the stream, and marks retained access, host, and target data stale. `bootstrapCsrf()` correctly refuses that stale state, so recovery must first refresh the exact current target and only then bootstrap if the refreshed authority is still a current paired writer.
- No production UI calls `bootstrapCsrf()`. Host & access currently compresses every non-ready CSRF phase into `Securing writes`, exposes no page-authority fact, and provides no bounded recovery command or operation state.
- Pairing startup already owns the separate `paired_csrf_unavailable` screen and its literal browser reload action. This leaf owns the normal loaded application after fragment-free startup; it must not duplicate the claim flow or retain pairing material.
- The executable mobile contract names `access_csrf_bootstrap` and `access_csrf_failure`. The approved Focus Rail target maps access recovery to `RecoveryRailPanel`; typed state overrides the raster examples and forbids remote profile switching, Serve mutation, unlock, raw credentials, or pre-load HostDeck diagnosis.
- Existing component and browser evidence covers static writer/read-only/locked/stale/access states and initial bootstrap, but not an interactive failed-bootstrap recovery, stale-generation refresh-then-bootstrap sequence, duplicate action race, target switch, response loss, or reload request inventory. No new dependency is required.

## Frozen Design

### Page-Authority Ownership

- One headless recovery controller owns local recovery phase, one explicit attempt, same-target correlation, bounded result/failure copy, subscription, and close. It consumes only the existing coordinator snapshot, `refresh()`, and `bootstrapCsrf()` ports; it owns no HTTP client, route, token, operation id, cookie, storage, timer, or network diagnosis.
- The controller is mounted with the app-bar Host & access owner, not recreated whenever the sheet opens. Sheet dismissal does not cancel or duplicate the page-global coordinator operation. Route/target replacement, owner close, coordinator close, and StrictMode replacement suppress every late local result.
- Public immutable view state contains only page-security phase/tone/label/detail, action kind/label/enabled truth, and busy/result semantics. It never exposes CSRF generation/rotation time, access device id, session id, operation id, raw error/envelope, cookie, token, origin internals, or Tailscale identity.
- Initial page load remains coordinator-owned. Once exact current paired-writer access, matching host status, and current target data are proven, one automatic bootstrap may run. The recovery controller observes and renders it but never starts a second initial bootstrap.

### Explicit Recovery Algorithm

- One action derives from the current snapshot. A current paired writer with idle or failed page authority runs one direct `bootstrapCsrf()`. Stale/failed access, host, or target state runs one `refresh()` for the exact target, then runs at most one `bootstrapCsrf()` only if the refreshed snapshot is still that target, current, and paired-writer with CSRF not ready.
- One attempt has one atomic local owner. Click, touch, Enter, rerender, sheet close/open, StrictMode, and a second action while busy return the same in-flight promise or no-op; they cannot start another refresh or bootstrap.
- The controller snapshots the target identity before work. A target switch, target removal, coordinator epoch supersession not caused by its owned refresh, access loss, permission downgrade, revoke/expiry, host mismatch, or coordinator close prevents follow-up bootstrap and prevents recovered copy from publishing against another target.
- Refresh may already complete an initial single-flight bootstrap through the coordinator. The controller re-reads the resulting snapshot and never sends a second bootstrap when CSRF is bootstrapping or ready.
- Recovery success means only that the exact current page authority is ready. It does not claim that the host is unlocked, runtime compatible, stream connected, session writable, remote ingress repaired, a prior product mutation succeeded, or the user logged in/out.
- No failed prompt/control/approval/lock/archive/interrupt/device mutation is replayed. There is no automatic recovery after a protected failure, background retry, polling, interval, backoff, reload loop, service worker, alternate client, or browser persistence.

### Failure And Disclosure Truth

- Initial checking, automatic bootstrap, page authority ready, current-writer recovery required, checking current access, securing the refreshed page, recovered, explicit recovery failure, stale retained access, generic loaded-origin unreachable, read-only, locked, unpaired, invalid, expired, revoked, and closed states remain distinct.
- A bootstrap transport/timeout/response-loss/malformed/API failure leaves page authority absent and writes disabled. The UI says secure setup could not be confirmed and offers only another explicit bounded attempt when current authority permits it; it never restores the previous token or claims logout.
- Stale-generation or authority-rejected product failure first renders retained data as stale/read-only and offers `Check access`. Current revoked/expired/unpaired truth removes protected session disclosure and instructs the user to create a new pairing link on the laptop; it does not keep a CSRF retry command.
- Read-only permission, host lock, host/runtime health, remote ingress, and stream status stay independently visible through existing owner facts. This leaf does not turn their states into page-security failures or expose controls owned by `FE-V1-032` to `FE-V1-035`.
- Failure mapping uses only typed coordinator/CSRF reason families and fixed local copy. Raw API detail, request path/body/header, native cause, target/session/device id, private origin, token/generation, and server diagnostics never enter the rendered DOM, live region, browser storage, logs, or artifacts.

### Focus Rail Surface

- Host & access remains one labelled Radix Focus Rail bottom sheet reached from the stable app bar. The existing summary and fact rail remain intact; one `Page security` rail row and one unframed recovery/status band extend it without a nested card, separate route, modal, toast stack, or desktop-only panel.
- `Page security` renders `Checking`, `Securing`, `Ready`, `Check required`, or `Unavailable` with text plus Lucide icon and Focus Rail tone. Ready copy says the protection is held for this page; it never renders a generation or token-like value.
- The single recovery command is context-specific: `Secure this page`, `Retry secure setup`, or `Check access`. It is a stable minimum-44 px button, disabled and visibly busy during work, absent when pairing/laptop action or another leaf owns recovery, and never adjacent to a destructive action.
- Status uses restrained `status`; failed explicit recovery uses `alert` once. Keyboard order, visible focus, sheet focus trap/restore, Escape/outside behavior, reduced motion, safe-area inset, long origin/copy wrapping, and one sheet scroll owner follow the existing selected component system.
- At 320, 360, 390, 412, 768, and 1280 widths, 390 x 420 short height, long content, and actual 200 percent reflow, the summary, page-security row, recovery command, sheet close, and underlying route controls remain reachable without horizontal overflow, clipping, overlap, or layout shift.

## Harsh Success Criteria

| ID | Requirement |
| --- | --- |
| `CRR-01` | One headless owner consumes only the exact coordinator snapshot, `refresh`, and `bootstrapCsrf` ports; malformed ports/context, closed owner, missing target, and late foreign results fail or suppress without direct HTTP, token, cookie, storage, timer, or diagnostic ownership. |
| `CRR-02` | A fragment-free clean reload begins with no page credential, loads access first, and performs exactly one automatic bootstrap only after current paired-writer access, matching host, and current target truth; read-only/denied/invalid/expired/revoked loads perform zero bootstrap requests. |
| `CRR-03` | Public snapshots and rendered state are deeply immutable, bounded, and contain no CSRF token/generation/time, cookie, bearer, operation/device/session id, request path/body/header, raw error/envelope/cause, private identity, or durable credential. |
| `CRR-04` | Initial checking, automatic bootstrapping, ready, idle-after-authority-change, failed bootstrap, stale retained authority, and closed state project distinct text, tone, actionability, and write-disabled truth without calling every state `Securing writes`. |
| `CRR-05` | A current paired writer with idle/failed CSRF performs one direct explicit bootstrap; one action creates at most one bootstrap and no access refresh when current access/host/target truth already permits it. |
| `CRR-06` | Stale-generation/authority-rejected state performs one exact-target refresh before at most one bootstrap; bootstrap occurs only after refreshed current paired-writer truth and never from stale retained data. |
| `CRR-07` | Target switch/removal, unrelated epoch supersession, permission downgrade, access loss, revoke/expiry, host mismatch, or close during refresh suppresses follow-up bootstrap and recovered publication for the old owner. |
| `CRR-08` | Click/touch/Enter duplication, rerender, sheet close/open, StrictMode replacement, concurrent action, and refresh/bootstrap settlement races retain one local owner and cannot create a second refresh, bootstrap, listener, or unbounded waiter. |
| `CRR-09` | Recovery sends no product mutation, does not replay the failed write, and has no automatic retry, polling, interval, backoff, reload loop, secondary client, service worker, URL/history state, or browser persistence. |
| `CRR-10` | Unpaired, invalid, expired, and revoked current authority removes protected session disclosure, disables all writes, exposes no CSRF recovery command, and gives only bounded laptop pairing recovery without fake logout. |
| `CRR-11` | Read-only, locked, host/runtime unavailable, incompatible, remote unavailable, and stream states remain independent; page-authority readiness never overrides their block causes or claims full control readiness. |
| `CRR-12` | Bootstrap rejection, transport/timeout/abort, response loss, malformed response, stale generation, API failure, and contract failure map to bounded known/unknown setup truth with old authority absent and another attempt only through explicit user action. |
| `CRR-13` | Refresh failure/offline retains only already-authorized stale projection with explicit stale/read-only truth; a fresh browser that cannot load the origin still receives no HostDeck-rendered diagnosis. |
| `CRR-14` | Success publishes only after same-target current CSRF `ready`; it says page security is ready/recovered and never claims unlock, runtime/stream/remote recovery, prior mutation outcome, login, logout, or session freshness beyond the proven coordinator snapshot. |
| `CRR-15` | Existing access, CSRF, coordinator, pairing startup, prompt/model/goal/plan/approval, route, and privacy contracts do not regress; raw credential material never enters React props, DOM ids/data attributes, live regions, diagnostics, screenshots, or test artifacts. |
| `CRR-16` | Production app-shell composition mounts one persistent recovery owner and renders one `Page security` rail row plus at most one context command in the existing Host & access sheet, with no separate route, nested card, duplicate sheet, or dead placeholder. |
| `CRR-17` | Region/fact/button/status/alert semantics, accessible names/descriptions, keyboard activation/order, visible focus, sheet focus trap/restore, Escape/outside dismissal, busy/disabled state, non-color meaning, and minimum 44 px targets pass. |
| `CRR-18` | 320/360/390/412/768/1280, 390 x 420, long origin/status copy, underlying Mission Control and Session Detail, and actual 200 percent reflow have no overlap, clipping, horizontal overflow, hidden action, or inaccessible close/control. |
| `CRR-19` | Deterministic production-shell screenshots cover initial bootstrap, ready, failed bootstrap, direct retry, stale-generation check, checking, securing, recovered, refresh failure/offline, read-only, locked, expired, revoked, target change, long content, short height, and responsive/reflow states with approved Focus Rail drift recorded. |
| `CRR-20` | Focused projection/controller/component/API/race/browser suites, adjacent pairing/coordinator/Host access/Mission Control/Session Detail/control regressions, full unit/contract/integration/static/build/package/planning/privacy checks, manual source/visual inspection, clean residue, and owner-doc evidence pass before closure. |

## Planned Evidence

- Headless controller tests own state projection, direct versus refresh-then-bootstrap planning, same-target correlation, duplicate ownership, target/epoch/authority races, failure mapping, close, and immutable privacy-safe output.
- Component tests own the Page security fact, context command, busy/result/live semantics, keyboard operation, persistent sheet owner, Focus Rail mapping, and adjacent Host access facts.
- Browser tests use the production shell and exact browser clients to prove fragment-free reload inventory, one automatic bootstrap, failed bootstrap, explicit retry, stale protected-write rejection, one refresh plus one bootstrap, revoke/expiry/read-only/lock/offline states, no product replay, and request/header/storage/DOM privacy.
- Deterministic captures and layout measurements own 320/360/390/412/768/1280, short-height, long-copy, Mission Control/Session Detail, and 200 percent reflow fidelity against `access-recovery-states.png` and the selected design system.
- Selected Fastify/bootstrap/coordinator integration, repository-wide validation, package/install/audit checks, source/privacy/no-retry review, residue inspection, and clean commit/push state close `CRR-01` to `CRR-20`.
