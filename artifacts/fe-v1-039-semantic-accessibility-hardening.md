# FE-V1-039 Semantic Accessibility Hardening

Date: 2026-07-27

Status: complete.

## Scope

Harden the complete implemented HostDeck dashboard and pairing entry as one keyboard- and assistive-technology-usable product. Prove Mission Control, Session Detail, the retained desktop navigation context, composer and primary controls, every supporting sheet, inline approvals, confirmations, Host & access, device/lock/recovery controls, diagnostics, pairing, and route errors against the active accessibility contract.

This leaf owns semantic HTML and ARIA relationships, heading/landmark/list correctness, accessible names/descriptions/state, complete keyboard operation, route and dialog focus lifecycle, restrained live announcements, selected-theme WCAG 2.2 AA contrast, visible focus, product touch-target rules, true 200 percent browser zoom, 320 CSS px reflow, and reduced-motion behavior. It may add test-only accessibility tooling and narrowly refactor markup, focus, announcements, and colors without changing the selected Focus Rail structure or any product/runtime contract.

Excluded: a formal third-party WCAG certification; a second browser engine or supported-browser claim owned by `FE-V1-040`; target/current pixel-diff closure owned by `FE-V1-017`; copy/workflow acceptance owned by `FE-V1-018`; physical TalkBack/VoiceOver and final phone module acceptance owned by `FE-V1-090`; a second theme; API/runtime/trust/Tailscale/pairing behavior changes; new routes or capabilities; visual redesign; package/install/release-readiness claims.

## Audit Findings

- The implementation already uses one main landmark, semantic buttons/links/lists, labelled Radix dialogs, a skip link, text-plus-icon status, stable target sizes, a high-contrast dark token set, and a reduced-motion media query. Existing module tests cover many local names, roles, disabled causes, dialog instances, and responsive states.
- There is no complete accessibility audit owner. No axe-core dependency or browser audit currently covers all 15 surfaces, 141 state traces, 39 interactions, supporting-sheet families, confirmations, or dynamic transitions.
- Six definition-list families have invalid ownership: Mission status, Session context, Host/access facts, device facts, Usage summary qualifiers, and compatibility evidence place `dt`/`dd` or extra content under nonconforming wrappers. Visual layout tests do not prove the resulting accessibility tree.
- At desktop split width, retained Mission navigation emits an `h2` before the live detail route's page `h1`. The pane is already labelled as navigation, so this heading order is unnecessary and misleading.
- SPA route navigation does not transfer focus. Opening detail can leave focus on an unmounted row; Back does not restore the originating session row; invalid-route and pairing-to-app transitions can fall back to the document body. The skip-link target itself is correctly focusable.
- The primary action dock declares `role="toolbar"` but implements ordinary Tab traversal only. It must either implement the toolbar keyboard pattern or use a semantic group matching its actual behavior.
- Newly arriving approvals have no dedicated restrained announcement. Unpinned new-activity count is visually exposed but not owned by a live region. Pairing places `aria-live` on an entire interactive result section, and several danger statuses combine implicit alert semantics with an explicit polite live setting. These patterns can be silent, duplicative, or urgency-inconsistent depending on assistive technology.
- Enabled primary-button text is `#ffffff` on `#4e8dff`, only 3.19:1. Module and shared disabled styles use 0.45 to 0.76 opacity, so visible disabled labels/icons can fall below the product's explicit disabled-state contrast requirement even though WCAG normally exempts inactive controls.
- Focus treatment is broadly present, including custom radio/search/focusable-region cases, but no aggregate proof checks every keyboard target, clipping at sheet/viewport boundaries, modal trapping/restoration, or scroll visibility.
- Core targets are generally 44 px and the responsive leaf found no layout collision, but there is no executable inventory proving every visible action remains at least 44 px where frozen, never below 40 px, and safely separated from unrelated destructive actions.
- The existing responsive DPR2 capture leaves a 640 CSS px layout viewport. Device pixel ratio is not browser zoom and does not satisfy the 200 percent/320 CSS px accessibility gate. A headed Chromium plus browser-level zoom probe confirms five native zoom increments produce exact 2x DPR and a 320 x 400 CSS viewport from a 640 x 800 window; this must become acceptance evidence.
- Orca 46.1 is available on the validation host, but no manual screen-reader evidence exists. Raw Orca diagnostics may contain machine/process details and are not acceptable as committed evidence; only bounded sanitized observations may be stored.

