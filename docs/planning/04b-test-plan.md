# Test Plan

Owns V1 validation layers, commands, matrices, real-boundary policy, UI/device evidence, and release proof. Passing package tests is necessary but never sufficient for production or release completion.

## Evidence Levels

| Level | Proves | Does not prove |
| --- | --- | --- |
| L1 Unit/contract | Pure invariants, schema rejection, deterministic projections, package APIs. | Process, database, network, browser, or Codex behavior. |
| L2 Integration | Real SQLite, IPC transport, Fastify injection/listener, process orchestration, concurrency, retention. | Complete user workflow or real phone behavior. |
| L3 System | Packaged HostDeck plus real Codex app-server/TUI/browser on Ubuntu. | Clean-machine setup or release support quality by itself. |
| L4 Device/release | Clean install, user services, Tailscale Serve HTTPS from a phone without a LAN route, saved-profile switching, supported browsers, security/privacy, handoff. | Future-version compatibility. |

Task and block evidence names its level. "Complete for package scope" cannot satisfy a block whose outcome requires L3/L4.

## Commands

| Command | Required owner | Purpose | Release expectation |
| --- | --- | --- | --- |
| `pnpm check:scaffold` | Foundation | Workspace/package/export skeleton. | Pass. |
| `pnpm check:planning` | `FND-V1-014` | Task/requirement/dependency/current-queue integrity. | Pass. |
| `pnpm check:runtime-boundary` | `INT-V1-008` | Reject tmux package/dependency/export/source/CLI reachability while requiring the bounded legacy reset repository. | Pass. |
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
| `pnpm test:package` | `IFC-V1-021`, `IFC-V1-054`, `IFC-V1-086` | Build twice, inspect and verify the production tree, then run unrelated-path read-only import/native/loopback lifecycle, five-layout command invocation, command/service-host/verifier mutation, rollback, and failure-injection checks. | Pass on the exact supported Node/pnpm Linux build target without network or source TypeScript execution; retain exactly one executable HostDeck command. |
| `HOSTDECK_CODEX_BIN=/absolute/path/to/codex-0.144.0 pnpm smoke:executable-serve` | `IFC-V1-054` | Run the direct packaged command twice from a read-only relocation against test-owned package-layout assets; verify loopback readiness/static delivery, exact runtime, signal shutdown, same-port reuse, no model turn, and zero residue. | Pass only with the exact reviewed executable and already-built verified package; no Tailscale/profile/phone mutation. |
| `HOSTDECK_CODEX_BIN=/absolute/path/to/codex-0.144.0 pnpm smoke:service-host` | `IFC-V1-086` | Run an externally owned exact app-server plus the non-executable packaged service-host from a read-only relocation; replace app-server while HostDeck stays alive, then replace HostDeck twice while app-server stays alive. | Local health/static recover without Tailscale, no model turn occurs, ownership never crosses, and every test-owned process/socket/temp path is removed. |
| `HOSTDECK_CODEX_BIN=/absolute/path/to/codex-0.144.0 pnpm smoke:systemd-user-units` | `IFC-V1-055` | Verify and runtime-link the exact generated user units, then exercise pull-in, repeated start, HostDeck-only restart, Codex-only restart/stop/recovery, shared-lease exclusion, and exact cleanup against the real user manager. | Pass on supported systemd with the pre-existing failed-unit set preserved, exact ownership/PID/socket/readiness transitions, unchanged pre-existing Tailscale profile/Serve state, no model turn, and no persistent unit/runtime/temp residue. |
| `pnpm test:codex` | `INT-V1-091` | From a clean commit and exact binary, run the frozen deterministic runtime inventory plus strict structured-control and lifecycle/restart/TUI scenarios, then publish one machine-validated private aggregate. | Pass on release host with exact commit/version, five bounded model turns, no skip/retry/fallback, and zero process/socket/temp residue; may be excluded from ordinary CI because credentials/model use are required. |
| `pnpm test:e2e` | `IFC-V1-046`, `FE-V1-040` | Packaged browser workflow against isolated fixture runtime and the supported browser matrix. | Pass. |
| `pnpm build` | `IFC-V1-021`, extended by `IFC-V1-053` and `IFC-V1-054` | Emit the deterministic self-contained compiled server/CLI package and one verified runnable CLI entry; the asset owner later adds the real web build. | Pass after frozen install; no network, source TypeScript runtime, stale output, or partial publication. |
| `pnpm smoke:local` | `REL-V1-006` | Installed user service, real Codex, local browser, and remote-phone workflow through the selected Tailscale profile. | Pass with artifact; the artifact also records manual device/profile evidence the command cannot automate. |

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

