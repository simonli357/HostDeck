# Bug Log

Owns accepted bugs, triage, routing, fix evidence, and closure.

Humans can report bugs in any format. The agent should extract the useful details, choose a route, and ask only for blocking reproduction, environment, or priority details.

| ID | Symptom | Severity | Route | Status | Owning task | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| BUG-001 | Selected-path backlog rows pass graph checks while still bundling independent implementation outcomes. | High | Spike / planning bug | Closed | `FND-V1-017` | `artifacts/fnd-v1-017-selected-backlog-granularity.md`; planning commit `481cb44`. |
| BUG-002 | `test:unit` opportunistically runs real tmux processes when local binaries exist, causing load-dependent failures in the deterministic unit gate. | Medium | Small bugfix | Closed | Validation harness | Real tmux suites are opt-in through `pnpm test:tmux`; default unit and explicit smoke commands pass. |
| BUG-003 | A matched static wildcard reports a missing GET file as 405 because method discovery sees its automatic HEAD route. | Medium | Small bugfix | Closed | `IFC-V1-024` / app factory | Current-method route detection plus pinned static missing-file regression; `artifacts/ifc-v1-024-fastify-static-boundary.md`. |
| BUG-004 | The deadline fixture intermittently rejects a valid 5-second monotonic duration because it requires integer timestamp subtraction. | Low | Small bugfix | Closed | Validation harness | Fractional monotonic duration schema plus close-to assertion; canonical 408-test unit gate passes. |
| BUG-005 | A finite Readable SSE source completes on a real listener but the pinned plugin leaves the HTTP response and handler open. | High | Backlog bugfix | Closed | `IFC-V1-023` / `IFC-V1-025` | Readable-end raw-response termination plus real finite-response and active-shutdown regressions; `artifacts/ifc-v1-025-fastify-host-lifecycle.md`. |
| BUG-006 | Exact Codex emits notifications after the initialize response but before `initialized`; the connection treats them as pre-initialize violations and terminates. | High | Small bugfix | Closed | `INT-V1-004` / `INT-V1-006` | Bounded ordered response/ack queue, hostile-window tests, exact private-socket smokes, and semantic capture. |
| BUG-007 | The goal-based legacy thread materialization path sets an active goal, which autonomously starts model turns despite its no-model contract. | Critical | Backlog bugfix | Closed | `INT-V1-005` / `INT-V1-006` | Paused internal goal, active-marker recovery, idle/zero-turn/token/history real smoke, corrected evidence, `DEC-022`. |
| BUG-008 | Private Serve is classified as public because the observer treats a nonempty `funnel status --json` result as a distinct Funnel projection. | High | Backlog bugfix | Closed | `IFC-V1-071` / `IFC-V1-072` | Exact 1.98.8 source/live semantics, duplicate-read equality regression, corrected active observer smoke, and private enable/read-back/path-off smoke. |
| BUG-009 | Proxy-decision invariants reject truthful combined hostile-header assessments unless lower-priority forwarding and identity evidence is falsely normalized. | High | Backlog bugfix | Closed | `FND-V1-018` / `IFC-V1-073` | Precedence-aware schema plus combined lookalike/unknown/identity/forwarding contract regressions. |
| BUG-010 | The exact Codex thread lifecycle smoke can fail cleanup when the native app-server outlives its npm launcher while settling its temporary plugin cache. | Low | Small bugfix | Closed | Validation harness / `IFC-V1-061` | Owned-socket shutdown wait, bounded recursive-remove retries, and consecutive exact 0.144.0 lifecycle smokes. |
| BUG-011 | The exact HostDeck/TUI coexistence smoke can leave its marker command unfinished or pause TUI B before the product view, despite healthy completed runtime state. | Medium | Small bugfix | Closed | Validation harness / `INT-V1-031` / `INT-V1-032` | Bounded prompt/tool timing, direct second-TUI identity proof, isolated update-check suppression, sanitized diagnostics, and clean exact standalone/aggregate passes. |
| BUG-012 | The strict Android runner fails Fastify readiness because its fixed authenticated driver routes omit required API response schemas. | High | Small bugfix | Closed | Validation harness / `IFC-V1-079` | Commit `3528c6c`; route-schema inventory/static gates plus clean physical Fastify/start/pair/reload progression pass. |
| BUG-013 | Post-pairing Chrome foreground inspection reads ActivityManager intent state containing the protected QR fragment and correctly aborts on its own privacy guard. | High | Small bugfix | Closed | Validation harness / `IFC-V1-079` | Commit `b4078b6`; bounded WindowManager-only regression plus the clean no-retry physical run pass all 12 phone rows without retaining the fragment. |
| BUG-014 | A current production audit reports two high-severity `fast-uri` host-confusion advisories through Fastify's AJV and JSON serializer paths. | High | Release blocker | Closed | Supply chain / `FE-V1-010` validation | Exact patched overrides 3.1.4/4.1.1, dependency-tree proof, zero-vulnerability audit, full workspace/runtime/package gates, implementation `9b095ad`. |
| BUG-015 | The selected mobile access fixture requires browser state that the selected APIs cannot produce and permits implicit loopback writes. | High | Backlog bugfix | Closed | `FE-V1-025` | Route-backed coordinator contract and regressions; implementation `888abf1`. |
| BUG-016 | Newly published production advisories affect the selected router, static plugin, browser router, and transitive glob graph. | High | Release blocker | Closed | Supply chain / `FE-V1-020` validation | Exact patched versions, zero-vulnerability audit, and full workspace/package/browser gates. |
| BUG-017 | Production substitutes the reviewed Codex version for a real probe and exits before it can serve an incompatible-runtime diagnostic UI. | Critical | Release blocker | Closed | `IFC-V1-087` | Real probe, diagnostic-ready listener, durable/public truth, aggregate and clean exact/drift process evidence; implementation `ceb339e`. |
| BUG-018 | Physical dashboard acceptance treats the intentionally below-fold quiet session as a failed initial Mission Control load after all protected reads return 200. | High | Release blocker | Closed | `FE-V1-090` | The next clean physical run passed pairing, protected route reads, the attention-first viewport, and fragment-free reload entry; exact cleanup passed. Implementation `9bc73ec`. |
| BUG-019 | Physical dashboard reload scrolls for a quiet session without first expanding its intentionally collapsed `QUIET` disclosure. | High | Release blocker | In progress | `FE-V1-090` | The clean `9bc73ec` run reached the fragment-free reload and exposed the inaccessible target. Accessible disclosure naming and an explicit verified expand interaction pass focused component/driver and Chromium checks; corrected physical acceptance remains pending. |
| BUG-020 | The supported-browser oracle can inspect or classify a routed POST failure without complete intercepted-response proof, making a valid synthetic response pass or fail according to scheduler timing. | High | Release blocker | Closed | `FE-V1-040` / `FE-V1-090` | Exact same-request `200`, one-request, schema, origin, and header proof gates synthetic CSRF-bootstrap aborts; the corrected 76/76 matrix passes with zero unexpected diagnostics. |
| BUG-021 | Android Chrome drops the stateful `aria-label` from the native quiet-queue `summary`, exposing only concatenated visible text to the physical accessibility hierarchy. | High | Release blocker | In progress | `FE-V1-090` | The clean pushed `4b1316b` phone run proved the mismatch. The explicit stateful button passes focused/broad gates, ten inspected captures, deterministic package identity, and the exact 76-case matrix; corrected physical acceptance remains pending. |
| BUG-022 | Android exposes an unnamed whole-session link only through its 21 CSS-pixel child text node, despite the DOM link's valid 96 CSS-pixel box. | High | Release blocker | In progress | `FE-V1-090` | The clean pushed `23c8fc3` phone run passed the corrected quiet disclosure and failed the exact 44 CSS-pixel target gate at `178.1x21`; cleanup passed. Explicit row naming and full-target device acquisition pass focused, broad, and 76/76 package gates; corrected physical acceptance remains pending. |
| BUG-023 | A Firefox CONNECT reset can terminate the supported-browser HTTPS proxy through an unhandled client-socket `ECONNRESET`. | High | Release blocker | Closed | `FE-V1-040` / `FE-V1-090` | Persistent socket handling and a mandatory 12-reset plus real-TLS guard pass; the corrected 76/76 package matrix publishes complete evidence and cleans all owned state. |
| BUG-024 | The physical dashboard replay fixture violates the production boundary-handoff contract, so Session Detail receives a fail-closed `500` instead of a live SSE subscriber. | High | Release blocker | Closed | `FE-V1-090` | The clean pushed `bcdcd1e` run established one live subscriber, drained the corrected replay, and opened boundary plus complete-event diagnostics exactly once. |
| BUG-025 | Physical failure cleanup can issue lifecycle-owned remote disable before a fresh idle observation after restoring the dedicated profile. | High | Release blocker | Closed | `FE-V1-090` | Fresh-idle cleanup passed in the pushed `824fbec` failure run; Serve, phone settings, Chrome, tunnels, processes, temporary/evidence state, and worktree all restored exactly. |
| BUG-026 | The physical detail sequence assumes top context and below-fold replay truth are already present in the current Android hierarchy. | High | Release blocker | Closed | `FE-V1-090` | The clean pushed `bcdcd1e` run bounded-backward-revealed fully visible `Current`, then bounded-forward-revealed and opened the first two event rows exactly once. |
| BUG-027 | A physical event diagnostic can treat an Android hierarchy action beneath the fixed session-control dock as tappable. | High | Release blocker | In progress | `FE-V1-090` | The clean pushed `bcdcd1e` run reached the third event, selected its occluded action, and correctly sent no request after the one allowed tap. Pair selection must fail closed until row and action are both above measured dock geometry. |

