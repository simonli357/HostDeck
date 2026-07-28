# FE-V1-038 Exact Laptop TUI Resume Handoff

Date: 2026-07-27

Status: complete. `LTR-01` through `LTR-24` pass.

## Scope

Implement the selected Focus Rail mobile handoff for reading one exact current managed session's laptop-local Codex TUI resume metadata, showing the canonical command, and copying that command only after explicit human action. The phone remains a read-only handoff surface: it does not launch Codex, execute shell input, attach a terminal, import a thread, or mutate laptop/runtime state.

Excluded: Mission Control row actions, remote command execution, phone shell/terminal input, terminal emulation or preview, arbitrary command/thread/socket entry, command editing, process status or launch confirmation, remote clipboard sync, QR/share/deep-link handoff, automatic copy/read retry, browser persistence, history/URL command transport, operation ids, audit/CSRF/write/lock gates, active-turn interruption, archive/delete, arbitrary thread import, compatibility UI, aggregate dashboard hardening, physical-phone release acceptance, and store packaging.

## Pre-Change Findings

- `IFC-V1-060` owns strict `GET /api/v1/sessions/:session_id/resume`. It authenticates before params/service access, accepts no query or body, disables implicit `HEAD`, sets `no-store`, and has no process, shell, runtime-mutation, write-gate, CSRF, lock, or audit port.
- The exact response is `selectedResumeMetadataResponseSchema`: one requested HostDeck session id, `local_only: true`, and either a canonical display command plus exact structured launch descriptor or one bounded unavailable reason. The contract rejects command/descriptor disagreement, wrong verbs/options, non-Unix remotes, control characters, oversize values, and extra fields.
- The server consistency-brackets selected mapping/projection/runtime state. Availability requires an active current nonarchived selected mapping, exact runtime-version agreement, allowed supported/degraded policy, and `thread_lifecycle` plus `multi_client`; missing, archived, recovery-required, stale, incompatible, disconnected, drifted, malformed, or unstable state cannot yield a command.
- The returned command contains the exact private Unix socket and Codex thread identity by design. The browser may render and copy that one canonical string inside the explicit resume sheet, but must not separately expose, log, store, route, query, diagnose, or reconstruct its launch fields.
- The typed browser route contract already includes `session_resume_metadata`, but the coordinator's exact selected-session read allowlist does not. FE-V1-038 must add that GET route to the same current target/authority/epoch boundary used by other selected-session reads.
- Session Detail now owns one shared Session actions sheet. Its menu order is Interrupt, Archive, Host/access; the approved screen contract adds laptop resume to this overflow. The selected Focus Rail detail asset, shared sheet, and established action rows are the implementation target, so no new visual direction or nested sheet is needed.

## Frozen Design

### Exact Read And Correlation

- Add one strict headless laptop-resume owner for one immutable HostDeck session id. Its ports are exactly one resume-metadata read and one browser-local clipboard write; it has no HTTP implementation, shell/process/runtime, terminal, storage, timer, share, mutation, or retry scheduler dependency.
- The menu action is visible only with a matching selected Session Detail and readable access. It is enabled only for the exact active, current, nonarchived detail under current selected-session read authority; turn state, write permission, CSRF, host lock, and stream continuity do not gate this read-only handoff.
- Each open performs one explicit `session_resume_metadata` GET for the immutable path session id. Each human `Check again` performs at most one additional GET. Concurrent open/refresh calls coalesce or disable; no mount, render, reconnect, elapsed time, failure, or clipboard action automatically repeats a read.
- A read snapshots the exact session id, name, Codex thread id, runtime source/version, creation identity, selected-target epoch, and read-authority identity. Route, target, authority, immutable identity, or epoch drift before settlement suppresses installation and cannot retarget a replacement session.
- Installation strictly parses `selectedResumeMetadataResponseSchema`, requires exact response session id and `local_only: true`, and, when available, requires the structured launch descriptor's thread id to equal the current selected detail's Codex thread id. The contract-owned command/launch equality remains mandatory.
- The controller projects only target label, canonical command, available/unavailable state, and bounded copy/read status. It does not retain or expose the launch object, executable, argv, socket, or thread id as separate public view fields.

