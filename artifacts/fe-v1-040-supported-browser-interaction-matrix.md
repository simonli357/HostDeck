# FE-V1-040 Supported Browser Interaction Matrix

Date: 2026-07-28

Status: complete; `BRM-01` to `BRM-24` pass.

## Scope

Prove that the manifest-verified packaged HostDeck dashboard preserves its selected mobile-first behavior in the pinned Playwright Chromium and Firefox engines at phone and desktop regimes. Exercise actual browser navigation, fragment handling, reload/history, streamed event consumption, forms, structured controls, confirmations, protected writes, authority loss, and recovery against isolated same-origin fixtures without a model call, live Tailscale mutation, laptop-LAN route, or custom CA installation.

This leaf owns the supported browser declaration, exact engine/version inventory, a four-project package runner, an executable portability ledger for all 39 mobile interaction IDs, representative cross-engine workflows, viewport and input-mode differences, browser diagnostics, sanitized interaction traces, and explicit support limitations.

Excluded: visual pixel-diff closure owned by `FE-V1-017`; copy/workflow acceptance owned by `FE-V1-018`; physical TalkBack/VoiceOver and aggregate phone module acceptance owned by `FE-V1-090`; live Tailscale Serve/profile/device acceptance owned by `FE-V1-090` and `REL-V1-006`; clean-package aggregate browser acceptance owned by `REL-V1-007`; UI redesign, new routes/capabilities, server trust-policy changes, or a Safari/iOS support claim.

## Criteria-Freeze Audit Findings

These findings describe the repository state at criteria freeze and are retained as the implementation rationale.

- `pnpm test:e2e` was an intentional `REL-V1-007` placeholder, even though the test plan assigned it to both `IFC-V1-046` and `FE-V1-040`. No executable supported-browser command existed.
- All current Playwright configs hard-code Chromium. The source-preview shell suite proves 168 Chromium cases and the pairing suite proves 11 Chromium cases, but neither declares nor executes a second engine.
- `IFC-V1-053` adds one real relocated-package Chromium smoke. It proves package/static identity, CSP, cache/MIME policy, basic Mission/detail navigation, and selected API reads, but it does not exercise pairing, SSE recovery, writes, controls, approvals, lock, or profile-return behavior.
- Existing feature-owner browser specs are intentionally broad visual/state suites. Running them under a second engine would rewrite task-owned screenshots, including 18 user-modified protected files, and would still not provide one versioned support declaration or interaction-to-engine coverage record.
- Pairing bootstrap currently runs through a separate Vite test entry. Cross-engine completion must drive the production package entry so fragment scrubbing, claim, CSRF bootstrap, route continuation, reload, and history share the shipped graph.
- The production app uses browser-sensitive behavior including `crypto.randomUUID`, streamed Fetch `ReadableStream`, `TextDecoder`, `history.replaceState`, Clipboard API, native dialog/radio/focus behavior, `100dvh`, `:has()`, `color-mix()`, sticky/fixed positioning, safe-area variables, and touch/pointer input. Chromium-only component and screenshot evidence cannot establish their Firefox behavior.
- The pinned `@playwright/test` version was 1.61.1. Its managed Chromium 149.0.7827.55 was installed; its managed Firefox 151.0 was not installed. Browser installation therefore had to become an explicit prerequisite and could not occur silently during acceptance.
- Playwright Firefox cannot claim a real Firefox Android device from Linux emulation. A 390 x 844 touch-capable Firefox context can prove narrow-layout and interaction semantics, but only physical-device evidence can close mobile browser/platform integration.
- Current package browser evidence is loopback HTTP. It cannot by itself prove a browser's trust in a real Tailscale Serve certificate or end-to-end proxy behavior. An isolated HTTPS fixture may prove `Secure`/`HttpOnly`/`SameSite` cookie semantics without installing a CA, but its ignored test certificate is not live Serve evidence.
- No current artifact records exact browser revisions, project options, interaction coverage, per-project request/action counts, storage/cookie observations, diagnostics, or a release limitation in one machine-checked identity.

