# FE-V1-011 Mobile Mission Control

Date: 2026-07-22

## Scope

Implement the default phone route as a thin React projection of the completed browser connection-state coordinator. The screen owns the Focus Rail host-status strip, grouped session queue, current/stale and failure presentation, explicit refresh and bounded pagination commands, route-safe session navigation, responsive layout, accessibility, production browser-client composition, and visual evidence.

This leaf does not own Session Detail content or SSE rendering, pairing claim/recovery, host-access sheet content, mutation controls, Tailscale/profile/Serve changes, polling, browser persistence, release packaging, or final real-phone acceptance. Those remain with `FE-V1-012`, `FE-V1-013`, `FE-V1-020` to `FE-V1-039`, `IFC-V1-053`, and `FE-V1-090`.

## Pre-Change Findings

- The selected Focus Rail direction is complete for this screen: `mobile-mission-control-mixed.png`, `responsive-continuum.png`, `design-system.md`, and `theme.md` define the hierarchy, tokens, components, and target widths. `DEC-028` permits no Signal Ledger borrowing or unrecorded structural drift.
- The current shell owns strict routing, app chrome, and the Host/access sheet, but the production entry always renders a loading placeholder. No Mission Control component or browser-client composition exists.
- `FE-V1-025` is the live source of access-first truth. The older selected-mobile fixtures remain state and visual-density inputs, not a wire contract: they cannot represent retained same-target stale resources and previously required fields the current browser API cannot produce.
- Mission Control has no session event stream. The approved raster's sample `Live` copy must become route-backed `Current`, `Stale`, `Loading`, or an exact host/runtime state rather than a fabricated stream claim.
- The session-list response is already canonically ordered by attention, last activity, and id. Rendering may group rows without re-sorting within each group; pagination must preserve the coordinator's merged order.
- No new production dependency is required. React 19, React Router, Lucide, the existing clients/coordinator, Vitest/Testing Library, and Playwright cover the leaf.

## Frozen Design

### Runtime Boundary

- One production runtime factory creates exactly one same-origin HTTP client, one SSE client, one page-memory CSRF client over that HTTP client, and one connection-state coordinator. Client construction is inert; the mounted owner closes the coordinator exactly once.
- React StrictMode setup/cleanup must not reuse a closed coordinator. Runtime creation occurs inside the owning effect, cleanup closes that exact instance, and a second development setup creates a fresh owner.
- `HostDeckBrowserApp` accepts an injected coordinator for tests/composition. Without an injected coordinator, the production owner creates one; explicit outlet injection remains authoritative for shell tests and downstream screen development.
- Mission Control subscribes through `useSyncExternalStore`, sets only the exact `mission_control` target, and exposes no transport object. Setup/action rejection becomes a bounded local screen error; it is never swallowed or relabeled as success.
- The component performs no polling, timer-driven refresh, automatic retry, browser storage, pairing mutation, Tailscale command, profile switch, or hidden fallback. Refresh and pagination happen only from explicit controls.

### Disclosure And State Projection

- No session name, path, branch, summary, goal, timestamp, count, or retained row renders before current access allows session reads. Access-only loading, denial, invalid/expired/revoked authority, and origin/network failure surfaces remain row-free.
- Same-target data retained by the coordinator may render only when its resource carries data. Any loading/stale/failed resource with retained data receives an explicit non-color `Stale`/refresh notice; it never appears current.
- The host strip has three stable cells: connection, permission, and data/runtime. Each combines Lucide icon or shape with text. Labels derive only from current/retained coordinator resources: for example `Remote ready`/`Laptop`, `Write`/`Read only`/`Locked`/`Pair required`, and `Current`/`Stale`/`Offline`/`Incompatible`/`Degraded`.
- Generic browser transport loss says the private HostDeck origin is unreachable and does not invent a laptop profile, Serve, Tailscale, or runtime diagnosis. Precise remote causes appear only when current or explicitly retained host status contains them.
- Failure copy is bounded, actionable, and source-aware without exposing route ids, status bodies, configured origin, device id, cookie, CSRF state, Tailscale identity, cwd, thread id, or raw thrown values.
- Loading, empty, mixed attention, all quiet, reconnecting/stale, locked, read-only, remote unavailable, local runtime offline, incompatible, degraded, fatal, long-content, and access-limited states have explicit render and test coverage.

### Queue Semantics

