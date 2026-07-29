# FE-V1-018 Copy And Workflow Review

## Purpose

Close the aggregate mobile copy and workflow gate after selected-target fidelity. This task owns executable traceability from every canonical V1 journey, interaction, surface, and state to truthful user-facing language and a complete phone-first workflow. It may correct copy, presentation state, and workflow affordances, but it does not change runtime semantics, API authority, remote ingress, routes, the selected Focus Rail structure, or the V1 scope.

## Audited Baseline

- `DEC-028` selects the seven Focus Rail assets under `assets/ui-concepts/option-b/`; typed runtime state, accessibility, and final copy remain authoritative over illustrative raster text.
- The canonical mobile design contract contains 12 journeys, 39 interactions, 15 surfaces, and 141 state traces. `FE-V1-017` maps that complete contract to the selected visual target.
- Mission Control and Session Detail are the only full-page V1 routes. Supporting controls remain sheets or dialogs, and laptop/browser-preload boundaries remain visibly external to the phone app.
- HostDeck is a phone-first mission-control surface, not a terminal emulator, desktop console, editor, file tree, Git client, raw protocol inspector, or remote Tailscale administrator.
- Current focused leaves prove individual state and authority semantics. This aggregate task must detect contradictory vocabulary, incomplete transitions, unsafe retry implications, impossible recovery actions, and cross-surface workflow gaps that leaf-local tests can miss.
- Evidence created by completed tasks is immutable. This task writes fresh evidence only under `artifacts/fe-v1-018-copy-workflow-review/` and must preserve the 18 pre-existing user-owned screenshot modifications.

## Review Method

- Build one immutable executable ledger over the canonical mobile design contract. Every journey, interaction, surface, and state trace must be covered exactly once or explicitly classified as a browser-preload or local-laptop boundary.
- Inventory user-facing production copy through structured owners, not a broad source-text ban. Technical terms are permitted only where a bounded diagnostic or exact local handoff requires them; primary navigation, state labels, and actions must use the product vocabulary.
- Review each workflow as a state machine: entry evidence, available action, pending/accepted state, authoritative progress or terminal result, uncertainty behavior, recovery owner, and exit/navigation.
- Make only root-cause corrections that preserve approved structure and authority. New behavior, routes, permissions, automatic retry, profile mutation, or visual direction require a separate task or human decision.
- Capture task-owned screenshots from the current production shell for copy-heavy phone states and compare them manually with the approved Focus Rail hierarchy. Automated tests own exact coverage and semantics; manual review owns clarity, density, truncation, hierarchy, and actionable recovery.

## Frozen Success Criteria