## Supported Browser Decision

| Project | Engine and pinned browser | Regime | Support meaning |
| --- | --- | --- | --- |
| `chromium-phone` | Playwright Chromium 149.0.7827.55, revision 1228 | 390 x 844, touch, mobile viewport semantics | Automated Android-class responsive-browser compatibility; physical Android remains separate evidence. |
| `chromium-desktop` | Same Chromium identity | 1280 x 800, mouse and keyboard | Supported Ubuntu desktop Chromium interaction semantics. |
| `firefox-phone` | Playwright Firefox 151.0, revision 1532 | 390 x 844, touch-capable narrow viewport | Second-engine phone-layout compatibility; no Firefox Android device claim because Playwright Firefox does not provide Chromium-equivalent mobile emulation. |
| `firefox-desktop` | Same Firefox identity | 1280 x 800, mouse and keyboard | Supported Ubuntu desktop Firefox interaction semantics. |

Firefox is selected over Linux Playwright WebKit. It is a maintained independent engine available on Ubuntu and Android, while Linux WebKit automation would not justify a Safari or iOS support claim without Apple hardware. The release claim is bounded to the exact managed browser identities above until `REL-V1-007` deliberately rebases them.

## Frozen Test Architecture

- `pnpm test:e2e` becomes the FE-V1-040 package-browser command. It builds once through the frozen production package owner, independently verifies the result, relocates it read-only, starts only task-owned loopback fixture processes, runs all four projects, validates evidence, and removes every process/path on success or failure.
- The page must execute `dist/hostdeck/web` through the compiled selected static boundary. Vite dev/preview, source TypeScript execution in the page, synthetic HTML, post-verification asset mutation, and workspace asset fallback are forbidden.
- Browser-side API fixtures intercept only exact selected same-origin routes and validate method/path/query/body/header/correlation. They may provide deterministic JSON/SSE outcomes but may not replace UI code, invoke component internals, set final DOM state, or claim server/runtime/Tailscale behavior.
- A separate task-owned HTTPS fixture may proxy the exact packaged document/assets and fixture API responses to exercise real browser cookie handling. The test context may ignore its ephemeral certificate error, but no CA is installed and the artifact must label certificate trust and Serve routing unproven by that case.
- Successful runs emit one bounded strict JSON report per project plus one aggregate manifest under a new FE-V1-040 artifact directory. Raw Playwright traces are retained only for failure in `/tmp`; successful committed evidence contains sanitized semantic interaction traces, not browser profiles, cookies, response bodies, machine paths, or credentials.
- Existing owner screenshots are read-only regression inputs. FE-V1-040 produces no replacement screenshot for another task and never stages the 18 protected user modifications.

## Portability Coverage

An executable ledger must map exactly all 39 `mobileInteractionIds` and all 12 mobile journeys to one portability family, existing behavior owner, required project set, test scenario, and explicit disposition. Local-only laptop actions remain visible non-browser boundaries and cannot be mislabeled as remote browser interactions.

| Family | Representative shipped workflow | Browser mechanisms |
| --- | --- | --- |
| Package and navigation | load Mission, open detail, retained desktop context, Back, direct detail, invalid route | module/CSS execution, history, focus, responsive layout |
| Pairing and reload | consume `#pair`, scrub immediately, claim once, bootstrap CSRF, continue, reload/back/forward without replay | URL fragments, history replacement, Fetch, cookie/authority adoption |
| Stream continuity | receive replay/live events, drop stream, show reconnecting, resume after exact cursor without duplicate | streamed Fetch, `ReadableStream`, UTF-8 decode, abort, timers |
| Prompt | compose, submit exact start, event-confirm running state, preserve focus, no duplicate | textarea/input events, form submit, random operation id, protected Fetch |
| Primary controls | read and mutate `/model`, `/goal`, and `/plan` through their real sheets | native radio/keyboard, text input, dialogs, protected Fetch |
| Utilities | read Usage and Skills; confirm and start Compact | menus, search, long list, confirmation, read/write request paths |
| Approval | render exact pending request and approve/deny once with terminal reconciliation | dynamic list, confirmation policy, protected Fetch, focus |
| Session actions | event details, interrupt, archive, and laptop-resume copy boundary | disclosure/dialog, destructive confirmation, Clipboard feature detection |
| Host security | list/revoke a device and lock writes once; expose local-only unlock truth | nested sheet state, confirmation, authority purge, protected Fetch |
| Remote recovery | current ready state, simulated disconnect/profile-away, stale purge, explicit check, profile-return recovery | aborted reads/stream, no polling, same-origin recovery, focus/state continuity |

