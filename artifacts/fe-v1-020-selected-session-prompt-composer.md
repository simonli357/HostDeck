# FE-V1-020 Selected-Session Prompt Composer

Date: 2026-07-25

## Scope

Implement the production Session Detail prompt composer over the completed browser coordinator and selected `POST /api/v1/sessions/:session_id/prompts` route. This leaf owns exact-session target projection, bounded draft validation, secure operation-id creation, one abortable dispatch, accepted response correlation, authoritative turn-event progress, truthful failure and unknown-outcome handling, Focus Rail sticky-composer UI, deterministic browser evidence, and physical Android soft-keyboard acceptance.

This leaf does not implement `/model`, `/goal`, `/plan`, utilities, approvals, interrupt, archive, laptop resume, reconnect recovery, or generic terminal/slash input. Those remain separate leaves. It does not retry automatically, persist a draft or receipt, render prompt content outside the textarea, infer completion from HTTP `202`, or bypass the coordinator's CSRF/write gate. No new dependency is required.

## Pre-Change Findings

- `IFC-V1-041` already owns a strict target-free request and prompt-specific accepted response. The browser sends only `operation_id`, `kind: "prompt"`, and canonical text; the server resolves the selected HostDeck session to the runtime target.
- `BrowserConnectionStateCoordinator.requestProtected` is the sole production browser mutation path. It rejects a closed or non-writable coordinator before CSRF dispatch and updates authority state after every result.
- The response proves dispatch acceptance only. It includes the exact operation, selected session target, accepted turn id, accepted time, and `start` or `steer`; later projected turn events alone prove running, waiting, completed, interrupted, or failed truth.
- A transport timeout, absent/invalid response, caller abort after dispatch, or authority race can leave the prompt outcome unknown. Repeating the text could create a duplicate turn and is not a safe convenience retry.
- Session Detail already owns exact access-first disclosure, replay-to-live feed continuity, current/stale truth, scroll retention, and matching turn events. The composer must consume those owners instead of creating another session or stream client.
- `browser-operation-id.ts` uses secure UUID generation but currently limits scopes to pairing and CSRF. Prompt dispatch requires one additional explicit scope.
- The selected Focus Rail target is `assets/ui-concepts/option-b/mobile-session-detail-active.png`, supported by `design-system.md` and the responsive continuum. Typed contracts override raster copy.
- The target shows a primary-action dock above the composer. `FE-V1-021`, `FE-V1-026`, and `FE-V1-027` own those live controls; this leaf records their temporary absence instead of rendering placeholders or dead buttons.

## Frozen Design

### Headless Ownership

- One pure projector accepts the current `BrowserConnectionSnapshot`, exact `SessionId`, feed state, and local dispatch state. It returns one immutable composer view with target label, availability, disabled cause, phase, status copy, tone, retry policy, and send eligibility.
- Availability requires the exact current detail target, disclosed active/current session, canonical coordinator write eligibility, a usable current stream, and a prompt-admissible turn state. Unpaired, invalid/expired/revoked, read-only, locked, stale, unavailable host/runtime/CSRF, wrong target, replaying/reconnecting/failed stream, archived/non-active session, and waiting/unknown/conflicting turn states remain disabled with one bounded reason.
- One hook owns draft text, one in-flight `AbortController`, one generated operation id, one accepted receipt, and one sanitized failure. Target change resets local state and aborts the old request. Unmount aborts once and ignores every late result.
- Input is trimmed exactly once at submission and validated by `promptSessionRequestSchema` before operation-id creation or network work. Empty/whitespace input and text beyond 20,000 characters never dispatch.
- The controller calls `requestProtected("prompt_dispatch", ...)` once per explicit submit. It verifies operation id, selected session id, and response kind before accepting the receipt. Runtime thread id, audit id, raw turn id, prompt text, and private error details never render.

### Dispatch And Progress Truth

| State | Source | Composer behavior |
| --- | --- | --- |
| Empty/composing | Local draft plus current availability | Send is disabled for empty/invalid text and enabled only for one valid current target. |
| Submitting | One unresolved protected request | Textarea and send are disabled; duplicate submit is inert; copy says `Sending`, not accepted or running. |
| Accepted | Correlated HTTP `202`, no matching turn event yet | Draft clears; status distinguishes new-turn versus follow-up acceptance and does not claim runtime progress. |
| Running | Latest matching accepted `turn_id` event is `in_progress` | Status says running; the timeline remains the detailed authority. A later prompt is allowed only if current server/UI admission still permits it. |
| Needs input/approval | Latest matching turn event says so | Status names the exact wait state; ordinary prompt submission stays disabled under selected prompt admission. |
| Completed | Latest matching turn event is `completed` | Status says completed only after that event. |
| Interrupted/failed/unknown | Latest matching turn event proves the terminal or unknown state | Status is explicit and never rewritten as completed. A bounded projected failure may render; raw adapter detail may not. |
| Known dispatch rejection | Parsed API rejection or proven pre-wire client rejection | Draft remains. Explicit retry is available only when the public error says retryable and current availability is restored. |
| Outcome unknown | Timeout/transport loss, absent or invalid response, post-dispatch abort/authority race, or correlation mismatch | Draft remains; submit is latched off and copy requires reload/checking activity. The composer never retries or claims rejection/success. |

