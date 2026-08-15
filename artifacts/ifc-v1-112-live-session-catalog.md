# IFC-V1-112 Live Session Catalog

Status: passed

## Result

- Added authenticated `/api/v1/sessions/catalog/stream` SSE with ordered `catalog_reset`, `session_upsert`, `session_remove`, `catalog_ready`, and `catalog_boundary` events.
- Durable mapping/projection commits publish through one catalog hub. Reconnect cursors, replay/live continuity, stale and future cursors, slow consumers, rebuilds, shutdown, revoke, storage failure, and publication failure are explicit.
- Catalog and per-session streams share global and per-device admission limits. Catalog events expose bounded session summaries and no transcript content.
- Production now selects 36 routes through 23 API/SSE registrations: 21 API and two SSE. The deterministic non-web closure is 663 sources.

## Validation

| Gate | Result |
| --- | --- |
| Workspace | Unit: 290 files, 3,245 passed and 31 intentional skips. Contract: 44 files, 308 passed. Integration: 21 files, 36 passed. Root typecheck, lint/exports, scaffold, planning, runtime-boundary, and diff checks passed. |
| Catalog | Reader, publication wrapper, hub, route, replay/live, stale/future cursor, overflow, shared admission, revoke, shutdown, storage/publication failure, reconciliation, security, and resource tests passed. |
| Browser | Headless Chromium opened the real loopback Fastify listener, received reset `1001` then ready `1002`, closed `EventSource`, and server subscriber accounting returned to zero without an observed failure. |
| Package | `pnpm test:package` passed from `254b741`: 43 contracts, two deterministic builds, 6,353 relocated entries, 663 selected sources, and executable/runtime/config/static/web-integrity rejection. All six supply-chain metadata checks passed. |

## Remaining Boundary

- `FE-V1-107` owns Mission Control consumption, reconnect UI, selected-detail continuity, and responsive browser inspection.
- Aggregate shared-runtime hardening, Ubuntu packaging, physical Android acceptance, and release acceptance remain downstream release gates.
