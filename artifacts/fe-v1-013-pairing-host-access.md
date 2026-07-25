# FE-V1-013 Fragment-Safe Pairing And Host Access

Date: 2026-07-22

## Scope

Integrate the completed fragment-safe pairing boundary into the production browser startup path and replace the production Host & access placeholder with a thin, persistent projection of the selected connection coordinator. This leaf owns pre-React pairing startup order, sanitized pairing progress/result UI, successful CSRF adoption into the one production coordinator, access-first disclosure, current permission/lock/origin/read/write/host/stream summaries, Focus Rail pairing and access presentation, deterministic browser evidence, and a physical Android claim of the generated QR payload through private Tailscale Serve HTTPS.

This leaf does not create pairing links or QR codes, retry an uncertain claim, persist credentials, manage paired devices, implement CSRF reload recovery, mutate lock state, diagnose or repair Tailscale/profile/Serve state in detail, expose runtime-version detail, or implement prompt/control actions. Local QR creation remains `codexdeck pair`; `FE-V1-031` to `FE-V1-035` own CSRF recovery, devices, lock controls, remote recovery, and compatibility. No phone profile switch, Serve mutation, remote unlock, LAN/custom-CA fallback, terminal, or raw shell surface belongs here.

## Pre-Change Findings

- `IFC-V1-077` already provides a hardened browser bootstrap. It reads the fragment once, replaces history with `/` before operation-id creation or fetch, validates one private Tailscale HTTPS root, issues one no-referrer claim, performs one CSRF bootstrap, maps bounded outcomes, and has browser plus physical Android evidence.
- The production entry never calls that bootstrap. `HostDeckBrowserApp` creates the browser coordinator from a React effect, while route children start access/session loads from their own effects. Adding pairing in another effect would create an ordering race and React StrictMode could duplicate startup ownership.
- A successful bootstrap returns the raw CSRF value in page memory, but production never adopts it into the coordinator. The coordinator already exposes exact `adoptCsrfBootstrap`; adoption before the first target load prevents a redundant rotation and keeps all later write gating under the existing CSRF owner.
- The shell's Host & access trigger is selected and accessible, but production always renders `HostAccessLoading` inside it. Mission Control has a route-backed compact rail; Session Detail and the sheet do not yet share one persistent access projection.
- `GET /api/v1/access` is the only pre-pairing app read and is safe for access-only disclosure. Host status, session reads, stream state, and CSRF truth become available only through the coordinator after current readable authority.
- A fresh phone that cannot load the private origin receives only the browser/Tailscale network error page. HostDeck cannot render or diagnose laptop profile, Serve, runtime, or pairing state before its document loads.
- The approved Focus Rail targets are `pairing-journey.png`, `access-recovery-states.png`, `design-system.md`, and `theme.md`. The pairing rail structure is selected, while typed contracts override illustrative permission-before-claim copy: requested permission is not available to the browser until the accepted claim response.
- No new dependency is required. Existing React, Radix Dialog, Lucide, coordinator, pairing bootstrap, Testing Library, and Playwright owners cover the leaf.

## Frozen Design

### Production Startup Ownership

- One headless app-startup controller is created before `createRoot().render`. Creation immediately starts `bootstrapWindowPairing`, so any nonempty fragment is removed synchronously before React, BrowserRouter, coordinator construction, operation-id creation, route reads, referrer-capable work, or visible app content.
- The controller has exact injected bootstrap/coordinator/reload ports for tests, an immutable sanitized snapshot, stable subscription, one explicit `continueToApp` transition after success, and idempotent close. It performs no storage, logging, polling, Tailscale mutation, or timer work.
- Its public states are bounded: checking, claiming, paired confirmation, normal app ready, invalid/rejected link, rate limited, temporarily unavailable, unknown claim outcome, paired with CSRF unavailable, startup failure, and closed. Public state never contains the raw fragment/code, device id, CSRF token/generation, cookie, source/profile identity, URL query, or thrown cause.
- No-fragment startup creates exactly one production coordinator and opens the normal route. A successful claim creates exactly one coordinator, adopts the returned CSRF bootstrap before any route load, discards the raw result reference, and pauses on a paired confirmation until the user explicitly opens Mission Control.
- Claim/entry failure creates no coordinator and therefore starts no access, host, session, SSE, or CSRF-client request. Pairing-CSRF failure never repeats the one-time claim or starts the normal coordinator in that document; bounded copy directs the user to reload so ordinary cookie authority can be checked without the fragment.
- Startup close ignores late publication and closes an already-created coordinator once. React StrictMode does not construct, claim, adopt, or close the externally owned startup controller twice.

### Pairing Truth And Recovery