- An unrelated turn event cannot advance the accepted receipt. Matching uses only the exact response `turn_id`; cursor order selects the latest matching event.
- A second accepted dispatch replaces only the prior local receipt after its own correlated response. It never mutates retained timeline events.
- Known failed submissions generate a fresh operation id only after an explicit user retry. Unknown outcomes cannot retry in the same document.
- No error path logs, stores, reflects, or places prompt text in URL/history, diagnostics, accessibility status, or artifact output.

### Interface And Keyboard

- The composer is a flat sticky Session Detail footer, not a card nested in the route. It shows a bounded exact session target, a multiline textarea, an icon-only Lucide send button with tooltip and accessible name, and one compact `aria-live="polite"` operation status.
- Enter inserts a newline. The visible send button is the primary mobile command; keyboard submission, if supported, requires Ctrl+Enter or Meta+Enter and follows the identical gate.
- The textarea is bounded to a stable minimum and maximum height, wraps longest valid content, and scrolls internally after its maximum. Sending never changes the route width or feed geometry unexpectedly.
- Sticky positioning accounts for `env(safe-area-inset-bottom)` and the dynamic visual viewport. At 360/390/412 phone widths, focusing the textarea with the Android keyboard open leaves the target, editable line, and send action visible without horizontal scroll or incoherent overlap.
- Focus remains in the textarea after a known rejection. After acceptance it returns to the cleared textarea. Disabled reasons and operation statuses use text plus icon/tone, never color alone.
- The approved Focus Rail tokens, 0/4/6 px radii, 44 px target, fixed type, divider continuity, visible focus, contrast, reduced motion, 320 reflow, five reference widths, 200 percent zoom, and long target/text/error containment apply.
- Until the three primary-control leaves land, the composer follows the timeline directly. No `/model`, `/goal`, `/plan`, More, terminal, attachment, file mention, microphone, magic action, or fake capability appears.

## Acceptance Matrix

| ID | Criterion |
| --- | --- |
| `SPC-01` | One pure projector validates exact snapshot/session/feed/local inputs and emits immutable exhaustive composer states without network, React, or hidden authority logic. |
| `SPC-02` | Availability covers every coordinator write-block cause plus exact target, disclosure, session lifecycle/freshness/turn state, replay, stream continuity, and current failure state with stable bounded disabled copy. |
| `SPC-03` | Empty, whitespace-only, oversized, invalid target, and disabled submissions create no operation id, request, draft mutation, success state, or private output. |
| `SPC-04` | Every explicit valid submit canonicalizes once, creates one secure prompt-scoped operation id, and issues one exact `prompt_dispatch` request through `requestProtected`; no direct fetch or retry exists. |
| `SPC-05` | Pending submission disables input/send and rejects click, key, reentrant, rerender, and double-submit races without a second request. |
| `SPC-06` | Only a strict correlated `202` for operation, kind, and selected session clears the submitted draft and enters accepted state; acceptance never means running or completed. |
| `SPC-07` | Exact matching turn events alone advance accepted to running, needs input/approval, completed, interrupted, failed, or unknown; unrelated/out-of-order/retained events cannot. |
| `SPC-08` | Known rejection preserves the draft and exposes explicit retry only when the public envelope marks it safe; retry is user-triggered, rechecks current authority, and uses a fresh operation id. |
| `SPC-09` | Timeout, transport ambiguity, invalid/oversized response, correlation mismatch, post-dispatch abort, and authority race latch `outcome_unknown`, preserve the draft, prohibit same-document retry, and require reload/activity inspection. |
| `SPC-10` | Target change and unmount abort the exact in-flight owner once, reset receipt/failure/draft ownership, suppress late settlement, and leave no timer/listener/controller residue. |
| `SPC-11` | Prompt content never renders outside its editable textarea or fixture-only timeline event; operation/audit/turn/runtime ids, CSRF/cookie values, private target data, and raw failures never enter UI copy, URL/history, browser storage, console, screenshots, or persisted evidence. |
| `SPC-12` | The production Session Detail route renders one target-aware Focus Rail composer only after disclosure; authority loss removes writable content and disables or suppresses submission without leaking retained protected truth. |
| `SPC-13` | Textarea, send icon, tooltip/name, status live region, multiline behavior, focus, touch size, safe area, reduced motion, and keyboard semantics are accessible and do not invent unsupported controls. |
| `SPC-14` | Empty, composing, submitting, accepted start, accepted steer, running, completed, retryable failure, nonretryable failure, unknown outcome, and all disabled families have component and deterministic screenshot evidence. |
| `SPC-15` | Production browser tests prove exact request body/target, one-attempt behavior, API correlation, event-driven progress, no prompt reflection, reload/history/storage privacy, and clean console/network ownership. |
| `SPC-16` | 320 reflow, 360/390/412/768/1280 layouts, 200 percent zoom, short height, long target/text/error, scrolled feed, new activity, and opened software keyboard preserve usable composer/feed geometry with no overlap or horizontal overflow. |
| `SPC-17` | Selected Fastify/SQLite evidence proves one paired-HTTPS prompt from browser coordinator through CSRF/write gate to accepted audit and later projected terminal truth, including rejection, ambiguity, privacy, and cleanup. |
| `SPC-18` | A physical Android Chrome run over cellular plus private Tailscale HTTPS uses automated one-time-link pairing, opens the keyboard, edits multiline text, sends once, sees accepted then authoritative progress, and restores phone/laptop state without QR scanning, LAN, custom CA, or ADB tunnel. |
| `SPC-19` | Approved Focus Rail comparison records temporary omission of separately owned primary controls and finds no Signal Ledger, desktop console, terminal, raw slash, card nesting, clipping, or unapproved structural drift. |
| `SPC-20` | Focused/web/browser/workspace/type/lint/planning/runtime/package/install/audit/privacy/residue gates pass; downstream controls, complete-dashboard hardening, and release acceptance remain open. |

