# FE-V1-025 Shell Connection-State Coordinator

Date: 2026-07-22

## Scope

Implement one headless browser coordinator over the completed bounded HTTP, SSE, and page-memory CSRF clients. It owns current route/session target epochs, access-first disclosure, host and target query state, bounded Mission Control pagination, selected-session stream lifetime, stale-data retention, exact failure source, browser write eligibility, authority-driven CSRF invalidation, immutable subscriptions, and deterministic cleanup.

The coordinator does not render React, invent a diagnosis before the HostDeck document loads, poll or mutate Tailscale, switch profiles, repair Serve, unlock remotely, retry writes, persist browser state, merge event-feed content, or replace server-side admission. `FE-V1-011` and `FE-V1-012` render its state; `FE-V1-013` and `FE-V1-031` own pairing and recovery UI; `FE-V1-015` closes the cross-screen acceptance matrix.

## Pre-Change Findings

- `GET /api/v1/access` is the only selected browser read available before app pairing. It returns current origin/network/transport, exact authentication state, permission, lock, and read/write capability without disclosing session data.
- Authenticated `GET /api/v1/host/status` returns independent local and remote health plus health-and-authority write eligibility. It does not return lock state, device label, request provenance/source key, or full runtime compatibility.
- Session list/detail responses repeat the exact read access mode/network/transport and are checked for current device/remote authority before response completion. They do not carry a remote generation.
- A current remote `host_status` success must describe ready remote ingress at the same document origin. A fresh remote browser cannot receive a precise wrong-profile or Serve diagnosis when that private origin does not load; only a local or already retained HostDeck observation can contain that cause.
- The SSE client already owns bounded reconnect and a sticky replay boundary, but it clears a transient failure after new activity. The coordinator must retain one bounded recovered failure so reconnect does not erase history silently.
- The CSRF client accepts proven access/profile/revoke invalidation reasons but has no access observer. Browser writes are not eligible until paired-write access, unlocked/current local health, and current CSRF authority all agree.
- The selected mobile access fixture contract predates `DEC-024`: it permits implicit `loopback_local` browser writes and requires admitted provenance/source key, device label, full compatibility, and a globally connected stream that the selected browser API cannot produce. Components cannot be allowed to fabricate those fields. This is tracked as `BUG-015` and corrected with the route-backed coordinator contract.
- No new dependency is required. This is application state orchestration over existing exact contracts and clients.

## Frozen Design

### Public Boundary

- `createBrowserConnectionStateCoordinator` accepts exact factory-created HTTP, SSE, and CSRF clients plus a non-regressing wall-clock port. The coordinator takes exclusive ownership of the SSE/CSRF lifetimes and its own HTTP abort scopes; construction performs no request, timer, storage, DOM, or profile action.
- The public port exposes `snapshot`, `subscribe`, `setTarget`, `refresh`, `loadMoreSessions`, `connectSessionStream`, explicit CSRF bootstrap/adoption, protected mutation delegation, and idempotent `close`.
- Targets are exactly Mission Control or one validated session id. Same-target setup is idempotent, explicit refresh supersedes the current query epoch, and any route/session change aborts old HTTP work and closes the old stream with `route_changed` before publishing the new target.
- Snapshots are deeply frozen and stable until a material transition. Subscribers receive no raw event, request, credential, source key, profile identity, or thrown cause. Unsubscribe is idempotent; a closed coordinator accepts no new work.

### Query And Disclosure Order

- Every target load starts with one `access_state` request. No host-status, session-list, session-detail, SSE, or CSRF-bootstrap request starts until current access proves that session reads are allowed.
- Remote unpaired, invalid, expired, revoked, and otherwise denied access publishes access-only state and clears all retained session data. Loopback browser access is `loopback_read`, never implicit local admin; browser writes require a paired-write cookie even on loopback.
- After readable access, `host_status` and the exact target read may execute concurrently under one target epoch. Each result has independent current/stale/failed state. A target success may remain current while host status fails, but its access mode/network/transport must agree with the access response and with any current host response; writes remain closed without current host status.
- Mission Control starts with the selected default page size. `loadMoreSessions` follows only the returned opaque cursor, rejects duplicate/out-of-order/cross-access pages, caps the merged inventory at the selected 4,096-session maximum, and never retries a stale cursor automatically.
- Session Detail stores only the exact selected detail response. `session_not_found` is a current not-found result and clears retained detail; a permission failure never becomes not-found disclosure.

