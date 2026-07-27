# FE-V1-034 Remote Connection Recovery

Date: 2026-07-26

Status: implementation and non-device validation complete; physical Android acceptance pending.

## Scope

Implement one read-only remote-connection recovery surface over the selected remote-ingress lifecycle and browser coordinator. Current laptop-observed Tailscale, saved-profile, private Serve HTTPS, and external-origin truth must remain distinct from local HostDeck/Codex health. The production Host & access sheet owns detailed diagnosis and local recovery; route-level notices consume the same bounded copy where remote state is currently knowable.

Excluded: profile switching, Tailscale login/logout/up/down/service ownership, Serve enable/disable/repair/reset, Funnel, public or LAN fallback, custom CA or certificate workflow, browser-side local-admin headers, remote unlock, automatic retry/polling, mutation replay, raw Tailscale output/identity/profile names, a new route, desktop-only controls, compatibility diagnosis, and release readiness.

## Pre-Change Findings

- The selected remote lifecycle already publishes strict `RemoteIngressPublicState` and `SelectedHostRemoteStatus` contracts. Public truth is bounded to generations, availability, reason, canonical external origin, laptop-action flag, and observation/check times; raw account, profile, node, source, credential, Serve document, and command output remain private.
- Current browser coordination reads `host_status` only after readable access and retains same-authority host truth as stale. The local loopback browser can therefore read lifecycle-owned remote health without browser local-admin authority. A current paired device may call exact `GET /api/v1/remote/status`; no browser may call remote enable or disable.
- A paired remote status read performs a fresh configured observation. If that observation closes the request's remote generation, server currentness suppresses the response. The phone must then show generic browser/network loss, not infer the laptop profile or Serve cause.
- `host_status.remote` has an independent health generation and nullable durable state generation. Ready requires current host status, a non-null matching state generation/origin, no cause, and no laptop action. Retained or failed status cannot remain visually ready.
- Current Host & access renders only `Ready`, `Disabled`, `Unavailable`, or `Not checked`. Mission Control has a separate coarse cause switch, while Session Detail has generic remote copy. There is no shared exact recovery projector, explicit remote check owner, or detailed Focus Rail recovery section.
- The selected API has no public in-progress remote-enable or Serve-configuration phase. `serve_absent` means only that the expected mapping is absent. The existing `access_serve_configuring` fixture and validation wording would fabricate "enable accepted" from unavailable evidence; V1 instead owns a browser `checking` phase that explicitly says no laptop setting is being changed.
- A fresh browser that cannot load the private origin executes no HostDeck code. Its only truthful recovery is browser/Tailscale network guidance. An already loaded page may label retained laptop truth as last known, but connection failure outranks that truth and no retained cause is current diagnosis.
- `DEC-028` selects Focus Rail. The approved access-recovery target uses owner-labelled flat rails for browser failure and laptop-observed disabled, Tailscale unavailable, wrong-profile, and Serve-conflict states. It authorizes no card grid, terminal, remote repair action, desktop inspector workflow, or Signal Ledger borrowing.

## Frozen Design

### Authority And Source Precedence

- Add one pure remote-recovery projection with four evidence sources: `current_laptop_observation`, `last_laptop_observation`, `browser_connection`, and `not_observed`. Current browser connection failure outranks retained laptop detail; current laptop observation outranks all retained detail.
- Current detailed truth requires readable current access plus current strict host status. A direct paired-device status request is an observation trigger, not a second durable UI authority: after it succeeds, one coordinator refresh must read the lifecycle-owned host status before the check is called recovered.
- A local loopback read cannot synthesize a local-admin status call. Its explicit check performs one coordinator refresh and consumes current `host_status.remote`; background lifecycle polling remains server-owned and is not duplicated in React.
- A paired remote check performs at most one exact `remote_status` request followed by at most one coordinator refresh. A failed, canceled, authority-invalidated, generation-changed, or malformed status call does not refresh, retry, retain its response as current truth, or call any mutation route.
- A ready projection requires current host state, `availability:ready`, a non-null state generation and external origin, null cause, false laptop action, and a current matching remote HTTPS access origin when the browser itself is remote. Any contradiction fails closed.
- When access/host truth becomes stale, failed, blocked, replaced, or closed, detailed state is labelled last known or removed. It cannot claim ready, successful recovery, active profile mismatch, or current Serve state. Authority replacement clears controller result state and suppresses late settlement.

