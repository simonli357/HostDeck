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

Pending criteria review and implementation.