- Rows map into exactly three sections while preserving source order within each section:
  - `ACT NOW`: `needs_approval`, `needs_input`, `failed`, `stuck`, `unknown`, interrupted sessions, or non-current projections.
  - `IN PROGRESS`: current `watch` attention or `in_progress` turns.
  - `QUIET`: current idle/completed/no-attention sessions.
- Visible row status is derived from exact session truth: `Needs approval`, `Needs input`, `Failed`, `Needs attention`, `Unknown`, `Interrupted`, `Stale`, `Running`, or `Quiet`. Color never carries the state alone.
- A row shows bounded session name, project cue from the final normalized cwd segment, optional branch, status, relative activity time, and recent summary with goal objective as a fallback. It never displays Codex thread id, full cwd, raw cursor, or unavailable metadata.
- The entire row is one `SessionRouteLink` target. Lists use `ul`/`li`, section names are headings, focus remains visible, and no nested row action creates competing targets.
- Section rails are semantic, continuous, and token-mapped. `QUIET` is collapsed by default when higher-priority rows exist and open when it is the only populated section; the user may expand/collapse it with a native accessible control.
- Empty state says there are no active sessions and does not imply runtime failure. A loading skeleton does not fabricate counts or rows.
- `Load more` appears only when the coordinator reports `hasMore`; one activation calls `loadMoreSessions` once, disables while pending, preserves current rows, and reports a bounded failure without retry. Refresh follows the same single-flight UI rule.

### Responsive And Visual Contract

- The implementation uses the approved canvas/surface/ink/muted/divider/connected/attention/danger/focus tokens, fixed 4/8/12/16/24 spacing, 0/4/6 px radius, 44 px minimum targets, stable typography, and Lucide icons.
- At 390 x 844, the app bar, complete host strip, route heading, and at least two `ACT NOW` rows are visible in the first viewport for the mixed fixture. This is measured in Playwright, not inferred from a screenshot.
- At 360 x 800 and 412 x 915, hierarchy remains one column with no horizontal overflow, clipped labels, overlapping content, or viewport-scaled type. Long unbroken names, cwd segments, branches, summaries, and translated-length state copy wrap or truncate predictably.
- At 768 x 1024, the same grouped queue may widen but gains no new route or unsupported inspector. At 1280 x 800, Mission Control remains a bounded grouped queue until implemented Session Detail content exists; this leaf does not fabricate an empty desktop split pane.
- Hover, focus-visible, active, disabled, loading, empty, error, stale, and collapsed states are mapped. Reduced motion removes nonessential transitions. At 200 percent zoom and 320 px reflow, all information and controls remain usable without horizontal document scrolling.
- Screenshots are captured from deterministic coordinator-backed states, compared manually to both approved Focus Rail references, and stored under `artifacts/fe-v1-011-mission-control/`. Any remaining structural drift requires explicit human approval before closure.

## Acceptance Matrix