## Routing

| Route | Use when | Backlog interaction |
| --- | --- | --- |
| Small | Local root cause, clear expected behavior, no planning change | Fix directly; link existing task if relevant |
| Backlog | Multi-step fix or affects planned/completed work | Create or update leaf task(s), add `BUG-*` refs, update blockers if needed |
| Spike | Root cause or expected behavior is unclear | Create triage/spike task before implementation |
| Release blocker | Blocks acceptance, data integrity, security/privacy, install/run, deployment, or critical flow | Mark blocker in status/release tracking and prioritize blocking task(s) |

## Bug Template

```md
### BUG-000 Name

- Symptom:
- Impact:
- Route:
- Related requirements:
- Affected / owning task:
- Blocks:
- Root cause:
- Fix:
- Validation:
- Closed by:
```

### BUG-001 Selected Backlog Granularity

- Symptom: unfinished selected-path rows such as `DAT-V1-020`, `INT-V1-006`, and `IFC-V1-017` to `IFC-V1-021` contain independent outcomes that cannot be handed off without architecture decisions during implementation.
- Impact: dependency readiness and V1 completion can look stronger than the executable leaf backlog really is.
- Route: planning bug; implementation leaves are gated while the remaining selected backlog is audited and decomposed.
- Related requirements: all active V1 requirements through their existing owners; no product scope change.
- Affected / owning task: `FND-V1-017`.
- Blocks: resolved; affected execution now uses handoff-sized leaves, with deliberate spikes/acceptance/hardening gates classified explicitly.
- Root cause: `check:planning` validates graph/trace/status integrity but cannot determine semantic task breadth.
- Fix: classify every unfinished row, split independent outcomes, update dependencies/traces/block maps/queue, and record intentional module-hardening/release/human-gate rollups explicitly.
- Validation: planning check, manual junior-handoff audit, before/after inventory artifact, clean diff/commit/push.
- Closed by: `FND-V1-017`; planning commit `481cb44` pushed to `origin/main`.

### BUG-002 Real Tmux Leaks Into Unit Gate

- Symptom: two consecutive `pnpm test:unit` runs failed in different real-tmux tests under suite-wide load, while the same smoke passed in isolation.
- Impact: the deterministic unit gate depended on installed binaries, process scheduling, and tmux timing; failures could obscure regressions in unrelated work.
- Route: small bugfix; expected test-layer behavior was already clear from the dedicated `pnpm test:tmux` command.
- Affected / owning task: validation harness; discovered while validating `IFC-V1-016`.
- Root cause: real tmux suites selected `describe` whenever tmux/Codex happened to exist instead of requiring the repository's explicit smoke environment flag.
- Fix: gate both real-tmux suites on `HOSTDECK_REQUIRE_TMUX_SMOKE=1`, make an explicitly requested missing tmux binary fail loudly, and expand `test:tmux` to run adapter plus server real-process coverage.
- Validation: `pnpm test:unit`, `pnpm test:tmux`, lint, typecheck, and the normal aggregate checks.
- Closed by: current `IFC-V1-016` validation unit.

### BUG-003 Static Missing File Misclassified As Method Error

- Symptom: `GET /assets/missing.*` enters the pinned static wildcard, calls the global not-found handler, and returns `method_not_allowed`/405 instead of `route_not_found`/404.
- Impact: clients receive false method guidance and static not-found behavior violates the stable API/error contract.
- Route: small bugfix; expected behavior is explicit in `IFC-V1-024` and no product or architecture choice changed.
- Affected / owning task: `IFC-V1-024`; root cause was in the completed `IFC-V1-022` app-factory method resolver.
- Root cause: `allowedMethodsForUrl` skipped the current GET method, then treated the matched wildcard's generated HEAD route as evidence that GET was unsupported. It did not distinguish a router miss from a matched handler deliberately calling not-found.
- Fix: return no alternate-method result when `findRoute` confirms the current method already matches the URL; preserve normal 405 behavior when the current method has no route.
- Validation: pinned static valid/missing GET regression, explicit browser POST 405, focused factory/static tests, and aggregate unit/contract/integration gates.
- Closed by: `IFC-V1-024`; evidence in `artifacts/ifc-v1-024-fastify-static-boundary.md`.

### BUG-004 Fractional Monotonic Duration Fixture

- Symptom: under parallel test loading, the app-factory deadline fixture serializes a duration infinitesimally different from integer `5000` and response validation converts the otherwise valid probe into a 500.
- Impact: the deterministic unit gate can fail based on floating-point representation of `performance.now()`, obscuring unrelated regressions.
- Route: small bugfix; the monotonic deadline contract already permits numeric timestamps and integer timeout inputs.
- Affected / owning task: validation harness; discovered during `IFC-V1-024` aggregate validation.
- Root cause: the fixture required `expiresAtMs - startedAtMs` to satisfy `z.number().int()` and exact equality even though both timestamps are fractional monotonic values.
- Fix: keep the duration positive, require it to be close to 5,000 ms, and retain exact same-signal plus bounded-positive remaining-time assertions.
- Validation: repeated focused parallel factory/static run and canonical `pnpm test:unit` with 408 passed/18 explicit external skips.
- Closed by: current `IFC-V1-024` validation unit.

### BUG-005 Finite SSE Leaves Real Response Open

