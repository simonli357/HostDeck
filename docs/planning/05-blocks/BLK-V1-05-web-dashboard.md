# BLK-V1-05 Mobile Dashboard UX

Owns the phone-first dashboard, visual gate, structured controls/approvals, responsive expansion, accessibility, and fidelity evidence.

## Outcome

- Mission Control is the default phone route and surfaces the highest-attention session immediately.
- Session Detail is conversation/event-first with a sticky prompt composer, `/model`, `/goal`, `/plan`, utilities, and inline structured approvals.
- Trust, lock, HTTPS/certificate, incompatibility, stale/boundary, and failure states are visible before action.
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
| Host/access | Pairing, permission, CSRF reload state, lock, HTTPS/LAN/certificate, Codex compatibility, stream health. |
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
| Mobile structured state/interaction rebaseline | `FE-V1-004` | Blocked by contracts and real event semantics. |
| Replacement visual directions | Reopened `FE-V1-002` | Blocked by `FE-V1-004`. |
| Human selection | `FE-V1-003` | Blocked by replacement options. |
| App shell/API client/Mission Control/Session Detail | `FE-V1-010` to `FE-V1-012`, `FE-V1-019` | Blocked by selection and production API. |
| Trust/diagnostics/status states | `FE-V1-013` to `FE-V1-015` | Blocked by production security/runtime contracts. |
| Composer and structured controls | `FE-V1-020`, `FE-V1-021` | Blocked by selected adapter API. |
| Inline approvals | `FE-V1-022` | Blocked by real approval vertical/API. |
| Responsive/accessibility/fidelity/copy hardening | `FE-V1-016` to `FE-V1-018`, `FE-V1-090` | Blocked by implemented screens. |

Owning backlog: `docs/tracking/backlog/web-dashboard.md`.

## Validation

| Level | Evidence |
| --- | --- |
| L1 | View-model, component, accessibility semantics, disabled/risky control, long-content states. |
| L2/L3 | Browser API/SSE flow, replay, approval races, keyboard/safe-area behavior, screenshots/diffs. |
| L4 | Real phone HTTPS enrollment, pair/reload, scan, prompt, approval, lock, disconnect recovery. |

## Done Criteria

- Every UX flow in `03-ux-spec.md` completes at 360 x 800 without horizontal scroll or desktop dependency.
- Approved visual targets and design-system mapping are recorded.
- UI invokes structured controls and never blind slash/terminal input.
- Approval duplicate/expiry/reconnect and trust/certificate/incompatibility states are truthful.
- Playwright screenshots cover all reference viewports and required states with no incoherent overlap/clipping.
- Keyboard, focus, screen reader, contrast, reduced motion, touch, zoom, and reflow checks pass.
- Real phone evidence passes and visible drift is fixed/approved.
- `FE-V1-090` passes and block matrix marks complete.