## Implementation Result

- `tests/browser/supported-browser-manifest.json` and its strict parser pin Playwright 1.61.1, Linux x64, Chromium 149.0.7827.55/revision 1228, Firefox 151.0/revision 1532, four exact projects, package hashes, 19 scenarios, 34 automated interactions, and evidence schema 1.
- `packages/test-fixtures/src/browser-compatibility-matrix.ts` maps all 39 mobile interaction IDs, all 12 journeys, ten portability families, all four projects, existing behavior owners, and five explicit local-only boundaries without an unsupported browser claim.
- `pnpm test:e2e` builds and independently verifies the current 619-source production package, checks the exact managed browser identities before execution, creates one ephemeral task-owned HTTPS certificate, runs 76 no-retry Playwright cases through the compiled package boundary, validates strict reports, closes ports 4175 to 4177, removes temporary output, and only then replaces the evidence directory.
- Every project passes the same 19 scenarios. Chromium projects record 78 bounded requests each; Firefox projects record 80 each because their fragment-history path has two additional reads. Every project records 13 exact mutations, zero unexpected browser diagnostics, and all 34 automated interactions.
- The HTTPS case uses a real cross-site top-level navigation between separate public-suffix sites to prove `SameSite=Strict` suppression, plus same-origin inclusion, `Secure`, `HttpOnly`, host-only scope, reload persistence, JavaScript invisibility, and zero credential storage. The ignored ephemeral certificate remains fixture-only evidence.
- The current aggregate evidence records 316 requests and 52 mutations against package SHA-256 `903df036e5f71db5406f591fabbe1e838125fa43317715331d8251e5e35f9a21` and web SHA-256 `5e96b3c87b6e5c942426bbd0748c1f7b36325a4c597199545871a08a55024ae5`.
- Physical Android, Firefox Android, live Tailscale Serve routing/certificate trust, and Safari/iOS remain explicitly unproven and downstream. No existing screenshot was generated, replaced, or staged.

## Strict Success Criteria

