# Test Plan

Owns V1 validation layers, commands, matrices, real-boundary policy, UI/device evidence, and release proof. Passing package tests is necessary but never sufficient for production or release completion.

## Evidence Levels

| Level | Proves | Does not prove |
| --- | --- | --- |
| L1 Unit/contract | Pure invariants, schema rejection, deterministic projections, package APIs. | Process, database, network, browser, or Codex behavior. |
| L2 Integration | Real SQLite, IPC transport, Fastify injection/listener, process orchestration, concurrency, retention. | Complete user workflow or real phone behavior. |
| L3 System | Packaged HostDeck plus real Codex app-server/TUI/browser on Ubuntu. | Clean-machine setup or release support quality by itself. |
| L4 Device/release | Clean install, user services, HTTPS phone access, supported browsers, security/privacy, handoff. | Future-version compatibility. |

Task and block evidence names its level. "Complete for package scope" cannot satisfy a block whose outcome requires L3/L4.

## Commands

| Command | Required owner | Purpose | Release expectation |
| --- | --- | --- | --- |
| `pnpm check:scaffold` | Foundation | Workspace/package/export skeleton. | Pass. |
| `pnpm check:planning` | `FND-V1-014` | Task/requirement/dependency/current-queue integrity. | Pass. |
| `pnpm check:codex-bindings` | `INT-V1-003` | Regenerate the pinned experimental binding and reject identity or method-catalog drift. | Pass with the reviewed Codex version installed. |
| `pnpm smoke:codex-compatibility` | `INT-V1-003` | Prove the pinned runtime initialize/platform/Plan catalog over stdio without a model call. | Pass on the supported development/release host. |
| `pnpm smoke:codex-ipc` | `INT-V1-004` | Prove the production private Unix transport, broker, and handshake against the pinned runtime without a model call. | Pass on the supported development/release host. |
| `pnpm smoke:codex-model` | `INT-V1-019` | In an isolated authenticated runtime, select one visible non-current catalog model, send it through `turn/start`, confirm settings plus later resume read-back, archive, and clean up. | Pass against exact reviewed Codex 0.144.0; terminal prompt failure remains distinct from setting confirmation. |
| `pnpm smoke:codex-goal` | `INT-V1-020` | In an isolated authenticated runtime, prove paused set causes no turn, active resume autonomously starts one bounded turn, explicit pause plus interrupt prevents continuation, then complete/clear/read-back and cleanup. | Pass against exact reviewed Codex 0.144.0 with at most one observed goal turn. |
| `pnpm smoke:codex-plan` | `INT-V1-021` | In an isolated authenticated runtime, compose one visible non-current model into a Plan turn, require matching settings plus plan-specific item/delta evidence, then exit through a later explicit Default turn; reject top-level settings, zero-turn update, slash fallback, excess turns, or incomplete cleanup. | Pass against exact reviewed Codex 0.144.0 with exactly two bounded turns. |
| `pnpm smoke:codex-usage` | `INT-V1-022` | In an isolated authenticated no-model runtime, read exact account usage, validate bounded summary/daily shape, prove no turn/token/message work, record no account values, then close and remove private runtime state. Existing redacted real-turn captures own exact token/rate notification evidence; the no-model read does not require or invent a rate update. | Pass against exact reviewed Codex 0.144.0 without retaining token totals, account identity, paths, credentials, or claiming monetary/per-thread cost. |
| `pnpm typecheck` | Foundation | Strict workspace TypeScript. | Pass. |
| `pnpm lint` | Foundation | Formatting/lint/package-export checks. | Pass. |
| `pnpm test:unit` | All modules | L1 pure behavior. | Pass. |
| `pnpm test:contract` | Contracts/interfaces | L1 normalized API/storage/UI/Codex-adapter contracts. | Pass. |
| `pnpm test:integration` | Storage/runtime/server | L2 SQLite/process/IPC/Fastify/SSE/auth/concurrency. | Pass. |
| `pnpm test:web` | Web | Component/state/API-client tests. | Pass. |
| `pnpm test:codex` | `INT-V1-027` | Opt-in L3 real app-server thread/turn/control/approval/TUI/reconnect suite assembled from the semantic and operation leaves. | Pass on release host with recorded version; may be excluded from ordinary CI when credentials/model use are required. |
| `pnpm test:e2e` | `IFC-V1-046`, `FE-V1-040` | Packaged browser workflow against isolated fixture runtime and the supported browser matrix. | Pass. |
| `pnpm build` | `IFC-V1-053`, `IFC-V1-054` | Production server/web assets and runnable CLI artifacts. | Pass from clean checkout. |
| `pnpm smoke:local` | `REL-V1-006` | Installed user-service, real Codex, browser/phone workflow. | Pass with artifact. |

