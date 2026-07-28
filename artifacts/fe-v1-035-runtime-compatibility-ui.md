# FE-V1-035 Runtime Compatibility UI

Date: 2026-07-27

Status: complete; `RCU-01` to `RCU-24` pass.

## Scope

Implement one phone-first Codex compatibility presentation over the protected `host_status.compatibility` projection proven by `IFC-V1-087`. Show exact public compatibility state, currentness, observed versus supported version, and aggregate capability truth in Host & Access; reuse the same headless projection for bounded Mission Control and Session Detail warnings. Add one explicit read-only compatibility check owner with no mutation or retry behavior.

Excluded: changing the reviewed Codex 0.144.0 binding, accepting a new runtime version, probing or updating Codex from the browser, restarting HostDeck, exposing capability names or raw reasons, adding a route or desktop console, terminal/raw-protocol/shell fallback, changing Tailscale/profile/Serve state, automatic polling/retry, persisting browser state, or claiming complete dashboard/device/release hardening.

## Audit Findings

- Production already exposes one strict seven-field compatibility object with six states, three evidence classes, four aggregate capability cues, and a monotonic `recorded_at` revision. Browser code must consume that object rather than infer detailed compatibility from local-health cause strings.
- The coordinator already reads protected host status only after current session-read authority and blocks writes whenever host status is absent, stale, mutation-closed, or ineligible. Compatibility UI must not create a parallel permission or mutation policy.
- Mission Control and Session Detail currently collapse all incompatibility into generic copy that always says to update Codex. That is wrong for exact-version interface/capability incompatibility and omits observed/supported versions.
- Host & Access exposes only a coarse laptop-host fact. It does not show compatibility evidence, versions, aggregate capability, check time, or an explicit check action.
- Session Detail can retain a readable disconnected session while the runtime is incompatible; its current notice path can therefore omit the compatibility failure even though controls are blocked.
- The existing coordinator `refresh` operation is the selected same-authority read owner. A compatibility check can call it once and inspect the resulting protected host snapshot without adding an API route or special transport.
- A same-revision reread cannot prove recovery. A check that begins from non-supported recorded evidence may acknowledge recovery only from a current supported record whose `recorded_at` is strictly newer.
- Approved Focus Rail assets already provide an in-flow owner/state/detail/action rail in Host & Access and compact route notices. No new structural mockup, desktop panel, or modal is required.

## Frozen Boundary

### Headless Projection

- Add one strict projector from a frozen `BrowserConnectionSnapshot` to an immutable public-only compatibility view. It consumes `snapshot.host.data.compatibility` only when current session-read authority permits protected disclosure.
- Preserve all six server states: `supported`, `degraded`, `incompatible`, `unknown`, `disconnected`, and `version_drift`. Do not derive a more favorable state from local health, target data, or a previous response.
- Keep browser resource freshness independent from server evidence. A retained compatibility object in a stale or failed host resource is presented as last known and never current, verified, writable, or recovered.
- Distinguish `current`, `last_known`, and `unobserved` evidence in visible text. Show `observed_version` as installed/observed only when non-null; otherwise show an explicit not-observed value. Always show the supported version after protected disclosure.
- Map aggregate capability only to `Verified`, `Limited`, `Blocked`, or `Unverified`. Never expose binding ids, capability names, schema detail, raw reasons, executable/socket/path/process data, command output, environment, identity, credential, session data, or operation ids.
- `version_drift` uses the literal decision title `Codex update required` and shows installed versus supported versions. `incompatible` uses distinct interface/capability copy and does not falsely claim version drift or prescribe a command.
- `degraded`, `unknown`, and `disconnected` remain non-healthy. `supported` requires the strict current/exact/verified server shape plus a current browser host resource.
- Access loss, authority replacement, closed coordinator, or host-data purge immediately removes all retained protected version/check detail from the compatibility view.

### Explicit Check Owner

- Add one persistent compatibility controller under the existing shell-level Host & Access owner. It has exactly one `check` action and delegates to one coordinator `refresh` call; it issues no direct fetch, mutation, Codex operation, service action, or external-network action.
- Check admission requires a current readable exact browser authority and a current route target. The owner captures authority, target, epoch, starting state, and starting `recorded_at` before dispatch.
- Duplicate activation coalesces onto the same promise. There is no timer, poll, automatic retry, automatic second read, or failure-triggered replay.
- Route/target change, authority change/loss, close, or superseding coordinator epoch suppresses the settlement and purges activity without reusing private state. Closing aborts owned activity where possible and settles callers without residue.
- Check failure is explicit, private-free, retryable only by a new human activation, and retains no fabricated current/recovered claim.
- A check from non-supported recorded evidence may report supported/recovered only when the result is current `supported/current/verified`, exact-version, and has `recorded_at` strictly newer than the captured non-supported revision. Same/older revision, stale host data, or missing evidence reports recovery unconfirmed and leaves unsafe controls governed by existing fail-closed coordinator truth.
- A check from unobserved evidence may confirm a current supported record with a non-null revision. Rechecking an already current supported record may confirm current truth without calling it a recovery.