- `BRM-01`: one executable support manifest pins Playwright 1.61.1, Chromium 149.0.7827.55/revision 1228, Firefox 151.0/revision 1532, Linux platform/architecture, project options, package identity, and evidence schema; unexpected or missing browser identity fails before test execution.
- `BRM-02`: exactly four projects run: Chromium phone/desktop and Firefox phone/desktop. Phone projects use 390 x 844 and touch capability; desktop projects use 1280 x 800 and pointer/keyboard. Firefox's lack of true mobile emulation is explicit and never promoted to physical-device evidence.
- `BRM-03`: every project loads the same independently verified, relocated, read-only `dist/hostdeck` identity through the compiled selected static boundary with exact manifest-declared document/assets; no Vite server, source page, synthetic asset, or post-verification mutation participates.
- `BRM-04`: an executable portability ledger covers exactly 39 interaction IDs, 12 journeys, four projects, ten portability families, and the existing behavior owners with no missing, duplicate, invented, or unsupported interaction claim.
- `BRM-05`: package/navigation evidence loads Mission Control, opens the exact session, renders live detail, uses the selected retained desktop context only at desktop width, navigates Back with truthful focus, handles direct detail, and rejects an invalid route with matching semantics in all projects.
- `BRM-06`: fragment-pairing evidence proves immediate secret scrubbing before request, one exact claim, one CSRF bootstrap, no fragment in URL/referrer/log/trace, successful continuation, and reload/back/forward with no claim replay in all projects.
- `BRM-07`: stream evidence consumes at least one replay and one live projected event through the production browser SSE client, preserves order/cursor/session, exposes a disconnect, aborts the old owner, reconnects explicitly, and resumes without duplicate, gap concealment, polling, or retained request in all projects.
- `BRM-08`: prompt evidence uses real keyboard/input/form behavior, sends one exact protected request with one operation id, moves only from matching accepted/event truth, keeps prompt text out of storage/evidence, restores useful focus, and rejects duplicate submit in all projects.
- `BRM-09`: `/model`, `/goal`, and `/plan` each open their shipped dialog, read exact current state, accept native keyboard/pointer input appropriate to the project, emit one correlated protected mutation, expose pending/terminal truth, and restore focus without slash-text injection in all projects.
- `BRM-10`: Usage, Compact, and Skills prove the shared utility menu, read-only loading/content paths, search/long-list reachability, Compact confirmation and single protected start, close/restoration, and no hidden unsupported action in all projects.
- `BRM-11`: approval evidence renders one exact actionable request, preserves consequence/scope, makes one approve or deny mutation, disables duplicate action while pending, reconciles terminal state, and never grants ongoing policy in all projects.
- `BRM-12`: event diagnostics, interrupt, archive, and laptop-resume evidence covers disclosure, safe versus destructive confirmation, one exact mutation per action, Clipboard availability/denial truth, and no phone terminal execution or automatic retry in all projects.
- `BRM-13`: device and lock evidence lists bounded devices, confirms and sends one revoke, confirms and sends one host lock, purges write availability after lock, exposes local-only unlock recovery, and makes no hidden unlock/profile mutation in all projects.
- `BRM-14`: remote-recovery evidence transitions ready to disconnected/profile-away, cancels stale reads/stream, retains only explicitly labelled safe stale context, makes no polling or automatic profile switch, performs one explicit status check, and returns to current ready state in all projects.
- `BRM-15`: phone projects complete every representative workflow at exact 390 x 844 with no horizontal overflow, occluded required action, fixed-region collision, or pointer-only dependency; desktop projects preserve the same information architecture, exact actions, and selected 1280 split without desktop-only capability.
- `BRM-16`: keyboard, pointer, touch, native radio, textarea composition, Enter/Control+Enter policy, dialog focus cycle/restoration, Back navigation, and reduced-motion semantics remain equivalent where applicable; engine-specific input differences are asserted or recorded, never silently skipped.
- `BRM-17`: browser-sensitive CSS and platform APIs used by the shipped graph have direct behavioral evidence: `dvh`, `:has()`, `color-mix()`, sticky/fixed layout, safe-area fallback, `crypto.randomUUID`, streamed Fetch, UTF-8 decoding, history replacement, AbortController, and Clipboard feature detection. Unsupported required behavior is a blocker, not a hidden polyfill.
- `BRM-18`: an isolated HTTPS-cookie case in both engines proves `Secure`, `HttpOnly`, host-only, `SameSite=Strict`, reload persistence, JavaScript invisibility, same-origin inclusion, and no local/session storage credential. Its ignored ephemeral certificate is labelled fixture-only and cannot prove live Serve trust.
- `BRM-19`: every fixture validates exact selected method/path/query/body/media/CSRF/correlation, records bounded request/action counts, and proves no duplicate mutation, unexpected route, external request, network retry, storage credential, service worker, IndexedDB, cache residue, or unbounded pending request.
- `BRM-20`: all projects finish with zero unexpected console error, page error, CSP violation, request failure, unhandled rejection, accessibility-breaking focus loss, browser crash, timeout, retry, flaky annotation, conditional skip, or engine-specific expected failure.
- `BRM-21`: one sanitized strict report per project records browser identity, package/web hashes, viewport/input options, scenario/interaction outcomes, request/action counts, stream cursors, cookie/storage booleans, diagnostics, durations, and cleanup. Reports contain no raw fragment, CSRF value, cookie, operation id, prompt, transcript, private path, user/profile/tailnet identity, or machine-specific browser path.
- `BRM-22`: the task records exact limits: Linux Playwright Firefox phone-width evidence is not Firefox Android; the HTTPS fixture does not prove Tailscale certificate trust/Serve routing; no Safari/iOS support is claimed; existing focused Android Chromium evidence remains separate; live no-LAN/profile/device acceptance stays downstream.
- `BRM-23`: focused matrix tests, `pnpm test:e2e`, complete Chromium shell/pairing/package regression, aggregate web/unit/contract/integration, typecheck, lint/exports, scaffold, planning, runtime boundary, exact binding, build/package/install/supply-chain/privacy/diff/residue gates pass without modifying existing owner evidence.
- `BRM-24`: task/backlog/status/test-plan/command/developer/evidence owners match actual behavior; the placeholder ownership is removed only for the implemented FE-V1-040 command without claiming `REL-V1-007`; coherent criteria, implementation, and closure commits are pushed; the 18 protected user screenshots remain unstaged and byte-identical to their preserved backup.