### Freshness, Failure, And Lifetime

- One current available response yields a current copyable command. One exact unavailable response yields its bounded reason with no command or copy affordance. Neither response implies that a laptop process started, connected, resumed, remained active, or completed work.
- A same-target capture becomes visibly stale and non-copyable when its epoch or read eligibility is no longer current. A target or read-authority replacement aborts the read, purges the capture, closes resume state, and never leaves a foreign command available.
- `session_not_found` and `stale_session` remain distinct selected-session failures; runtime unavailable/unstable, storage/protocol/contract, timeout/transport, rate/capacity, authorization, abort, and unexpected failures use bounded non-secret copy and expose no fabricated diagnosis or retained launch fields.
- Explicit refresh is allowed only while the same current target/read authority remains eligible and no read is active. Prior current metadata becomes stale during refresh and is never copied until a newly correlated response succeeds.
- Dismiss/close aborts an active GET, invalidates active read/copy settlements, clears command/copy state, removes listeners once, and publishes no late state. It does not claim a clipboard write was cancelled after invocation.

### Clipboard-Only Handoff

- `Copy command` is enabled only for one current available capture. It passes the exact canonical command unchanged to one injected clipboard-write port and sends no API, shell, navigation, share, or process request.
- Opening the sheet, loading metadata, focusing/selecting command text, rerendering, keyboard navigation, and read failure copy nothing. Duplicate activation while copy is pending invokes the clipboard port once.
- Clipboard success is reported only after the exact write promise resolves while target/capture authority is still current. Success copy states plainly that nothing ran from the phone and the command must be used on the HostDeck laptop.
- Clipboard unavailable/denied/throw/rejection is visibly `Copy failed`; the selectable command remains current and an explicit human retry may invoke one new clipboard write. There is no legacy `execCommand`, hidden textarea, download, Web Share, URL, storage, or automatic fallback.
- The production adapter uses only the browser Clipboard API with its correct receiver and fails loudly into the bounded UI state when unavailable. Tests inject a clipboard port and never read or overwrite the user's real clipboard.

### Mobile Session Surface

- The exact Session actions menu order becomes `Interrupt active turn`, `Archive session`, `Resume on laptop`, then `Host & access`. Resume follows the two session mutations but remains visually neutral/read-only and does not inherit danger styling.
- Resume remains available during an active turn, paired read-only access, and host lock when current read authority and session identity permit it. Stale, archived, incompatible, missing, foreign, or unreadable detail disables with exact bounded reason before any GET.
- Selecting Resume transitions the existing labelled modal sheet to one laptop-resume page with Back/Close, exact session label, a non-color local-only boundary, readable selectable wrapped command, read/copy status, and one fixed-footer copy/check action. It does not nest a dialog or render terminal chrome/input.
- Copy, loading, available, copied, copy-failed, unavailable, not-found, stale-session, runtime/offline, protocol, stale-capture, read-only, locked, active-turn, long-command, and authority-loss states remain semantically and visually distinct.
- Use the selected Focus Rail dark canvas, flat rails/dividers, fixed type scale, six-pixel maximum radius, safe-area spacing, 44 px targets, visible focus, reduced motion, and restrained Lucide laptop/copy/refresh/status icons. Preserve Mission Control, detail timeline, composer, `/model`, `/goal`, `/plan`, utilities, Interrupt, Archive, and Host/access behavior.

## Harsh Success Criteria