| ID | Required behavior |
| --- | --- |
| `CWR-01` | Verify the selected `DEC-028` Focus Rail target, the two-route V1 information architecture, the 12 canonical journey ids, 39 interaction ids, 15 surface ids, and 141 state ids before review; reject missing, duplicate, extra, reordered, or unapproved design input. |
| `CWR-02` | One immutable executable ledger maps every canonical state and interaction exactly once to a workflow step, user-facing copy owner, evidence boundary, permitted action, authoritative result source, recovery owner, and applicable journey; all 12 journeys and 15 surfaces remain complete. |
| `CWR-03` | Every UX-001 to UX-012 workflow has an executable ordered path from entry through success plus its applicable unavailable, denied, stale, conflict, unknown-outcome, and recovery exits; no path depends on an undocumented route, blind command, hidden automatic action, or desktop-only control. |
| `CWR-04` | Primary navigation and labels use `session`; `thread` appears only where exact Codex/runtime identity, archive behavior, or laptop resume detail requires it. Runtime terminology never replaces the user's session identity or primary action language. |
| `CWR-05` | Session status uses the canonical labels `Needs approval`, `Needs input`, `Running`, `Quiet`, `Interrupted`, `Failed`, `Unknown`, and `Stale` consistently, with completed history represented truthfully and no disconnected, missing, retained, or unknown state described as healthy, ready, current, or quiet. |
| `CWR-06` | Accepted, running, and terminal outcomes remain distinct for prompts and Compact: an accepted response proves only admission, running requires matching runtime progress, and completed requires matching terminal runtime evidence. Failed, interrupted, conflict, and unknown outcomes cannot collapse into completion or invite an unsafe resend. |
| `CWR-07` | Model and Plan copy distinguishes current runtime state, pending next-turn selection, turn acceptance, and runtime confirmation. Goal copy distinguishes passive paused edits, agentic resume/active work, and pause from interruption; no control claims immediate state change before authoritative evidence. |
| `CWR-08` | Every mutating action exposes exact pending/disabled/result truth, suppresses duplicate activation, retains immutable target identity, and states whether another attempt is safe. Unknown post-dispatch outcomes require observation before another mutation and never become a retry button by inference. |
| `CWR-09` | Every user-facing failure or unavailable state says what failed at the product level, whether retry or refresh is safe, and whether the next action belongs on this phone, in the browser/network, or on the local laptop. Copy must not invent a cause that the current evidence cannot prove. |
| `CWR-10` | Browser-preload failures remain generic browser/Tailscale reachability outcomes with zero HostDeck application diagnosis or protected data. Once admitted, app recovery copy is limited to observed access, host, runtime, stream, and remote-status evidence. |
| `CWR-11` | Pairing copy preserves the local-CLI-created one-time link, automatic fragment scrubbing and claim, explicit device permission, bounded expiry/revocation outcomes, and reload continuity. It never asks the phone to create a code, expose a fragment, trust a custom CA, or repeat a successful claim. |
| `CWR-12` | Remote-access copy distinguishes HostDeck profile active, another saved profile active, Tailscale stopped/signed out/absent, Serve missing/drifted/conflicted, and generic unreachable origin only when that fact is observable. Profile switching, Serve repair, remote enable/disable, and unlock remain clearly local-laptop actions with no company identity disclosure. |
| `CWR-13` | Access, CSRF, permission, lock, expiry, and revocation copy remain independent. Authority loss synchronously removes protected content and write affordances; read-only never implies locked, locked never implies revoked, and recovery never claims automatic unlock, re-pair, or credential repair. |
| `CWR-14` | Mission Control preserves one-handed scan order and bounded row copy: attention before running/quiet work, exact session/project cue, one meaningful summary, current/stale activity truth, and whole-row navigation without crowded quick actions or desktop-table language. |
| `CWR-15` | Session Detail preserves structured conversation/event hierarchy, exact status/project context, inline approval and boundary truth, sticky composer, and `/model`, `/goal`, `/plan` as the primary dock. It never presents a shell, raw command prompt, editor, or generic remote-control surface. |
| `CWR-16` | `/model`, `/goal`, `/plan`, `/usage`, `/compact`, and `/skills` retain literal slash labels while invoking structured typed operations. Each sheet names current versus pending state, exact target, unsupported/update-required state, conflict, bounded failure, and safe dismissal without implying literal slash dispatch. |
| `CWR-17` | Approval copy shows the exact requested action, affected scope or working directory, reason, one-time versus ongoing-policy truth, immutable request target, and distinct deny/approve outcomes. Elevated or broad approval requires a consequence-specific confirmation, and expiry/supersession becomes read-only. |
| `CWR-18` | Interrupt, archive, laptop resume, device revoke, and host lock each name the exact target and consequence. Interrupt does not claim deletion; archive does not claim file or conversation deletion; laptop resume only copies an exact local command; revoke and lock state their authority consequences; unlock remains local only. |
| `CWR-19` | Loading, empty, not found/archived, stale, reconnecting, replay boundary, incompatible, degraded, runtime-offline, rate-limited, interrupted, failed, fatal, and recovered-prior-failure states remain semantically distinct across both routes and supporting surfaces. Retained data exposes bounded last-confirmed or unavailable-time truth. |
| `CWR-20` | No user workflow or primary copy drifts into a desktop console, terminal emulator, arbitrary shell, editor, file tree, Git review, storage console, raw JSON/protocol viewer, Tailscale profile switcher, or direct Codex app-server client. Bounded projected stdout/stderr and exact local resume commands are allowed only in their approved read-only diagnostic/handoff surfaces. |
| `CWR-21` | User-facing copy contains no pairing fragment, CSRF value, cookie, credential, raw device/profile identity, private origin, tailnet, company account, node key, unbounded path/prompt/output, raw server envelope, or fabricated fallback. Diagnostic details remain allowlisted, redacted, truncated, and explicitly limited. |
| `CWR-22` | Required copy fits without clipping, overlap, hidden actions, horizontal scrolling, or unstable controls at 320 reflow, 360/390/412 phone widths, short height, keyboard-open, 200 percent zoom, 768 tablet, and 1280 retained-list/detail states. Status is not color-only; semantics, focus, live-region restraint, target size, and reduced motion remain at the completed accessibility bar. |
| `CWR-23` | Focused contract tests prove exact ledger coverage, vocabulary/outcome/recovery rules, forbidden-surface exceptions, and workflow reachability. Production component tests and task-owned Chromium evidence cover representative pairing, Mission Control, prompt lifecycle, controls, approval, dangerous action, stale/boundary, and remote-recovery states with zero unexpected diagnostics or request drift. |
| `CWR-24` | Closure records the issue/fix inventory, manual copy/workflow disposition, exact validation commands/counts, current-build screenshots, privacy and residue checks, criteria/implementation/evidence commits, remaining physical-phone scope, and push state. Full selected static, unit, contract, integration, web, browser/package, planning, and artifact-preservation gates pass without claiming `FE-V1-090` real-device completion. |