An immediate `thread/compact/start` `{}` is not completion evidence. Direct adapter tests require the exact one-field mutation, exact empty response, capability/version/generation gates, malformed-response rejection, possible-send outcome, and no retry. Direct control tests cover confirmation and exact current idle target checks; per-session serialization and capacity; response/event races; ordered turn plus context-item binding; item-complete/turn-terminal conjunction; duplicate, stale, wrong-thread, archive, and reconnect events; known rejection versus unknown outcome; and completed, interrupted, failed, and incomplete states across two isolated threads. Normalizer/usage tests prove that independent `last` usage may exceed post-compaction `total` and that exactly one cumulative reset is accepted only after the matching context-compaction item starts; ordinary, repeated, stale, pre-item, and post-terminal regressions still reject. Deprecated `thread/compacted`, elapsed time, terminal output, and slash fallback are forbidden proof sources.

The exact real suite records request acceptance, matching turn/context-compaction item start, and either authoritative item-plus-turn completion or bounded incompleteness. If still unresolved, it invokes the separate exact-turn interrupt path and requires `turn/completed: interrupted`; it never reports context reduction from acceptance, item start, timeout, or interrupt. The artifact records exact Codex/binding identity, bounded method/state counts, redaction checks, and process/socket/thread cleanup without retaining prompts, ids, paths, credentials, account values, or raw frames.

Skills contract/adapter/control tests require one exact selected-cwd `skills/list` read with forced runtime refresh, stable target/runtime/generation before and after, exact one-cwd response identity, strict bounded required keys plus the reviewed omitted-or-null-or-valid policy for generated optional short-description/interface/dependency fields, known scope/enabled truth, deterministic unique public summaries, and explicit content/empty/partial/error states. Tests reject caller/extra/missing cwd, duplicate names, unknown scope/keys, malformed optional interface/dependency/error data, count/UTF-8 overflow, stale/archive/version/generation races, retry/mutation, and any public or artifact retention of cwd/skill/error/icon paths, default prompts, dependency command/URL/transport/value fields, or raw error messages. The repeated exact two-cwd smoke issues independent one-cwd reads, checks only shape/count/state relations, proves no turn/server request/protocol issue, and cleans every temporary resource.

## Storage And Audit Matrix

| Area | Cases |
| --- | --- |
| Migration | Empty DB, current DB, prior tmux-shaped DB, remote-ingress settings/audit/admission-proof upgrade, interrupted migration, checksum/version drift, incompatible future schema. |
| Session mapping | Start saga success; Codex failure; thread created/DB failure; duplicate alias/id/thread; missing/archived thread; pre-release legacy record. |
| Projection | Storage-owned cursor/counters, ordered append, malformed/caller-addressed event, stale full revision, metadata/event writer race, duplicate upstream id, corrupt counters/rows, forced transaction rollback with zero publication, post-commit publisher throw/reject with durable read-back and no automatic republish, restart freshness. |
| Codex event normalization | Every selected exact method and observed item kind; strict ids/timestamps/statuses/bounds; clock, turn/item, archive, retained-identity, and pending-queue capacity invariants; two managed threads isolate; valid unmanaged TUI payloads become bounded identity-only observations before deep parsing; classification/mapping disagreement is fatal; generated optional flood stays bounded/content-free; unknown and deprecated compact cannot project; runtime rate limit remains unscoped; approval resolution carries no invented decision; raw normalization cannot run ahead of append/publication and stops after queue/managed malformed/order/storage/publication failure. |
| Retention | Event-count cap, byte cap, audit-count cap, age cap, newest item larger than byte cap, cleanup on production append/startup, boundary persistence. |
| Audit | Accepted/succeeded/failed/rejected/incomplete, remote enable/disable with ownership/profile conflicts, atomic prior-proof invalidation on accepted remote mutation, post-terminal generation proof, read-only status with no mutation audit, crash between accepted/result/proof, emergency lock under audit degradation, sanitization, retention. |
| Auth | Pair create/consume/expire/revoke, device read/write permission, raw-secret absence, CSRF rotate/reload/revoke race, last-used update. |
| Permissions/lease | Fresh paths, over-permissive path/file/key/socket, symlink/path substitution, second daemon, stale lease recovery. |

Permission/lease evidence also proves pure path validation before mutation, minimal state/lease bootstrap, acquisition before config/runtime/database/listener mutation, owner/type/hard-link rejection, descriptor/path-substitution detection, mode-repair reporting, idempotent release, release after each later startup failure, and child-process crash recovery against the real Linux lock implementation.