- Symptom: a finite selected-event source reaches generator `finally`, but a real HTTP client never receives response end and Fastify listener shutdown times out; injection had appeared to settle.
- Impact: finite streams retain the handler/request slot and can hang otherwise cooperative listener shutdown and restart.
- Route: backlog bugfix discovered by the planned `IFC-V1-025` real-listener lifecycle matrix; expected finite-source behavior was already owned by `IFC-V1-023`.
- Affected / owning task: transport fix in `IFC-V1-023`; real shutdown evidence in `IFC-V1-025`.
- Root cause: `@fastify/sse` 0.5.0 does not end the raw response when the Readable source ends, and `await reply.sse.send(readable)` cannot reach post-send cleanup until that response closes.
- Fix: attach one Readable `end` listener before send and explicitly end a still-writable raw response; retain plugin close after send and remove the listener during final cleanup. Listener shutdown reaps sockets that become idle after close initiation without force-closing active requests.
- Validation: direct real HTTP finite-source response end, zero final in-flight accounting, active finite-SSE lifecycle close, exact cleanup order, and immediate same-port restart.
- Closed by: `IFC-V1-025`; evidence in `artifacts/ifc-v1-025-fastify-host-lifecycle.md`.

### BUG-006 Initialize Response/Acknowledgement Notification Race

- Symptom: an isolated exact 0.144.0 app-server emits `configWarning` and `remoteControl/status/changed` after the successful initialize response but before HostDeck can send `initialized`; HostDeck reports three fatal protocol issues and closes the private socket.
- Impact: valid authenticated startup can fail based on app-server configuration notifications, blocking all structured runtime operations despite a compatible version and schema.
- Route: small bugfix; the real trace establishes expected ordering and no product or architecture choice changes.
- Affected / owning task: connection handshake from completed `INT-V1-004`; discovered by the pre-model phase of `INT-V1-006`.
- Root cause: the connection used one boolean for both "initialize response not observed" and "initialized acknowledgement not sent," so it could not distinguish a truly premature message from the legal response/ack race window.
- Fix: broker reports the correlated initialize response synchronously; connection accepts only the resulting narrow handshaking window, queues server-originated messages in order under the existing pending-server-request bound, sends `initialized`, then flushes. Messages before the response and queue overflow still terminate.
- Validation: deterministic notification/server-request ordering and overflow tests, retained pre-response rejection matrix, recorder tests, and exact isolated 0.144.0 no-model/live probe rerun.
- Closed by: `INT-V1-006`; evidence in `artifacts/int-v1-006-codex-operation-semantics.md`.

### BUG-007 Agentic Internal Goal Materialization

- Symptom: each internal `thread/goal/set` used to materialize a zero-turn legacy thread returns `active`, then app-server emits `thread/status/changed: active`, `turn/started`, reasoning/message items, token usage, and potentially approval requests after the marker is cleared.
- Impact: session creation can spend model usage, execute agent work, pollute event attribution/history, and invalidate the `INT-V1-005` no-model evidence and the semantic spike's cost bound.
- Route: backlog bugfix against the completed lifecycle behavior; expected behavior remains an isolated, persisted, empty thread with no model work.
- Affected / owning task: `INT-V1-005` materialization and `INT-V1-006` semantic evidence.
- Root cause: `thread/goal/set` defaults a new objective to `active`; active goals are execution controls, not passive metadata. Immediate clear does not cancel the already scheduled turn.
- Fix: create the version-scoped internal marker with explicit `status: paused`; if recovery finds a prior active marker, pause it before clear and reject unsupported terminal marker states.
- Validation: unit request/status/recovery assertions plus exact isolated 0.144.0 lifecycle smoke requiring idle state, empty stored turns, no `turn/started`, no token-usage update, and no agent-message delta before TUI resume.
- Closed by: corrected `INT-V1-005` lifecycle plus `INT-V1-006`; evidence in `artifacts/int-v1-005-managed-thread-lifecycle.md` and `artifacts/int-v1-006-codex-operation-semantics.md`.

### BUG-008 Private Serve Misclassified As Funnel

- Symptom: after the ownership-safe manager created one private HTTPS root proxy from an empty profile, configured observation reported `public` and correctly refused cleanup.
- Impact: every valid nonempty private Serve mapping would remain unavailable; explicit enable could end incomplete and leave an owned mapping requiring manual path-scoped cleanup.
- Route: backlog bugfix against completed `IFC-V1-071`, discovered by `IFC-V1-072` live mutation evidence; expected private/public ownership remains unchanged.
- Related requirements: `FR-018`, `NFR-005`, `NFR-010`, `NFR-013`, `PR-003`, `PR-007`, `SFR-015`, `DEC-027`.
- Affected / owning task: observer behavior in `IFC-V1-071`; manager validation in `IFC-V1-072`.
- Blocks: resolved before `IFC-V1-072` closure.
- Root cause: fixtures modeled `tailscale funnel status --json` as a separate Funnel-only projection. Exact 1.98.8 source and redacted live inspection proved both Serve and Funnel status commands call the same implementation and serialize the same ServeConfig; public exposure is represented by `AllowFunnel`.
- Fix: require the two parsed ServeConfig reads to be deeply equal, fail disagreement as `schema_invalid`, and classify public state only when `AllowFunnel` is present. Preserve the second bounded read as a race/consistency check.
- Validation: 23 focused observer regressions, corrected real active-profile observer smoke, exact-source review, normalized live equality/cleanup inspection, and real manager private enable/exact read-back/HTTPS proxy/path-off/repeat smoke with final empty state.
- Closed by: `IFC-V1-071` corrective implementation and `IFC-V1-072` live validation; evidence in `artifacts/ifc-v1-070-tailscale-remote-ingress-spike.md` and `artifacts/ifc-v1-071-tailscale-observer.md`.

### BUG-009 Combined Proxy Rejections Require False Assessments

- Symptom: a request carrying an untrusted `X-Tailscale-*` lookalike plus missing forwarding or malformed standard identity could not produce a schema-valid rejection while retaining those actual assessments.
- Impact: the proxy evaluator would have to invent `forwarding: exact`, hide a simultaneous identity defect, or fail contract parsing on hostile input. That makes diagnostics misleading and can turn an intended fail-closed path into an internal error.
- Route: backlog bugfix against completed `FND-V1-018`, resolved before the dependent `IFC-V1-073` evaluator implementation.
- Related requirements: `NFR-005`, `SFR-002`, `SFR-012`.
- Affected / owning task: normalized proxy-decision contract in `FND-V1-018`; executable precedence and regression evidence in `IFC-V1-073`.
- Blocks: resolved before the `IFC-V1-073` evaluator consumes the contract.
- Root cause: schema refinements equated each lookalike or identity assessment with one exclusive reason and required exact forwarding for lookalike, identity, and unknown-context reasons. Hostile signals are independent and can coexist; only the highest-priority reason is singular.
- Fix: require lookalike precedence, permit unknown reserved context to precede malformed standard identity, constrain forwarding only for reasons that logically determine its assessment, and allow missing forwarding to be wholly absent or partial/invalid.
- Validation: all rejection reasons retain coherent representative evidence; strict reason-specific forwarding contradictions reject; combined lookalike plus malformed identity, unknown reserved plus malformed identity, and malformed identity plus missing forwarding preserve truthful assessments; incorrect lower-priority reasons reject.
- Closed by: `IFC-V1-073` contract correction and focused contract suite.

### BUG-010 Codex Lifecycle Smoke Cleanup Race