## Planned Validation

```bash
pnpm --filter @hostdeck/web test
pnpm --filter @hostdeck/web typecheck
pnpm --filter @hostdeck/web build
pnpm test:browser:shell
pnpm test:web
pnpm test:unit
pnpm test:contract
pnpm test:integration
pnpm typecheck
pnpm lint
pnpm check:scaffold
pnpm check:runtime-boundary
pnpm check:planning
pnpm test:package
pnpm install --offline --frozen-lockfile
pnpm audit --prod
pnpm smoke:prompt-android
git diff --check
```

Focused real-route validation will compose the selected Fastify prompt route, paired HTTPS/CSRF authority, real SQLite audit, fake Codex prompt service, and projected event handoff without a model call. Browser and physical evidence must use fixture prompt text only, redact the private DNS/device identity, remove ephemeral phone captures, and restore Serve, browser, keyboard, Wi-Fi, stay-awake, and ADB state.

## Evidence

### Implementation

- `6232718` implements the prompt-scoped operation id, exhaustive headless state/projector/controller, production Session Detail composer, Focus Rail styling, browser fixture, and deterministic visual evidence. `979ee96` adds the production physical Android prompt path.
- `2bb2199` updates disclosed production dependencies without changing the prompt contract. Physical-runner hardening from `345a311` through accepted revision `cb6bc1d` aligns the strict Fastify/SSE contracts, proves phone-side cellular Tailscale HTTPS without blocking the server event loop, targets the real Android editor and keyboard state, and verifies teardown without QR, ADB tunneling, certificate bypass, or retry.
- No `/model`, `/goal`, `/plan`, utility, approval, interrupt, archive, resume, terminal, or generic slash-input control was added. The three primary controls remain separate leaves.

### Automated Validation

- Web package: 15 files and 211 tests passed. Aggregate web: 16 files and 214 tests passed. Chromium shell/detail/composer: 18 passed; the focused prompt-composer rerun passed 6 and reproduced the final FE-V1-020 screenshot hashes.
- Workspace unit: 207 files and 2,069 tests passed with 28 explicit skips. Contract: 243 passed. Integration: 36 passed. The physical opt-in file passed all 18 tests on the accepted run.
- Root and web typechecks, lint/exports over 600 files and 8 packages, scaffold (8 packages/21 scripts), selected runtime boundary (612 production modules/22 externals), and planning integrity (219 tasks/84 requirements/675 dependencies/17 queued before closure) passed.
- The production Vite build emitted 28.00 kB CSS and 679.58 kB JavaScript. Deterministic package acceptance passed two builds at 6,445 entries, the frozen offline install was already current, and `pnpm audit --prod` reported no known vulnerabilities.

### Deterministic Visual Evidence