## Required Evidence

- Executable copy/workflow ledger and tests proving exact 12-journey, 39-interaction, 15-surface, and 141-state coverage plus ordered journey reachability.
- Structured copy inventory tests for canonical state vocabulary, accepted/running/terminal semantics, recovery owner and safe-attempt guidance, bounded technical-term exceptions, and prohibited product-surface drift.
- Focused production state/component tests for every corrected copy or workflow projection, including hostile, stale, denied, conflict, post-dispatch-unknown, and repeated-use boundaries where applicable.
- Task-owned 390 x 844 phone captures for representative entry, active, pending, terminal, failure, and recovery states, plus selected 320/short-height/200-percent stress evidence for the longest corrected copy.
- Manual full-resolution review against Focus Rail hierarchy, with each issue recorded as already conforming, corrected, contract-authorized technical detail, deferred to `FE-V1-090`, or blocked on a human decision. No unresolved V1 copy/workflow ambiguity may remain.
- Full selected repository validation, privacy/request/diff/residue checks, and a clean staged scope that excludes all 18 pre-existing user-owned screenshot changes.

## Implementation Record

Complete. `CWR-01` to `CWR-24` pass without changing routes, runtime semantics,
permissions, remote-ingress ownership, or the selected Focus Rail structure.

## Executable Coverage

| Contract input | Exact coverage | Executable owner |
| --- | ---: | --- |
| Canonical journeys | 12 | `mobileWorkflowPaths` covers every `UX-001` to `UX-012` journey with ordered success and recovery states. |
| Canonical interactions | 39 | `copyWorkflowInteractionCoverageLedger` assigns copy, result, attempt, retry, recovery, target, and technical-language policy exactly once. |
| Canonical surfaces | 15 | State-ledger surface coverage equals the immutable mobile design contract. |
| Canonical states | 141 | `copyWorkflowStateCoverageLedger` preserves source order and classifies every state exactly once. |
| Production copy owners | 40 | `mobile-copy-contract.test.ts` scans visible string/template/JSX literals with explicit bounded exceptions. |

The ledger distinguishes `accepted`, `running`, terminal success, terminal
interruption, terminal failure, conflict, and unknown outcomes. All 39 interactions
disable automatic retry. Mutations use no-resend-until-observed or explicit
local-laptop ownership; browser-preload failures remain owned by the browser or
Tailscale.

## Issue And Fix Inventory