- Symptom: the exact Codex 0.144.0 thread lifecycle assertions complete, but temporary-home teardown can fail with `ENOTEMPTY` under `plugins/cache/openai-curated-remote`.
- Impact: valid real archive evidence can report a cleanup-only failure based on Codex background filesystem settling.
- Route: small bugfix; temp-resource ownership and eventual complete removal are already required, with no product or planning change.
- Affected / owning task: validation harness; discovered while closing `IFC-V1-061`.
- Root cause: the exact native app-server can outlive and be reparented from its npm launcher after the client disconnects, while recursive `rm` also used Node's zero-retry default. Teardown could therefore race the real socket owner and its plugin-cache writes.
- Fix: wait up to 10 seconds for the owned Unix socket to disappear after client/launcher shutdown, then retain fail-loud removal with five bounded native retries at 100 ms intervals.
- Validation: two consecutive exact Codex 0.144.0 thread lifecycle smokes, type/lint checks, and absence of retained `hostdeck-thread-smoke-*` roots.
- Closed by: current `IFC-V1-061` validation unit.

### BUG-011 Nondeterministic Exact TUI Coexistence Probe

- Symptom: aggregate lifecycle acceptance reached `exact_tui_coexistence` and failed without publishing evidence. Isolated diagnostics twice observed one authoritative completed turn with a stable HostDeck connection/runtime but a marker still at `started`; later runs completed that direction but intermittently left TUI B alive on a small pre-product startup view.
- Impact: valid runtime lifecycle behavior could fail based on minimal-model shell wait choices or an interactive update check, preventing repeatable `INT-V1-031` and `INT-V1-032` evidence.
- Route: small bugfix; expected multi-client identity, lifecycle, and cleanup behavior remains unchanged, while the local exact-runtime harness removes nondeterministic validation inputs.
- Affected / owning task: validation harness from completed `INT-V1-031`; discovered while validating `INT-V1-032`.
- Blocks: resolved before `INT-V1-032` closure.
- Root cause: the 20-second marker interval exceeded the shell tool's common initial yield, but the prompt prohibited a second wait call; TUI B identity depended on model sentinel replay instead of the exact resume target; and the isolated `CODEX_HOME` omitted Codex's supported startup-update suppression.
- Fix: use an eight-second marker interval with an explicit 15-second initial tool wait, prove TUI B by exact resume thread id plus managed cwd and HostDeck read-back, set only `check_for_update_on_startup = false` in the private test home, allow a bounded 30-second history-view readiness window, and emit classifications rather than terminal content on readiness failure.
- Validation: dirty-worktree diagnostics complete both teardown directions and stop only at the intentional clean-commit publication guard. The clean exact coexistence smoke then passed in 24.29 seconds, and the no-retry four-scenario aggregate passed in 91.01 seconds with zero resource residue; full workspace and supply-chain gates also pass.
- Closed by: corrective harness commit `7584321`; aggregate evidence in `artifacts/int-v1-032-runtime-lifecycle-acceptance-evidence.json`.

### BUG-012 Physical Driver Routes Omit Response Schemas

- Symptom: `pnpm smoke:remote-android` fails during Fastify readiness before Serve mutation, QR generation, or phone interaction because `physical-phone-driver` registers API routes without response schemas.
- Impact: the selected physical Android acceptance cannot start, while cleanup correctly leaves the dedicated Serve state absent and the phone unchanged.
- Route: small bugfix; the production app boundary and frozen `IFC-V1-079` composition contract already require normal API plugin registration.
- Related requirements: `NFR-005`, `PR-007`, `SFR-005`, `SFR-018`.
- Affected / owning task: validation harness in `IFC-V1-079`.
- Blocks: clean committed physical Android acceptance rerun.
- Root cause: the phone-driver routes were added without the strict Zod response maps required by the API surface hook, while ordinary tests covered driver state and browser bundle behavior but never enumerated route registration.
- Fix: declare exact empty-checkpoint, bounded pre-revocation, and command/revision schemas for all ten fixed routes; add direct pinned Zod ownership to the CLI package; and enumerate every route/schema in the ordinary test gate.
- Validation: focused driver suite passes 5 with the physical case explicitly skipped; CLI/root typecheck, lint/exports, planning, scaffold, and frozen offline install pass. The full unit gate had two unrelated load failures; both exact files pass in isolation. The clean committed run passed Fastify registration, remote enable, private QR claim, paired checkpoint, and fragment-free reload before stopping at the independent `BUG-013` privacy guard.
- Closed by: commit `3528c6c`; physical progression evidence from the subsequent clean run.

### BUG-013 Activity Inspection Exposes Pairing Fragment

- Symptom: the phone successfully pairs and reloads fragment-free, then `requireChromeForeground` reads `dumpsys activity activities`; ActivityManager includes Chrome's original fragment-bearing launch intent, and the harness's protected-value guard aborts before retaining or logging it.
- Impact: the strict run cannot continue after a valid scan, and repeated runs unnecessarily require another human pairing action.
- Route: small bugfix; the frozen privacy contract already forbids the fragment in ADB output and evidence.
- Related requirements: `NFR-005`, `NFR-013`, `SFR-006`, `SFR-007`.
- Affected / owning task: validation harness in `IFC-V1-079`.
- Blocks: clean committed physical Android acceptance rerun.
- Root cause: ActivityManager task inspection was chosen to prove Chrome foreground state without accounting for retained launch intents. Scrubbing browser history prevents network/history leakage but does not rewrite Android's task intent record.
- Fix: replace ActivityManager inspection with the fixed `dumpsys window displays` argv, accept exactly one bounded Chrome `mCurrentFocus` component, and reject URI-bearing, oversized, null, duplicate, or non-Chrome output.
- Validation: the ordinary driver suite passes 6 with the physical case explicitly skipped; root typecheck, lint/exports, planning, scaffold, live bounded URI-free WindowManager output, and the full unit gate (1,858 passed, 27 explicit skips) pass. The strict no-retry Android run then passed pair/reload, lock/local unlock, profile-away/return, SSE recovery, self-revoke, evidence publication, and exact cleanup with all 12 phone rows terminal.
- Closed by: commit `b4078b6`; `artifacts/ifc-v1-079-device/evidence.json` and the inspected four-screen physical evidence.

### BUG-014 Vulnerable Fastify URI Parser Transitively Locked

- Symptom: `pnpm audit --prod` reports `GHSA-v2hh-gcrm-f6hx` twice for `fast-uri` 3.1.3 and 4.1.0 through Fastify's AJV compiler and `fast-json-stringify` paths.
- Impact: the committed production dependency graph contains high-severity host-confusion vulnerabilities and cannot meet release supply-chain acceptance.
- Route: release blocker discovered during `FE-V1-010` dependency validation; the expected patched versions and affected paths are explicit.
- Related requirements: `NFR-005`, `NFR-010`, `PR-007`.
- Affected / owning task: shared production dependency graph; closure evidence is recorded with `FE-V1-010` because that audit discovered and fixed it.
- Blocks: resolved in the same implementation unit before task closure; no release or frontend task remains blocked by this advisory.
- Root cause: the frozen lock predated the advisory and retained vulnerable patch releases permitted by Fastify's current dependency ranges.
- Fix: exact workspace overrides replace only `fast-uri` 3.1.3 with 3.1.4 and 4.1.0 with 4.1.1; no Fastify API, source fallback, or broad dependency upgrade was introduced.
- Validation: dependency tree shows only 3.1.4/4.1.1; `pnpm audit --prod` reports no known vulnerabilities; offline frozen install, 1,870 unit, 240 contract, 27 integration, runtime-boundary, deterministic package acceptance, browser, typecheck, lint, scaffold, and planning gates pass. Both patched releases are BSD-3-Clause.
- Closed by: implementation commit `9b095ad`; evidence in `artifacts/fe-v1-010-phone-shell.md`.