## Required Evidence

- A strict support-manifest parser/test and an executable 39-interaction portability ledger checked against the mobile contract exports.
- One four-project Playwright configuration plus a bounded runner that verifies browser executables and the package before starting, publishes no partial report, and cleans all test-owned output/processes.
- Representative package interaction specs for the ten portability families, using shipped pages/components and existing exact API fixture contracts without screenshots or product-DOM injection.
- A task-owned HTTPS-cookie fixture for engine cookie semantics with a plainly recorded certificate/Serve limitation and no installed CA.
- Four sanitized per-project JSON traces plus one aggregate identity/report manifest under `artifacts/fe-v1-040-supported-browser-interaction-matrix/`.
- Browser/version/executable inspection, request/action/stream/cookie/storage diagnostics, privacy scans, process/listener/temp cleanup, and protected-artifact hash comparison.
- Full selected repository validation and a staged scope containing only FE-V1-040 implementation, tests, task-owned evidence, and owning documentation.

## Validation

| Gate | Result |
| --- | --- |
| Supported-browser focused contracts | 11 passed across the manifest, preflight, portability ledger, strict report parser, complete publication, and replacement-path tests. |
| `pnpm test:e2e` | 76/76 passed in 2.5 minutes across Chromium phone/desktop and Firefox phone/desktop; four reports and one aggregate manifest published after cleanup. |
| Evidence audit | Four report hashes match the aggregate; 19 scenarios and 34 automated interactions per project; 316 requests; 52 mutations; zero unexpected console/page/CSP/network/storage/cache/service-worker diagnostics; all three cleanup flags true. |
| Aggregate tests | Current release-review rerun: unit 2,909 passed with 29 intentional environment/device-gated skips; contract 245; integration 36; web 932; relocated packaged Chromium 1. |
| Static/package/runtime | Typecheck; lint/exports; scaffold; planning; runtime boundary; exact Codex 0.144.0 binding; deterministic build/package/install; zero-vulnerability production audit; permissive-license inventory; privacy/diff/residue checks pass. |
| Package identity | 619 sources, 1,245 owned outputs, 6,231 entries, and three web files at the package/web hashes recorded above. The lower entry count reflects release hardening that prunes and rejects dependency source maps. |
| Protected evidence | All 18 pre-existing modified PNGs remain unstaged and byte-identical to the preserved backup after every browser run. |

Criteria commit: `845b85b`. Implementation and initial generated evidence commit:
`869ab75`. The current release package was repinned and all 76 cases were rerun
without scenario, engine, viewport, or support-scope changes in `ee31ea7`.