| ID | Requirement |
| --- | --- |
| `LTR-01` | One strict deeply frozen headless owner validates exact options/context/read/clipboard ports, subscriptions, update/open/refresh/copy/dismiss/close, and malformed/accessor/foreign inputs without React, direct HTTP, shell/process/runtime, terminal, storage, timer, share, mutation, or retry-scheduler dependencies. |
| `LTR-02` | Exact availability requires one matching active/current/nonarchived selected detail and current readable target/access authority; turn activity, read-only permission, host lock, CSRF, write eligibility, and stream continuity do not incorrectly block the read-only handoff. |
| `LTR-03` | Missing/foreign/archived/stale/incompatible detail, route/epoch drift, unreadable/rejected authority, and non-current target disable with deterministic bounded copy before a request; no command, operation id, or clipboard write is created. |
| `LTR-04` | The browser selected-session read boundary explicitly admits only the exact GET `session_resume_metadata` contract in addition to its prior routes and still rejects wrong route, target, params, query/body, authority, or post-response epoch. |
| `LTR-05` | Open and each explicit eligible refresh issue exactly one receiver-safe read for immutable `{params:{session_id}}` plus abort signal; duplicate/concurrent/mount/render/reconnect/failure/copy paths do not prefetch, poll, or automatically retry. |
| `LTR-06` | Every read freezes session/name/thread/runtime/creation/epoch/read-authority identity; any replacement or authority transition before settlement aborts or suppresses installation without retargeting or stale publication. |
| `LTR-07` | Installation strictly parses the exact wire schema and correlates response session id, local-only marker, and available launch thread id to the selected detail; malformed, extra, cross-session, wrong-thread, command/launch-mismatch, or contradictory responses fail closed. |
| `LTR-08` | The public view retains only target label, canonical command, available/unavailable truth, and bounded status; launch/executable/argv/socket/thread fields are never separately rendered, logged, stored, routed, queried, or exposed from the owner. |
| `LTR-09` | Available metadata means only one current command can be copied; unavailable metadata shows the exact bounded reason and no command/copy action. Neither state claims process launch, TUI attachment, remote execution, resumed work, or completion. |
| `LTR-10` | Same-target epoch/read-eligibility drift marks retained metadata stale and non-copyable; target/read-authority replacement purges capture and closes resume state. Refresh cannot copy the previous capture while awaiting new exact proof. |
| `LTR-11` | Not-found, stale-session, authorization, runtime/unstable, storage/protocol/contract, timeout/transport/capacity/rate, abort, and unexpected failures map to bounded non-secret states without inferring from arbitrary status/message/retryable text or manufacturing recovery. |
| `LTR-12` | Dismiss/close aborts active reads, invalidates late read/copy settlements, clears command and copy state, and removes listeners exactly once without claiming an invoked clipboard write was cancelled. |
| `LTR-13` | Copy is possible only from one current available capture and writes the exact canonical command unchanged to one injected browser-local clipboard port; no API, shell, process, runtime, URL, share, download, navigation, or storage side effect occurs. |
| `LTR-14` | No open/load/focus/select/rerender/key navigation path copies automatically; duplicate activation while pending writes once, and stale/foreign/closed settlement cannot publish copied success. |
| `LTR-15` | Clipboard success appears only after exact promise resolution and states that nothing ran on the phone; unavailable/denied/throw/rejection is visible, keeps current selectable text, and allows only explicit human retry with no `execCommand`, hidden-textarea, share, or automatic fallback. |
| `LTR-16` | Session Detail retains one top-right shared sheet whose exact order is Interrupt, Archive, Resume, Host/access; Resume is a neutral laptop/read affordance and Mission Control/routine dock/composer gain no second icon or duplicate action. |
| `LTR-17` | Active-turn, paired read-only, and host-locked current sessions can read/copy resume metadata; archive/interrupt eligibility remains independent and no resume path interrupts, archives, unlocks, writes, or changes runtime state. |
| `LTR-18` | One labelled modal sheet owns menu/resume/loading/content/failure/Host/access/mutation transitions, focus trap/order/restore, keyboard activation, Escape/outside behavior, live status, selectable code, visible focus, reduced motion, and 44 px targets without nesting a terminal/dialog. |
| `LTR-19` | Local-only boundary, exact session, command freshness, loading, available, copied, copy-failed, unavailable, not-found, stale-session, runtime/offline, malformed/mismatch, stale-capture, disabled, and authority-loss states are non-color-distinct and expose no unsafe control. |
| `LTR-20` | Focus Rail tokens, flat dividers, one body scroll owner, fixed footer, safe areas, and six-pixel radii match approved assets at 320/360/390/412/768/1280, short height, maximum contract-valid private Unix remote and 240-character unavailable reason, and actual 200 percent reflow without overlap, clipping, horizontal overflow, hidden command/action, or composer obstruction. |
| `LTR-21` | Headless tests cover strict construction/context, every admission/identity/authority transition, exact read timing/correlation, available/unavailable and every failure class, stale/purge/refresh, exact clipboard writes/failures/duplicate suppression, immutability, close/late settlement, and no private side effects. |
| `LTR-22` | Component/coordinator/API tests prove exact allowlist/GET shape/count, four-row order, active/read-only/lock independence, local-only copy, all states, focus transitions, selectable command, Host/access and mutation continuity, no nested dialog/terminal, and production app-shell composition. |
| `LTR-23` | Deterministic Chromium captures/layout records cover menu, loading, available, copied, copy failure, unavailable, not-found/stale/runtime/transport/malformed/mismatch, disabled states, long/narrow/short/tablet/desktop/zoom plus request/clipboard/DOM/history/storage/privacy and no-automatic-retry inspection. |
| `LTR-24` | Focused and aggregate web/browser suites plus full unit/contract/integration/type/lint/scaffold/planning/runtime-boundary/build/package/install/audit/privacy/diff/residue checks, owner-doc evidence, clean commits, and pushes pass before closure. |