### BUG-015 Selected Mobile Access Contract Is Not Browser-Producible

- Symptom: `selectedHostAccessSchema` permits implicit `loopback_local` browser writes and requires admitted request provenance/source key, device label, full runtime compatibility, and a connected session stream for Mission Control.
- Impact: the selected browser API cannot produce that state. `DEC-024` makes safe loopback browser GETs unpaired/read-only; access/host/session routes intentionally omit proxy source keys, access bootstrap omits device labels and full compatibility, and Mission Control owns no session stream. A screen consuming the old fixture would have to fabricate authority or private/unavailable fields.
- Route: closed inside `FE-V1-025`; the coordinator is the first live consumer and establishes route-backed state before screens consume it.
- Related requirements: `IR-005`, `IR-006`, `IR-008`, `UX-009`, `DEC-024`, `DEC-027`.
- Affected / owning task: selected-mobile fixture contract from completed foundation work; live replacement and regression evidence in `FE-V1-025`.
- Blocks: resolved; `FE-V1-011`, `FE-V1-012`, and `FE-V1-013` are ready on the route-backed contract.
- Root cause: the normalized visual fixture predated the final browser authentication/status composition and was not re-audited against exact route outputs after local-admin safe-GET authority was removed.
- Fix: `selectedHostAccessSchema` now uses `loopback_read`, device id only, route-derivable access/lock/read/write/error fields, optional current remote ingress, and no provenance/source key, label, detailed compatibility, or global stream fabrication. Session Detail owns its stream and compatibility remains with its exact runtime source.
- Validation: selected-mobile regressions, 33 direct coordinator cases, three real loopback/admitted-Serve Fastify/SQLite cases, 243 contract tests, 35 integration tests, full workspace/static/package/install/audit gates, and manual privacy/residue review pass.
- Closed by: `FE-V1-025` implementation `888abf1`; evidence in `artifacts/fe-v1-025-shell-connection-state-coordinator.md`.

### BUG-016 Newly Published Production Dependency Advisories

- Symptom: the final `FE-V1-020` `pnpm audit --prod` gate newly reported four high and one moderate advisory across `find-my-way` 9.6.0, `react-router` 8.2.0, `@fastify/static` 9.3.0, and transitive `brace-expansion` 5.0.7.
- Impact: the committed production graph failed the zero-known-vulnerability release gate; the Fastify findings affect request routing/static boundaries and cannot be waived as unrelated UI risk.
- Route: release blocker discovered and resolved in the active `FE-V1-020` hardening unit; requirements and architecture remain unchanged.
- Related requirements: `NFR-005`, `NFR-010`, `PR-007`.
- Affected / owning task: shared server/web production dependency graph; closure evidence is recorded with `FE-V1-020` because its required supply-chain gate discovered the advisories.
- Blocks: resolved before physical Android acceptance and task closure; no downstream task remains blocked by these advisories.
- Root cause: exact direct versions and the frozen lock predated `GHSA-c96f-x56v-gq3h`, `GHSA-qwww-vcr4-c8h2`, `GHSA-83w8-p2f5-377r`, `GHSA-mh99-v99m-4gvg`, and `GHSA-8pvw-jcv7-9cmj`.
- Fix: upgrade exact `@fastify/static` to 10.1.2 and `react-router` to 8.3.0; pin only vulnerable permitted transitives to `find-my-way` 9.7.0 and `brace-expansion` 5.0.8 through workspace overrides; adapt the static header callback to the patched plugin's `FastifyReply.header` contract. No route, CSRF, static-path, cache, or fallback policy changed.
- Validation: dependency enumeration contains only the four patched versions; all are MIT licensed; static-boundary/Fastify 11, web 214, unit 2,064 with 28 explicit skips, contract 243, integration 36, Chromium 18, typecheck, lint/exports, scaffold, runtime boundary, deterministic package acceptance with 6,445 entries, frozen offline install, and zero-known-vulnerability production audit pass.
- Closed by: the current dependency-hardening unit; final `FE-V1-020` evidence records its pushed commit.

### BUG-017 Production Compatibility State Is Not Observable Or Reachable

- Symptom: production gives the reconnect controller `codexBindingDescriptor.codex_version` as the observed version, and initial incompatibility rejects application startup before Fastify/static routes listen.
- Impact: a protocol-compatible drifted binary can be recorded as the reviewed 0.144.0 value, while a proven incompatible runtime leaves no dashboard from which the phone can see the version or update-required state. `FE-V1-035` cannot truthfully implement its required production behavior.
- Route: critical release blocker and backlog architecture fix. The defect crosses process observation, runtime admission, durable compatibility/session truth, application/listener startup, selected host status, and later UI recovery.
- Related requirements: `FR-017`, `IR-006`, `IR-008`, `NFR-005`, `NFR-010`, `NFR-012`.
- Affected / owning task: completed production composition/lifecycle and health-route behavior from `IFC-V1-039`, `IFC-V1-082`, `IFC-V1-083`, and `IFC-V1-086`; corrective leaf `IFC-V1-087`.
- Blocks: resolved for `FE-V1-035` and `IFC-V1-091`; release acceptance remains downstream of those tasks.
- Root cause: smoke setup is the only real `codex --version` owner; the initialize user agent reflects HostDeck's client identity and is not independent server-version evidence; compatibility persistence occurs only after successful reconciliation; and listener startup requires runtime-ready application phase.
- Fix: boundedly probe the configured binary, skip runtime start/attachment for a valid version mismatch, persist current incompatibility, seal durable projections disconnected, permit only the proven diagnostic-ready listener with mutation admission closed, and expose a strict sanitized compatibility projection through the existing protected host-status response.
- Validation: `PCD-01` to `PCD-24` pass through hostile fake ports, 2,393 unit/28 skips, 245 contract, 36 integration, 516 web, full static/install/audit/package gates, clean committed exact/mismatched real process/listener smokes, durable boundary/privacy inspection, and zero residue.
- Closed by: `IFC-V1-087`; criteria `0fa8b18`, implementation `ceb339e`, and evidence in `artifacts/ifc-v1-087-production-compatibility-diagnostics.md`.

### BUG-018 Offscreen Quiet Session Misclassified As Load Failure

- Symptom: the first clean `FE-V1-090` physical run paired successfully and received one `200` response each from access, host status, and session list, but the harness reported that Mission Control did not load.
- Impact: valid production UI/network/auth behavior fails before the 39-interaction sequence because the physical oracle requires a quiet session to be visible in the first viewport, contradicting the required two-item `ACT NOW` hierarchy.
- Route: release blocker and small validation-harness fix inside the active physical hardening leaf; no product, UX, security, or architecture contract changes.
- Related requirements: `NFR-004`, `PR-005`, `MDH-02`, `MDH-06`, `MDH-21`, `MDH-24`.
- Affected / owning task: `FE-V1-090`.
- Blocks: the corrected clean no-retry physical acceptance and all downstream release tasks.
- Root cause: the dashboard fixture deliberately orders `release-approval` and `migration-input` in `ACT NOW`, while `physical-pairing-review` has no attention and appears below the fold. `openProductionMissionControl` used the quiet session as its universal first-viewport readiness node instead of the visible attention heading, and later target acquisition did not scroll.
- Fix: require every caller to declare either `dashboard_attention` or `single_session` initial-viewport truth; validate `ACT NOW` for the dashboard; retain the exact session check for single-session fixtures; and use bounded forward reveal before dashboard reload and prompt target acquisition.
- Validation: focused physical ledger/driver 29 passed with one device-gated case, typecheck, lint/exports, exact cleanup after the first failed attempt, and a regression for both initial-viewport modes pass. The next clean physical run reached paired Mission Control, rendered `ACT NOW`, issued the fragment-free reload, and failed only at the distinct collapsed-disclosure acquisition now owned by `BUG-019`.
- Closed by: implementation `9bc73ec`; final aggregate evidence remains owned by `FE-V1-090`.