- The existing pairing bootstrap remains the network owner: one exact root fragment, history removal before work, one claim, one post-claim CSRF bootstrap, selected byte/schema/framing limits, no referrer, no redirect, no cache, same-origin credentials, and no automatic retry.
- Pairing starts automatically after secure fragment removal because the frozen `IFC-V1-077` contract does not expose permission before claim and already submits once. The UI preserves the selected finite progress rail but does not invent a pre-claim `Read & write` review or a second Pair action.
- Invalid, malformed, expired, revoked, already-used, and losing two-tab claims share the server's intentional non-enumerating `not accepted` outcome. Origin rejection, rate exhaustion, server-declared unavailability, transport/schema ambiguity, and CSRF-after-claim failure remain distinct bounded families.
- Unknown claim outcome says that pairing may or may not have completed and offers only reload-to-check. It never retries the scrubbed code or claims success. A paired-without-CSRF result says device pairing completed but secure write setup did not; it does not claim write readiness.
- The paired confirmation shows only response-backed permission, optional bounded client label, bounded expiry, this-phone ownership, and private HTTPS transport. It never displays the device id, code, token, origin identity headers, or a fabricated laptop diagnosis.

### Host And Access Projection

- One pure projector accepts only `BrowserConnectionSnapshot` and a valid time input. It derives bounded semantic rows from exact current/stale coordinator resources and fails loudly on impossible inputs; components do not recreate authority or write-gate logic.
- The sheet exposes only producible facts: loopback versus private HTTPS connection, canonical configured origin in a wrapping non-link value, current/stale permission, paired expiry, lock, session-read availability, canonical browser write eligibility, coarse host health, and detail-stream state when applicable.
- Device ids, client labels not returned by access state, proxy/source keys, remote generation, Tailscale account/profile identity, raw health causes, CSRF generation/token, cookies, session ids, and private failure bodies never render.
- Current remote access can say private HTTPS is reached. Precise laptop Tailscale/profile/Serve recovery appears only when a current or explicitly retained host-status response carries it; a generic loaded-page transport loss stays generic. A fresh unreachable origin remains outside the app.
- Unpaired, invalid, expired, revoked, denied, and access-loss states suppress all host/session detail and retain only access-safe recovery. Read-only and lock states keep permitted reads visible while canonical write eligibility remains closed.
- Host and stream rows distinguish loading, current, stale/reconnecting, degraded/offline/incompatible, failed, not active, and closed without color-only signaling. Mission Control never fabricates a global session stream.

### Interface And Fidelity

- Pairing uses one phone-width Focus Rail surface with finite stage nodes, a compact app bar, one dominant state, bounded recovery, and one 44 px action when applicable. The browser never renders the laptop QR; that remains a local CLI surface.
- Paired confirmation requires an explicit `Open Mission Control` command. Error outcomes offer `Reload to check` only where reload can resolve cookie authority; otherwise recovery names the required local new-link action without a dead retry control.
- The existing Host & access Radix sheet remains route-preserving, labelled, focus-trapped, Escape/close dismissible, and trigger-focus restoring. Its contents are flat semantic sections and definition rows, not nested cards or a settings dashboard.
- Focus Rail tokens, Lucide icons, 0/4/6 px radii, 44 px targets, fixed type, wrap-safe long origin/error text, safe-area padding, visible focus, reduced motion, and text-plus-icon state pass at 320/360/390/412/768/1280 and 200 percent zoom.
- Deterministic captures cover claiming, paired writer, rejected/expired link, unknown outcome, paired-CSRF unavailable, unpaired access, paired read-only, paired writer, locked, stale/reconnecting, and long-origin/reflow states. Any drift from the two approved assets is recorded with typed-contract ownership.

## Acceptance Matrix