## Frozen Boundary

### Conformance And Tooling

- The selected dark Focus Rail theme is evaluated against applicable WCAG 2.2 Level A and AA success criteria. Completion is a scoped product acceptance claim, not blanket certification for untested browsers, operating systems, extensions, translated copy, or future states.
- Pin `@axe-core/playwright@4.12.1` as test-only tooling after the audited registry metadata: official Deque repository, MPL-2.0, `axe-core~4.12.1`, and compatible `playwright-core>=1.0.0`. It must not enter production dependencies, runtime modules, package closure, or browser output.
- Representative production-shell and pairing audits run all applicable axe rules tagged `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22a`, `wcag22aa`, and `best-practice`. No rule is disabled globally. A documented rule-scoped exclusion is admissible only for a proven tool false positive with direct replacement evidence.
- Custom browser assertions supplement axe for route focus, dialog cycles, announcement deltas, source/visual order, focus clipping, target geometry, product-specific disabled contrast, exact zoom, reduced motion, storage/privacy, and cleanup.

### Executable Coverage

An executable ledger must map every one of the 141 mobile state traces and all 39 interaction IDs to exactly one primary accessibility family, an existing behavior owner, required semantics, keyboard action, announcement policy, and audit tier. No state may be treated as covered merely because a visually similar state passed.

| Family | Surfaces | Required audit emphasis |
| --- | --- | --- |
| Shell and Mission | browser preload, Mission Control | title/main/skip link, host status descriptions, grouped list/disclosure semantics, rows, refresh/load more, route focus, empty/loading/error announcements. |
| Detail and timeline | Session Detail, approval | page heading, context definitions, ordered activity, event headings/details, approval arrival/decision, new-activity notice, no token-delta announcements. |
| Fixed controls | composer and detail dock | semantic group/toolbar pattern, exact target names, textarea label/error/count, send status, keyboard visibility, destructive separation. |
| Primary sheets | model, goal, Plan | trigger/dialog naming, radio/fieldset semantics, objective label/error, current/pending state, initial/trapped/restored focus, Escape. |
| Utility sheets | usage, Compact, Skills | menu/list semantics, definition structure, search/results announcement, disclosure state, confirmation focus, long-list keyboard reach. |
| Session action/diagnostic sheets | event details, interrupt, archive, laptop resume | exact trigger/target/consequence, disclosure, Clipboard result, safe/destructive confirmation, pending dismissal policy. |
| Host and access | access recovery, compatibility, lock, devices | fact semantics, urgent/current status, local-only recovery, confirmation, device-row focus, revoke/lock labels. |
| Pairing and errors | pairing, unavailable/not-found | progress-list current step, bounded result announcement, labelled action, transition focus, page heading, generic error recovery. |

### Keyboard And Focus

- Tab and Shift+Tab reach every enabled interactive element once in logical source order. Enter/Space activate buttons, links, disclosures, and confirmations; native radio arrow behavior remains intact. No positive `tabindex`, focusable hidden duplicate, keyboard-only dead end, or mouse-only action is allowed.
- Route changes move focus without scroll jump to the new main region. Returning from Session Detail restores the exact originating Mission row when it still exists; otherwise focus falls back to main. Direct detail, invalid-route recovery, retained-row replacement, archive success, and pairing continuation use truthful fallback behavior.
- Every sheet/dialog has a labelled title and bounded description, sensible initial focus, one modal cycle, visible focused target, Escape dismissal when no exact in-flight operation forbids it, and restoration to the connected trigger. A blocked dismissal must be limited to the existing post-dispatch/pending safety contract and expose current status; it cannot silently trap focus after terminal state.
- Programmatically focused non-controls may use `tabindex=-1` but must not enter normal Tab order. Focus remains visible and within the viewport or owning scroller at 320 reflow, short height, landscape, and desktop split.
- If the dock retains toolbar semantics, Left/Right plus Home/End and one Tab stop are required. Otherwise it must expose a labelled group and retain normal Tab order; the implementation may not claim an unimplemented ARIA pattern.

