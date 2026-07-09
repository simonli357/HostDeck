# REL-V1-011 V1 System Hardening Audit

Date: 2026-07-09

## Target

- Audit the complete V1 delivery system before further feature implementation.
- Scope: product direction, requirements, architecture, implementation blueprint, capability blocks, dependency graph, completed-task evidence, runtime integration, security/privacy, mobile UI direction, validation, packaging, and release gates.
- Documentation impact: Tier 3 because the audit changes architecture, validation strategy, module maturity, task dependencies, and release blockers.

## Strict Success Criteria

### Product And UX Alignment

- The V1 default workflow starts on a phone-width Mission Control screen, identifies the highest-attention session, opens a conversation-first Session Detail screen, sends one prompt or approved slash command, and shows resulting output without a laptop terminal.
- Both visual-direction candidates cover phone Mission Control and phone Session Detail in trusted writable and safety-disabled states before human selection.
- Desktop UI is a responsive expansion of the same information architecture, not the source layout from which mobile is reduced.
- No mockup or task introduces deferred file browser, code editor, Git review, approval queue, storage console, or generic terminal surfaces as V1 navigation.

### Architecture And Runtime Ownership

- The approved runtime stack and actual dependencies agree, or a recorded decision explains a deliberate replacement.
- One production application path owns startup, the HTTP server, session orchestration, output workers, live fanout, metadata classification, retention, health reporting, and graceful shutdown.
- A single HostDeck daemon owns a state directory at a time; concurrent daemon startup fails explicitly.
- Persisted live tmux sessions restart through the real service without test-only output-reader injection.
- Shutdown closes listeners and live streams, stops output workers, disarms owned capture resources, flushes durable writes, and leaves managed tmux sessions running unless explicitly stopped.

### Session Output And Intelligence

- Every running managed session has a supervised production output worker.
- Output ingestion uses the selected live `pipe-pane` path plus bounded `capture-pane` recovery, assigns monotonic cursors, applies configured retention, and publishes events to per-session subscribers.
- New output updates last activity, recent summary, status, attention, output cursor, and stream health through shared contracts.
- Replay followed by live subscription cannot lose or silently duplicate events at the handoff boundary; discontinuity emits an explicit boundary.
- Output and audit retention policies are invoked by production paths, not only repository tests.

### Trust, Network, And Local Data Security

- Loopback HTTP remains local-only; LAN phone access carrying session output or credentials uses an explicitly approved encrypted transport.
- LAN reads require paired read or write authority; no unauthenticated LAN client can read cwd, branch, output, or session metadata.
- Host/Origin validation resists DNS rebinding and cross-origin browser writes.
- Pairing claims are bounded and rate-limited; device tokens are revocable through a user-accessible local-admin path.
- A paired browser can recover a valid CSRF write posture after reload without storing the device bearer token in JavaScript-readable storage.
- Device cookies use the strongest attributes supported by the selected transport, and plaintext LAN mode never receives write credentials.
- Dashboard lock, pair claim, token revocation, writes, and LAN changes have truthful bounded audit outcomes.
- State directories and secret-bearing database files are owner-only; insecure permissions fail or are repaired observably.

### Failure, Resource, And Data Integrity

- Request body, header, connection, stream, and CLI client timeouts are bounded.
- SSE handles disconnect, backpressure, heartbeat, replay cursor, and shutdown without leaking subscribers or hanging service close.
- Session start either commits tmux target plus registry and metadata coherently or leaves an explicit recoverable failure that does not permanently block retry.
- Normal, invalid, boundary, repeated, concurrent, restart, and partial-failure cases have direct tests at the owning layer.
- No success response or audit record claims an outcome that was not reached.

### Planning, Tasks, And Evidence

- Every active V1 requirement maps to concrete leaf tasks and an executable evidence route.
- Every task records real dependencies; a completed dependency remains listed instead of being replaced with `none`.
- The current queue contains only current ready/in-progress work and intentional blockers, not the full historical task list.
- Module maturity distinguishes isolated/headless proof from production integration and release proof.
- Automated planning checks reject missing task references, unknown dependencies, dependency cycles, invalid ready states, and missing requirement trace rows.
- A block is complete only when its production integration and manual evidence meet its block-level outcome, not merely its package-local scope.

