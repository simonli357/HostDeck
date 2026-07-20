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