### Focus Rail UI

- Add one full-width `Codex runtime` Focus Rail section inside Host & Access, adjacent to existing host and remote recovery ownership. It contains owner/source label, state title/detail, observed version, HostDeck-supported version, capability cue, evidence cue/check time, and the sole check button.
- The rail uses existing surface, divider, semantic tone, Lucide icon, 6px-or-less radius, 44px target, stable type, reduced-motion-safe spinner, and responsive one-column action layout. It is not a nested card, route, modal, desktop sidebar, or command console.
- Mission Control and Session Detail reuse the same headless title/detail through their existing notice grammar. Supported current truth stays quiet; every actionable/non-current compatibility state remains visible before session actions or timeline content.
- Mission Control's three-cell mobile host rail remains structurally unchanged. Its state cell may use `Update required`, `Incompatible`, `Unknown`, `Disconnected`, or `Degraded` when exact compatibility truth is the deciding condition.
- Session Detail shows compatibility failure even when durable session data remains readable. All prompt, approval, goal, model, plan, compact, interrupt, archive, and other unsafe mutations continue to consume coordinator write eligibility and remain disabled for mutation-closed compatibility states.
- Copy names the laptop as the place where Codex is inspected or changed. It offers no browser update button, download link, package-manager command, raw version probe, terminal, arbitrary URL, or fallback transport.

## Strict Success Criteria

- `RCU-01`: one immutable projector consumes only the selected protected compatibility object plus browser access/resource freshness and preserves all six states.
- `RCU-02`: supported renders only for current browser host data with exact `supported/current/verified` contract truth; stale or retained data never looks healthy.
- `RCU-03`: version drift visibly distinguishes installed and supported versions under `Codex update required` and blocks mutation truth.
- `RCU-04`: exact-version incompatible truth is visibly distinct from version drift and never falsely says that a newer version alone is proven to fix it.
- `RCU-05`: degraded current/limited and degraded last-known/unverified remain distinct, non-writable, and actionable without fabricated diagnosis.
- `RCU-06`: unknown unobserved and unknown last-known states remain distinct; missing observed version and timestamps are explicit rather than invented.
- `RCU-07`: disconnected exposes only last-known evidence, says the runtime is disconnected, and never claims current capabilities.
- `RCU-08`: observed/supported version, capability cue, evidence cue, and bounded check time are complete and internally consistent for every disclosed state.
- `RCU-09`: no binding id, capability inventory, raw reason, schema, executable/socket/path/process, command output, environment, identity, credential, operation id, or session data enters the view.
- `RCU-10`: access loss, authority replacement, host purge, and close synchronously remove retained protected compatibility detail.
- `RCU-11`: one shell-lifetime controller owns the sole compatibility check and invokes exactly one coordinator refresh per explicit attempt.
- `RCU-12`: duplicate activation coalesces; no auto retry, polling, second fetch, mutation, Codex dispatch, service restart, or external-state change occurs.
- `RCU-13`: target/epoch/authority races and close suppress stale settlement, settle callers, and leave no listener/promise/activity residue.
- `RCU-14`: failure is explicit and private-free; a retry requires one new human activation and cannot reuse a failed result as current.
- `RCU-15`: recovery from recorded non-supported truth requires a newer current supported revision after the explicit check; same/older revision is visibly unconfirmed.
- `RCU-16`: a supported recheck is not mislabeled recovery, while unobserved-to-supported confirmation requires a non-null current revision.
- `RCU-17`: Host & Access has one complete accessible Focus Rail compatibility section and no second action owner.
- `RCU-18`: Mission Control and Session Detail use the same headless compatibility copy/state, stay quiet when current supported, and show non-supported decision truth in flow.
- `RCU-19`: the three-cell mobile rail, grouped mission queue, session timeline, sticky controls/composer, and existing Host & Access recovery hierarchy retain approved Focus Rail structure.
- `RCU-20`: every compatibility-blocked mutation remains disabled by the selected coordinator/control contracts; UI adds no local bypass or fallback.
- `RCU-21`: 320/360/390/412/768/1280, short-height, long-version, and 200-percent-reflow captures have no overlap, clipping, horizontal scroll, hidden action, or unstable target.
- `RCU-22`: semantic heading/description/status or alert roles, keyboard focus, 44px action target, disabled/busy state, live update behavior, and reduced motion pass component and Chromium checks.
- `RCU-23`: focused, full web, unit, contract, integration, typecheck, lint/exports, scaffold, planning, runtime-boundary, build/package, frozen-install, audit/license, privacy, diff, and residue gates pass or a real unrelated limitation is recorded.
- `RCU-24`: owner docs, artifact/screenshots/layout evidence, task state, coherent commits, and push state match actual behavior; this leaf does not claim aggregate dashboard, physical-device, packaging parity, or release readiness.