## Baseline Validation

Passed on the pre-audit `main` baseline:

- `pnpm check:scaffold`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm test:unit`: 32 files passed, 1 skipped; 184 tests passed, 1 skipped
- `pnpm test:contract`: 6 files and 68 tests passed
- `pnpm test:integration`: 1 file and 15 tests passed
- `pnpm test:web`: 2 files and 14 tests passed
- `pnpm test:tmux`: 1 real tmux smoke test passed

These results prove substantial package-level foundations. They do not prove the missing production integration paths below.

## Confirmed Findings

### Blockers

- Both visual candidates are desktop-led and omit phone Mission Control, the default V1 workflow. Both phone Session Detail candidates show only disabled writes. `FE-V1-002` must be reopened; `FE-V1-003` cannot request selection yet.
- The architecture was committed to tmux/TUI scraping before evaluating Codex app-server, the current interface intended for rich clients. Local Codex 0.144.0 smoke proved schema generation, structured thread/model/goal calls, and normal TUI attachment over loopback and Unix-socket transports. The primary integration must be rebaselined and proven through a real structured vertical slice before UI implementation.
- The real service defaults to an empty live stream source. It can replay retained output but does not publish ongoing tmux output without test-only injection.
- Restarting the real service with persisted live sessions requires an externally injected output-reader callback before the service constructs its own output reader.
- Production output append does not receive configured retention policy, and production audit append never invokes audit cleanup. The documented bounds are not enforced by the running service.
- Output ingestion does not update status, attention, summary, last activity, or metadata cursor. The core mission-control signal remains `unknown` after session start.
- LAN HTTP can expose session reads without read authorization, and the pairing cookie is explicitly non-Secure. The current transport is not adequate for shell-controlling phone access.

### High Severity

- Browser trust state cannot recover write posture after reload: cookie-only security state is reported as untrusted, while the raw CSRF token cannot be recovered from its stored hash.
- Pairing claim has no rate limit, Host allowlist, or DNS-rebinding defense.
- Dashboard lock and pair claim do not write the audit events required by the architecture; device revocation exists only as a repository method with no user-facing control.
- The approved Fastify runtime and SSE/WebSocket architecture do not match the custom Node HTTP implementation or installed dependencies. The current adapter lacks framework lifecycle, validation, and shutdown controls promised by the block spec.
- Service health is a startup snapshot. Runtime output-reader failures do not update host/session health.
- Active SSE streams are not aborted on client disconnect or service shutdown and can prevent graceful close.
- State directory and SQLite file permissions are not constrained to the owning user.
- There is no single-daemon lock for a state directory, so two services on different ports can operate the same database and tmux namespace.

### Planning And Evidence Integrity

- The implementation blueprint maturity table and candidate-block language are stale relative to completed work.
- The blueprint orders the visual mockup gate after Foundation UI even though UI implementation is explicitly blocked on visual selection.
- `IFC-V1-012` is marked done for foreground and long-running service behavior while its evidence explicitly says the service wrapper is not implemented.
- `docs/status.md` and the current queue contain historical completion detail instead of concise handoff/current work truth.
- Most completed task cards record `Blocked by: none`, so the documented dependency graph cannot prove the implementation order it claims.
- No repository script currently validates requirement/task references, ready-state dependencies, or dependency cycles.

## Repair Sequence

1. Rebaseline owner docs, module maturity, requirements, and the dependency-aware current queue around the app-server recommendation and confirmed findings.
2. Add narrowly scoped leaf tasks for app-server compatibility and vertical proof, transport security, production event supervision/fanout/projection/retention, auth lifecycle, Fastify/SSE integration, daemon ownership/permissions/shutdown, runnable packaging, and corrected mobile mockups.
3. Add automated planning integrity checks and repair historical dependency metadata.
4. Implement integration/security fixes in dependency order with focused regression evidence.
5. Regenerate two complete mobile-first visual directions and request human selection only after both pass the corrected UI gate.
6. Resume UI implementation, module hardening, and release hardening only after the reopened gates are satisfied.

## Rebaseline Applied

- Rewrote the end goal, roadmap, PRD, requirements, UX contract, technical plan, implementation blueprint, test plan, six block specs, block completion matrix, delivery plan, status, current queue, and backlog index around the selected mobile/app-server/HTTPS direction.
- Recorded `DEC-018`: primary Codex integration is app-server over a user-private Unix socket; terminal scraping is legacy evidence until structured acceptance.
- Recorded `DEC-019`: phone Mission Control and conversation-first Session Detail are primary; inline structured approvals are V1; raw phone shell input is deferred; exact-thread laptop TUI resume is the full-control path.
- Recorded `DEC-020`: HTTP is loopback-only; LAN is HTTPS-only with paired reads/writes, configured Host/Origin policy, and secure cookies; app-server is never exposed to LAN.
- Reopened every capability block whose production outcome changed. Historical task evidence remains linked but cannot complete the selected path.
- Replaced the 54-row historical current queue with one active audit task. The next selected-path work is blocked explicitly behind the audit.
- Added 104 total leaf tasks with 262 explicit dependencies. New tasks cover normalized contracts, strict invariants, mapping/projection migration, secure paths/daemon lease, production retention/audit, CSRF/device lifecycle, app-server compatibility/IPC/real vertical/restart, legacy disposition, HTTPS phone enrollment, Fastify/SSE/auth/fanout/health/bounds/package/services, mobile state/mockups/approval, and release proof.
- Expanded traceability to 84 individual active requirements with an evidence route for each requirement.
- Added `pnpm check:planning` and five self-tests. The checker validates task ids/statuses/required fields, block and requirement refs, unknown dependencies, cycles, stale todo/ready states, deferred dependencies, done-task evidence, exact requirement coverage, and current-queue truth.

## Validation After Rebaseline

Passed:

- `pnpm check:planning`: 104 tasks, 84 requirements, 262 dependencies, 1 current queue task; 5 checker tests.
- `pnpm check:scaffold`: 8 current packages and 13 root scripts.
- `pnpm typecheck`.
- `pnpm lint`: 115 files and 8 package exports.
- `pnpm test:unit`: 32 files passed, 1 skipped; 184 tests passed, 1 skipped.
- `pnpm test:contract`: 6 files and 68 tests.
- `pnpm test:integration`: 1 file and 15 tests.
- `pnpm test:web`: 2 files and 14 tests.
- `pnpm test:tmux`: 1 historical regression smoke test.
- `git diff --check`.

## Remaining No-Go Gates

- `FND-V1-015` and `FND-V1-016`: normalize contracts/fixtures and fix timestamp, cursor, transition, target, capability, and audit outcome invariants.
- `INT-V1-003` to `INT-V1-007`: generated compatibility gate and real app-server thread/turn/event/control/approval/TUI/restart proof.
- `IFC-V1-015`: real-phone HTTPS certificate enrollment decision/proof.
- `DAT-V1-018` to `DAT-V1-021`: selected mapping/projection/auth/audit/permission/retention state.
- `IFC-V1-016` to `IFC-V1-021`: production Fastify/SSE/security/orchestration/resources/build/user services.
- `FE-V1-004`, reopened `FE-V1-002`, and human `FE-V1-003`: real mobile states, two replacement directions, selection before React screens.
- All selected-path module hardening and L4 release/security/device gates.

## Current Audit Status

- Audit and rebaseline: complete; rebaseline commit `2e06d4b` pushed to `origin/main` and closure handoff committed separately.
- Existing package-level tests: passing.
- Production integration/security readiness: no-go until blocker tasks are completed.
- UI visual selection readiness: no-go; current options are retained as rejected audit evidence, not implementation targets.