| ID | Criterion |
| --- | --- |
| `PHA-01` | Production starts one pairing owner before React; every nonempty fragment is removed before router/coordinator/API/referrer work or visible protected content. |
| `PHA-02` | Missing fragments enter the normal app without a claim; malformed origin/route/query/fragment/history cases fail closed after best-effort scrubbing and start no network or coordinator work. |
| `PHA-03` | One selected claim and one post-claim CSRF bootstrap retain all existing request/response bounds, exact schemas, no-referrer/no-store policy, one-time semantics, and zero automatic retries. |
| `PHA-04` | The app-startup controller rejects hostile ports, publishes stable immutable sanitized states, bounds subscribers, handles reentrancy/late settlement, and closes every created owner exactly once. |
| `PHA-05` | No pairing result or startup snapshot exposes raw code/fragment, device id, CSRF material, cookie, source/profile identity, private response/cause, or query/path input. |
| `PHA-06` | Successful pairing adopts CSRF into the same production coordinator before target load, causes no duplicate bootstrap, discloses no sessions before explicit continuation, and opens Mission Control once. |
| `PHA-07` | Pairing-CSRF failure, coordinator/adoption failure, unknown transport completion, close, and StrictMode remount never replay the claim, fake readiness, or leak a live coordinator. |
| `PHA-08` | Rejected/invalid/expired/used, origin-rejected, rate-limited, unavailable, unknown, and paired-without-CSRF families have accurate bounded copy and only valid recovery actions. |
| `PHA-09` | Reload/back/forward after scrubbing never reclaims; paired cookie reload follows ordinary access/CSRF authority, while unpaired or revoked reload discloses no sessions. |
| `PHA-10` | Access-first coordinator behavior remains authoritative: protected reads/SSE/writes do not start before readable access, and authority loss purges protected UI content. |
| `PHA-11` | The pure host/access projector covers every access authentication state, lock, read/write capability, connection freshness, host phase, target kind, and detail-stream phase without contradictory or fabricated labels. |
| `PHA-12` | External HTTPS origin, permission, expiry, lock, reads, canonical write gate, host health, and applicable stream state remain visible and textually distinct before any control; secret/private-only fields remain absent. |
| `PHA-13` | Generic origin loss stays generic, precise remote recovery requires selected host truth, and browser-preload failure is never represented as a HostDeck-rendered diagnosis. |
| `PHA-14` | The connected Host & access sheet is present on production Mission Control and Session Detail, preserves route and target, traps/restores focus, and never starts an extra request or mutation. |
| `PHA-15` | Pairing/access components use approved Focus Rail hierarchy/tokens/assets without QR reuse, Signal Ledger borrowing, terminal styling, profile controls, Serve controls, remote unlock, or fake downstream actions. |
| `PHA-16` | Claiming, paired, failure, unpaired, read-only, writer, locked, stale/reconnecting, and long-content cases pass semantics, keyboard, focus, contrast, reduced motion, 320 reflow, five reference widths, and 200 percent zoom. |
| `PHA-17` | Component and production-browser tests prove request ordering, explicit continuation, no disclosure, no duplicate work, history/referrer privacy, reload/back/forward, modal behavior, and empty browser storage. |
| `PHA-18` | Selected real Fastify/SQLite evidence proves production startup claim, cookie, CSRF adoption, first access/session load, audit/storage privacy, revocation suppression, and cleanup without live profile mutation. |
| `PHA-19` | The exact in-memory QR payload reaches a physical Android Chrome through bounded stdin-only USB handoff, then private Tailscale Serve HTTPS with no laptop-LAN route or custom CA proves scrubbed claiming, paired confirmation, Mission Control, Host & access truth, reload, and privacy-safe ephemeral screenshot evidence. The separate full remote smoke retains the human scanner path. |
| `PHA-20` | Focused/web/browser/workspace/type/lint/planning/runtime/package/install/audit/privacy/residue gates pass; downstream access controls and release acceptance remain explicitly open. |

## Planned Validation

```bash
pnpm --filter @hostdeck/web test
pnpm --filter @hostdeck/web typecheck
pnpm --filter @hostdeck/web build
pnpm test:browser:pairing
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
git diff --check
```

Focused real-route validation adds the selected Fastify composition around claim, CSRF, access, host, and first session read. Manual inspection covers approved-reference comparison, exact startup/request ordering, 320 px reflow, five target widths, 200 percent zoom, keyboard/focus order, reduced motion, contrast, long origin/copy containment, browser console/network/history/referrer/storage privacy, StrictMode behavior, process/temp residue, and physical Android use through private Tailscale Serve. Real screenshots or logs must redact the private DNS name, device identity, and all credentials.

## Evidence

### Implementation

- `dc7886d` implements the pre-React one-attempt pairing owner, sanitized pairing states, CSRF adoption, explicit continuation, and production Host & access projection. `622dd13` adds the production Android UI path.
- Physical-harness hardening from `519f7f4` through final accepted revision `68ea403` adds exact production preflight, stdin-only USB handoff, asynchronous Android inspection, repository-valid session state, verified UI transitions, cleanup-path ownership, bounded diagnostics, and exact audit assertions without weakening remote trust or retrying a claim.
- `be4bfbc` pins each visual suite to its approved review instant; repeated FE-V1-011 to FE-V1-013 browser runs no longer rewrite evidence as wall-clock-relative labels age.
- No dependency, selected product scope, Tailscale profile policy, Serve ownership, LAN/custom-CA behavior, or downstream control surface changed.

### Automated Validation

- Web aggregate: 14 files and 197 tests passed. Pairing Chromium: 6 passed. Shell/detail Chromium: 12 passed, including all pairing outcomes, history/referrer privacy, Host & access states, responsive widths, 320 reflow, 200 percent zoom, keyboard/focus, reduced motion, and contrast.
- Workspace unit: 205 files and 2,046 tests passed with 28 explicit skips. Contract: 243 passed. Integration: 35 passed. Root typecheck, lint/exports over 593 files and 8 packages, scaffold, and the 612-source/22-external runtime boundary passed on the final revision.
- The prior implementation gate also passed production web build, planning, deterministic package acceptance at 6,433 entries, frozen offline install, production audit, privacy/no-retry inspection, and residue cleanup. Post-implementation commits changed only acceptance tests and their browser fixture.