## Planned Evidence

- Headless tests own exact target/read authority, one-read lifecycle, strict wire and thread correlation, current/stale capture truth, explicit refresh, private launch-field projection, exact clipboard write, copy failure/retry, duplicate suppression, immutability, and close/late settlement.
- Coordinator/component tests own the selected read allowlist, exact GET, four-row Session actions order, independent mutation/resume eligibility, local-only copy, all status/action states, focus/modal ownership, Host/access continuity, and production Session Detail composition.
- Production-shell Chromium owns real typed GET shape/count/cache/cookie behavior, available/unavailable/error responses, no auto retry, clipboard-only side effects, read-only/locked/active states, authority changes, responsive containment, 200 percent reflow, and DOM/storage/history/request/privacy inspection.
- Deterministic screenshots and layout JSON own approved Focus Rail fidelity across menu, loading, command/copy states, unavailable/failure/disabled states, maximum command/reason, narrow, short-height, tablet, desktop, and zoom.
- Repository validation owns adjacent Interrupt/Archive/Host-access/prompt/primary/utility regressions, selected route/runtime boundaries, package/build/install/supply-chain truth, diff/privacy review, residue cleanup, and pushed history.

## Reuse And Ownership

Reuse `selectedResumeMetadataResponseSchema`, `selectedLaptopResumeSchema`, the typed `session_resume_metadata` route, coordinator selected-session read authority, selected Session Detail projection, `IFC-V1-060` server consistency and command formatting, the shared Session actions sheet, existing Host/access content, Radix Dialog, Lucide icons, Focus Rail sheet primitives, production browser fixture, and approved `mobile-session-detail-active.png`, `responsive-continuum.png`, and Option B design system. Add no production dependency or generated asset.

`FE-V1-038` owns browser resume-metadata read/capture/copy state, exact response-to-selected-detail correlation, the local-only Session actions presentation, clipboard adapter, accessibility, and responsive visual evidence. `IFC-V1-060` retains API/service/command/CLI/process-launch truth; `FE-V1-012` retains detail/feed/SSE; `FE-V1-036` and `FE-V1-037` retain Interrupt/Archive and the shared menu foundation; `FE-V1-033` retains lock; `FE-V1-035` retains compatibility UI; `FE-V1-015`, `FE-V1-016`, `FE-V1-039`, and release leaves retain aggregate hardening, physical-phone acceptance, packaging, and go/no-go.

## Completion Evidence

### Implemented Behavior

