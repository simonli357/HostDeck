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

## Planned Validation

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
pnpm check:planning
git diff --check
```

Implementation and final evidence are pending.