### Semantics And Announcements

- Each page has one main landmark and one page `h1`; headings are ordered by content hierarchy even when desktop visual placement differs. Navigation/region/dialog/form/list labels are unique and useful. Definition terms/descriptions follow valid HTML ownership.
- Icon-only controls have stable accessible names; decorative/status icons are hidden from the accessibility tree; visible state always includes text and does not rely on color, position, or animation alone.
- Form fields and grouped choices have labels, legends/group names, selected/current/pending truth, constraints, invalid state, and bounded descriptions. Disabled controls expose their cause in adjacent or referenced text where the product contract provides one.
- Material nonurgent changes use one atomic polite announcement. Urgent actionable failures use an assertive alert. A node cannot combine contradictory alert/polite semantics. Initial static content, repeated snapshots, timestamps, list reorder, and streaming token/event deltas do not spam announcements.
- A newly requested actionable approval is announced once with bounded session/action/risk context and never reads raw protocol data. An unpinned new-activity count is announced only when its count increases. Pairing announces bounded phase/result copy without re-reading facts or interactive controls.

### Contrast, Targets, Reflow, And Motion

- Normal text below the WCAG large-text threshold is at least 4.5:1; large text is at least 3:1. Required icons, state marks, control boundaries, and focus indicators are at least 3:1 against adjacent colors. Focus is also distinguishable from the unfocused component.
- HostDeck's stricter product rule keeps visible disabled labels at least 4.5:1 and disabled icons/boundaries at least 3:1. Disabled styling remains visibly distinct without whole-control opacity that destroys contrast.
- Core controls are 44 x 44 CSS px or larger where frozen and never below 40 x 40. Radio/row/disclosure labels provide the target, not a hidden subcontrol. Smaller inline text targets, if any, must meet WCAG 2.5.8's 24 px or spacing exception. Unrelated destructive and send/approve targets cannot share an accidental-touch region.
- A real browser-level 200 percent zoom run starts from 640 x 800 physical/window geometry and proves 320 x 400 CSS layout geometry, one-column reflow, stable type, no horizontal scroll, no clipped focus/action, and complete core keyboard reach. Independent headless 320 x 800 and reference-viewport checks remain required.
- `prefers-reduced-motion: reduce` disables nonessential spinner/rotation/transition behavior and changes scripted smooth scroll to instant. No interaction requires motion, auto-scrolls a reader away from their position, or moves the focused/active target after dynamic copy.

## Strict Success Criteria