Unavailable commands fail loudly with owning task id. No placeholder command may exit zero.

## Foundation Matrix

| Area | Normal | Boundary/invalid | Repeated/concurrent |
| --- | --- | --- | --- |
| Timestamps | Valid UTC/offset round trip. | Invalid calendar date, offset, format reject. | Stable serialize/parse. |
| Cursors/counts | Zero and safe integer max policy. | Negative, fraction, unsafe integer reject. | Monotonic under concurrent append. |
| Lifecycle | Documented user and reconciliation transitions. | Impossible transition rejects. | Repeated terminal transition is deliberate idempotency or conflict. |
| Error envelope | Bounded safe detail. | Secret/unbounded/unknown shape reject. | Nested failures preserve one stable cause. |
| Target identity | One session/request/device/host target. | Missing, unknown, multiple, mismatched ids reject. | Duplicate operation ids do not duplicate mutation where idempotency exists. |

## Codex Compatibility Matrix

| Case | Required assertion |
| --- | --- |
| Supported version | Binding regeneration matches reviewed identity; handshake and required capabilities pass. |
| Initialize response/ack race | Bounded generated notifications after the correlated initialize response queue in order and flush after `initialized`; pre-response messages and overflow terminate. |
| Older/newer unsupported version | Startup is incompatible before session mutation; message names observed and supported policy. |
| Additive optional notification | Count/ignore according to compatibility policy without changing status. |
| Unknown required response/server request | Runtime degrades/incompatible; no fallback text injection. |
| Malformed frame/message | Connection closes or request fails with bounded protocol error. |
| Request timeout/disconnect | Read may retry by policy; mutation becomes incomplete/unknown unless proven idempotent. |
| Max in-flight/frame/queue | New work rejects with overload; process remains healthy. |
| Multi-client | HostDeck and TUI connect to one runtime and address the same thread without corruption. |
| Usage read/observations | Exact no-param account response keys, safe integer and calendar/bucket bounds, target before/after race, generation change, absent/current token and rate snapshots, monotonic token/context updates, malformed/oversize response, unsupported/disconnected runtime, abort/timeout, and two-thread isolation all remain read-only. |

## Real Codex Vertical

The release host records Codex version, HostDeck commit, commands, thread ids in redacted form, and cleanup result. Required sequence:

1. Start dedicated app-server on private Unix socket and complete handshake.
2. Start two managed threads in separate temporary repositories without alias collision. For the pinned legacy store, prove loaded-thread recovery before id persistence, id-first recovery persistence, no-model rollout materialization, final empty goals, and stored list/read identity before either start is reported successful.
3. Start one bounded real turn, treat the response as accepted, wait for matching `turn/started`, and verify ordered item/status events through HostDeck projection and SSE.
4. Steer only that event-proven active turn with `expectedTurnId`; prove no second `turn/started` and no change to the other thread. Early/stale steer rejects.
5. Exercise model catalog plus next-turn model read-back, paused and agentic goal behavior, Plan/Default next-turn settings, usage read, accepted/incomplete compact, and skills list according to supported capabilities.
6. Trigger a safe approval request in an isolated temporary repository; approve once, deny once, reject duplicate/expired response.
7. Interrupt an event-proven active turn and verify `turn/completed: interrupted` is not normal completion or archive.
8. Resume the exact thread in the normal TUI through the same Unix socket.
9. Restart HostDeck only and prove app-server/thread work remains; restart app-server and prove honest interruption/boundary/reconciliation.
10. Archive/clean temporary threads and remove temporary repositories/runtime state.