### Exact Check Owner

- One strict persistent headless owner above route and Host & access sheet lifetimes consumes only coordinator snapshot, exact remote-status read, coordinator refresh, and close ports. It owns one explicit check, operation phase, authority correlation, result copy, and late-settlement suppression without direct fetch, React, credentials, storage, timers, or external-state adapters.
- Check availability is independent from session mutation eligibility, host lock, local Codex readiness, selected target, and stream state. It requires current readable access and a source path the browser can actually use. Unpaired remote, denied, stale, closed, or pre-load failure sends no request.
- Duplicate touch/click/Enter, rerender, StrictMode, route change, sheet close/open, and repeated `check()` while busy coalesce to one attempt. There is no interval, backoff, retry, focus/visibility listener, or automatic check after failure.
- Browser abort and close are conservative. A caller abort before HTTP dispatch sends nothing; after dispatch, failure remains unconfirmed until a later explicit check or ordinary coordinator refresh produces current laptop truth. The controller never claims that a read-only check changed Tailscale or Serve state.
- Public views are immutable and private-free. They retain no device id, authority key, configured origin beyond the selected public external-origin field, request id, cookie, CSRF value, profile comparison key, raw error, API envelope, command, account, or tailnet identity.

### Recovery Taxonomy

- `unknown/not_observed`: remote status has not been observed; check locally without claiming disabled or broken state.
- `checking`: the browser is reading current remote status; copy explicitly says no laptop setting is being changed. This replaces the unsupported "Serve configuring" claim.
- `ready`: exact private Tailscale HTTPS and the public external origin are current. The origin is inert, wrapped text, never a credential or remote-action link.
- `remote_disabled`: enable remote access explicitly from the laptop when desired. `cleanup_incomplete` remains distinct: remote admission is closed but exact mapping cleanup was not confirmed.
- `client_not_installed`, `client_unsupported`, and `client_error`: respectively install/support, compatibility, or bounded client-inspection recovery on the laptop. They do not collapse into Codex runtime offline.
- `client_stopped` and `client_signed_out`: respectively start Tailscale or sign in locally. HostDeck does neither and never offers a phone action.
- `profile_absent`, `profile_other`, and `profile_unknown`: respectively saved HostDeck profile unavailable, different profile active, or profile unverifiable. Copy never names the active/company profile and states that HostDeck made no profile change.
- `serve_absent`, `serve_foreign`, `serve_colliding`, `serve_drifted`, and `serve_public`: respectively missing expected mapping, foreign ownership, collision, changed mapping, or unsafe public/Funnel conflict. Each is distinct; all require local inspection or explicit local remote enable after conflicts are resolved. HostDeck performs no dashboard repair.
- `external_origin_invalid`: the private HostDeck address failed canonical HTTPS validation and is not rendered as a link.
- `observation_stale`, `observation_failed`, `command_failed`, `command_timeout`, `output_oversized`, `schema_invalid`, and `profile_changed`: preserve bounded check-failure families and require a later explicit/current observation. They never reuse old ready truth.
- `consent_required` and `permission_denied`: laptop approval or permission is required locally. No consent URL, shell output, privilege prompt, or automatic repeat appears in the browser.
- Generic origin unreachable/reconnecting: the browser can only say to verify the phone's Tailscale connection and the laptop locally, then try the private address again. It cannot name profile mismatch, Serve conflict, HostDeck runtime failure, certificate state, or pairing loss before the app responds.