- `A11Y-01`: one executable ledger covers exactly 141 state traces, 15 surfaces, 39 interactions, 12 journeys, five reference viewports, eight accessibility families, existing behavior ownership, and explicit keyboard/announcement/audit policies without missing, duplicate, or invented coverage.
- `A11Y-02`: pinned axe 4.12.1 audits every representative page/sheet/confirmation family and all required dynamic variants with zero applicable WCAG A/AA or best-practice violations and no broad rule suppression.
- `A11Y-03`: every rendered page has one main landmark, one page-level `h1`, ordered headings, labelled navigation/regions, one useful document title, and no duplicate landmark/name/id ambiguity at phone, tablet, or desktop split.
- `A11Y-04`: session/activity/pairing/menu lists and all definition lists expose valid roles, ownership, names, order, current/selected state, counts, and term-description relationships in both DOM and accessibility tree.
- `A11Y-05`: every interactive element has an exact stable accessible name, role, state, and description; decorative Lucide/rail/progress icons are hidden; status is never color-only; long visual truncation retains the full accessible value.
- `A11Y-06`: labels, fieldsets/radiogroups, textareas/search, constraints/counts/errors, `aria-invalid`, `aria-describedby`, current/pending selection, and disabled causes are complete and do not reference missing or hidden-unrelated nodes.
- `A11Y-07`: skip links become visible, move focus to main, and do not hide under safe-area/app-bar geometry; initial page reading order remains app bar then main without forced focus theft.
- `A11Y-08`: Mission-to-detail and retained-detail route changes focus main without scroll jump; Back restores the exact surviving source row; direct/invalid/archive/pairing paths use the frozen fallback with no body/lost focus.
- `A11Y-09`: every enabled operation is reachable and activatable with keyboard alone in logical order; native disclosure/radio behavior works; no positive tabindex, hidden focus target, duplicate stop, mouse-only action, or keyboard trap exists.
- `A11Y-10`: the primary action dock implements its declared group or toolbar keyboard contract exactly, including names, order, disabled-item behavior, and source/visual-order consistency at all regimes.
- `A11Y-11`: every sheet and confirmation proves initial focus, forward/reverse modal cycling, focus visibility, Escape policy, outside-interaction policy, nested-view transition, terminal closure, and restoration to the connected trigger or documented fallback.
- `A11Y-12`: focus indicators remain at least 3 px/3:1, distinguish focused controls, and are not clipped or obscured by app bar, fixed controls, sheet scrollers, safe areas, viewport edges, or 200 percent zoom.
- `A11Y-13`: ordinary statuses announce atomically/politely and urgent failures assertively with no contradictory role/live setting, duplicate initial announcement, repeated-snapshot spam, or hidden private/raw content.
- `A11Y-14`: each newly arriving actionable approval and increasing unpinned activity count announces once; resolving/reordering/replaying does not reannounce; streaming agent token/event deltas are never live regions.
- `A11Y-15`: pairing progress/result changes announce only bounded phase copy, expose current step, preserve action focus, and transfer focus truthfully into Mission Control without reading the full interactive result region.
- `A11Y-16`: selected-theme normal/large text, metadata, links, status/error copy, and enabled control text meet exact WCAG 2.2 AA ratios; the known 3.19:1 primary-button pair is removed.
- `A11Y-17`: required non-text icons/rails/boundaries, selected/checked state, and focus indicators meet 3:1; all visible disabled labels/icons/boundaries meet the stricter frozen product ratios without opacity dilution.
- `A11Y-18`: every core touch target measures at least 44 px where frozen and never below 40 px, inline exceptions satisfy 2.5.8, and unrelated destructive versus send/approve actions remain safely separated with no overlay interception.
- `A11Y-19`: exact 320 x 800 and true headed-Chromium 200 percent zoom/320 x 400 CSS evidence completes all core flows with stable type, no horizontal scroll, clipping, overlap, hidden final content/action, or focus loss.
- `A11Y-20`: reduced-motion evidence disables nonessential CSS/JS motion, smooth scrolling, and spinners while preserving visible progress/state; default motion never hijacks scroll or moves an active target.
- `A11Y-21`: dynamic loading, stale/recovery, stream, operation, approval, lock, pairing, and list updates preserve focused element identity or use one documented focus handoff; state changes never create an incoherent focus/order/layout jump.
- `A11Y-22`: sanitized manual keyboard review completes pairing, Mission scan/open/back, detail prompt/control/approval, every sheet family, Host/access lock/device/recovery, diagnostics/actions, and error recovery at 390 phone, 320 reflow, short height, and 1280 split.
- `A11Y-23`: sanitized Orca 46.1 review confirms page/heading/list/status/row/timeline/form/dialog/approval/error reading order, names, descriptions, state, focus transitions, announcement restraint, and no protected/raw disclosure for the representative end-to-end journeys.
- `A11Y-24`: focused and aggregate web/unit/contract/integration, complete Chromium shell/pairing, typecheck, lint/exports, scaffold, planning, runtime-boundary, exact binding, build/package/install, audit/license, privacy, diff, evidence, process/listener residue, owner docs, coherent commits, push state, downstream limitations, and the 18 excluded user-owned screenshots all match reality.

