# FE-V1-010 Phone Shell And Navigation

Date: 2026-07-22

## Scope

Implement the first real React/Vite browser surface for HostDeck as a thin, phone-first Focus Rail shell. This leaf owns framework entry, exact browser routes, route-local shell chrome, safe navigation, one accessible supporting-sheet primitive, selected design tokens, component/router tests, and a local 390 x 844 browser smoke.

This leaf does not own session/API data, SSE, CSRF, pairing state, Mission Control rows, Session Detail events, composer/actions, control sheets, production asset packaging, broad responsive/accessibility hardening, or final visual fidelity. Those remain in `FE-V1-011` to `FE-V1-040`, `IFC-V1-053`, and `FE-V1-090`.

## Selected Inputs

- Decision: `DEC-028`.
- Visual system: `assets/ui-concepts/option-b/design-system.md`.
- Shell references: Option B Mission Control, Session Detail, access/recovery, and responsive assets listed in `artifacts/fe-v1-003-focus-rail-selection.md`.
- Route contract: the production static owner already serves only `/` and `/sessions/:session_id`.
- Session identity: `sessionIdSchema` from `@hostdeck/contracts`.
- Interaction owners: browser-local `open_session` and `navigate_back` from the executable mobile design contract.

## Reuse And Dependencies

Use maintained upstream owners instead of custom framework, routing, focus-trap, or icon code:

| Capability | Exact selected package | Reason |
| --- | --- | --- |
| UI runtime | `react` and `react-dom` 19.2.8 | Existing approved React architecture; current MIT release. |
| Browser routing | `react-router` 8.2.0 | Browser History API, declarative exact/dynamic routes, memory-router tests; MIT and compatible with pinned Node 22.22.2. |
| Supporting dialog/sheet | `@radix-ui/react-dialog` 1.1.20 | WAI-ARIA dialog semantics, modal focus containment, Escape close, and trigger focus restoration; MIT. |
| Icons | `lucide-react` 1.25.0 | Maintained familiar icon set; ISC and React 19 compatible. |
| Vite integration | `@vitejs/plugin-react` 6.0.4 | Official Vite 8 React/Fast Refresh owner; MIT. |
| Component tests | Testing Library React 16.3.2, user-event 14.6.1, DOM 10.4.1, jsdom 29.1.1 | Interaction/semantics-oriented component and history tests; MIT and compatible with the pinned runtime. |

React type packages remain development-only. No CSS framework, state store, data-fetching library, animation package, custom router, or custom focus trap is justified by this leaf.

## Exact Browser Contract

| Path | Surface | Required behavior |
| --- | --- | --- |
| `/` | Mission Control shell | Default route with HostDeck app bar and a bounded loading outlet; no fabricated sessions or readiness. |
| `/sessions/:session_id` | Session Detail shell | Parse the decoded parameter with `sessionIdSchema` before rendering the detail outlet. |
| Any other or invalid session path | Explicit not-found surface | No silent success, API call, raw parameter reflection, or hidden redirect. Offer one route-safe return to Mission Control. |

- A shared session-link helper validates identity and records Mission Control as the browser-local source before navigation.
- Back from a link-opened detail uses browser history and restores the prior Mission Control entry.
- Back from a direct deep link replaces the current entry with `/`, so it cannot leave HostDeck or create a back-button loop.
- Opening or closing Host/access never changes the URL or creates a third full-page route.
- Query/hash content is not interpreted as a route, session identity, or control command. Existing pairing bootstrap remains separately owned.

## Shell And Visual Contract

- Use the exact Focus Rail canvas/surface/ink/muted/divider/connected/attention/danger/focus tokens and fixed 4/8/12/16/24 spacing scale.
- Use stable 56px app bars, at least 44px icon targets, 24px route heading, 6px maximum radius, zero viewport-scaled type, no gradient, and no decorative rail.
- The phone surface fills `100dvh`, respects safe-area insets, has no horizontal overflow, and keeps the main landmark separate from portalled supporting surfaces.
- Mission Control and Session Detail are the only full-page product routes. Host/access is a labelled bottom sheet using Radix Dialog; it has a close icon, bounded loading outlet, modal semantics, Escape close, focus containment, and trigger focus restoration.
- Route outlets are injectable so later leaves can implement real screens without replacing routing, focus, or shell ownership.
- Default outlets show bounded skeleton/loading state only. They must not invent session, access, network, Codex, Tailscale, or permission truth.

## Implemented Surface

- `packages/web/src/app-shell.tsx` owns the exact routes, strict shared session-id validation, linked versus direct-entry Back semantics, explicit not-found state, injectable downstream outlets, and Radix Host/access sheet.
- `packages/web/src/main.tsx`, `index.html`, `vite.config.ts`, and `styles.css` provide the fail-loud React entry and exact Focus Rail phone shell. Production entry imports no API, SSE, CSRF, pairing, or storage behavior.
- `@hostdeck/contracts/scalars` exposes the existing scalar validator through a narrow package subpath. This keeps one schema owner while reducing the emitted browser JavaScript from 498.55 KB to 331.61 KB and excluding unrelated pairing/CSRF contract code.
- The selected runtime-boundary checker now scans `.tsx`, resolves `.js` source imports to `.ts` or `.tsx`, validates the expanded web root, and starts the currently packaged production closure from the six non-web roots. Package acceptance remains exactly 610 server/CLI source modules until `IFC-V1-053` owns built web assets.
- `BUG-014` pins the two audited Fastify transitive paths to patched `fast-uri` 3.1.4 and 4.1.1. No React dependency was implicated.
- Implementation commit: `9b095ad`.