If a safe deterministic approval trigger cannot be created, the approval feature remains blocked; a fake-only approval is not release evidence.

An immediate `thread/compact/start` `{}` is not completion evidence. Direct adapter tests require the exact one-field mutation, exact empty response, capability/version/generation gates, malformed-response rejection, possible-send outcome, and no retry. Direct control tests cover confirmation and exact current idle target checks; per-session serialization and capacity; response/event races; ordered turn plus context-item binding; item-complete/turn-terminal conjunction; duplicate, stale, wrong-thread, archive, and reconnect events; known rejection versus unknown outcome; and completed, interrupted, failed, and incomplete states across two isolated threads. Deprecated `thread/compacted`, elapsed time, terminal output, and slash fallback are forbidden proof sources.

The exact real suite records request acceptance, matching turn/context-compaction item start, and either authoritative item-plus-turn completion or bounded incompleteness. If still unresolved, it invokes the separate exact-turn interrupt path and requires `turn/completed: interrupted`; it never reports context reduction from acceptance, item start, timeout, or interrupt. The artifact records exact Codex/binding identity, bounded method/state counts, redaction checks, and process/socket/thread cleanup without retaining prompts, ids, paths, credentials, account values, or raw frames.

## Storage And Audit Matrix

| Area | Cases |
| --- | --- |
| Migration | Empty DB, current DB, prior tmux-shaped DB, interrupted migration, checksum/version drift, incompatible future schema. |
| Session mapping | Start saga success; Codex failure; thread created/DB failure; duplicate alias/id/thread; missing/archived thread; pre-release legacy record. |
| Projection | Storage-owned cursor/counters, ordered append, malformed/caller-addressed event, stale full revision, metadata/event writer race, duplicate upstream id, corrupt counters/rows, forced transaction rollback with zero publication, post-commit publisher throw/reject with durable read-back and no automatic republish, restart freshness. |
| Codex event normalization | Every selected exact method and observed item kind; strict ids/timestamps/statuses/bounds; clock, turn/item, archive, retained-identity, and pending-queue capacity invariants; two managed threads isolate; valid unmanaged TUI payloads become bounded identity-only observations before deep parsing; classification/mapping disagreement is fatal; generated optional flood stays bounded/content-free; unknown and deprecated compact cannot project; runtime rate limit remains unscoped; approval resolution carries no invented decision; raw normalization cannot run ahead of append/publication and stops after queue/managed malformed/order/storage/publication failure. |
| Retention | Event-count cap, byte cap, audit-count cap, age cap, newest item larger than byte cap, cleanup on production append/startup, boundary persistence. |
| Audit | Accepted/succeeded/failed/rejected/incomplete, crash between accepted/result, emergency lock under audit degradation, sanitization, retention. |
| Auth | Pair create/consume/expire/revoke, device read/write permission, raw-secret absence, CSRF rotate/reload/revoke race, last-used update. |
| Permissions/lease | Fresh paths, over-permissive path/file/key/socket, symlink/path substitution, second daemon, stale lease recovery. |

Permission/lease evidence also proves pure path validation before mutation, minimal state/lease bootstrap, acquisition before config/runtime/database/listener mutation, owner/type/hard-link rejection, descriptor/path-substitution detection, mode-repair reporting, idempotent release, release after each later startup failure, and child-process crash recovery against the real Linux lock implementation.

## HTTP, SSE, And Security Matrix