## Required Evidence

- Direct component/headless tests for semantic structure, action-dock keyboard behavior, route focus resolution, announcement deduplication, urgency mapping, and reduced-motion scroll selection.
- Executable state/interaction-to-accessibility ledger checked against all mobile contract IDs and existing behavior owners.
- Production-shell and pairing Playwright audits for every accessibility family, with axe results, accessibility-tree summaries, keyboard/focus traces, target/contrast geometry, live-region mutations, storage/privacy, console/page errors, and cleanup.
- True native browser zoom evidence from headed Chromium at 200 percent plus independent 320/reflow/reference viewport screenshots. Device-scale emulation alone is explicitly insufficient.
- Sanitized manual keyboard and Orca 46.1 observation records. Do not commit raw assistive-technology logs, process IDs, machine paths, profile data, speech configuration, or private runtime/session values.
- Full-size focus/zoom/error captures and contact sheets under `artifacts/fe-v1-039-semantic-accessibility-hardening/`, reviewed against the selected Focus Rail structure. Existing owner screenshots remain regression inputs and are not rewritten as this leaf's evidence.
- Full selected repository validation and a clean staged scope that excludes the 18 pre-existing user-owned screenshot modifications.

## Implementation Record

- Added an executable accessibility ledger for all 141 state traces and 39 interactions. It preserves the 15 frozen surfaces, 12 journeys, five reference viewports, eight accessibility families, existing behavior owners, and explicit semantic, keyboard, announcement, and audit policies.
- Pinned `@axe-core/playwright@4.12.1` as test-only tooling and added production-shell and pairing audit matrices without global rule suppression. Added custom assertions for headings/landmarks, definition and list ownership, route/dialog focus, keyboard order, live-region deltas, target geometry, computed contrast, reduced motion, reflow, privacy, and cleanup.
- Repaired invalid definition-list ownership, desktop heading order, document titles, skip/route focus, exact Mission-row restoration, pairing current-step truth, dialog/scroller focus, icon/region names, and the dock's semantic contract. The dock now exposes its implemented native group/Tab behavior rather than claiming an unimplemented toolbar pattern.
- Added restrained approval and unpinned-activity announcements, bounded pairing announcements, and consistent polite-versus-alert urgency. Approval handles become seen only after they are actionable, while initial baseline and replay remain silent.
- Replaced the failing primary/disabled/control/focus color pairs and opacity dilution with exact selected-theme tokens. Browser math proves 5.83:1 primary text, 6.60:1 minimum disabled text, 3.23:1 disabled boundaries, 3.31:1 control boundaries, and 5.41:1 focus indicators.
- Added true native Chrome zoom and Orca 46.1 runners. The zoom runner drives a physical 640 x 800 window to DPR 2 and a 320 x 400 CSS viewport; the Orca runner commits only bounded booleans and deletes raw output.
- Added four deterministic full-size focus/error captures and one contact sheet. The short-height model capture first scrolls the loading status fully inside its keyboard-owned body, asserts both vertical edges are contained, and restores visible close-button focus before capture.
- Aggregate validation found and closed three release-gate defects: the runtime-boundary allowlist and test-fixture root exports had drifted (`80c82f0`), the compatibility browser helper flattened a valid value/detail definition (`1809ac0`), and long Host/access values squeezed the `Secure writes` term below one word at 390 px (`b96dae3`). The final fact grid keeps a 112 px term track and passed 390/320 visual review.
- Product/API/runtime/Tailscale/pairing authority and route contracts did not change. The only dependency addition is the pinned test-only axe adapter.