## HTTP, SSE, And Security Matrix

| Dimension | Required cases |
| --- | --- |
| Bind/proxy policy | Production HostDeck listener is loopback HTTP only; wildcard/private-address/public binds reject; Tailscale Serve maps the selected HTTPS origin to exact loopback; app-server socket never uses TCP. |
| Tailscale/profile | Not installed, daemon stopped, signed out, dedicated profile active, company/unknown profile active, profile switch before/during/after mutation, direct and DERP paths where observable, Serve absent/exact/foreign/colliding/drifted/public, consent/permission denial, exact/unchanged/nonzero-with-change/timeout/abort/oversize/partial outcomes, serialized enable/disable/read-back, path-scoped cleanup, HostDeck restart, raw-output privacy, other-profile noninterference, and no automatic switch/retry/repair/reset. |
| Host/Origin/proxy | Exact configured external origin; loopback local-admin origin; missing Origin on allowed non-browser safe reads; foreign Origin; reflected/mismatched Host; DNS rebinding names; forwarded-header absence/duplication/contradiction; only the spike-proven Serve overwrite/header contract is admitted; non-loopback direct access fails; exact host-local loopback imitation cannot manufacture paired remote authority and remains inside the documented single-user-host boundary; wildcard CORS absent. |
| Cookies/CSRF | Secure/HttpOnly/host-only/SameSite, no raw bearer in JS storage, reload bootstrap, stale generation, cross-origin form/fetch, revoked device. |
| Pair/rate | QR/link fragment removal before claim, fragment absent from request/log/referrer/history, invalid/expired/used codes, verified remote-source rate key, unverified/spoofed source, global cap, concurrent claim, audit each outcome without secret. |
| Authorization | Loopback local-admin policy, unpaired tailnet peer, paired read-only write, locked write, expired/revoked, wrong target, local-admin-only operation; Tailscale identity alone never grants app access. |
| Limits/timeouts | Oversized headers/body, slow body, request deadline, idle connection, max connections/subscribers, protocol deadline, CLI timeout. |
| Browser JSON | Exact 34-route catalog and type inference; loopback HTTP/private Tailscale HTTPS origin; fixed params/query/body/CSRF construction; caller abort/deadline/capacity; exact/over request and declared/chunked response bytes; malformed status/media/UTF-8/JSON/schema/error; no retry; bounded privacy-safe errors; real selected Fastify loopback and admitted-Serve paired/denied reads. |
| Browser SSE | Exact selected stream path/origin/fetch policy; connect/idle/error/event/concurrency bounds; heartbeat comments; fatal UTF-8 and parser buffer; id/type/session/schema/cursor continuity; sticky first replay boundary; duplicate/out-of-order/gap/malformed input; synchronous consumer commit; capped cursor reconnect/reset/exhaustion; caller/route/unmount/client cancellation; immutable privacy-safe state; real selected Fastify loopback and admitted-Serve paired/denied streams. |
| Browser CSRF | Page-memory-only credential; exact bootstrap/adoption; single-flight rotation; higher/lower/equal/gap generation ordering; old-epoch rejection; all 11 protected-route injections; no caller override; explicit access/profile/revoke invalidation; active-request cancellation; no mutation retry/automatic bootstrap; token-free immutable public state; real selected Fastify reload/stale-page/revoke over loopback and admitted Serve. |
| Browser coordinator | Access-first disclosure; exact route/session epochs; access/host/session origin-mode consistency; loopback-read versus paired authority; current/stale/purged data; 4,096-row bounded pagination; default live-only versus explicit 100-cursor recent detail replay; local/remote health classification; canonical lock/health/CSRF write gate; profile-generation invalidation; recovered failure and sticky boundary; SSE cancellation; no arbitrary cursor, pre-load diagnosis, write retry, polling, storage, or profile mutation. |
| SSE | Initial replay, empty replay, `Last-Event-ID`, explicit cursor, invalid/future/pruned cursor, event during handoff, heartbeat, Readable-backed slow-client backpressure, abort/source/iterator cleanup, direct-AsyncIterable regression guard, queue overflow, auth revoke, shutdown. |
| Lifecycle | Failed startup leaves no listener/lease/socket; readiness updates after runtime/storage/projector failure; shutdown completes with active SSE. |
| External HTTPS | Browser trusts the Tailscale Serve certificate without custom CA enrollment; canonical origin and Secure cookies work across the HTTP proxy hop; stopped/wrong-profile/Serve-certificate failure is explicit; HostDeck owns no TLS key or certificate renewal. |

