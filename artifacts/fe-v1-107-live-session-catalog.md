# FE-V1-107 Live Session Catalog UI

Status: passed

## Result

- Added one authority-scoped catalog SSE connection that survives route changes and closes on authority loss or app shutdown. No polling or fallback path exists.
- Mission Control applies reset/upsert/remove/ready/boundary events atomically while retaining the last complete list through reconnects. Stable ordering, focused-row restoration, and scroll position passed browser inspection.
- Session Detail merges live catalog projections into the selected session. A removed selected session becomes explicitly unavailable, closes its detail stream, and removes prompt and fixed controls.
- Strict stream identity, cursors, native/internal identity pairs, malformed events, shared admission limits, and reconnect boundaries fail closed.

## Validation

| Gate | Result |
| --- | --- |
| Workspace | Typecheck passed. Lint passed across 920 files with eight export checks. Web: 55 files, 960 passed. Unit: 291 files passed, 29 skipped; 3,263 tests passed, 31 skipped. Contract: 44 files, 309 passed. Integration: 21 files, 36 passed. Runtime boundary selected 663 production sources. |
| Browser | Full production shell passed 179/179. Focused live-catalog coverage exercised initial state, atomic replacement, upsert/remove, reconnect cursor, boundary, selected-session removal, focus, scroll, privacy, and fixed controls with no page or console errors. |
| Visual | Inspected current Mission Control at 360x800, 390x844, 412x915, 768x1024, and 1280x800 plus 390x844 boundary and selected-removed states in `artifacts/fe-v1-107-live-session-catalog/`. |
| Package | Commit `c67cdea` passed 43 package contracts, two deterministic 6,353-entry builds, six supply-chain checks, and the relocated production-browser test. The package selected 663 sources and 1,333 owned outputs. |

## Remaining Boundary

- `INT-V1-114` owns aggregate shared-runtime hardening and a real multi-project, two-client run.
- Ubuntu packaging, physical Android acceptance, and release acceptance remain downstream gates.