| ID | Finding | Resolution and proof |
| --- | --- | --- |
| `CWR-I01` | User-facing state and control copy leaked implementation terms such as authority, projection, terminal proof, process-live, reconciliation, and structured-operation labels. | Replaced the jargon at its production copy owners and synchronized exact component/browser expectations. The literal-aware source guard rejects recurrence across 40 owners. |
| `CWR-I02` | Cross-module vocabulary was locally correct but lacked one executable aggregate owner for all states, interactions, journeys, outcomes, recovery owners, and attempt policies. | Added the immutable copy/workflow matrix and seven exact contract tests over 12 journeys, 39 interactions, 15 surfaces, and 141 states. |
| `CWR-I03` | Technical language had no aggregate exception policy, risking either desktop-console drift or removal of required exact handoff/diagnostic detail. | Limited `thread` and terminal language to exact archive/runtime, local laptop handoff, and bounded event-diagnostic owners. Forbidden product surfaces are frozen and tested. |
| `CWR-I04` | Pairing, browser-preload failure, app recovery, and local-laptop recovery needed one explicit ownership boundary. | Ledger policies separate browser/Tailscale, HostDeck observation, and local-laptop actions. Current pairing evidence contains no custom-CA, certificate, fragment, or repeated-successful-claim instruction. |
| `CWR-I05` | After approval success, the approval row could say `Approved once` while a lagging turn snapshot told the user to resolve a supposedly pending approval. | Composer copy now says the turn still reports waiting for approval and directs a refresh before sending. Unit, browser, and approval-workflow evidence prove the non-contradictory lag state. |
| `CWR-I06` | Exact browser assertions still encoded pre-review wording after production copy changed. | Updated the selected browser specifications and verified the complete 175-case shell suite, not only focused replacements. |
| `CWR-I07` | Initial task evidence asserted a replay boundary and remote recovery in the DOM without reliably framing them in the screenshot after timeline auto-pin or sheet scrolling. | Evidence code now centers the boundary and fully contains the remote recovery section at 390, 320, short-height, and 200 percent zoom bounds. |
| `CWR-I08` | The selected-runtime checker had not authorized the new exact fixture export or selected web tests. | Updated the fail-closed root-module and `test:web` allowlists; the 619-module/22-external boundary passes. |
| `CWR-I09` | The supported-browser manifest correctly rejected the changed production web/package identity. | Repinned only the four verified package hashes, reran all 76 cases, and atomically refreshed four sanitized reports plus the aggregate manifest. |

## Manual Review

All 18 current-build PNGs under
`artifacts/fe-v1-018-copy-workflow-review/` were inspected at original resolution.
The two JSON records contain exact viewport, document, dialog, primary-control, and
pairing-rail geometry for 15 app frames and three pairing frames.

| Review group | Frames | Disposition |
| --- | ---: | --- |
| Pairing claim, success, and uncertain outcome | 3 | Conforming: phone-first progress, explicit result/recovery, no fragment or certificate instruction, and no repeated QR requirement. |
| Mission Control entry | 1 | Conforming: attention-first scan order, exact project/session cues, and whole-row navigation remain primary. |
| Prompt ready, pending, and completed | 3 | Conforming after copy correction: immutable target, one pending attempt, and event-confirmed completion remain distinct. |
| Approval confirmation, pending, and confirmed | 3 | Corrected: exact consequence and one-time grant are clear; the confirmed/composer lag contradiction is removed. |
| Interrupt confirmation | 1 | Conforming: exact turn target and non-delete consequence are visible before dispatch. |
| Replay boundary and stale retained state | 2 | Corrected evidence framing: missing history, last-confirmed truth, and unavailable writes are visible at phone bounds. |
| Remote profile recovery | 5 | Conforming: observed laptop state, local-laptop ownership, action, and page-security boundary fit at 390, 320, short height, and 200 percent zoom. |

No frame has horizontal overflow, incoherent overlap, clipped required action,
desktop-table/editor/terminal drift, color-only status, or unresolved V1 copy
ambiguity. Literal `/model`, `/goal`, `/plan`, bounded Codex/Tailscale names, exact
event detail, and the local terminal handoff are contract-authorized technical
detail. No human decision remains open.

## Criteria Disposition