## Validation

| Gate | Result |
| --- | --- |
| Coverage and focused web | Ledger assertions cover exactly 141 states, 39 interactions, 15 surfaces, 12 journeys, five viewports, and eight families. Focused accessibility shell 16/16, pairing 3/3, native zoom 1/1, Orca 1/1, and `pnpm test:web` 52 files/920 tests pass. |
| Aggregate repository | `pnpm test:unit`: 246 files/2,805 passed with 27 files/28 intentional external or device skips; contract 34 files/245; integration 21 files/36. |
| Complete Chromium | Final `pnpm test:browser:shell` passes 168/168 on evidence revision `4a79877`; final `pnpm test:browser:pairing` passes 11/11 on the final product revision. Earlier complete runs exposed the two stale-test/layout defects recorded above; focused fixes and complete reruns pass without retries. |
| Native zoom and contrast | A headed 640 x 800 Chrome window reaches exact DPR 2 and 320 x 400 CSS geometry with 16 px root type, 312 px client/scroll width, bounded dialog/focus, and all five exact contrast thresholds passing. Both committed X-root captures are nonblank 640 x 800 PNGs with distinct hashes. |
| Visual evidence | Seven committed PNGs have exact declared dimensions, nonzero means, and unique SHA-256 identities: six full-size Mission row, approval confirmation, route error, short-height model, and native-zoom captures plus one 1,008 x 832 contact sheet. Manual review finds visible focus, complete text/actions, correct scroller ownership, no overlap/clipping, and no Focus Rail drift. |
| Keyboard and Orca | Sanitized keyboard evidence passes nine complete journeys at five viewport regimes. Orca 46.1 observes Mission/page headings, row, detail timeline, form, model dialog, approval, error recovery, focus, and speech output; no protected marker or raw log is retained. Host D-Bus/FUSE/portal startup and shutdown warnings remain environmental noise and did not prevent AT-SPI or product assertions. |
| Static and runtime boundaries | Root typecheck; Biome over 751 files plus eight package exports; scaffold eight packages/21 scripts; planning 220 tasks/84 requirements/683 dependencies/two queued before closure; and runtime boundary seven tests plus 614 production modules/22 externals pass. Exact isolated Codex 0.144.0 verifies 671 binding files at `e1a1a5cff3ab91862f9215dd06538eae1ea0b00bae48cbb7d87061faaee27e24`; default 0.145.0 correctly rejects the exact gate. |
| Build, package, and supply chain | Frozen offline install passes. Vite transforms 2,054 modules. Root build/package acceptance and independent verification pass at 614 sources, 1,235 outputs, 6,449 entries, and SHA-256 `35f41f5daccab92d6ded30bf1de374d5451e1ce81282e1136a2452f7810a3ace`. Production audit reports no known vulnerabilities; 172 entries across 175 paths use the eight reviewed permissive license expressions. |
| Privacy, evidence, and residue | Task JSON predicates, PNG dimensions/nonblank hashes, and private-marker scan pass. No browser-test listener, process, raw Orca log, or task temporary output remains. `git diff --check` passes, and all 18 excluded user-owned screenshots match the pre-run backup byte-for-byte and remain outside task commits. |

The existing greater-than-500-kB Vite chunk advisory is unchanged. Physical Android TalkBack and final phone acceptance remain `FE-V1-090`; second-engine support remains `FE-V1-040`; target/current pixel-diff closure remains `FE-V1-017`; copy/workflow acceptance remains `FE-V1-018`. This leaf is not a V1 release-readiness claim.

## Completion Record