### Shared UI And Focus Rail

- Host & access adds one flat `Remote connection` rail before page-security, lock, and device sections. It contains owner label, exact state, bounded detail, current/last-known source, optional inert private origin, and one explicit `Check remote access` action only when the check owner can dispatch.
- Mission Control and Session Detail consume the same pure state/cause copy for current laptop-observed non-ready states. Generic transport loss remains route-specific browser truth. Neither route adds a repair control, hides authorized stale reads, or creates a second live-region owner.
- Local HostDeck/Codex health, browser transport, app permission, write lock, page security, and remote ingress remain separate visible facts. Remote degradation never relabels local host readiness or independently blocks loopback mutation admission; connection/authority loss continues to block browser writes through existing owners.
- Preserve Focus Rail dark neutral surfaces, semantic rails, 6 px maximum radius, stable type, Lucide icons, 44 px controls, flat sheet sections, existing sheet scroll ownership, and phone-first hierarchy. No nested cards, terminal motif, copied shell output, desktop-only inspector, or decorative network artwork is added.
- Status uses text plus icon and owner/source labels. Stable information uses status semantics; failed explicit checks and current dangerous conflicts use bounded alert semantics. Busy state is atomic, the action remains dimensionally stable, and color is never the sole signal.
- At 320/360/390/412/768/1280, 390 x 420 short height, long origin/copy, and actual 200 percent reflow, the remote rail, state/source, check action, sheet close, route notice, and adjacent page-security/lock/device sections remain reachable without overlap, clipping, horizontal overflow, or a second scroll owner.

### Physical And Privacy Evidence

- Deterministic browser evidence covers every public reason, checking, ready, stale/retained, generic pre-load/unreachable, authority replacement, duplicate activation, failure, and recovery at the required viewports. Request inspection proves no `remote_enable`, `remote_disable`, profile, login, Serve, certificate, LAN, or unlock call.
- A physical Android run uses production private Tailscale HTTPS on an unrelated network. It captures secret-free ready, profile-away/browser-unreachable, and observation-only recovered states without re-pairing, custom CA, LAN, ADB network tunnel, or dashboard mutation.
- Physical profile switching is a human/local external action. The run proves the dashboard issued zero profile/Serve mutations, the company/non-HostDeck profile was not altered, and return recovery came from a current observation. It restores the selected HostDeck profile and leaves final Serve state/task residue clean.
- Screenshots must hide browser address bars, notifications, QR/pairing material, origin/DNS/IP, device ids, account/profile identity, cookies, tokens, and command output. Existing `IFC-V1-079` screenshots may inform the scenario but do not substitute for this production UI implementation's evidence.

## Harsh Success Criteria