Security tests assert both response behavior and side effects: no dispatch, no leaked session data, no success audit, and no credential issuance where rejection is expected.

Fastify evidence is layered: `IFC-V1-016` freezes exact dependencies and proves validation/error, injection/close, SSE negotiation/replay/heartbeat/real-disconnect, and static boundaries in `packages/server/src/fastify-stack.probe.test.ts`. The current registry has 99 exact resource definitions after `FE-V1-019` adds generic HTTP/browser JSON ownership and `FE-V1-023` adds browser SSE ownership; `IFC-V1-020` owns the base bounded observer, cross-limit invariants, public breach families, Fastify/Codex option mappings, and monotonic owner/view semantics. Its contract matrix rejects every below-minimum/above-maximum/non-integer field and contradictory policy; fake-clock tests cover expiry, no extension, external-signal identity, parent abort, disposal, rollback, and timer cleanup. `IFC-V1-022` proves the unbound factory, exact frozen config, API/SSE/static registration surfaces, local Zod request/response ownership, pre-routing plus route error normalization, request-id policy, URL/parameter/body/in-flight bounds, same-signal deadlines, handler-plus-response completion accounting, real timeout retention, and pinned SSE/static compatibility by injection. `IFC-V1-023` proves exact SSE registration, pinned Accept behavior with stable 406, canonical query/header cursor reconciliation, cursor-bearing selected-event framing, heartbeat, full wire-byte bounds, strict session/order validation, Readable-only structure, composite request-plus-authority cancellation, observed source/plugin failure, bounded iterator return, real paused-client backpressure, noncooperative cleanup settlement, real finite-response end, and active/opening revoke. `IFC-V1-024` proves static traversal/dotfile/cache/fallback and current-file admission. `IFC-V1-025` proves upfront runtime cleanup authority, no-listen-before-ready, constructor/mutable Node limit inventory, exact loopback bind, startup and per-step deadlines, route/ready/listen failure cleanup, real secure lease restart, active finite-SSE close, idempotent aggregate shutdown, and same-port restart. `IFC-V1-034` owns replay/high-water/live continuity, `IFC-V1-035` owns bounded subscriber queues, `IFC-V1-036` and `IFC-V1-037` own mutable health and complete application drain, and `IFC-V1-047` to `IFC-V1-052` own enforcement and aggregate stress evidence. `FE-V1-023` adds fake-clock/fetch/parser and real loopback/admitted-Serve browser evidence without changing server SSE ownership.

`IFC-V1-050` deadline evidence must bind the real Fastify request owner to every protocol-bearing route, request service, protocol client, and broker call. Fake-clock and structural tests prove one unchanged signal, decreasing per-call remainder through pages/nested operations, valid 1-49 ms final children, pre-send no-frame failure, possible-send incomplete/unknown mutation, 504 protocol-read timeout, no retry, retired late responses, matching-event-only reconciliation, immutable audit truth, and exact timer/listener/pending cleanup. Session start/archive and model/goal/Plan multi-stage tests expire between every stage; compact/approval/interrupt and serialized-queue tests abort every waiter boundary. A selected loopback/admitted-remote Fastify aggregate proves failed no-send and incomplete possible-send outcomes with zero duplicate dispatch or retained owner.

`IFC-V1-051` CLI evidence must structurally bind all 15 selected client factories, 23 public operations, and 23 selected method/path rows to one direct-loopback transport/error reader. Deterministic event-order tests plus a real Node loopback server cover connect/refusal, complete-request and response-idle timeout, pre/during abort, exact/over request and response bytes, fixed/chunked framing, length mismatch, invalid media/encoding/UTF-8/JSON/error envelopes, early close, capacity, and repeated cleanup. The aggregate proves all 25 expected requests when each public operation runs once, no mutation retry, bounded human/JSON/failure output, pairing-fragment confinement, and distinct local-daemon, observed remote-state, and typed remote-mutation outcomes.

`FE-V1-019` browser evidence compares an executable 34-route JSON catalog against the selected server manifest while excluding the one SSE row. Fake fetch/clock tests cover strict request construction, hostile inputs and response ports, exact/over byte limits, caller/deadline races, capacity release, response/error parsing, no retry, and object-graph privacy. A real-listener integration uses the production Fastify health/status routes through native loopback HTTP and the production admitted-Serve trust/authentication context, including unpaired denial and paired HTTPS read, without changing live Tailscale/profile/Serve state.

