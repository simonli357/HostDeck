# BLK-V1-05 Mobile Dashboard UX

Owns the phone-first dashboard, visual gate, structured controls/approvals, responsive expansion, accessibility, and fidelity evidence.

## Outcome

- Mission Control is the default phone route and surfaces the highest-attention session immediately.
- Session Detail is conversation/event-first with a sticky prompt composer, `/model`, `/goal`, `/plan`, utilities, and inline structured approvals.
- Trust, lock, Tailscale/profile/Serve availability, incompatibility, stale/boundary, and failure states are visible before action.
- No phone raw-shell input, terminal emulator, editor, file tree, or desktop-only required workflow exists.
- Approved mockups, implementation screenshots/diffs, accessibility checks, and a real-phone pass are recorded.

Requirement refs: `FR-002`, `FR-005` to `FR-010`, `FR-016`, `NFR-004`, `IR-001` to `IR-012`, `PR-005`, `SFR-001` to `SFR-004`, `SFR-009`, `SFR-018`.

## Screen Groups

| Group | Required behavior |
| --- | --- |
| Mission Control | Host/access strip, attention ordering, compact stable session rows, empty/offline/degraded states. |
| Session Detail | Structured feed, status, composer, primary controls, utilities, boundaries, interrupt/archive/resume actions. |
| Inline approval | Scope/reason/action, approve/deny, confirmation policy, exact pending/resolved/expired state. |
| Model/goal/plan/utilities | Runtime-sourced current values and capability-aware loading/unsupported/conflict/failure states. |
| Host/access | Tailscale/profile/Serve state, QR/link pairing, permission, CSRF reload state, lock, Codex compatibility, and stream health. |
| Event details | Bounded read-only diagnostic projection with redaction/truncation/boundary. |

## Visual Gate

- Existing Option A/B boards are rejected evidence, not targets.
- Rebased state fixtures and interaction contracts complete first.
- Two new image-generated directions each show required phone states plus desktop expansion and differ structurally, not only by palette.
- Mockup review checks 360, 390, 412, 768, and 1280 widths before human selection.
- Human `FE-V1-003` selects exact assets before React screen implementation.

## Task Map

| Work | Tasks | Status |
| --- | --- | --- |
| Historical view-model/state helpers | `FE-V1-001` | Retained; requires structured mobile rebaseline. |
| Mobile structured state/interaction rebaseline | `FE-V1-004` | Done; executable matrix and evidence in `artifacts/fe-v1-004-mobile-state-interaction-contract.md`. |
| Replacement visual directions | `FE-V1-002` | Ready; selected matrix is complete. |
| Human selection | `FE-V1-003` | Blocked by replacement options. |
| Phone-first shell and typed HTTP/SSE/CSRF/state clients | `FE-V1-010`, `FE-V1-019`, `FE-V1-023` to `FE-V1-025` | Blocked by visual selection and the assembled production API. |
| Mission Control and structured Session Detail | `FE-V1-011`, `FE-V1-012` | Blocked by approved state contracts and coordinated clients. |
| Prompt, model, goal, plan, utilities, and inline approval | `FE-V1-020` to `FE-V1-022`, `FE-V1-026` to `FE-V1-030` | Each leaf consumes its exact structured API/runtime port. |
| Host access, QR pairing, CSRF reload, devices, lock, remote profile/Serve, and compatibility UI | `FE-V1-013`, `FE-V1-031` to `FE-V1-035` | Blocked by production remote security and mutable-health contracts. |
| Event diagnostics, interrupt, archive, and TUI-resume affordances | `FE-V1-014`, `FE-V1-036` to `FE-V1-038` | Blocked by Session Detail and exact operation routes. |
| Cross-screen failure and continuity matrix | `FE-V1-015` | Blocked by complete stream, health, and compatibility state. |
| Responsive, accessibility, and browser matrices | `FE-V1-016`, `FE-V1-039`, `FE-V1-040` | Ordered after every required implemented state/action. |
| Fidelity, copy/workflow review, and module hardening | `FE-V1-017`, `FE-V1-018`, `FE-V1-090` | Blocked by selected mockups, browser evidence, and complete screens. |

Owning backlog: `docs/tracking/backlog/web-dashboard.md`.

## Validation

| Level | Evidence |
| --- | --- |
| L1 | View-model, component, accessibility semantics, disabled/risky control, long-content states. |
| L2/L3 | Browser API/SSE flow, replay, approval races, keyboard/safe-area behavior, screenshots/diffs. |
| L4 | Real phone through Tailscale Serve without a laptop-LAN route or custom CA: pair/reload, prompt, approval, lock, disconnect/profile-switch recovery. |

## Done Criteria

- Every UX flow in `03-ux-spec.md` completes at 360 x 800 without horizontal scroll or desktop dependency.
- Approved visual targets and design-system mapping are recorded.
- UI invokes structured controls and never blind slash/terminal input.
- Approval duplicate/expiry/reconnect and trust/profile/Serve/incompatibility states are truthful.
- Playwright screenshots cover all reference viewports and required states with no incoherent overlap/clipping.
- Keyboard, focus, screen reader, contrast, reduced motion, touch, zoom, and reflow checks pass.
- Real phone evidence passes and visible drift is fixed/approved.
- `FE-V1-090` passes and block matrix marks complete.
