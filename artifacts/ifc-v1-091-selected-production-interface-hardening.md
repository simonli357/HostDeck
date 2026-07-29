# IFC-V1-091 Selected Production Interface Hardening

Date: 2026-07-29
Status: strict criteria frozen before implementation changes

## Objective

Harden the complete selected browser/operator boundary as one production module: typed loopback Fastify API and SSE, private Tailscale Serve ingress, HostDeck application authorization, remote lifecycle, bounded CLI transport, deterministic package, and foreground/user-service ownership. The pass must find cross-owner contradictions that isolated leaves can miss and must produce current L2-L4 traceability without treating historical direct-LAN, custom-CA, raw, tmux, or source-TypeScript paths as selected evidence.

Requirement refs: `FR-011`, `FR-012`, `FR-017`, `FR-018`, `IR-006`, `IR-008`, `NFR-001`, `NFR-002`, `NFR-005`, `NFR-009` to `NFR-012`, `PR-002` to `PR-005`, `PR-007` to `PR-012`, and `SFR-001` to `SFR-008`, `SFR-012` to `SFR-018`.

Primary owners: `docs/planning/04-technical-plan.md`, `docs/planning/04a-implementation-blueprint.md`, `docs/planning/04b-test-plan.md`, `docs/planning/05-blocks/BLK-V1-04-api-cli-control-plane.md`, and `docs/tracking/backlog/api-cli-control-plane.md`.

## Frozen Boundary

- The selected production surface is the manifest-derived 35-route API with 22 unique registrations: 34 JSON routes, one SSE route, and the manifest-verified same-origin dashboard. Count or identity drift must fail until every client, package, and evidence owner is updated coherently.
- HostDeck listens only on verified IPv4 loopback HTTP. Tailscale Serve owns private external HTTPS. Codex app-server remains on one owner-private Unix socket. No HostDeck TLS, LAN/private-address, wildcard, public, Funnel, relay, or manual-CA path exists.
- Remote membership and Tailscale identity provide transport/source context only. Protected reads and writes require current HostDeck application authority; writes additionally require the exact ordered write gate.
- Remote profile and Serve mutation occurs only after an explicit local CLI `remote enable` or `remote disable`. HostDeck never invokes profile switching, repairs ambiguous state, retries an uncertain mutation, or changes foreign/company Serve configuration.
- Foreground and service modes share the selected application/listener contracts while retaining distinct Codex process ownership. The deterministic package and verified installation are the only production execution roots.
- Existing completed leaf artifacts are admissible inputs only when their scope, product identity, and cleanup remain current. This pass must add executable aggregate coverage and current inspection; a list of historical task claims is not aggregate proof.

## Frozen Success Criteria