`FE-V1-025` coordinator evidence must drive access, host, list/detail, SSE, and CSRF ports through deterministic target and authority epochs. Direct tests cover hostile construction, access-first no-disclosure, all authentication/lock/local/remote states, partial query completion, cancellation races, same-target stale retention, access-loss purge, list-page merge bounds, detail not-found, sticky recovered failures/boundaries, subscriber cleanup, and exact write causes. Real selected Fastify tests cover loopback-read and admitted-Serve unpaired/read/write authority plus lock, degradation, remote-generation invalidation, reconnect, and zero residue without mutating live Tailscale/profile/Serve/phone state. `BUG-015` regressions reject implicit loopback browser writes and any UI field that requires unavailable provenance, label, compatibility, or Mission Control stream data.

`IFC-V1-052` aggregate evidence must resolve one reduced coherent budget and consume it across the real selected loopback lifecycle, exact 22-registration/35-route composition, projection subscribers, shared write admission, controlled Codex connection/broker, real SQLite audit, and shared bounded source-CLI transport. The synchronized matrix holds HTTP, SSE, protocol read, and mutation owners at exact capacity; distinguishes CLI-local from HTTP/admission/protocol rejection; covers exact/over bytes, partial upload, stalled/overflowing subscriber, duplicate/conflict/target contention, no-send and possible-send timeout, client response loss, late response/event reconciliation, noncooperative settlement, drain, active-work shutdown, and same-port restart. Exact frozen snapshots, request/dispatch/frame/audit counts, repeated-cycle peaks, durations, privacy scans, and before/after active-resource inspection must return every current owner to zero without retry, fallback, private output, or a test-only production path.

`IFC-V1-036` health evidence must exercise all seven local sources under fixed state/reason contracts, aggregate severity/readiness, explicit newer recovery, equal/lower/out-of-order source sequences, fake-clock failure/regression, generation exhaustion, and a generation-bound mutation proof checked before fake dispatch. The separate remote matrix covers disabled, ready, every stopped/profile/Serve/stale/failure class, observer failure, and recovery while asserting byte-for-byte stable local health/proof validity. Startup evidence captures one cutoff, invokes orphan reconciliation before retention, rejects malformed port results, and keeps storage non-ready for every degraded, partial, failed, or unknown result. Snapshots/errors are deeply frozen and privacy-inspected; the reducer owns no timer, retry, process, listener, route, Tailscale mutation, or shutdown side effect.

`IFC-V1-037` shutdown evidence must prove synchronous mutation-admission closure before listener refusal; selected admission open/draining/closed transitions; active-owner completion/failure/abandon and concurrent/aborted drain waiters; subscriber, approval, reconnect, write, audit, projection, supervisor, listener/app, storage, and lease order; exact zero-pending barrier acknowledgements; dedicated component caps under one outer deadline; and same-promise repeated/concurrent close. Inject each stage throw, timeout, malformed acknowledgement, parent abort, and late settlement, then prove all later cleanup still ran and only bounded stage truth entered snapshots. Real listener/SQLite/lease and foreground/service-owned runtime cases must cover active request plus SSE, sent-mutation unknown-to-incomplete truth, zero active resources, same-port/lease restart, foreground child cleanup, service sibling survival, and no Tailscale mutation.

`IFC-V1-086` service-process evidence must prove the selected production composition is not coupled to foreground ownership. Deterministic tests require an existing canonical `0700` runtime directory, exact `service_owned` supervisor input/output, null process-exit observation, bounded missing/refused/replaced socket behavior, no runtime-directory repair, no process/socket mutation, shared lease exclusion, inert import, direct Node execution, bounded generic terminal output, and package-manifest mutation rejection. The exact no-model process smoke starts an external app-server, starts HostDeck A, removes/recreates the app-server runtime while A remains alive and recovers, stops A while the sibling survives, starts/stops HostDeck B against the same sibling, and finally proves Tailscale absence affected only remote health. PID/socket/listener/database/lease/temp inventories and raw output privacy must be explicit before cleanup.

`IFC-V1-055` unit evidence must prove exact deterministic content before manager mutation. Hostile fixtures cover object/path/package/service-host/mode/version/hash and systemd injection boundaries; structural checks require one static Codex runtime-directory owner, one installable HostDeck owner, weak one-way `Wants=`/`After=` only, one no-shell `ExecStart` each, fixed bounded restart/start-limit/timeout/log/umask policy, and no root/Tailscale/public/source-loader path. The supported systemd parser and security inspection must accept both files. A runtime-only real user-manager smoke then proves repeated start, HostDeck restart with stable Codex PID/socket, Codex restart/stop/recovery with stable HostDeck PID, foreground lease exclusion, local liveness/readiness truth, and cleanup that preserves any pre-existing failed units while leaving no HostDeck unit/process/socket/listener/lease/temp residue.