| Dimension | Required cases |
| --- | --- |
| Bind policy | Default loopback only; explicit LAN HTTPS; plaintext LAN rejected; app-server socket never TCP/LAN. |
| Host/Origin | Valid configured origin; missing Origin on non-browser safe reads by policy; foreign Origin; reflected/mismatched Host; DNS-rebinding names; wildcard CORS absent. |
| Cookies/CSRF | Secure/HttpOnly/host-only/SameSite, no raw bearer in JS storage, reload bootstrap, stale generation, cross-origin form/fetch, revoked device. |
| Pair/rate | Invalid/expired/used codes, per-source rate, global cap, concurrent claim, audit each outcome without secret. |
| Authorization | Loopback policy, unpaired LAN read, read-only write, locked write, expired/revoked, wrong target, local-admin-only operation. |
| Limits/timeouts | Oversized headers/body, slow body, request deadline, idle connection, max connections/subscribers, protocol deadline, CLI timeout. |
| SSE | Initial replay, empty replay, `Last-Event-ID`, explicit cursor, invalid/future/pruned cursor, event during handoff, heartbeat, Readable-backed slow-client backpressure, abort/source/iterator cleanup, direct-AsyncIterable regression guard, queue overflow, auth revoke, shutdown. |
| Lifecycle | Failed startup leaves no listener/lease/socket; readiness updates after runtime/storage/projector failure; shutdown completes with active SSE. |
| TLS | Trusted configured certificate, unknown CA, expired/not-yet-valid, wrong SAN, weak/invalid key, key permission, renewal/reconfigure, no secret logging. |

Security tests assert both response behavior and side effects: no dispatch, no leaked session data, no success audit, and no credential issuance where rejection is expected.

Fastify evidence is layered: `IFC-V1-016` freezes exact dependencies and proves validation/error, injection/close, SSE negotiation/replay/heartbeat/real-disconnect, and static boundaries in `packages/server/src/fastify-stack.probe.test.ts`. `IFC-V1-020` freezes 59 exact resource definitions, cross-limit invariants, public breach families, Fastify/Codex option mappings, and monotonic owner/view semantics. Its contract matrix rejects every below-minimum/above-maximum/non-integer field and contradictory policy; fake-clock tests cover expiry, no extension, external-signal identity, parent abort, disposal, rollback, and timer cleanup. `IFC-V1-022` proves the unbound factory, exact frozen config, API/SSE/static registration surfaces, local Zod request/response ownership, pre-routing plus route error normalization, request-id policy, URL/parameter/body/in-flight bounds, same-signal deadlines, handler-plus-response completion accounting, real timeout retention, and pinned SSE/static compatibility by injection. `IFC-V1-023` proves exact SSE registration, pinned Accept behavior with stable 406, canonical query/header cursor reconciliation, cursor-bearing selected-event framing, heartbeat, full wire-byte bounds, strict session/order validation, Readable-only structure, exact-signal disconnect, observed source/plugin failure, bounded iterator return, real paused-client backpressure, noncooperative cleanup settlement, and real finite-response end. `IFC-V1-024` proves static traversal/dotfile/cache/fallback and current-file admission. `IFC-V1-025` proves upfront runtime cleanup authority, no-listen-before-ready, constructor/mutable Node limit inventory, exact loopback bind, startup and per-step deadlines, route/ready/listen failure cleanup, real secure lease restart, active finite-SSE close, idempotent aggregate shutdown, and same-port restart. `IFC-V1-034` owns replay/high-water/live continuity, `IFC-V1-035` owns bounded subscriber queues, `IFC-V1-036` and `IFC-V1-037` own mutable health and complete application drain, and `IFC-V1-047` to `IFC-V1-052` own enforcement and aggregate stress evidence.

## UI State Matrix

Every row is tested at 390 x 844; marked stress states also run at 360 x 800 and 1280 x 800.

| Screen | Required states |
| --- | --- |
| Mission Control | Loading, empty, mixed attention, all quiet, long names/paths, offline, locked, read-only, incompatible runtime, certificate error, degraded host. |
| Session Detail | Active writable turn, waiting input, approval, completed, interrupted, failed, unknown, stale, archived/not found, reconnecting, replay boundary. |
| Composer | Empty, keyboard open, sending, accepted/running, failed retryable/nonretryable, disabled by each trust/runtime state. |
| Model/goal/plan | Current value, loading, changed, active/paused/complete goal, plan active, unsupported version, conflict, failure. |
| Usage/compact/skills | Loading, content, empty, unsupported, compact running/completed/failed. |
| Approval | Normal, broad/elevated confirmation, approve pending/success/fail, deny, duplicate tap, expired/resolved, connection generation changed. |
| Host/access | Unpaired, pair claim, read-only, writer, reload/CSRF bootstrap, expired/revoked, locked, LAN/HTTPS state. |
| Event details | Normal, redacted, truncated, unknown optional type, boundary. |

