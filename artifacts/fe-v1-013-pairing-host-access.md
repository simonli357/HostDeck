# FE-V1-013 Fragment-Safe Pairing And Host Access

Date: 2026-07-22

## Scope

Integrate the completed fragment-safe pairing boundary into the production browser startup path and replace the production Host & access placeholder with a thin, persistent projection of the selected connection coordinator. This leaf owns pre-React pairing startup order, sanitized pairing progress/result UI, successful CSRF adoption into the one production coordinator, access-first disclosure, current permission/lock/origin/read/write/host/stream summaries, Focus Rail pairing and access presentation, deterministic browser evidence, and a physical Android QR pass through private Tailscale Serve HTTPS.

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
| `PHA-19` | A physical Android scan through private Tailscale Serve HTTPS with no laptop-LAN route or custom CA proves scrubbed claiming, paired confirmation, Mission Control, Host & access truth, reload, and privacy-safe screenshot/manual evidence. |
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

Criteria are frozen before implementation. Implementation, validation results, deterministic screenshot hashes, physical Android observations, drift disposition, and commit ids remain pending.