## Acceptance Matrix

| ID | Criterion |
| --- | --- |
| `SHL-01` | React/Vite starts and builds from `packages/web` without source maps, external asset URLs, or source-loader/runtime dependencies. |
| `SHL-02` | `/` is the only default route; route landmarks and titles are semantic and Focus Rail-styled at 390 x 844. |
| `SHL-03` | Valid `/sessions/:session_id` renders one exact branded session identity; invalid/encoded/oversized/unknown paths fail explicitly without disclosure. |
| `SHL-04` | A validated session link opens detail and browser-local Back restores the same Mission Control history entry. |
| `SHL-05` | Direct detail entry Back safely replaces to `/`; repeated use cannot leave HostDeck or loop. |
| `SHL-06` | Host/access uses a modal sheet, preserves the route, closes by button and Escape, traps focus, and restores trigger focus. |
| `SHL-07` | Shell controls use Lucide icons with accessible names and stable 44px targets; no terminal/editor/desktop-only route or control exists. |
| `SHL-08` | Production entry has no API/SSE/CSRF/pairing request, storage write, fake data, or hidden fallback. Existing pairing-bootstrap exports remain compatible. |
| `SHL-09` | Component/router tests cover normal, direct-entry, invalid, repeated, keyboard, dialog, and injected-outlet behavior with cleanup. |
| `SHL-10` | Vite production build and local Playwright 390 x 844 smoke pass; screenshots are manually inspected for blank output, clipping, overlap, and unauthorized visual drift. |

## Completion Evidence

| Criterion | Evidence |
| --- | --- |
| `SHL-01` | Vite emits only `index.html`, one CSS asset, and one 331.61 KB JavaScript asset; no map/source file, external HTML/CSS URL, pairing/API/SSE/WebSocket marker, or source loader is emitted. |
| `SHL-02` | Semantic root landmark/heading/loading state and exact Focus Rail tokens render at 390 x 844; screenshot inspected. |
| `SHL-03` | Shared schema accepts the branded session id; empty, wrong-prefix, encoded slash, oversized, unknown, and hostile paths fail to the non-reflecting not-found surface. |
| `SHL-04` | `SessionRouteLink` validates identity, records Mission Control source, and restores the prior history entry in component/router evidence. |
| `SHL-05` | Direct detail Back replaces to `/`; the detail-only control disappears and cannot create a UI loop. Browser smoke proves the production deep-link fallback. |
| `SHL-06` | Radix sheet retains `/`, contains focus, closes by button and Escape, and restores trigger focus in component and real Chromium evidence. |
| `SHL-07` | Lucide-only shell controls have accessible names and exact 44px dimensions; source and screenshots contain no terminal/editor/desktop-only surface. |
| `SHL-08` | Browser diagnostics observe zero API/external request, page/console error, or local/session storage entry. Source and emitted boundary scans contain no production entry call or pairing payload. Existing pairing tests remain green. |
| `SHL-09` | Seven component/router cases cover default, linked, direct, invalid/encoded/oversized/unknown, query/hash, injected outlet, keyboard, close, and repeated-return behavior. |
| `SHL-10` | Two Playwright phone scenarios pass and the three final screenshots were manually compared with Focus Rail for blank output, hierarchy, clipping, overlap, overflow, and unauthorized drift. |

Final screenshots:

| Capture | SHA-256 |
| --- | --- |
| `artifacts/fe-v1-010-shell/mission-control-390x844.png` | `ce118ac5a2608c8471e279983dc6dba463f8b9ce711bfb7444a2af3c5e2824d2` |
| `artifacts/fe-v1-010-shell/session-detail-390x844.png` | `d0173b8db1c7e3ea835e8e4b9eb93e8207be474698f704740b017f689b4322f9` |
| `artifacts/fe-v1-010-shell/host-access-390x844.png` | `67485e58065f3c7ac586eac748778c16bfac612552e9419858c7c74ebb7885df` |

## Validation

```bash
pnpm --filter @hostdeck/web test
pnpm --filter @hostdeck/web typecheck
pnpm --filter @hostdeck/web build
pnpm test:browser:shell
pnpm test:web
pnpm test:unit
pnpm typecheck
pnpm lint
pnpm check:scaffold
pnpm check:runtime-boundary
pnpm check:planning
pnpm test:contract
pnpm test:integration
pnpm test:package
pnpm install --offline --frozen-lockfile
pnpm audit --prod
git diff --check
```

Results:

- Web package: 7 component/router tests; aggregate web: 27 tests; Chromium: 2 phone scenarios.
- Workspace: 1,870 unit tests passed with 28 intentional skips; 240 contract and 27 integration tests passed. One first post-override unit invocation was terminated by signal 15 under host memory pressure before Vitest emitted a result; the unchanged canonical rerun completed normally in 81.85 seconds.
- Static: root and web typechecks, Biome/package exports over 548 files and 8 packages, scaffold at 8 packages/21 scripts, runtime boundary at 610 production source modules/22 external modules, and planning integrity pass.
- Package/supply chain: frozen offline install, two deterministic relocated package builds with 6,429 entries, and zero-known-vulnerability production audit pass. Patched `fast-uri` releases remain BSD-3-Clause.
- Manual review: final source, emitted files, routes, privacy/runtime boundary, and all three final 390 x 844 images pass. No remaining drift is approved or hidden in this leaf.

Downstream data, screens, actions, broad responsive/accessibility/fidelity, package integration, and real-phone work remain explicitly owned by the leaves listed in Scope; this shell evidence does not claim them complete.