### Authority And Health

- The coordinator preserves exact `SelectedAccessStateResponse`, `SelectedHostStatusResponse`, session response, CSRF snapshot, and SSE snapshot sources. Derived classifications never replace or broaden those contracts.
- Access/host/session mode, network, transport, configured origin, and current document origin must agree. Browser `local_admin`, remote non-HTTPS, remote non-ready host status, remote-origin/generation contradiction, and impossible capability combinations are fatal contract failures rather than fallbacks.
- Local health classification uses the exact seven components. Compatibility failure is incompatible; runtime disconnect/failure is offline; other failed local aggregates are fatal; unknown/stale/degraded local state is degraded. Exact component causes remain available.
- Local loopback state may expose current remote disabled/unavailable reasons. Current remote state can only be ready; after remote loss, the last ready observation may remain stale beside a generic transport failure but cannot become a newly diagnosed profile or Serve cause.
- A changed device, permission, origin, network mode, or remote authority generation aborts stale work. Revocation, pairing replacement, access loss, and remote-authority change map to their exact CSRF invalidation reason. Access loss purges session data; generic transport loss retains bounded data as stale.

### Write Eligibility And CSRF

- One canonical write-eligibility result is published before controls. It is open only for current paired-write access, unlocked access capability, current host status with open local mutation admission, matching access mode, and ready current CSRF authority.
- Canonical closed causes distinguish unresolved/stale connection, unpaired/invalid/expired/revoked authority, read-only access, host lock, unavailable host status, non-ready host, and non-ready CSRF. Components consume this result and do not recreate the gate.
- The first proven paired-writer authority epoch may start one CSRF bootstrap if the page is still `idle/not_bootstrapped`. Concurrent shell loads join that bootstrap. A failed bootstrap, failed mutation, or explicit invalidation never starts an automatic retry; recovery uses the explicit bootstrap/adoption method.
- Protected mutation delegation calls the CSRF client once, republishes any authority transition, and never retries, refreshes, or relabels uncertain server completion. Operation-specific success/failure remains owned by the calling screen.

### Stale, Failure, And Stream Truth

- Query resources use exact absent/loading/current/stale/blocked/not-found/failed variants. Loading may retain same-target data; failure may retain it only as stale. A target change never relabels data from another session as current or stale for the new target.
- Failures retain source (`access`, `host_status`, `session_list`, `session_detail`, `session_stream`, or `csrf`), bounded reason, route, transport, status, validated API envelope, target epoch, and observation time only. Raw inputs, response bodies, URLs, cookies, tokens, source/profile identity, and thrown causes are absent.
- A later success clears only the active failure. One bounded `last_failure` records that recovery occurred and remains until target/authority reset or a newer failure; it cannot keep data stale after all current sources recover.
- A detail stream can start only for the current readable detail target. It resumes after the detail projection cursor, forwards only same-epoch events to one explicit consumer, and mirrors connecting/connected/reconnecting/failed/closed state.
- Replay boundary remains sticky for that session. A bounded detail event window also preserves an existing retention boundary. Route/access/profile change and close cancel the reader, timers, listeners, and reconnect work; late stream state/events cannot reach the new target.

## Contract Defect Disposition

`BUG-015` is closed in this leaf by replacing impossible live assumptions, not by weakening selected server authority:

- browser loopback is read-only unless a paired device cookie grants read/write permission;
- source-key/request-provenance and private Tailnet identity are not copied into live UI state;
- device labels remain owned by the device-list route, not access bootstrap;
- coarse compatibility comes from exact local-health components until `FE-V1-035` consumes a dedicated detailed source;
- Mission Control has no fabricated connected session stream;
- current and retained-stale laptop remote observations remain distinguishable from an unreachable remote origin.