| ID | Required assertion |
| --- | --- |
| `PIH-01` | One immutable task-owned ledger enumerates all 35 routes, 22 registrations, production execution roots, HTTP/SSE/security test dimensions, requirement refs, and `PIH-01` to `PIH-24`. Missing, duplicate, stale, historical-only, or unowned rows fail before a success report is written. |
| `PIH-02` | Selected composition reaches every manifest route, the one SSE transport, current built dashboard assets, mutable health, remote lifecycle, and shutdown through public production factories. No test-only live source, legacy listener/TLS/LAN/raw/tmux route, source loader, or alternate production export is reachable in source, emitted closure, package manifest, CLI, or startup. |
| `PIH-03` | Normal local and admitted-remote reads plus every permitted mutation return schema-valid bounded results. Unknown route/method, unsupported media, malformed URL/parameter/query/header/body/JSON/UTF-8/schema, impossible target, and serialization failure return the stable true cause with no protected side effect or fake success. |
| `PIH-04` | Exact and over-limit URL, parameter, header, body, response, connection, in-flight, request, handler, protocol, CLI, replay, queue, and subscriber cases use the one frozen policy. Slow upload/client/handler and noncooperative work retain and release the correct owner exactly once under bounded deadlines without global starvation or leaked timers/listeners. |
| `PIH-05` | Repeated, duplicate, concurrent, and response-loss mutations preserve one operation identity, target/device/global admission order, at-most-once dispatch, and truthful conflict/incomplete outcomes. No automatic retry, compensation, late-success rewrite, or second dispatch occurs after timeout, abort, socket loss, or response serialization failure. |
| `PIH-06` | Every browser mutation executes parse, ingress, authentication/permission/expiry/CSRF/rate, lock, exact target/runtime/capability, audit accepted, dispatch once, terminal audit, and response consistency in that order. Each injected boundary failure proves response, dispatch count, durable state, and audit chronology agree. |
| `PIH-07` | SSE initial/empty/pruned/future replay, `Last-Event-ID`, explicit cursor, replay-to-live handoff, event ordering, duplicate/gap/malformed input, heartbeat, finite completion, reconnect, and reset/exhaustion are schema/session/cursor/wire-byte bounded and commit no event twice. |
| `PIH-08` | SSE opening and active streams close on request abort, route/client cancellation, paired-device revoke, remote-generation invalidation, queue overflow, source failure, listener drain, and shutdown. Readable backpressure, iterator return, raw-response completion, subscriber counters, timers, and same-port restart settle within owner deadlines. |
| `PIH-09` | Listener verification admits only exact IPv4 loopback HTTP. Exact Host/Origin and the reviewed Serve proxy form pass; wildcard/private/public/IPv6-any binds, DNS rebinding, reflected/foreign/null Origin, CORS preflight, duplicate/comma-joined/partial/contradictory forwarding or identity fields, Funnel, wrong socket/TLS/target, and proxy-shaped local fallback reject before protected work. |
| `PIH-10` | Pair claim, Secure/HttpOnly/host-only/SameSite=Strict cookie, page-memory CSRF bootstrap/rotation, read/write permissions, expiry, revoke, self-revoke, lock/local unlock, source/device/global rate, and concurrency behavior pass normal, invalid, boundary, repeated, and race cases. Tailscale identity or loopback header imitation never manufactures HostDeck application authority. |
| `PIH-11` | Pairing fragments, bearer values, CSRF tokens, protected data, raw source identity, full account/profile/node/DNS identity, Tailscale output, node keys, credentials, prompts, approvals, and transcript content are absent from URLs after bootstrap, history, referrers, browser storage, public objects, responses, errors, logs, audits, process arguments, raw SQLite/WAL/SHM, package output, and retained evidence except within the exact ephemeral owner that requires them. |
| `PIH-12` | Tailscale absent/stopped/signed-out/unsupported, dedicated/other/unknown profile, and Serve absent/exact/foreign/colliding/drifted/public states produce the frozen bounded taxonomy. Observation never switches profiles, starts/stops Tailscale, resets Serve, exposes raw output, or changes local Codex/API readiness. |
| `PIH-13` | Explicit local `remote enable/status/disable` serializes through one durable intent/proof/generation owner and one bounded manager call. Profile switch before/during/after mutation, consent/permission denial, unchanged/nonzero-with-change/timeout/abort/oversize/partial result, storage/audit/proof/response failure, and cleanup conflict remain fail-closed, non-retried, and truthful; unrelated Serve state is unchanged. |
| `PIH-14` | Phone/client network loss affects only that request. Profile-away, Serve drift/removal, observer failure, lease expiry, and generation change synchronously close stale remote authority while local HostDeck/Codex continue. Exact profile return only observes current persisted proof; missing/drifted state requires explicit enable and is never auto-repaired. |
| `PIH-15` | Runtime, storage, projection, stream, and remote health remain independently mutable after startup. Exact Codex 0.144.0 reaches full readiness; valid unsupported version reaches only durable mutation-closed diagnostic readiness; malformed/unobservable version, schema/capability drift, and stale health cannot publish ready or dispatch. |
| `PIH-16` | Invalid config/path/origin/profile/Serve state, insecure/substituted files, migration failure, held lease, unavailable/replaced socket, plugin/route/listen/verification/observer/scheduler failure, and partial startup roll back every acquired owner in reverse order. They leave no listener, authority, lease, child, socket, timer, database handle, or temporary path. |
| `PIH-17` | Repeated/concurrent shutdown closes mutation admission before listener refusal and then drains SSE, requests, protocol work, audit/projection, app/listener, storage, runtime ownership, and lease in the frozen order. Every stage throw/timeout still runs later cleanup; restart reuses the exact port/lease without stale authority or contradictory incomplete audit. |
| `PIH-18` | The packaged `codexdeck` grammar exposes exactly the selected serve/status/session/control/access/remote/service operations. Invalid grammar fails before side effects; all clients use one bounded loopback transport, stable exit classes, schema-valid public output, no mutation retry, no direct Tailscale bypass, no browser-only authority shortcut, and no private origin or secret in human/JSON/errors. |
| `PIH-19` | Two clean frozen-lock builds produce byte-identical verified packages whose manifests bind source, emitted closure, runtime, native dependency, web, route, command, unit, mode, link, and hash identity. Relocation/read-only execution, corrupt/missing/extra/stale content, source-map/source-loader absence, static cache/MIME/CSP policy, and atomic publication/rollback all pass. |
| `PIH-20` | Compiled foreground, packaged service host, generated user units, install/idempotence/start/status/restart/stop, active/inactive upgrade, rollback/recovery, retention, uninstall/reinstall, and clean ordinary-user parity agree on API/dashboard behavior and ownership. HostDeck-only lifecycle never kills the service-owned Codex process or mutates Tailscale; complete cleanup preserves config/state and unrelated sentinels exactly as each command specifies. |
| `PIH-21` | A fresh L2 aggregate composes the real loopback listener, selected 35-route graph, production SSE transport, real SQLite audit/state, shared resource policy, write admission, controlled protocol boundary, remote authority/lifecycle, and bounded CLI. Synchronized normal/invalid/boundary/repeated/concurrent/slow/failure/shutdown/restart scenarios assert exact request/dispatch/event/audit/resource counts and return every owner to zero. |
| `PIH-22` | Current L3 evidence runs the verified package through direct foreground and service-owned execution against the exact supported Codex binary, inspects listener/process/socket/file/version/health ownership, and proves same-port/restart/shutdown behavior without a model turn, source execution, fake producer, or Tailscale mutation. Any implementation change invalidating accepted package/service evidence requires the affected smoke to be rerun. |
| `PIH-23` | The L4 matrix links current clean-user package/service proof and accepted physical cellular Tailscale HTTPS/profile-switch evidence by exact commit ancestry and unchanged owning boundaries. Live inspection confirms the dedicated profile/Serve state is not silently altered. Fresh full-dashboard phone acceptance remains `FE-V1-090`; historical direct-LAN/custom-CA evidence cannot satisfy any row. |
| `PIH-24` | Closure records every command, exact pass/skip count, duration where material, product/package/commit identity, manual loopback/profile/Serve/cookie/storage/process/version/privacy inspection, criterion disposition, discovered defect and fix, accepted prior evidence, remaining gap, cleanup inventory, and commit/push state. No open criterion, unexplained skip, listener/process/temp residue, secret-bearing artifact, or hidden fallback permits completion. |