### Deterministic Visual Evidence

All 18 checked-in captures were manually inspected against Focus Rail. No Signal Ledger borrowing, desktop-led restructuring, overlap, clipping, horizontal overflow, or unapproved structural drift remains.

```text
ec871c7a107d787487126796c40460bc685fbd65849c80a35cd7e9ea5f32d332  access-locked-390x844.png
9b7b544f3e95f175a52ab6e806834f88f11a4fc54375abc53525ab7c3a6bbb3c  access-long-origin-390x844.png
27315d426d2c00aaec0af21a9be8713f89affba187ccf8ee4ed40b54acb37005  access-long-origin-reflow-320x800.png
d52a6b114f908a95be1470a1f23a214616f7791554fce552d5bbc5d360736a8f  access-read-only-390x844.png
57397f39cadb1adfa2acda2562dba4a1a79cf3af2aa898df05678058ca00a5dd  access-reconnecting-390x844.png
ee9a30056942dd8ecc58c8abdfa4ed44bb1e133a850f96453271ccb5949b0f2b  access-stale-390x844.png
68be226e18a4879d963290d93eec72f496ff32b63afa5a5b92334829e6fc7e3c  access-unpaired-390x844.png
56098454019acc0af804fdb043cc273d44839ff8a85490ec14cf96fa33e94347  access-writer-390x844.png
b60b929a7e5b817ab227ad9b110040d2d5789e79a86c07db265b63b2e0855b08  pairing-claiming-390x844.png
34d5b57eada666930aa92be8ec667a2cc548c723f3b84b9d6dd284f3040012fe  pairing-claim_unknown-390x844.png
45801f94405f669d46150581dbdba5d24edcfd60da3f479fced8d4ea53a8e5ff  pairing-link_not_accepted-390x844.png
a3f7216317bdc55e14e7f9edeefb4d413e5a5e5e149afbd0aa9e237493c7d6c1  pairing-paired-1280x800.png
b388b96b8e0ab8895a4db8522f9ba42b5657fd90834a0349286de1455a276d0d  pairing-paired-360x800.png
e05303016242e6eaa396a8576f1735929a2b7a836e49b676bdafb5b5a1c7c464  pairing-paired-390x844.png
30dcd9ce9dc0e1b8922c2526b7a55344512a2d7f976319bd37de3984fc6cd0c4  pairing-paired-412x915.png
67c184ba0d2571152858832985a7822083ec5d682f8d4cae37b744c134ec3ca5  pairing-paired-768x1024.png
e15453f625fd75a317110ae1d1c20e08756c258b9922f6fd9c5c53cb3d3f5551  pairing-paired_csrf_unavailable-390x844.png
1a7aa1394f42435a49a74d2aac3b06ccc9dfe3ce5720db518788f35c8ba948de  pairing-paired-zoom-200-1280x800.png
```

### Physical Android Acceptance

- `pnpm smoke:pairing-android` passed 12 of 12 tests in 56.58 seconds on clean revision `68ea403`: Xiaomi 15 Pro (`2410DPN6CC`), Android 16/API 36, Chrome 150.0.7871.181, Android Tailscale 1.98.8, and laptop Tailscale 1.98.8.
- The harness disabled Wi-Fi and proved validated `CELLULAR|VPN` transport to private Tailscale Serve HTTPS. The exact generated one-time link reached Chrome through fixed stdin-only USB debug handoff; no QR scan, ADB forward/reverse tunnel, laptop-LAN route, public Funnel, or custom CA participated.
- The phone proved one scrubbed claim, paired confirmation with no session disclosure, explicit Mission Control continuation, current writer/access/host/session truth, Host & access open/close, fragment-free reload without a second claim, three successful CSRF audit pairs plus one rejected post-revocation probe, self-revocation, cookie deletion, revoked-authority rejection, and secret-free browser cleanup.
- Physical screenshots and hierarchy dumps were held only in the private run directory and removed after assertions; the private DNS name, device authority, pairing material, CSRF material, and cookies were not published. The final run used an unobscured Chrome surface after an unrelated Android chat-head overlay was removed from the acceptance environment.

### Cleanup And Disposition

- Final Serve status is `{}`; Wi-Fi and the original stay-awake setting are restored; Chrome is stopped; launcher is foreground; ADB forward/reverse lists are empty; both Tailscale peers remain enrolled; and `main` is clean and pushed.
- `PHA-01` through `PHA-20` pass. `FE-V1-031` to `FE-V1-035`, complete dashboard hardening, package/install parity, and release acceptance remain separate downstream work; this leaf does not claim them.