The 141-state design trace and approved Focus Rail mockups remain visual/product inputs. Their host-access fixture mapping must consume the new route-backed state rather than serving as a wire contract.

## Acceptance Matrix

| ID | Criterion |
| --- | --- |
| `BSC-01` | Exact constructor/client/clock/target/listener/consumer/options contracts reject missing, extra, accessor, prototype-invalid, hostile, or contradictory input before request or state mutation. |
| `BSC-02` | Construction is inert; initial and closed snapshots are exact, immutable, privacy-safe, and close releases every owned query, stream, CSRF, listener, and reference once. |
| `BSC-03` | Mission/detail target setup is idempotent; refresh, route change, session change, and close use monotonic epochs so every stale HTTP completion and stream callback is ignored. |
| `BSC-04` | Access is always read first; unauthenticated remote states disclose no host/session data, start no protected read/SSE/CSRF request, and purge previously authorized session data. |
| `BSC-05` | Loopback browser reads map to `loopback_read`; local-admin browser or implicit loopback write claims fail loudly, while paired loopback read/write remains exact. |
| `BSC-06` | Access, host, and session origin/network/transport/mode consistency is enforced across every valid combination and contradiction without a component-side guess. |
| `BSC-07` | Local health maps ready/offline/incompatible/degraded/fatal from exact component state and cause; remote disabled plus every Tailscale/profile/Serve/failure cause remains exact and independent. |
| `BSC-08` | Remote current success requires ready same-origin authority; profile/Serve loss after load becomes stale retained truth plus generic transport failure until a new HostDeck observation proves a cause. |
| `BSC-09` | Canonical write eligibility covers every access, lock, local-health, host-query, and CSRF state; no unknown, stale, read-only, locked, incompatible, disconnected, or failed state is writable. |
| `BSC-10` | Writer bootstrap occurs at most once per proven idle authority epoch; concurrent work joins it, and failure/invalidation/mutation never causes hidden bootstrap or write retry. |
| `BSC-11` | Device/permission/origin/network/remote-generation transitions select the exact CSRF invalidation reason, abort stale work, and either purge unauthorized data or retain authorized data with explicit staleness. |
| `BSC-12` | Mission pagination follows only selected cursors, preserves canonical order/uniqueness/access, stops at 4,096 rows, and handles stale/malformed/duplicate/concurrent pages without partial commit or retry. |
| `BSC-13` | Detail not-found, permission denied, transport loss, API failure, malformed response, timeout, capacity, caller cancellation, and route cancellation remain distinct; only authorized generic loss retains same-target data stale. |
| `BSC-14` | Stream setup/resume, event forwarding, reconnect, recovered failure, retention/replay boundary, consumer failure, authority loss, route change, unmount, and close preserve exact target/continuity and zero residue. |
| `BSC-15` | Active versus recovered failure is explicit; later success cannot silently erase failure/boundary history or leave recovered data marked stale. |
| `BSC-16` | `BUG-015` regression coverage rejects implicit loopback writes and proves every live coordinator field is derivable from selected browser responses/client state without provenance, label, compatibility, or stream fabrication. |
| `BSC-17` | Real selected Fastify evidence covers loopback read-only, admitted-Serve unpaired/paired read/paired write, access loss, lock, local degradation, remote/profile generation invalidation, session list/detail/not-found, SSE reconnect/boundary, CSRF readiness, and cleanup without live profile/Serve/phone mutation. |
| `BSC-18` | Focused/web/workspace/type/lint/planning/runtime/package/supply-chain/privacy gates plus manual state-machine and residue inspection pass; no React, storage, profile mutation, polling, hidden fallback, or release claim is introduced. |

## Planned Validation

```bash
pnpm --filter @hostdeck/web test
pnpm --filter @hostdeck/web typecheck
pnpm --filter @hostdeck/web build
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

## Evidence

Implementation and evidence are pending. No `BSC-01` to `BSC-18` criterion is claimed complete by this criteria commit.