| ID | Requirement |
| --- | --- |
| `RCR-01` | One strict persistent headless owner consumes only exact snapshot/status/refresh/close ports; malformed construction/state, authority replacement, close, and late foreign settlement fail or suppress without direct HTTP, React, credential, storage, timer, or external-state ownership. |
| `RCR-02` | The coordinator exposes one exact read-only paired-device remote-status operation. Generic protected requests and product UI cannot invoke `remote_enable` or `remote_disable`, and forged mutation/status paths fail before the HTTP client when outside their exact admission. |
| `RCR-03` | Local loopback check performs one coordinator refresh; current paired remote check performs one status read then at most one refresh. Denied/stale/closed/pre-load states send zero calls, and no path retries, polls, backs off, or auto-runs. |
| `RCR-04` | Duplicate activation, rerender, StrictMode, route/sheet lifecycle, caller abort, and repeated busy checks produce at most one owned attempt with deterministic settlement and no unhandled rejection. |
| `RCR-05` | Direct remote-status data is only an observation trigger. UI recovery requires later current lifecycle-owned `host_status.remote`; failed or generation-closing status cannot install a parallel ready/profile/Serve truth. |
| `RCR-06` | Source precedence is exact: current laptop observation, browser connection failure, last laptop observation, then unobserved. Current browser failure cannot be overwritten by a retained profile/Serve diagnosis. |
| `RCR-07` | Ready requires current readable host/access truth, exact ready fields, non-null current origin/generation, and matching remote browser origin when applicable. Unknown, stale, failed, contradictory, or older-generation data never appears ready. |
| `RCR-08` | Disabled and cleanup-incomplete remain distinct, state that laptop action is required, and expose no dashboard enable/disable control, hidden fetch, automatic cleanup, or claim that HostDeck changed external state. |
| `RCR-09` | Tailscale absent/unsupported/error/stopped/signed-out states have distinct bounded labels and local recovery; none is conflated with Codex runtime, phone pairing, browser page security, or HostDeck local health. |
| `RCR-10` | Profile absent/other/unknown states remain distinct. Wrong-profile copy names only the saved HostDeck profile, never the active/company profile, and explicitly avoids any automatic/remote switch claim. |
| `RCR-11` | Serve absent/foreign/colliding/drifted/public and invalid external origin remain distinct, with local-only inspection/recovery and no repair/reset/Funnel/certificate/LAN/custom-CA workflow. |
| `RCR-12` | Consent, permission, stale/failed observation, command/timeout/oversize/schema/profile-change, and generic client failures retain bounded truthful copy without raw errors, URLs, output, privilege controls, silent fallback, or old-ready reuse. |
| `RCR-13` | Browser-owned checking is explicitly read-only and cannot be described as accepted enable or Serve configuration. The impossible `access_serve_configuring` claim is removed from the V1 state contract. |
| `RCR-14` | A fresh unreachable private origin remains outside React and receives only browser/Tailscale network guidance. Loaded transport loss shows generic current failure and, at most, clearly labelled last-known laptop detail. |
| `RCR-15` | Local HostDeck/Codex health, remote ingress, browser transport, app permission, lock, CSRF/page security, and stream continuity remain independent in projection, copy, tests, and mutation admission. |
| `RCR-16` | Host & access renders one flat owner-labelled Remote connection rail with exact state/source, bounded recovery, optional inert public origin, and one availability-correct check action before the existing security/device sections. |
| `RCR-17` | Mission Control and Session Detail use the same remote cause projector for current detailed truth while preserving generic connection loss, authorized readable/stale content, and their existing action ownership. |
| `RCR-18` | Production composition mounts one remote-check owner above route and sheet lifetimes. Route navigation, sheet close/open, and adjacent controller updates neither duplicate work nor discard owned current result incorrectly. |
| `RCR-19` | Public views, DOM, logs, errors, evidence, history, and browser storage contain no device id, authority key, CSRF/cookie, operation id, raw profile/account/node/source, command output, private screenshot origin, or reusable Tailscale value. |
| `RCR-20` | Region/status/alert/button/text semantics, accessible names, keyboard activation/order, focus visibility, busy state, reduced motion, non-color meaning, stable 44 px targets, and bounded live announcements pass. |
| `RCR-21` | 320/360/390/412/768/1280, 390 x 420, long content/origin, both routes, and actual 200 percent reflow have no overlap, clipping, horizontal overflow, hidden action/close/adjacent section, or competing scroll owner. |
| `RCR-22` | Focused controller/coordinator/component/API/browser tests prove all public reasons, generations, stale/current precedence, request counts/order, duplicate/race/close behavior, no mutation, no retry, no fabricated diagnosis, and adjacent local/read/write continuity. |
| `RCR-23` | Physical Android evidence proves production ready, profile-away generic browser failure, profile-return observation-only recovery without re-pairing, unrelated-network private HTTPS, zero dashboard profile/Serve mutation, privacy, and complete restoration/cleanup. |
| `RCR-24` | Full web/unit/contract/integration/type/lint/scaffold/planning/runtime-boundary/build/package/install/audit/privacy checks, source/visual inspection, owner-doc evidence, residue cleanup, and clean commit/push state pass before closure. |