All 19 retained captures and `layout-measurements.json` were manually inspected against Focus Rail. The 320 short-height, 390 keyboard-height proxy, 768, 1280, and 200 percent zoom evidence preserves the target, editor, send action, status, timeline, focus, wrapping, and sticky geometry without overlap or horizontal overflow. Disabled, rejection, unknown-outcome, accepted, running, and completed states remain visually distinct without color-only meaning. There is no Signal Ledger borrowing, card nesting, terminal/raw slash surface, desktop-led restructuring, or unapproved structural drift. The separately owned primary-control dock is intentionally absent until `FE-V1-021`, `FE-V1-026`, and `FE-V1-027`.

```text
a9f20d5156df1c48eba5446f55968dd3946c1ebaa74c5bca9e7adada6b59f976  accepted-start-390x844.png
9a44c969d4a6dda698884cb3a1b0f03810e011c1a1e937628e4ee05d5d772cbe  accepted-steer-390x844.png
6b332157b1ab101f5cab949d8c5fd8ec3cdf6c5150ffe6f506a8d3c99287995a  completed-390x844.png
1f53a33ff830604ace005381c38896d3f550425cb2bad2099e1a92f6ccf9afe7  composing-390x844.png
95627b58a3149e453dcbffcdfc62c791ce77b036d7762cb5f6dd4de9a678f97c  disabled-csrf-390x844.png
539a392af4dd55f7fba50c44b6d1f1ef7081a3683cd3b9cb3b531d46ff53b3c6  disabled-host-locked-390x844.png
374cf62a59895465e4538c16c28d7d6153e7c71ed08e372056ef648e343ec9c6  disabled-needs-input-390x844.png
dc99865a4076216f78f021148ea367c0c1922c01b5b83b20a34207c6ab6efe29  disabled-read-only-390x844.png
8803e08e96541f05b995e85aef8a231e82fc9e702397ff1571f408d57808077c  disabled-stale-session-390x844.png
cd36eaaf37f0a36997f155f25e35d95c352f48e5380e1a2992b28cb7248bdf40  disabled-turn-unknown-390x844.png
ea9b30cc6d51047ada9eb0a3d601e80f19b46adf44c3b03580e6af71023b16a7  keyboard-height-proxy-390x420.png
31235ea9dd12827d5baa3eac38e4169801ab09a622e8e073c79cdbe81c252cbe  nonretryable-rejection-390x844.png
8cac69fa5b997edfcb46e74532ed01e9d61a23664f16b4678cd1276c6f5015f0  outcome-unknown-390x844.png
b01452bdd90b16ddb5375211c71930035a8ab1f320866348a2996407edf11560  ready-390x844.png
d1bc088bd0e18911f916f836da97ffb00dc6653457fe40aacda2c8231327a15d  retryable-rejection-390x844.png
d402a4a9bc3473581c68713c92662078e5e77ae6fe879e4982cc417d1caa6f47  running-390x844.png
d0d1877aab0b65335ff989a0f16b04a641b0f29dc258ecbe9757684a90a101bc  short-height-long-target-320x480.png
22074719f79573924ac11f77507464dc5ed24b236ab8f1ec8201fea14828438d  submitting-390x844.png
249b5dec67bcc811e34636f3880d830cf86c020f04ae65b1873c13102679e7b5  zoom-200-1280x800.png
```

### Physical Android Acceptance

- `pnpm smoke:prompt-android` passed all 18 tests in 61.12 seconds on clean revision `cb6bc1d`: Xiaomi 15 Pro, Android 16/API 36, Chrome 150.0.7871.181, Ubuntu 24.04.4 LTS, Node 22.22.2, and Tailscale 1.98.8.
- The harness disabled Wi-Fi, foregrounded Android Tailscale, proved phone-to-laptop tailnet reachability and certificate-verifying private Serve HTTPS, handed one one-time pairing link to Chrome through bounded stdin-only USB debug control, and made zero QR scans. USB was only the bootstrap/test driver; HostDeck requests used cellular plus Tailscale and never ADB forward/reverse, LAN, Funnel, a custom CA, or `--insecure`.
- The real production UI paired once, opened Session Detail and one bounded recent-replay/live stream, displayed the software keyboard with target/editor/send/status visible, preserved an exact two-line 45-character edit, sent one `start` prompt request, showed accepted, running, and completed states from authoritative events, and self-revoked writer authority.
- The machine-readable proof is `artifacts/fe-v1-020-selected-session-prompt-composer/physical-android.json`. It retains no private origin, runtime identifier, prompt text, pairing/CSRF material, or phone screenshot.

### Cleanup And Disposition

- Final Serve status is `{}`; Wi-Fi and stay-awake state are restored; Chrome is stopped; the keyboard is closed; ADB forward/reverse lists are empty; the listener/database/temporary state are closed; and stream subscribers are zero.
- `SPC-01` through `SPC-20` pass. Complete dashboard hardening, packaged web assets/install parity, remaining controls and recovery surfaces, supported-browser/device release acceptance, and V1 go/no-go remain downstream; this leaf is not a release claim.