## Initial Gap Audit

| Gap | Required action |
| --- | --- |
| No `IFC-V1-091` artifact or frozen aggregate criteria existed. | This revision freezes `PIH-01` to `PIH-24` before product changes. |
| Completed leaves have extensive evidence, but no task-owned executable ledger proves full current composition and L2-L4 ownership without omission. | Add a machine-checked criterion/requirement/route/evidence ledger and a focused fresh L2 aggregate. |
| Package, foreground, service, clean-user, remote-control, and physical Android evidence were produced by separate owners and commits. | Verify exact ancestry and changed-boundary relevance; rerun every invalidated L3 boundary and bind accepted L4 evidence explicitly. |
| Manual current-state listener/profile/Serve/cookie/storage/process/version/privacy inspection is not recorded for this aggregate. | Perform bounded current inspection, retain only sanitized facts, and prove cleanup/noninterference. |
| The live development host is intentionally uninstalled and the Android client is currently offline after prior acceptance cleanup. | Do not treat this as an interface defect. Reinstall and fresh physical dashboard acceptance belong to immediately following `FE-V1-090`. |

## Required Evidence Shape

- One machine-readable aggregate ledger and a validator that fails closed on route, registration, requirement, criterion, command, evidence, or package-identity drift.
- One fresh L2 real-boundary aggregate plus focused regressions for every defect found.
- Current static, unit, contract, integration, web, package, foreground/service, runtime-boundary, supply-chain, privacy, and residue results appropriate to changed boundaries.
- Sanitized L3 manual inspection and explicit L4 evidence ancestry/relevance review.
- Final criterion table with `pass`, `blocked`, or narrowly justified `not applicable`; only all-pass permits task closure.

## Documentation Impact

Tier 1 task/evidence update under `docs/README.md`: this artifact and the owning backlog row while criteria are frozen. Planning, architecture, delivery, command, and status owners change only if audit or implementation changes their facts.