## Required Evidence

- Projector tests for every valid compatibility state/evidence/capability combination, browser-stale overlays, authority hiding/purge, hostile snapshots, and privacy strings.
- Controller tests for one refresh, duplicate activation, current result, check failure, same/older/newer recovery revision, unobserved recovery, target/authority/epoch races, close, listener bounds, and hostile ports/promises.
- Component tests for complete facts, exact copy distinctions, sole action ownership, accessibility, and reduced-motion-safe busy presentation.
- Mission Control and Session Detail tests proving shared compatibility notices, exact state labels, readable diagnostic data, and blocked unsafe controls.
- Chromium fixture/API tests for all six states, current/last-known/unobserved evidence, explicit check transitions/failure, diagnostic readable routes, responsive/reflow/long content, request count, privacy, console/page errors, and screenshots against the approved Focus Rail mapping.
- Full selected validation and clean repository/push evidence without staging the user's pre-existing artifact changes.

## Implementation Record

- Added one strict immutable projector over the seven-field protected compatibility contract. It preserves all six states and all valid current/last-known/unobserved evidence products, downgrades retained browser data, and purges protected detail on authority loss or close.
- Added one shell-lifetime controller whose sole action delegates to exactly one coordinator refresh. Duplicate activation coalesces; target, authority, epoch, and close races suppress settlement; failure requires a new human attempt; recovery from recorded non-supported truth requires a newer current supported revision.
- Added one flat `Codex runtime` Focus Rail section inside Host & access with exact installed/supported version, aggregate control capability, evidence/check time, semantic status/alert behavior, and a 44 px read-only check action. It adds no route, modal, terminal, command, update action, persistence, or production dependency.
- Mission Control and Session Detail reuse the same projector for exact update-required, incompatible, degraded, unknown, disconnected, and stale copy. The three-cell Mission Control rail is unchanged, readable Session Detail diagnostics remain visible, and existing coordinator write eligibility continues to disable unsafe controls.
- Added deterministic strict fixtures and production-shell coverage for every valid state/evidence product, stale browser overlay, authority purge, pending/failed/same-revision/newer-revision checks, readable blocked Session Detail, privacy/request boundaries, long semver content, all selected widths, short height, reduced motion, and 200 percent reflow.

## Validation

| Gate | Result |
| --- | --- |
| Focused web | Six affected state/component/route/shell files pass 91 tests. |
| Aggregate web and unit | 46 web files/836 tests pass; 239 unit files/2,713 tests pass with 27 files/28 tests intentionally skipped. |
| Contract and integration | 34 contract files/245 tests and 21 integration files/36 tests pass. |
| Chromium | All six dedicated compatibility scenarios and the complete 137-scenario production shell pass. |
| Static and boundary | Root/web TypeScript, Biome and eight-package exports, 715-file lint, scaffold, planning, diff check, and the 614-module/22-external selected runtime boundary pass. The default Codex 0.145.0 correctly rejects the reviewed gate; the isolated exact 0.144.0 binary verifies all 671 reviewed files at `e1a1a5cff3ab91862f9215dd06538eae1ea0b00bae48cbb7d87061faaee27e24`. |
| Build and package | Vite and production builds pass; six structural package tests, deterministic/relocated package acceptance, and independent verification pass at 614 sources, 1,235 owned outputs, 6,449 entries, and SHA-256 `35f41f5daccab92d6ded30bf1de374d5451e1ce81282e1136a2452f7810a3ace`. |
| Supply chain | Frozen offline install passes, production audit reports no known vulnerabilities, and the unchanged production dependency inventory uses the existing permissive license set. |
| Visual, accessibility, privacy | 23 reviewed captures and eight layout records prove the approved flat Focus Rail hierarchy, exact state distinctions, reachable close/action controls, 44 px targets, one sheet scroller, no overlap/clipping/document overflow, reduced-motion-safe busy state, keyboard focus, private-free DOM/history/storage, read-only request ownership, and no retry or residue. |

The existing Vite large-chunk advisory remains downstream performance-hardening scope. This leaf does not change or accept the reviewed runtime binding, so the laptop's default 0.145.0 binary remains expected update-required input rather than supported-runtime evidence.

## Completion Record

- `RCU-01` to `RCU-24` are implemented and validated.
- Criteria commit: `a05bd23`. Implementation and evidence commit: `3382dec`.
- No dependency, lockfile, command, setup, service, Tailscale profile/Serve, browser storage, or phone state changed.
- The 18 pre-existing user-owned screenshot modifications were excluded from staging and restored byte-identically after aggregate browser validation.
- Remaining cross-screen state hardening, aggregate responsive/accessibility/browser hardening, packaged assets, physical-device acceptance, and release readiness remain owned by `FE-V1-015`, `FE-V1-016`, `FE-V1-039`, `FE-V1-040`, `FE-V1-090`, and release leaves.