## Planned Evidence

- Headless tests own strict construction, availability, source precedence, reason taxonomy, one-attempt orchestration, authority/route/sheet/close races, immutable private-free views, and no timers/retry.
- Coordinator tests own exact `remote_status` admission, forged-path rejection, request shape/count, response privacy, authority/generation currentness, and independence from session write eligibility.
- Mission Control, Session Detail, and Host & access tests own shared copy, detailed versus generic diagnosis, current versus last-known source, local-only action wording, origin rendering, and no external-state controls.
- Production-shell Chromium owns exact HTTP order, generic connection-loss boundaries, route/sheet persistence, duplicate activation, all reason families, DOM/storage/history/request privacy, responsive containment, and effective 200 percent reflow.
- Deterministic captures and layout records own Focus Rail fidelity for checking, ready, disabled, Tailscale absent/stopped/signed-out, profile mismatch, Serve missing/conflict/drift/public, invalid origin, stale/failed, generic unreachable, and recovery states.
- Physical Android owns production remote ready, profile-away browser failure, profile-return observation-only recovery, no re-pairing, no LAN/custom CA/ADB tunnel, no dashboard mutation, secret-free screenshots, and final profile/Serve/process cleanup.

## Implementation Baseline

- Added one strict persistent recovery controller and projector. Local checks perform one coordinator refresh; paired remote checks perform one exact `remote_status` read followed by at most one refresh. Failure, replacement, close, and malformed settlement paths publish no stale ready truth and perform no retry or mutation.
- Added exact coordinator admission for paired-device `GET /api/v1/remote/status`. Generic protected dispatch rejects `remote_status`, `remote_enable`, and `remote_disable` before HTTP dispatch.
- Added the flat `Remote connection` Focus Rail to Host & access and shared its current laptop diagnosis with Mission Control and Session Detail. Removed the unsupported Serve-configuring fixture claim.
- Added the production no-QR Android recovery harness and `pnpm smoke:recovery-android`. The harness owns profile-away/profile-return observation, request and audit counts, privacy-checked screenshots, authority cleanup, Serve cleanup, and phone-setting restoration.
- Focused and aggregate validation passed: 516 web tests; 21 physical-harness tests with the device case intentionally skipped; 2,371 unit tests with 28 skips; 244 contract tests; 36 integration tests; 63 production-shell Chromium scenarios; root and CLI typecheck; lint and package exports; scaffold, planning, runtime-boundary, production build, package/relocation, frozen offline install, dependency audit, and license review.
- Browser evidence covers every public recovery reason, checking, failed check, reconnecting, recovered, both production routes, 320/360/390/412/768/1280 widths, 390 x 420 short height, and actual 200 percent reflow. Layout records prove one sheet scroll owner, reachable close/action controls, 44 px targets, and no document overflow.
- `RCR-01` through `RCR-22` are implemented and validated. `RCR-23` and the physical portion of `RCR-24` remain open until `pnpm smoke:recovery-android` passes on the connected phone and its sanitized evidence is inspected.

## Physical Run Log