- One strict deeply frozen selected-session owner derives immutable target and read-authority identity, issues only the exact resume-metadata GET, strictly correlates the response session and thread, and retains no separate executable, argv, socket, or thread projection.
- Opening and each explicit `Check again` perform at most one coalesced read. Same-target epoch drift makes retained metadata stale and non-copyable; target or authority replacement aborts, purges, and closes without retargeting or late publication.
- `Copy command` writes the exact current canonical command through the browser Clipboard API only. Pending duplication is suppressed; denial remains visible and permits only an explicit retry; dismiss and close suppress late read/copy settlement without claiming cancellation.
- The existing Session actions sheet now presents Interrupt, Archive, Resume, and Host/access in that order. Resume remains a neutral read-only handoff during active turns, paired read-only access, and host lock, while stale, archived, incompatible, missing, and unreadable detail fail closed before a request.
- The laptop page states plainly that phone execution is unavailable, keeps the command selectable and wrapped, and adds no terminal, shell input, process action, mutation, CSRF/write/lock dependency, storage, URL transport, share path, or automatic retry.

### Automated Validation

| Gate | Result |
| --- | --- |
| Focused laptop-resume state/component | 2 files and 46 tests pass, including 36 direct headless cases and 10 component/integration cases. |
| Aggregate web | 44 files and 814 tests pass. |
| Aggregate unit | 237 files pass, 27 files skip explicitly; 2,691 tests pass and 28 skip explicitly. |
| Contract and integration | 34 contract files/245 tests and 21 integration files/36 tests pass. |
| Chromium | All 8 dedicated laptop-resume scenarios and the complete 131-scenario production shell pass. |
| Static and boundary | Scaffold, planning, TypeScript, Biome lint/package exports, diff check, and the 614-module selected-runtime boundary pass. The default Codex 0.145.0 correctly rejects the reviewed binding gate; the isolated exact 0.144.0 binary verifies all 671 reviewed files at `e1a1a5cff3ab91862f9215dd06538eae1ea0b00bae48cbb7d87061faaee27e24`. |
| Build and package | Production build, six structural package tests, deterministic and relocated package acceptance, and independent package verification pass. The verified 6,449-entry package hash remains `35f41f5daccab92d6ded30bf1de374d5451e1ce81282e1136a2452f7810a3ace`. |
| Supply chain | Frozen offline install succeeds, production audit reports no known vulnerabilities, and 172 production package records across 175 paths use the existing permissive license set. |

### Visual, Accessibility, And Privacy Inspection

- `artifacts/fe-v1-038-laptop-tui-resume/` contains 32 inspected screenshots and 10 layout records covering menu, loading, available/copied/copy-failed, all selected failure families, mutation-gate independence, stale admission, maximum remote/reason content, 320/360/390/412/768/1280 widths, 320 x 480 and 390 x 420 short heights, and actual 200 percent reflow.
- Layout records show no document or sheet horizontal overflow, one bounded body scroller, fixed-footer containment, four-pixel command radius, and no target below 44 px. Short-height and zoom scrolled captures prove the command/reason and terminal action remain reachable.
- Keyboard/focus, one-dialog ownership, exact request and clipboard counts, no automatic retry, Host/access and mutation continuity, DOM/history/storage/request privacy, reduced motion, and selectable text assertions pass. Manual source and screenshot review found no second action surface, terminal chrome, clipping, overlap, unsafe fallback, or real credential/user-secret disclosure.
- The surface uses the approved Focus Rail canvas, flat rails, semantic status colors plus icons/copy, compact type scale, safe areas, and shared sheet primitives without changing Mission Control, the timeline, composer, `/model`, `/goal`, `/plan`, or utility dock.

### Remaining Scope

- Cross-screen state hardening, physical-phone aggregate acceptance, final responsive/accessibility matrices, package/service release acceptance, and go/no-go remain owned by `FE-V1-015`, `FE-V1-039`, `FE-V1-016`, and release leaves. This leaf does not claim V1 release readiness.
- Compatibility and update-required presentation remains `FE-V1-035`; no terminal/update-command fallback was added here.
- Vite retains its existing large-chunk advisory. This leaf adds no production dependency or setup/command change; aggregate performance disposition remains downstream hardening work.