### BUG-019 Collapsed Quiet Queue Cannot Be Reached By Scrolling

- Symptom: the clean `9bc73ec` physical run paired, rendered the required attention-first Mission Control viewport, issued a fragment-free reload, and reread sessions, then timed out trying to reveal `physical-pairing-review`.
- Impact: the aggregate phone run cannot open the selected session or execute the remaining dashboard interactions even though paired authority and protected reads remain healthy.
- Route: high release blocker and small production-accessibility plus validation-harness fix inside the active physical hardening leaf; no product scope, architecture, remote-ingress, or authorization contract changes.
- Related requirements: `NFR-004`, `PR-005`, `MDH-05`, `MDH-06`, `MDH-20`, `MDH-21`, `MDH-24`.
- Affected / owning task: `FE-V1-090`.
- Blocks: corrected no-retry physical acceptance, retained phone deployment, and all downstream release tasks.
- Root cause: with attention rows present, the production dashboard intentionally renders quiet sessions inside a closed native `details` element. The first `BUG-018` correction added bounded scrolling after reload, but collapsed content is absent from the Android accessibility tree and therefore cannot be revealed by any scroll count. The summary also lacked one stable stateful accessible name for deterministic device acquisition.
- Fix: give the production summary a count-preserving `Expand quiet sessions (n)` / `Collapse quiet sessions (n)` accessible name; after reload, boundedly reveal that unique control, verify one state-changing tap, measure its physical target, then boundedly reveal the now-expanded session. Browser and driver regressions freeze the labels and native keyboard transition.
- Validation: focused production component plus physical driver 56 passed with one device-gated case; the real Chromium reflow/keyboard/reduced-motion/contrast scenario passes the collapsed and expanded accessible names. Unit 2,910/29 intentional skips, contract 245, integration 36, web 932, typecheck, lint/exports (828 files/eight packages), scaffold (eight packages/22 scripts), planning (220 tasks/84 requirements/683 dependencies/one queued), and runtime boundary (619 production modules/22 externals) pass. The deterministic 619-source/1,245-output/6,231-entry package and exact four-project supported-browser matrix pass 76/76 after `BUG-020`. The next clean pushed `4b1316b` phone run reached reload and exposed the distinct Android native-summary mapping defect now owned by `BUG-021`; exact failure cleanup passed.
- Closed by: pending the corrected `FE-V1-090` physical artifact and implementation commit.

### BUG-020 Supported-Browser Mutation Diagnostics Race Request Settlement

- Symptom: the full package matrix reached valid terminal UI after an intercepted `202` mutation, then Chromium reported `net::ERR_ABORTED`; a focused rerun could pass the same scenario and later report the same signal on a different valid mutation.
- Impact: release-package validation was scheduler-dependent and could either miss or reject an intercepted-route diagnostic after the application parsed the valid response.
- Route: high release blocker and small validation-harness fix in the already required supported-browser gate; no product, API, security, or browser-support contract changes.
- Related requirements: `NFR-004`, `PR-005`, `PR-011`, `BRM-03`, `BRM-10`, `BRM-16`, `BRM-21`, `BRM-24`, `MDH-02`, `MDH-24`.
- Affected / owning task: completed matrix owner `FE-V1-040`; active package consumer `FE-V1-090`.
- Blocks: resolved for the corrected `FE-V1-090` package and physical acceptance.
- Root cause: `expectCleanBrowser` inspected captured HTTP and request-failure diagnostics before polling non-stream requests to settlement. Playwright-fulfilled routes can expose a valid response to the application while later recording its synthetic request as aborted, so the old ordering made inspection timing determine the result.
- Fix: settle all non-stream requests before inspecting diagnostics; admit an intercepted mutation abort only for the exact captured same-origin `/api/v1/` POST path, and only after each scenario has proved terminal UI, one request, request schema, and CSRF protection. Other mutation aborts and all unexpected diagnostics still fail closed.
- Validation: Biome and diff checks pass; focused Chromium phone passes 19/19; the deterministic package identity is `920ce6b7389f212acfc1a981b9c1e7e4dad7da5d2bdd8552fcdc2cff0111acba`; and the complete exact Chromium/Firefox phone/desktop matrix passes 76/76 with 316 bounded requests, 52 exact mutations, and zero unexpected diagnostics.
- Reopened by: the `FE-V1-090` matrix rerun exposed the same Playwright synthetic-response dual signal on `/api/v1/access/csrf` after seven valid Chromium-phone scenarios. The correction admits it only for one exact same-origin POST whose request body passes `selectedCsrfBootstrapRequestSchema`, whose security headers are exact, and whose same Playwright request object already emitted `200`; a real abort or ambiguous request still fails.
- Final validation: the mandatory proxy-reset guard passes, and the corrected exact Chromium/Firefox phone/desktop matrix passes 76/76 over content `55ee52d7cd834250e90532dfa6aee5583a5fe6626af2923e95ebb3cd997a82c3` with 316 bounded requests, 52 exact mutations, zero unexpected diagnostics, four hash-bound reports, and exact server/root/output cleanup.
- Closed by: the republished `artifacts/fe-v1-040-supported-browser-interaction-matrix/` evidence and this `FE-V1-090` implementation commit.

### BUG-021 Android Native Summary Drops The Stateful Quiet-Queue Name

- Symptom: the clean pushed `4b1316b` physical run paired and reloaded successfully, but Android UIAutomator could not find `Expand quiet sessions (1)` even after four bounded forward reveals.
- Impact: the phone cannot deterministically acquire and measure the collapsed quiet-queue control, so the aggregate interaction sequence cannot open its selected session.
- Route: high release blocker and small cross-device production-accessibility fix inside `FE-V1-090`; no product scope, visual direction, API, remote-ingress, or authorization change.
- Related requirements: `NFR-004`, `PR-005`, `MDH-05`, `MDH-06`, `MDH-15`, `MDH-20`, `MDH-21`, `MDH-24`.
- Affected / owning task: `FE-V1-090` and the quiet-queue production surface from `FE-V1-011` / `FE-V1-039`.
- Blocks: corrected no-retry physical acceptance, retained phone deployment, and all downstream release tasks.
- Root cause: Chromium's desktop accessibility tree honors `aria-label` on native `summary`, but Android Chrome's physical hierarchy exposes the same clickable element as `text="QUIET1"`, `hint="QUIET 1"`, and an empty `content-desc`. The physical driver correctly refuses to infer state or tap a text fragment with sub-target geometry.
- Fix: retain the approved `QUIET`, count, chevron, 44 CSS-pixel target, collapsed behavior, and default-open rule behind an explicit full-width button with exact stateful `aria-label`, `aria-expanded`, and `aria-controls`; keep the controlled list present but explicitly hidden from both layout and accessibility while collapsed.
- Validation: an isolated non-private phone probe maps the explicit button to `android.widget.Button` with exact `content-desc="Expand quiet sessions (1)"`; component plus Android-driver tests pass 56 with one intentional device skip; all three Mission Control Chromium scenarios pass across five viewports, keyboard Enter, reduced motion, reflow, contrast, exact names/states, and controlled-list visibility; and ten refreshed screenshots have no unresolved visual drift. Typecheck, Biome/exports (828 files/eight packages), scaffold (eight packages/22 scripts), planning (220 tasks/84 requirements/683 dependencies/one queued), runtime boundary (619 modules/22 externals), web 932, unit 2,911/29 intentional skips, contract 245, and integration 36 pass. Two builds produce identical 619-source/1,245-output/6,231-entry package `f1d2f387dcc2de4bc66f72bae399aec0d7a64a15efb1ba1a18f739b6b03d1c1f` with web `67d9295b4b8cd0ed57b65165ced86f8914d9c0785f87a2687cb0b39d2162444a`; the exact four-project matrix passes 76/76 with 316 requests and 52 mutations. Corrected physical acceptance remains pending.
- Closed by: pending the corrected `FE-V1-090` package, physical artifact, and implementation commit.