Remote-ingress evidence is separate from Fastify's local listener proof. `IFC-V1-070` freezes the exact supported Tailscale behavior before code; `IFC-V1-071` to `IFC-V1-078` own bounded observation, Serve ownership, proxy trust, source/rate composition, routes/CLI, fragment-safe pairing, and lifecycle composition; `IFC-V1-079` owns hostile plus physical cellular/profile-switch acceptance. Historical direct-LAN/custom-CA evidence cannot satisfy these tasks.

`IFC-V1-076` control evidence must prove three independent readiness predicates: exact durable enabled state, a same-generation durable post-terminal enable proof, and an unexpired in-process observation lease. Restart starts closed; equivalent refresh renews without generation churn; material drift advances generation before publication; exact profile return may carry forward only the still-current proof; any accepted remote mutation invalidates prior proof atomically. Tests force every boundary between accepted audit, intent latch, one manager call, authoritative read-back, state persistence, terminal audit, response preparation, proof persistence, and publication. Disable must remain closed after every boundary and must persist cleanup-incomplete before the external command. Route tests admit loopback local-admin or paired-device status but only loopback local-admin mutations; CLI tests issue one loopback request and no direct Tailscale command or automatic retry.

`IFC-V1-067` isolation evidence must bind the accepted 22-registration/35-route composition to a selected-only production closure. Static and emitted-closure checks reject legacy listener, TLS/LAN, raw/slash/tmux handler, dependency, config, package-export, and CLI bypass reachability; listener tests reject every non-IPv4-loopback HTTP bind before dispatch; selected authority schemas reject LAN values; CLI tests prove pair/lock/unlock use exact loopback HTTP routes while only confirmed legacy status/reset can open SQLite. Migration evidence upgrades empty, loopback, LAN-configured, and populated historical databases without changing migrations 1-17, removes obsolete LAN settings/configuration storage, preserves historical audit decoding and legacy session reset, and rolls back injected failure atomically. Deleted certificate-backed route cases must retain equivalent local/admitted-Serve authority, CSRF, lock, audit, response-loss, and exact-target evidence.

`IFC-V1-073` proxy-trust evidence must exercise the full raw-header Cartesian boundary rather than only one rejection reason at a time: direct local versus proxy-shaped classification; absent/one/duplicate/comma-joined forwarding and standard identity names; all-or-none identity bundles; Funnel, unknown reserved names, and every `X-Tailscale-*` lookalike; exact and boundary CGNAT sources; wrong physical socket/TLS/target forms; safe missing Origin versus unsafe missing Origin and preflight; external Host/Origin canonical aliases and DNS rebinding; admission closed/throw/malformed/change-before-second-read; combined hostile signals with truthful normalized assessments; resource minima/defaults/maxima; and before-handler zero-side-effect rejection. Injection and raw-loopback tests assert one generic response, connection close, bounded reason-only diagnostics, no CORS, no generic proxy trust, and no raw value retention. A real private Serve smoke then proves external canonical provenance and Secure/HttpOnly/host-only/SameSite cookie transport, forwarding and standard-identity overwrite, surviving lookalike rejection, direct-local separation, and exact cleanup without retaining private identity or DNS values.

`IFC-V1-074` authorization-composition evidence must use the selected proxy-to-auth factory, not manually fabricated public auth contexts alone. Contract tests cover the explicit remote mode and reject remote HTTP, local-non-browser/local-admin, missing source/generation, noncanonical origin, and leaked ingress metadata. Injection and real-SQLite matrices cover local zero-reader behavior; optional identity independence; same/different source reconnect, process and durable per-source/global limits; unpaired/invalid/expired/revoked/read/write devices; CSRF, lock, local-only unlock, active revoke, and protected read/write side effects. Deterministic admission readers change before/during/after device authentication, pair transition, mutation pre-dispatch, response preparation, and cookie/on-send publication; assertions distinguish no transition, committed-but-undeliverable truth, no automatic retry/rollback, no success body/cookie, exactly-once limiter release, generic error, connection close, and bounded one-per-request stale diagnostics. Database-byte, error, audit, snapshot, and object-graph inspections allow the canonical configured origin only in its existing public-context and pair-actor fields, reject raw source/header/identity/profile/cookie/token retention elsewhere, and prove only approved source hashes reach limiter rows. A real private Serve smoke proves local code issue, external claim, hardened cookie, paired protected read, identity non-authority, fail-closed generation closure, and exact Serve cleanup.

## UI State Matrix

Every row is tested at 390 x 844; marked stress states also run at 360 x 800 and 1280 x 800.