| ID | Criterion |
| --- | --- |
| `MMC-01` | Production and injected runtime ownership create one exact coordinator authority, survive React StrictMode effect replay, and close all owned clients/subscriptions without late publication. |
| `MMC-02` | Mission setup uses `useSyncExternalStore`, exact target identity, stable snapshots, bounded action/setup errors, and no polling, persistence, automatic retry, or transport ownership in view components. |
| `MMC-03` | Access-first loading and every unauthenticated/invalid/expired/revoked/denied state render no protected session value or inferred count before current readable authority. |
| `MMC-04` | Current, retained-loading, stale, failed-with-data, empty, and no-data failures remain visually and semantically distinct; stale data never receives current/live wording. |
| `MMC-05` | The three-cell host strip derives connection, permission/lock, and data/runtime truth only from coordinator resources and always pairs state text with an icon or shape. |
| `MMC-06` | Generic origin loss remains generic; exact laptop profile/Serve/Tailscale/runtime causes appear only from current or retained route-backed host truth. |
| `MMC-07` | Every selected attention/turn/freshness/session combination maps to one canonical section and visible label; source canonical order remains stable within groups and across loaded pages. |
| `MMC-08` | Session rows expose only approved bounded fields, derive a safe project cue, handle absent/long metadata, and never reveal thread id, full cwd, cursor, credentials, authority identity, or raw failure data. |
| `MMC-09` | Whole-row route links preserve Mission Control history and remain valid 44 px targets with semantic lists/headings, visible focus, and no nested interactive conflict. |
| `MMC-10` | Quiet-only, mixed, and empty queues have correct open/collapsed behavior, counts, labels, and non-fabricated copy; native disclosure remains keyboard and screen-reader operable. |
| `MMC-11` | Refresh and pagination are explicit one-call commands with pending disablement, retained rows, source-aware bounded failure, no duplicate activation, no hidden retry, and exact `hasMore` termination. |
| `MMC-12` | Loading, mixed, all quiet, empty, stale/reconnecting, read-only, locked, remote unavailable, runtime offline, incompatible, degraded, fatal, access-limited, and long-content component cases pass. |
| `MMC-13` | Focus Rail token/component mapping, continuous semantic rails, restrained flat surfaces, status color redundancy, and approved hierarchy match both selected raster references without cross-option drift. |
| `MMC-14` | At 390 x 844 the complete status strip and two `ACT NOW` rows fit the first viewport; 360/390/412 phone captures have no horizontal overflow, overlap, clipping, or shifted stable controls. |
| `MMC-15` | 768/1280 expansion, 320 px reflow, 200 percent zoom, long content, reduced motion, touch targets, contrast, keyboard traversal, focus visibility, and restrained live regions pass inspection. |
| `MMC-16` | Unit tests cover pure projection/grouping/time/copy boundaries; component tests cover all states and commands; router tests cover navigation; production-browser tests use deterministic coordinator-backed data and assert console/network/storage cleanliness. |
| `MMC-17` | Final 360/390/412/768/1280 screenshots and focused state captures are manually compared with approved assets; hashes, dimensions, drift disposition, and first-viewport measurements are recorded. |
| `MMC-18` | Focused/web/workspace/type/lint/planning/runtime/package/supply-chain/privacy/residue gates pass; owning docs and task evidence match actual behavior, with device/release work left explicitly downstream. |

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
git diff --check
```

Manual inspection additionally covers screenshot/reference comparison, first-viewport measurements, 320 px reflow, 200 percent zoom, keyboard/focus order, reduced motion, contrast, long-content wrapping, page/network/console/storage privacy, and process/temporary-file residue. Real Android/Tailscale acceptance remains downstream and cannot be claimed by browser emulation.

## Evidence

Criteria were frozen before implementation in `4cb713e`. Implementation and deterministic browser evidence are committed in `9dccc6c`.

### Result

- `MMC-01` to `MMC-18` pass for this leaf. The production app now owns one same-origin HTTP/SSE/CSRF/coordinator runtime, survives StrictMode replay and injected-authority transitions, closes partial construction, and renders the real default route from coordinator state.
- Access denial wins over retained target data. Current, stale, failed-with-data, loading, empty, long-content, locked/read-only, local/remote failure, runtime, and fatal projections remain explicit and bounded.
- Mission rows preserve canonical source order inside `ACT NOW`, `IN PROGRESS`, and `QUIET`; the pure matrix exercises all 1,260 valid selected freshness/session/turn/attention combinations.
- Refresh and pagination are explicit single-flight commands. The view owns no polling, timer retry, persistence, transport, profile switch, Serve mutation, or Tailscale command.
- Session links expose only the approved name, final cwd segment, optional branch, status, activity age, and bounded summary/goal fallback. Full cwd, thread id, cursor, authority identity, raw error, and credential state remain absent.
- The shared route helpers no longer create an app-shell/Mission import cycle. Browser operation ids now use one strict secure UUID helper for pairing and CSRF bootstrap.

### Automated Validation

| Gate | Result |
| --- | --- |
| Focused Mission/runtime | 2 files, 29 tests passed. |
| Web aggregate | 9 files, 152 tests passed. |
| Production Chromium | 5 scenarios passed across route/modal behavior, mixed responsive layout, stale/denied/long content, reflow, keyboard/focus, reduced motion, contrast, and 2x layout zoom. |
| Unit | 200 files and 1,995 tests passed; 27 files/28 tests remained explicitly skipped by their existing opt-in gates. |
| Contract / integration | 34 files/243 tests and 21 files/35 tests passed. |
| Static | Root/web typecheck, Biome/package exports over 577 files/8 packages, scaffold, exact runtime boundary over 612 production modules/22 externals, and planning over 219 tasks/84 requirements/675 dependencies passed. |
| Build / package | Vite built 2,011 modules; deterministic package acceptance passed twice with 6,433 entries and relocated read-only/runtime/config/static/integrity rejection. |
| Supply chain / diff | Frozen offline install, zero-vulnerability production audit, and staged/final diff checks passed. |

The Vite entry is 599.50 kB minified and 166.44 kB gzip. Vite emits its advisory 500 kB uncompressed chunk warning; no V1 performance threshold fails, and route splitting is intentionally left for complete-dashboard responsive/release hardening rather than hidden in this leaf.

### Visual And Accessibility Evidence

At 390 x 844, the status rail is exactly `x=0, y=56, width=390, height=56`; the second `ACT NOW` row is `x=19, y=330, width=355, height=96` and ends at `y=426`, leaving 418 px in the first viewport. The mixed fixture contains four `ACT NOW` rows. Machine-readable evidence is `artifacts/fe-v1-011-mission-control/first-viewport-390x844.json` (`72821572bf8cf9adfc9833be59671c335a7ed6a089cda31aff6b351a73d4c6cf`).

| Capture | Dimensions | SHA-256 |
| --- | --- | --- |
| `mixed-360x800.png` | 360 x 800 | `54e7e0ea500f76f39d5aeb6bb828a5ec6269e07276f89c266e50db0b6f40b2bb` |
| `mixed-390x844.png` | 390 x 844 | `a905a49fb7a69008c546cd3ac79491b3f076ae9cd0e751f7dafab11930eecf6e` |
| `mixed-412x915.png` | 412 x 915 | `77ea856f6575ca7b8e6c98b01ff3ab11cfe271c4d0d1caf87c9002061470af71` |
| `mixed-768x1024.png` | 768 x 1024 | `ba1b6661b98fb2fbd72b976da8a25d03d2da10af28a419c87454ca5d2a65ac69` |
| `mixed-1280x800.png` | 1280 x 800 | `b3fe0459634946da467d6ddcd69c68e73a068ce0bb4c6a12ce08a225d4097e0d` |
| `stale-390x844.png` | 390 x 844 | `226fb9757ae20eeb43c353d73f67057bba7911dbdbf379e0696f1a369cfa214a` |
| `access-limited-390x844.png` | 390 x 844 | `8ac0d83404872d9e240e99d665d1da310c9e1f202a791b8ae75447d3506aca68` |
| `long-content-360x800.png` | 360 x 800 | `9177bcf02c21ec0565dd35fabe9e614f935f7a56dd8440d6b6fb50f7db4b72b1` |
| `reflow-320x800.png` | 320 x 800 | `cfacbc020f12ae1fbf24be87d07e575943a18575c68107a150d78c6b4c584afc` |
| `zoom-200-1280x800.png` | 1280 x 800 at 2x layout zoom | `6fa98551c9c8b13b3423c419bf894ba5057e382cf7f8a5d24751076280c6a74b` |

All captures decode at their named dimensions and have non-zero pixel variance. Automated inspection also proves no horizontal document overflow, 44 px controls/disclosure, unclipped rows/status text, keyboard order and 3 px focus outlines, disabled reduced-motion animation/transition, and empty browser storage. Token contrast against the selected surfaces is: ink 15.59:1, muted 7.59:1, connected 7.91:1, attention 9.33:1, danger 6.04:1, and focus 5.83:1.

Manual comparison against `mobile-mission-control-mixed.png` and `responsive-continuum.png` confirms the selected Focus Rail hierarchy, palette, three-cell status strip, grouped continuous rails, flat repeated rows, quiet disclosure, and phone-first expansion without Signal Ledger borrowing. Typed route truth intentionally replaces the illustrative `Live` sample with `Current`; local loopback evidence says `Laptop`; and the 1280 capture remains a bounded queue until `FE-V1-012` provides real detail content. These are the frozen dispositions, not unrecorded structural drift.

### Privacy, Residue, And Downstream Limits

Browser requests stay on `http://127.0.0.1:4175` in deterministic tests; console/page errors, external requests, and local/session storage remain empty except the one expected browser-generated 503 resource line in the stale case, whose private response body is not exposed. Source inspection found no storage, polling, hidden retry/fallback, console logging, raw credential/source path, or live Tailscale/profile/Serve mutation. Test-owned port 4175 processes and temporary integration/package directories are absent; the Playwright result marker was removed.

This leaf does not claim Session Detail, pairing/recovery, complete-dashboard cross-screen accessibility/fidelity, second-browser coverage, packaged web assets, or real Android/Tailscale acceptance. Those remain owned by `FE-V1-012`, `FE-V1-013`, `FE-V1-016`, `FE-V1-039`, `FE-V1-040`, `IFC-V1-053`, and `FE-V1-090`.