## UI Fidelity And Accessibility

- Two complete mobile-first directions are inspected against `03-ux-spec.md`; theme-only variations fail the gate.
- Human selection is recorded before React screen implementation.
- Playwright captures 360 x 800, 390 x 844, 412 x 915, 768 x 1024, and 1280 x 800 for required groups/states.
- Screenshot review checks overlap, clipping, first-viewport usefulness, sticky composer/keyboard behavior, long content, safe areas, and desktop expansion.
- Keyboard, focus restoration, dialog semantics, live-region restraint, 200 percent zoom, 320 px reflow, contrast, reduced motion, and touch targets are inspected.
- At least one real Android or iOS browser proves HTTPS enrollment, pairing, reload, prompt, approval, lock, and disconnect recovery.
- Drift from approved mockups is fixed or explicitly approved and recorded; generated assets are stored in the repo.

## Release Matrix

| Gate | Evidence |
| --- | --- |
| Clean checkout/install | Exact Node/pnpm/Codex/Ubuntu versions, frozen install, build, tests. |
| Package/CLI | Runnable `codexdeck`, help/exit codes, no source-only invocation dependency. |
| User services | Install, start, status, restart each unit, HostDeck-only restart, app-server crash, stop, uninstall, log inspection. |
| Data/privacy | Path/file/socket/key permissions, no raw secrets/transcript copy, retention, no external telemetry/listener. |
| Network | Listener inventory, loopback default, LAN HTTPS, host/origin/rate/cookie tests. |
| Browser/device | Supported desktop browser and real phone workflow. |
| Recovery | Reboot/login or documented service lifecycle, stale runtime files, incompatible Codex update, certificate renewal, DB backup/recovery policy. |
| Documentation | User/developer/command/repo docs contain only verified commands and behavior. |
| Go/no-go | Block completion matrix links L1-L4 evidence and lists zero hidden blockers. |

## Requirement And Block Coverage

| Scope | Minimum evidence |
| --- | --- |
| `FR-001` to `FR-018` | Contract plus integration; real Codex for runtime-owned semantics; UI/device where user-facing. |
| `NFR-001` to `NFR-013` | Architecture inspection, negative/resource/lifecycle tests, clean release smoke. |
| `IR-001` to `IR-012` | State/component/API tests, approved mockups, Playwright screenshots, accessibility, real phone. |
| `DR-001` to `DR-011` | Migration/repository/transaction/retention/restart/raw-storage evidence. |
| `PR-001` to `PR-012` | Ubuntu/Codex/browser/package/service/network compatibility evidence. |
| `SFR-001` to `SFR-018` | Security matrix, side-effect assertions, privacy review, device proof. |
| `BLK-V1-01` | Rebased contracts/fixtures/planning checker plus module hardening. |
| `BLK-V1-02` | Migrated secure state, production retention/audit/auth/lease plus hardening. |
| `BLK-V1-03` | Real structured Codex vertical, restart/TUI/multi-client, legacy disposition, hardening. |
| `BLK-V1-04` | Fastify/SSE/HTTPS/auth/CLI/package/service production path plus hardening. |
| `BLK-V1-05` | Mobile-first selected design, complete dashboard, screenshot/device/fidelity hardening. |
| `BLK-V1-06` | L1-L4 aggregate, clean setup, docs, privacy/security, explicit go/no-go. |

## Evidence Policy

- Artifacts record command, environment/version, scope, result, failures, manual observations, and cleanup.
- Secrets, full prompts/transcripts, private paths beyond what is necessary, cookies, pairing codes, certificates keys, and approval payloads are redacted.
- A skipped test is a gap unless its owning requirement explicitly permits it.
- Flaky retries are recorded; a retry is not evidence that the first failure was harmless.
- Human visual and acceptance decisions link exact assets/build/commit.
- Release claims use the current selected production path, never superseded tmux/fake evidence.