| Screen | Required states |
| --- | --- |
| Mission Control | Loading, empty, mixed attention, all quiet, long names/paths, runtime offline, remote unavailable, locally observed laptop-profile mismatch, Serve conflict, locked, read-only, incompatible runtime, degraded local host. |
| Session Detail | Active writable turn, waiting input, approval, completed, interrupted, failed, unknown, stale, archived/not found, reconnecting, replay boundary. |
| Composer | Empty, keyboard open, sending, accepted/running, failed retryable/nonretryable, disabled by each trust/runtime state. |
| Model/goal/plan | Current value, loading, changed, active/paused/complete goal, plan active, unsupported version, conflict, failure. |
| Usage/compact/skills | Loading, content, empty, unsupported, compact running/completed/failed. |
| Approval | Normal, broad/elevated confirmation, approve pending/success/fail, deny, duplicate tap, expired/resolved, connection generation changed. |
| Host/access | Remote disabled, Tailscale unavailable, local host status with laptop profile mismatch, Serve configuring/ready/conflict, unpaired, QR/link claim, read-only, writer, reload/CSRF bootstrap, expired/revoked, locked, profile switch while connected, and generic browser/network failure when the phone cannot reach the origin. |
| Event details | Normal, redacted, truncated, unknown optional type, boundary. |

`FE-V1-011` applies the Mission Control row directly to coordinator resources: access-only states must be session-data-free; retained loading/failure data must remain explicitly stale; generic origin failure cannot invent laptop diagnosis; grouped rows preserve canonical source order; refresh and pagination are single-call/no-retry controls. Its Playwright evidence additionally measures the full host strip plus two `ACT NOW` rows in the first 390 x 844 viewport and captures 360/390/412/768/1280 layouts from deterministic coordinator-backed states.

`FE-V1-012` applies the Session Detail row to one bounded recent-replay-to-live connection and a 100-event headless reducer. Tests cover empty/non-empty/retained windows, race-time events, reconnect duplicates, contradictory cursors, message-delta consolidation, every selected event/state/content variant, authority loss, stale/reconnecting/failure combinations, explicit refresh, pinned/unpinned new-activity behavior, privacy, cleanup, and 320/360/390/412/768/1280 visual/accessibility evidence against the approved Focus Rail targets.

`FE-V1-013` applies the pairing and Host/access rows through a pre-React startup owner and one coordinator-backed access projector. Direct and browser tests prove fragment removal before router/API/referrer work, one-attempt claim/CSRF adoption, no-fragment/reload/back/forward behavior, sanitized failure families, explicit paired continuation, zero pre-authority disclosure, every access/write/host/stream projection, persistent sheet semantics, StrictMode/late-settlement cleanup, empty browser storage, and approved Focus Rail evidence. A selected Fastify/SQLite aggregate and physical Android QR run close cookie, CSRF, first-read, private HTTPS, screenshot, privacy, and residue truth without LAN/custom-CA fallback or profile mutation.

## UI Fidelity And Accessibility

- Two complete mobile-first directions are inspected against `03-ux-spec.md`; theme-only variations fail the gate.
- Human selection is recorded before React screen implementation.
- Playwright captures 360 x 800, 390 x 844, 412 x 915, 768 x 1024, and 1280 x 800 for required groups/states.
- Screenshot review checks overlap, clipping, first-viewport usefulness, sticky composer/keyboard behavior, long content, safe areas, and desktop expansion.
- Keyboard, focus restoration, dialog semantics, live-region restraint, 200 percent zoom, 320 px reflow, contrast, reduced motion, and touch targets are inspected.
- The target Android phone, with Wi-Fi disabled or without a route to the laptop LAN, proves Tailscale HTTPS with no custom CA, QR/link pairing, reload, prompt, approval, lock, SSE recovery, dedicated-to-company profile switching, and return to the dedicated profile.
- Drift from approved mockups is fixed or explicitly approved and recorded; generated assets are stored in the repo.

## Release Matrix

