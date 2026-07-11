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
| BUG-008 | Repository entry points and validation wiring drift from the selected HostDeck architecture and owning task graph. | Medium | Small bugfix | Closed | Documentation/validation harness | HostDeck README, canonical Codex aggregate alias, exact placeholder-owner checks, nine-package convention coverage, and synchronized delivery guides; `artifacts/repository-audit-2026-07-11.md`. |

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

### BUG-008 Repository Entry Point And Validation Drift

- Symptom: the root README still describes a generic planning template; the test plan documents `pnpm test:codex` but no root script exists; build/E2E placeholders report aggregate `REL-V1-007` instead of their implementation owners; and the workspace-conventions unit test omits `codex-adapter`.
- Impact: a developer can misunderstand the product and release state, documented validation cannot be invoked canonically, failed build output points to the wrong task, and one package escapes the redundant unit-level workspace convention check.
- Route: small bugfix; selected product, command ownership, and package inventory are already explicit.
- Affected / owning task: documentation and validation harness; no product requirement or execution dependency changed.
- Root cause: repository entry points and duplicated script/package inventories were not synchronized after the app-server rebaseline and later package growth.
- Fix: replace the README with current HostDeck/release/architecture truth; add the canonical `test:codex` alias; correct build/E2E placeholder owners and support multiple blocking tasks; make scaffold validation assert every documented exact-Codex command plus exact future-command ownership; include all nine packages in workspace convention tests; update delivery guides.
- Validation: scaffold, planning, typecheck, lint/export checks, focused workspace convention test, placeholder failure, documentation diff, and production dependency audit.
- Closed by: repository audit branch; evidence in `artifacts/repository-audit-2026-07-11.md`.