| Criterion | Disposition |
| --- | --- |
| `CWR-01` | Exact selected target and 12/39/15/141 source identities are asserted without reorder or extras. |
| `CWR-02` | The immutable state and interaction ledgers assign every required policy exactly once. |
| `CWR-03` | Twelve ordered workflow paths cover success and applicable recovery exits. |
| `CWR-04` | Literal-aware production scanning limits `thread` to approved runtime/handoff owners. |
| `CWR-05` | The eight canonical session labels are frozen; aggregate failure-state regressions pass. |
| `CWR-06` | Prompt and Compact accepted/running/terminal/failed/interrupted/unknown semantics remain distinct. |
| `CWR-07` | Existing exact Model, Goal, and Plan state/component/browser suites pass with corrected product copy. |
| `CWR-08` | Every interaction has explicit pending/result/attempt policy and no automatic retry. |
| `CWR-09` | Recovery owner and safe-attempt policy are explicit for every state and interaction. |
| `CWR-10` | Browser-preload states remain generic and external; app evidence starts only after admission. |
| `CWR-11` | Three pairing outcomes prove fragment-safe, certificate-free claim and reload language. |
| `CWR-12` | Remote taxonomy regressions and five current recovery frames preserve local-laptop ownership. |
| `CWR-13` | Full access, CSRF, permission, lock, expiry, and revoke browser groups pass independently. |
| `CWR-14` | Mission entry evidence preserves the phone-first attention hierarchy. |
| `CWR-15` | Session evidence preserves structured activity, approvals, boundary, composer, and primary dock. |
| `CWR-16` | Slash labels remain literal while all operations stay typed and structured. |
| `CWR-17` | Approval evidence covers consequence, target, one-time grant, pending lock, and terminal result. |
| `CWR-18` | Interrupt evidence plus archive/resume/revoke/lock aggregate cases preserve exact targets and consequences. |
| `CWR-19` | The complete state ledger and shell suite retain distinct unavailable, stale, failure, boundary, and recovered truth. |
| `CWR-20` | Source guards and manual review find no unselected product surface. |
| `CWR-21` | Source/rendered/evidence privacy guards find no secret, private identity, origin, path, or fabricated fallback. |
| `CWR-22` | Geometry records, full responsive shell, pairing, native zoom, axe, and Orca gates pass. |
| `CWR-23` | Contract tests, production tests, 18 task frames, 175 shell cases, and 12 pairing cases pass with zero unexpected diagnostics. |
| `CWR-24` | This record contains fixes, manual disposition, exact gates, package/browser identity, residue, commits, push state, and physical-device deferral. |

## Validation

| Gate | Result |
| --- | --- |
| Focused copy/workflow contracts | 20 prompt/copy tests and seven workflow-matrix tests pass; focused browser-manifest/evidence/preflight/ledger tests pass 11. |
| Static planning/runtime | Scaffold 8 packages/22 scripts; planning 220 tasks/84 requirements/683 dependencies; typecheck; lint 816 files and 8 package exports; runtime boundary 619 sources/22 externals. |
| Unit/contracts/integration/web | Unit 2,892 passed/28 intentional skips; contract 245; integration 36; selected web 932. |
| Production browser | Clean committed worktree: shell Chromium 175; pairing Chromium 12; native 200 percent zoom 1; Orca 46.1 reading/focus 1; relocated packaged Chromium 1. |
| Package | Two deterministic builds pass at 619 sources, 1,245 owned outputs, 6,466 entries, and 3 web files/1,210,747 bytes. Package SHA-256 is `325f0a9fe1cfe36ffdd5255077d514cf39b922e1eaa905e5187a99386bd2ae82`; web SHA-256 is `5e96b3c87b6e5c942426bbd0748c1f7b36325a4c597199545871a08a55024ae5`. |
| Supported engines | `pnpm test:e2e` passes 76/76 in 3.0 minutes across exact Chromium 149.0.7827.55 and Firefox 151.0 phone/desktop projects; reports contain 316 requests and 52 mutations. |
| Evidence/privacy/residue | 18 PNG/2 JSON task files pass rendered-copy and geometry guards; secret/identity/origin/path scan is empty; validation ports 4175 to 4179 and browser/server processes are closed. |
| Protected user work | All 18 pre-existing modified PNGs remain unstaged and byte-identical to the pre-task snapshot. |

The existing Vite large-chunk advisory and non-failing Orca host portal/inotify
warnings remain unchanged. Neither affects this copy/workflow result.

## Remaining Scope

`FE-V1-090` still owns aggregate physical Android evidence, including actual phone
geometry/keyboard behavior, TalkBack, live private Serve HTTPS, fragment pairing,
reload, prompt, approval, lock, disconnect/profile-switch recovery, and final visual
drift. This task does not claim that physical-device release gate.

## Commit Record

- Criteria: `852c91c`.
- Executable ledger: `89353ed`.
- Production copy and source guard: `9bccc18`.
- Browser contract alignment: `1072a8f`.
- Approval lag correction: `f8b46ab`.
- Task-owned visual evidence: `daac7ad`.
- Selected-runtime boundary correction: `3034907`.
- Supported-package repin: `b2acc63`.
- Supported-browser evidence refresh: `936de0c`.
- Push state: all commits above are on `origin/main`.