- Attempt 1 reached the production Host & access sheet over cellular plus private Tailscale HTTPS, then stopped before interaction because the Android driver searched only the initial viewport for the below-fold Remote connection rail. No physical criterion was accepted from this run.
- Failure cleanup restored the dedicated saved profile, removed the dedicated Serve mapping, closed Chrome/runtime state, restored phone network settings, left no ADB application tunnel, and published no partial evidence.
- The driver now performs at most four device-relative swipes within the existing single sheet scroll owner to reveal the recovery rail, then reverses direction to reach the explicit close control. This changes only physical navigation; production UI and acceptance assertions remain unchanged.
- Attempt 2 reached and activated the production recovery control, then stopped at the immediate no-mutation/request-count assertion. Cleanup again restored the dedicated profile and absent Serve state and published no partial evidence. Sanitized per-route and manager counters were added at the pre-check and post-check boundaries so the next run can distinguish unexpected prior browser traffic, duplicate status dispatch, and external mutation without exposing private values.
- Attempt 3 stopped at the new pre-check boundary and identified a harness-classification defect: the intentional local CLI enable was counted as browser mutation because mutation authorization is resolved from loopback request authority, while the inspected explicit header is used by read-only status calls. The request inspector now classifies enable/disable calls from the resolved authentication context during response serialization. The baseline also pins the pairing-link client's two required local status reads around issuance; the complete expected run is two local pairing reads, two browser checks, and one local profile-away read.
- The next launch was rejected before setup when USB was absent; it changed no runtime state. After reconnection, the following launch stopped before HostDeck startup because mobile data was off and disabling Wi-Fi left only carrier IMS networks. The harness now captures, enables when necessary, and restores mobile data; requires distinct validated cellular Internet and Tailscale VPN network agents with no connected Wi-Fi; and rejects IMS-only false positives. Current mobile-data authority comes from bounded `mUserMobileDataState` records, and the network parser accepts Android's observed `CELLULAR|VPN` Tailscale handoff without treating the VPN itself as cellular proof. No partial evidence was published.
- One launch was rejected before setup because Android had relocked. The next launch was rejected by the exact environment gate after the laptop package automatically advanced from the spike-frozen Tailscale `1.98.8` to `1.98.9`; Android remained on `1.98.8`. The laptop package and daemon were restored and held at exact `1.98.8` instead of weakening the compatibility contract inside this UI task. Follow-up inspection found that this failed preflight had enabled cellular service but its best-effort `finally` path silently lost the mobile-data restoration failure. The original off state was restored manually before any further run.
- The following run reached the production ready screenshot checkpoint over cellular plus private HTTPS, where the evidence privacy guard rejected Chrome's visible address-bar origin. It published no partial evidence and restored its inherited baseline, but that baseline already contained the prior mobile-data cleanup defect. Failure cleanup now preserves the original acceptance error, independently attempts every Chrome, profile, Serve, lifecycle, database, temporary-state, Wi-Fi, mobile-data, stay-awake, and ADB-tunnel cleanup, and reports privacy-safe aggregate failures instead of swallowing them.
- Evidence capture now requires one exact Chrome toolbar and compositor geometry, scans every semantic node intersecting the retained page viewport, decodes the bounded full screenshot in memory, and writes only the app viewport. Ambiguous geometry, retained private page material, malformed PNG data, or out-of-bounds crop fails closed; deterministic geometry and pixel-copy tests pass.
- Clean revision `7c32565` then stopped before network mutation because Xiaomi's complete telephony-registry dump exceeded the generic 512 KiB ADB command buffer before the current-state parser could run. The strict cleanup contract passed and retained the mobile-data-off, Wi-Fi-on baseline. Mobile-data observation now runs one static on-device filter for only exact `mUserMobileDataState` boolean lines, retains the same one-to-four uniform-state parser, and lowers the accepted result bound to 1 KiB.

## Reuse And Ownership

Reuse the selected remote-ingress and host-health contracts, lifecycle-owned host status, bounded browser HTTP client, persistent coordinator, existing Host & access sheet, Focus Rail recovery rail, Lucide icons, deterministic fixtures, and Android acceptance infrastructure. Add no production dependency. The physical evidence harness directly declares existing `pngjs` `5.0.0` as a test-only dependency for bounded in-memory viewport cropping.

`FE-V1-034` owns browser read-only status checking, exact remote recovery projection/copy, detailed Host & access presentation, route-level shared diagnosis, and production UI/profile-switch evidence. It does not absorb remote lifecycle/CLI mutation ownership, `FE-V1-035` compatibility, `FE-V1-015` cross-screen failure hardening, `FE-V1-016` complete device acceptance, `FE-V1-039` dashboard hardening, or release readiness.