### BUG-022 Android Session Link Exposes Only Child Text Geometry

- Symptom: the clean pushed `23c8fc3` physical run paired, reloaded, found and expanded the corrected quiet queue, then measured `physical-pairing-review` as only `178.1x21` CSS pixels and failed before opening Session Detail.
- Impact: Android can tap only a text-fragment accessibility node instead of one deterministic whole-row target, so the aggregate phone run cannot prove the required 44 CSS-pixel session target or continue through the remaining dashboard interactions.
- Route: high release blocker and small cross-device production-accessibility fix inside `FE-V1-090`; no product scope, visual direction, API, remote-ingress, or authorization change.
- Related requirements: `NFR-004`, `PR-005`, `MDH-05`, `MDH-06`, `MDH-07`, `MDH-15`, `MDH-20`, `MDH-21`, `MDH-24`.
- Affected / owning task: `FE-V1-090` and the whole-row Mission Control navigation surface from `FE-V1-011` / `FE-V1-039`.
- Blocks: corrected no-retry physical acceptance, retained phone deployment, and all downstream release tasks.
- Root cause: the production anchor has a valid 96 CSS-pixel box and passes browser geometry gates, but without an explicit accessible name Android Chrome exposes the session name as a separate glyph-bounded text node. The physical driver correctly measures the semantic node it can acquire instead of assuming the parent anchor's DOM geometry.
- Fix: give both Mission Control and retained-navigation row links the canonical session name as an explicit accessible name, preserve native link semantics and the approved full-row visual target, and require every physical pairing, prompt, recovery, TalkBack, archive, and dashboard path to acquire that exact Android content description. A realistic hierarchy regression distinguishes the full named target from its child text fragment.
- Validation: production component plus Android-driver checks pass 57 with one intentional device skip. Typecheck, static/scaffold/planning/runtime gates, web 932, unit 2,912/29 intentional skips, contract 245, integration 36, and all 175 Chromium shell scenarios pass. The three Mission Control scenarios prove exact names, whole-row and disclosure geometry, responsive layout across five viewports, keyboard transitions, reduced motion, reflow, contrast, and unchanged captures. Two deterministic builds match; the repinned exact Chromium/Firefox phone/desktop matrix passes 76/76 with 316 bounded requests, 52 exact mutations, zero unexpected diagnostics, and exact cleanup. Corrected physical acceptance remains pending.
- Closed by: pending the corrected `FE-V1-090` package, physical artifact, and implementation commit.

### BUG-023 Supported-Browser CONNECT Reset Terminates HTTPS Proxy

- Symptom: the repinned package matrix passed 75 cases across Chromium phone/desktop and Firefox phone, then the HTTPS proxy emitted an unhandled client-socket `read ECONNRESET`, exited, and made the final Firefox desktop cookie navigation fail with `NS_ERROR_PROXY_CONNECTION_REFUSED`.
- Impact: a normal browser tunnel reset can terminate task-owned validation infrastructure and falsely fail otherwise valid package behavior. The exact 76-case package identity cannot be published or consumed by the physical gate.
- Route: high release blocker and small validation-infrastructure fix in the existing supported-browser matrix; no product, browser-support, HTTPS-cookie, API, or remote-ingress contract change.
- Related requirements: `NFR-004`, `PR-005`, `PR-011`, `BRM-02`, `BRM-03`, `BRM-15`, `BRM-21`, `BRM-23`, `BRM-24`, `MDH-02`, `MDH-24`.
- Affected / owning task: completed matrix owner `FE-V1-040`; active package consumer `FE-V1-090`.
- Blocks: exact package evidence, corrected no-retry physical acceptance, retained phone deployment, and all downstream release tasks.
- Root cause: the CONNECT bridge handled only the upstream socket's first error. Once piping began, a Firefox-side reset emitted `ECONNRESET` on the accepted client socket with no listener, so Node applied its default fatal `error` behavior and terminated the shared proxy process.
- Fix: persistently handle errors on every accepted HTTPS/tunnel socket and every outbound tunnel socket, destroy each peer when the other closes, refuse to establish a tunnel after the client is gone, and retain bounded pre-connect `502` behavior. Run a focused guard before every matrix that establishes and resets twelve CONNECT tunnels with TCP RST, proves the process remains alive, then completes a real tunneled TLS request.
- Validation: the focused Node regression passes before the matrix by establishing and forcibly resetting twelve CONNECT tunnels, proving the proxy remains alive, and completing one real tunneled TLS request. Static checks and deterministic package acceptance pass. The exact Chromium/Firefox phone/desktop matrix then passes 76/76 with 316 bounded requests, 52 exact mutations, zero unexpected diagnostics, and four hash-bound reports; ports 4175 to 4177, Playwright output, and the task-owned temporary root are absent afterward.
- Closed by: the republished `artifacts/fe-v1-040-supported-browser-interaction-matrix/` evidence and this `FE-V1-090` implementation commit.

### BUG-024 Physical Session Detail Does Not Establish Its Live Stream

- Symptom: after the earlier ambiguous timeouts, the clean pushed `74a6203` run reported one detail GET, one stream request, stream status `500`, zero opened/active/aborted/explicit subscribers, one source-open/source-failed outcome, and rendered `Live activity stopped`.
- Impact: the aggregate phone sequence cannot proceed because Session Detail requires one current replay-to-live SSE owner before later prompt, approval, recovery, and exact cleanup checks are valid.
- Route: high release blocker and bounded physical diagnosis inside `FE-V1-090` before selecting a browser, server, or harness root fix; no visual, API, authorization, ingress, or retry-contract change yet.
- Related requirements: `NFR-004`, `PR-005`, `MDH-05`, `MDH-06`, `MDH-07`, `MDH-15`, `MDH-20`, `MDH-21`, `MDH-24`.
- Affected / owning task: `FE-V1-090` physical Android target acquisition.
- Blocks: corrected no-retry physical acceptance, retained phone deployment, and all downstream release tasks.
- Ruled out: Tailscale transport, Chrome request dispatch, target naming, 44 CSS-pixel geometry, Chrome page containment, native clickability, tap dispatch, client navigation, detail routing, paired read authority, the detail GET, browser stream initiation, and subscriber cancellation are proven.
- Root cause: `PhysicalPromptHandoffService` copied dashboard replay events without the production contract's recursive immutability and always declared `truncated=false`. The dashboard replay begins with an intentional retention `replay_boundary`, which requires deep-frozen event data and `truncated=true`; the strict production subscriber rejected the contradictory fixture before admission and the selected SSE route correctly returned `500`.
- Fix: normalize every initial and published physical projection through the selected event schema, recursively freeze the normalized data, and derive `truncated` from whether the replay's first event is a boundary. Keep the strict production subscriber unchanged and retain the private-free lifecycle diagnostics.
- Validation: a direct regression opens all five dashboard boundary/complete/redacted/approval/runtime events through the real subscriber contract, drains replay in order, proves one live subscriber remains, then closes it exactly with no observed failure. The focused driver/fixture suite passes 28 with one intentional physical skip and CLI typecheck passes. The clean pushed `bcdcd1e` run established one live subscriber, drained replay, and opened the boundary and complete-event diagnostics exactly once before a separate occluded-control defect stopped the sequence.
- Closed by: replay normalization and handoff implementation `1ccf27e`, plus clean pushed physical proof on `bcdcd1e`.