| Criterion | Evidence and disposition |
| --- | --- |
| `A11Y-01` | Pass: the executable ledger has exact state, interaction, surface, journey, viewport, family, behavior-owner, and policy cardinality with no missing, duplicate, or invented IDs. |
| `A11Y-02` | Pass: all representative shell and pairing families run axe 4.12.1 with the frozen WCAG/best-practice tags, zero applicable violations, and no broad suppression. |
| `A11Y-03` | Pass: phone, reflow, and desktop split have one main, one page `h1`, ordered headings, unique labelled regions, and route-specific titles. |
| `A11Y-04` | Pass: session, activity, pairing, and menu lists plus all six repaired definition-list families expose valid ownership, order, state, and term/description relationships. |
| `A11Y-05` | Pass: controls and overflow owners have exact names/roles/states; decorative icons are hidden; status remains textual; full values remain accessible. |
| `A11Y-06` | Pass: fields, fieldsets, radio choices, constraints, errors, descriptions, pending/current truth, and disabled causes have complete valid relationships. |
| `A11Y-07` | Pass: the skip link becomes visible and focuses unobscured main content without initial-load focus theft. |
| `A11Y-08` | Pass: Mission/detail navigation focuses main, Back restores the exact surviving row, and direct/invalid/replaced/pairing paths use the documented fallback. |
| `A11Y-09` | Pass: every enabled action is keyboard reachable/operable in logical order with no positive tabindex, hidden duplicate, mouse-only action, dead end, or trap. |
| `A11Y-10` | Pass: the dock exposes a labelled native group/fieldset and ordinary Tab order, matching its implemented contract at every regime. |
| `A11Y-11` | Pass: every sheet/confirmation proves labelled initial focus, forward/reverse cycle, Escape/outside policy, nested transition, terminal closure, and connected-trigger restoration. |
| `A11Y-12` | Pass: computed focus contrast exceeds 3:1 and browser traces show no clipping at app bar, sheet scroller, fixed controls, viewport edge, or native zoom. |
| `A11Y-13` | Pass: ordinary changes are atomic/polite, urgent failures assertive, and static/replayed/streaming content does not duplicate or spam announcements. |
| `A11Y-14` | Pass: each newly actionable approval and increasing unpinned count announces once; baseline, disabled, replayed, reordered, and resolved items remain silent. |
| `A11Y-15` | Pass: pairing exposes one current step, bounded phase/result announcements, stable action focus, and truthful Mission focus transfer. |
| `A11Y-16` | Pass: exact selected-theme text pairs meet WCAG AA; the former 3.19:1 primary-button pair is removed. |
| `A11Y-17` | Pass: required boundaries/icons/focus exceed 3:1 and visible disabled text exceeds 4.5:1 without whole-control opacity dilution. |
| `A11Y-18` | Pass: core targets meet the frozen 44 px rule and never fall below 40 px; inline exceptions and destructive/send/approve separation pass browser geometry. |
| `A11Y-19` | Pass: independent 320 x 800 plus true 200 percent/320 x 400 native evidence preserves one-column flow, stable type, full actions, focus, and zero horizontal overflow. |
| `A11Y-20` | Pass: reduced motion removes nonessential animation and scripted smooth scrolling while preserving visible progress and interaction. |
| `A11Y-21` | Pass: loading, stale, stream, operation, approval, lock, pairing, and list changes preserve identity or use one documented focus handoff without incoherent jumps. |
| `A11Y-22` | Pass: sanitized keyboard review covers pairing, Mission/detail/back, prompt/approval, all sheet families, Host/access/device/lock/recovery, diagnostics, and errors at all frozen regimes. |
| `A11Y-23` | Pass: sanitized Orca 46.1 evidence confirms representative reading order, semantics, state, focus, announcement restraint, and zero protected/raw disclosure. |
| `A11Y-24` | Pass: focused/aggregate/browser/native, static/runtime, build/package/install, audit/license, privacy/diff/evidence/residue, owner-doc, commit/push, limitation, and 18-file exclusion truth agree. Criteria `8eb2c43`; ledger/tooling `c78bc97`; implementation `4903e3d`; boundary/test/layout corrections `80c82f0`, `1809ac0`, `b96dae3`; visual evidence `4a79877`. |