| Gate | Evidence |
| --- | --- |
| Clean checkout/install | Exact Node/pnpm/Codex/Ubuntu versions, frozen install, build, tests. |
| Package/CLI | Runnable `codexdeck`, help/exit codes, no source-only invocation dependency. |
| User services | Install, start, status, restart each unit, HostDeck-only restart, app-server crash, stop, uninstall, log inspection. |
| Data/privacy | Path/file/socket permissions, no raw HostDeck/Tailscale secrets or transcript copy, retention, no public HostDeck listener or HostDeck telemetry. |
| Network | Loopback-only HostDeck listener inventory; dedicated saved Tailscale profile; Serve HTTPS; exact host/origin/proxy/rate/cookie tests; wrong/company profile is untouched. |
| Browser/device | Supported desktop browser and real phone workflow over cellular or unrelated Wi-Fi, including profile switching and no custom CA. |
| Recovery | Reboot/login or documented service lifecycle, stopped Tailscale, wrong/returned profile, removed/drifted Serve state, stale runtime files, incompatible Codex update, DB backup/recovery policy. |
| Documentation | User/developer/command/repo docs contain only verified commands and behavior. |
| Go/no-go | Block completion matrix links L1-L4 evidence and lists zero hidden blockers. |

## Production Package Matrix

| Case | Required assertion |
| --- | --- |
| Exact closure | 611 selected server/CLI sources produce only six HostDeck runtime package roots; web, test fixtures, tests, smokes, maps, historical interfaces, and dev dependencies are absent. |
| Determinism | Two unchanged offline builds have identical source/output inventories and content digest; an undeclared stale sentinel is removed. |
| Metadata/dependencies | Runtime manifests use emitted exports and exact internal/external identities; manifest records Node/pnpm/platform/architecture/ABI, Codex binding, native modules, and downstream deferrals without time/private paths. |
| Permissions/links | Directories and regular files follow the frozen mode policy; exactly one HostDeck compiled bin target has the reviewed shebang and execute bit, all other HostDeck output is non-executable, and every symlink is relative, contained, and valid after relocation. |
| Executable invocation | Direct path, Node path, package-manager, packed-runtime, and temporary global-style help/version run from unrelated cwd and read-only relocation; malformed/config/service/serve failures preserve accepted bounded output and side-effect order. |
| Integrity/runtime drift | Missing/modified output, manifest drift, wrong Node/platform/architecture/ABI, missing native binary, or escaping link fails nonzero before load. |
| Relocation/read-only | From unrelated cwd and read-only relocated tree, all six package roots import, native SQLite/flock operations pass, the 22/35 descriptor holds, and a real loopback lifecycle request/close/same-port restart succeeds. |
| Required failures | Missing explicit config, missing/noncanonical static assets, missing/corrupt native module, and package-integrity drift fail loudly with no source/global/dev fallback. |
| Residue/privacy | No listener/process/socket/database/temp root remains; output and diagnostics contain no checkout/home/staging path, `.env`, token, credential, prompt, transcript, or Tailscale identity. |

## Requirement And Block Coverage

| Scope | Minimum evidence |
| --- | --- |
| `FR-001` to `FR-018` | Contract plus integration; real Codex for runtime-owned semantics; UI/device where user-facing. |
| `NFR-001` to `NFR-013` | Architecture inspection, negative/resource/lifecycle tests, clean release smoke. |
| `IR-001` to `IR-012` | State/component/API tests, approved mockups, Playwright screenshots, accessibility, real phone. |
| `DR-001` to `DR-011` | Migration/repository/transaction/retention/restart/raw-storage evidence. |
| `PR-001` to `PR-012` | Ubuntu/Codex/browser/package/service/network compatibility evidence. |
| `SFR-001` to `SFR-018` | Security matrix, side-effect assertions, privacy review, device proof. |
| `BLK-V1-01` | Rebased runtime and remote-ingress contracts/fixtures/planning checker plus module hardening. |
| `BLK-V1-02` | Migrated secure state, remote configuration/audit, production retention/auth/lease plus hardening. |
| `BLK-V1-03` | Real structured Codex vertical, restart/TUI/multi-client, legacy disposition, hardening. |
| `BLK-V1-04` | Fastify/SSE loopback host, Tailscale Serve HTTPS, app auth, CLI/package/service production path plus hardening. |
| `BLK-V1-05` | Mobile-first selected design, complete remote-access states, screenshot/device/fidelity hardening. |
| `BLK-V1-06` | L1-L4 aggregate, clean setup, remote-phone/profile noninterference, docs, privacy/security, explicit go/no-go. |

## Evidence Policy

- Artifacts record command, environment/version, scope, result, failures, manual observations, and cleanup.
- Secrets, full prompts/transcripts, private paths beyond what is necessary, cookies, pairing codes, Tailscale account/node/profile identifiers, node keys, and approval payloads are redacted.
- A skipped test is a gap unless its owning requirement explicitly permits it.
- Flaky retries are recorded; a retry is not evidence that the first failure was harmless.
- Human visual and acceptance decisions link exact assets/build/commit.
- Release claims use the current selected production path, never superseded tmux/fake evidence.