### BUG-025 Failure Cleanup Races Lifecycle Observation

- Symptom: after the first `BUG-024` assertion, cleanup reported that selected-lifecycle remote disable failed. The ownership-safe fallback subsequently removed Serve, and independent inspection proved absent Serve plus fully restored device and process state.
- Impact: an expected assertion failure can add a second cleanup failure and rely on fallback ownership proof even though the selected lifecycle remains available, obscuring the primary defect and weakening exact cleanup evidence.
- Route: high release blocker and small physical-harness cleanup correction inside `FE-V1-090`; no remote-ingress, profile-selection, ownership, or product behavior change.
- Related requirements: `NFR-004`, `PR-005`, `PR-011`, `MDH-02`, `MDH-09`, `MDH-16`, `MDH-22`, `MDH-24`.
- Affected / owning task: `FE-V1-090` physical Android cleanup.
- Blocks: corrected no-retry physical acceptance, retained phone deployment, and all downstream release tasks.
- Root cause: the normal success path explicitly waits for one fresh lifecycle observation with zero active control operations before `remote disable`; the failure path restored the dedicated profile and immediately issued disable without the same settle gate.
- Fix: retain the exact selected lifecycle for cleanup and require one new idle observation after profile restoration before calling its CLI-owned disable operation. Keep the ownership-safe direct-manager fallback as a separately observable last resort.
- Validation: the pushed `824fbec` failure run reported only the primary Session Detail assertion, with no cleanup error. Independent post-run inspection proved Serve `{}`, restored captured Wi-Fi/mobile-data/stay-awake and accessibility settings, stopped Chrome, no ADB forward/reverse tunnel, no acceptance process, no partial evidence, and no worktree change.
- Closed by: pushed implementation `824fbec` plus its exact physical failure-cleanup inspection.

### BUG-026 Initial Detail Gate Assumes Current Viewport Visibility

- Symptom: the clean pushed `1ccf27e` run established one live Session Detail subscriber and rendered the writable composer, then timed out on an unscrolled replay-boundary label. The clean pushed `a3ad76f` run proved replay drain and then timed out on unscrolled top-context value `Current`.
- Impact: the aggregate sequence stops before its existing event-diagnostic workflow can scroll to, open, capture, and inspect the boundary row.
- Route: high release blocker and small physical-harness correction inside `FE-V1-090`; no product UI, event, SSE, authorization, ingress, or retry-contract change.
- Related requirements: `NFR-004`, `PR-005`, `MDH-07`, `MDH-14`, `MDH-21`, `MDH-22`, `MDH-24`.
- Affected / owning task: `FE-V1-090` physical Session Detail evidence sequencing.
- Blocks: corrected no-retry physical acceptance, retained phone deployment, and all downstream release tasks.
- Root cause: `waitForAndroidUiText` observes only the current Chrome accessibility hierarchy and never scrolls. The docked composer remains visible when the route retains Mission Control's vertical offset, while top Session Context can be above the viewport and replay rows can be below it. The event diagnostic already owns bounded forward row reveal, but the top capture had no corresponding backward reveal owner.
- Fix: require one active subscriber and zero remaining server replay events, then perform a bounded backward reveal of the fully visible `Current` stream value before the top-of-detail capture. Keep the existing bounded forward row reveal, exact event read, limitation check, and screenshot as each replay row's physical evidence owner.
- Validation: direct five-event boundary replay and clean pushed physical live/writable/replay-drain transitions prove event production and stream ownership. The clean pushed `bcdcd1e` run backward-revealed fully visible top `Current` truth, captured the detail, then forward-revealed and opened the boundary and complete rows exactly once before a separate third-row tap defect stopped the sequence.
- Closed by: bounded initial-detail sequencing `a3ad76f`, viewport reveal `bcdcd1e`, and the clean pushed physical `bcdcd1e` run.

### BUG-027 Event Diagnostic Accepts An Occluded Action

- Symptom: the clean pushed `bcdcd1e` run passed top context plus the boundary and complete-event diagnostics, then found the third event's nearest `View event details` action near the bottom of Android's hierarchy. The action lay under the fixed session-control dock, so the one allowed tap produced neither an event read nor the `Turn event` dialog.
- Impact: the aggregate sequence stops before redaction, approvals, writes, recovery, utility controls, profile switching, TalkBack, revocation, privacy, and cleanup evidence can execute.
- Route: high release blocker and task-local physical-driver correction inside `FE-V1-090`; no product UI, event, authorization, ingress, or retry-contract change.
- Related requirements: `NFR-004`, `PR-005`, `MDH-07`, `MDH-08`, `MDH-14`, `MDH-21`, `MDH-22`, `MDH-24`.
- Affected / owning task: `FE-V1-090` physical event-row acquisition and one-tap integrity.
- Blocks: corrected no-retry physical acceptance, retained phone deployment, and all downstream release tasks.
- Root cause: the event diagnostic accepted a hierarchy-present label and chose its nearest action by vertical distance, but neither condition excluded the page region covered by the fixed session-control dock. Full Chrome-page containment alone cannot prove an element is unobscured by product overlays.
- Harsh success criteria: acquire each label and nearest action as one pair; require a unique sticky back control plus unique measured `/model`, `/goal`, `/plan`, and utility dock controls; require both pair members inside the resulting content region with a 24-device-pixel overlay inset; scroll forward no more than four times from that same unobscured lane; fail closed on absent or ambiguous geometry; issue one tap only after admission; and retain the exact one-read plus expected-heading assertion.
- Validation required: direct geometry regressions must accept an unobscured pair and reject top-occluded, bottom-occluded, incomplete-header, incomplete-dock, ambiguous-label, and distant-action fixtures. Focused driver tests, CLI typecheck, static/planning checks, and a clean pushed no-retry physical run must pass with exact cleanup.
- Fix: acquire the label, uniquely nearest clickable action, sticky back control, and four fixed-dock controls from one hierarchy snapshot. Admit the pair only inside the measured 24-device-pixel-inset region between sticky header and dock. Derive forward swipes from that same region instead of starting inside either overlay's scroll or tap surface.
- Validation: direct safe/top-occluded/bottom-occluded/incomplete-header/incomplete-dock/ambiguous-label/distant-action and swipe-lane geometry checks pass in the focused suite: 29 passed with one intentional physical skip. CLI typecheck, lint across 829 files, package exports, and the 220-task/84-requirement/683-dependency planning graph pass. Corrected no-retry physical proof remains pending.
- Closed by: pending corrected physical evidence and implementation commit.
