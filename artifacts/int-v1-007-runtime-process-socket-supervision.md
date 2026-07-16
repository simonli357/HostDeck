# INT-V1-007 Runtime Process And Socket Supervision

Date: 2026-07-16

Status: complete.

## Scope

Implement one headless runtime supervisor for the selected dedicated Codex app-server. It owns the distinction between a foreground child and a user-service sibling, the canonical private Unix-socket readiness boundary, child-exit observation, and bounded reverse cleanup. Compatibility handshake, reconnect/backoff, crash reconciliation, HostDeck-only restart recovery, TUI coexistence, aggregate startup composition, systemd unit installation, packaging, and release acceptance remain downstream.

## Pre-Change Findings

- The exact runtime smokes spawn `codex app-server --listen unix://...` directly and contain task-local socket polling and child cleanup. No production module owns those mechanics.
- The selected Unix transport validates an absolute Unix path and performs the compatibility handshake, but it neither creates nor owns the app-server process or socket.
- Secure local-path work already derives `app-server.sock`, prepares an owner-only runtime directory, validates socket owner/type/mode/canonical identity, and coordinates one HostDeck daemon with a kernel lease.
- The current executable startup path remains the historical tmux service. Wiring the selected runtime into aggregate Fastify startup is separate interface composition work and cannot be used as evidence for this leaf.
- The resource registry already owns startup, shutdown, cleanup-step, protocol-connect, and protocol-handshake deadlines. A process boundary must consume the caller-owned lifecycle deadline rather than inventing an unbounded wait.

## Frozen Architecture

- Add `HostDeckCodexRuntimeSupervisor` under `@hostdeck/server`. Construction accepts one exact mode, canonical socket path, optional foreground Codex executable, and injectable process/socket/clock ports. `start` consumes the caller's resolved `ResourceBudget` and timer-owning `OperationDeadline`; `close` consumes a caller-owned cleanup deadline.
- `foreground_child` requires one absolute bounded executable and generates the complete immutable command itself: `app-server --listen unix://<canonical socket>`. It uses no shell, accepts no caller arguments or TCP address, and owns only the returned child.
- `service_owned` forbids a Codex executable and process port. It waits for and validates the sibling-owned socket, but never spawns, signals, reaps, unlinks, or otherwise claims the sibling process or socket.
- One process-level canonical-socket claim is acquired before inspection or spawn and retained through ready, unexpected child exit, and cleanup. Concurrent or repeated supervisors for the same path reject before process or filesystem side effects. Cross-process HostDeck duplication remains guarded by the existing state-directory kernel lease.
- The supervisor is a lifecycle primitive, not a compatibility or restart manager. It does not probe Codex version/capabilities, open the adapter, retry a protocol mutation, auto-restart a child, reconcile projections, mutate systemd, inspect Tailscale, or bind HostDeck HTTP.

## Socket Trust And Readiness

- The socket path must be absolute, normalized, control-free, URL-delimiter-free, within the Linux Unix-socket byte limit, and end in the selected `app-server.sock` name. Its existing parent must be a canonical non-symlink directory owned by the current uid with exact mode `0700`.
- Existing symlink, regular-file, directory, foreign-owner, hard-linked, noncanonical, or otherwise invalid socket candidates fail closed. Owner-only socket mode drift may be repaired to `0600` with bounded evidence before readiness.
- Readiness requires both a validated socket inode and a successful local Unix stream connection. In foreground mode the owned child must still be running after the readiness probe; an inode alone cannot prove readiness.
- An already accepting socket in foreground mode is an active ownership conflict and is never signaled or removed. A valid same-uid socket that refuses connections is removable only in foreground mode, after identity recheck, as stale state under the already-required daemon-lease boundary. Service mode never removes it and waits for the sibling to replace or activate it.
- Missing and transiently refusing service sockets may be retried only inside the unchanged startup deadline. Invalid socket state fails immediately. There is no TCP, loopback-port, LAN, stdio, tmux, or alternate-path fallback.

## Process And Exit Contract

- The production process port invokes Node `spawn` with the exact executable/arguments, cwd `/`, inherited environment, ignored standard streams, `shell: false`, and no detached process group. Synchronous throw, asynchronous `ENOENT`, `EACCES`, other spawn error, early nonzero/zero exit, and signal exit map to stable bounded supervisor errors without raw stderr, environment, path, pid, or command disclosure.
- Foreground readiness returns one immutable owned handle with mode, socket path for the internal transport, mode-repair/stale-cleanup facts, a count-only snapshot, an unexpected-exit promise, and idempotent close. No mutable child-process object or kill capability escapes.
- A foreground child exit before readiness fails startup and performs reverse cleanup. Exit after readiness becomes explicit `exited` state and settles the one exit promise; it does not silently remain ready and is not restarted.
- Service readiness returns an immutable unowned handle with no process-exit promise or process capability. App-server loss is observed later by the transport/reconnect owner.
- Duplicate start, start after close/failure, close during start, repeated/concurrent close, and impossible process-port transitions have one explicit result and cannot leak a claim, listener probe, child, timer, or abort listener.

## Deadline And Cleanup Contract

- Startup checks the caller's deadline before every inspect, probe, spawn, and retry. Deadline expiry and caller abort remain distinct stable failures. Retry sleeps are abortable and never extend the original deadline.
- Any failure after foreground spawn attempts child termination and identity-safe socket cleanup before releasing the process claim. Cleanup failures are retained with the primary failure; they never turn failure into success.
- Normal foreground close sends `SIGTERM`, waits only within its cleanup allocation, escalates to `SIGKILL` if still running, waits again within the same caller deadline, then removes only the exact socket identity observed for this owned runtime. Missing socket is already clean; replacement or wrong-type state is a cleanup conflict and is not removed.
- If the close deadline is already expired, the supervisor still attempts the safety-critical `SIGKILL`, reports timeout/failure truthfully, and releases only capabilities that are actually settled. It unlinks only after the owned child is reaped; a late reap triggers identity-safe deferred cleanup without relabeling the failed close. It never signals by discovered pid, process name, socket peer, or stale metadata.
- Service close releases only the HostDeck process-local observation claim. It leaves the sibling and socket untouched even when readiness, compatibility, or later HostDeck work fails.

## Observability And Privacy

- A frozen snapshot exposes mode, phase, ownership, socket-ready state, repair/stale-cleanup booleans, spawn/TERM/KILL counts, child-exit classification, startup retry count, and cleanup-failure count.
- Snapshot counters saturate at `Number.MAX_SAFE_INTEGER`. No executable, arguments, environment, socket path, uid, inode, pid, raw error, stderr/stdout, signal callback, process object, or port implementation is exposed.
- Stable public messages contain no configured path or binary. Internal causes may retain operating-system error identity for local diagnostics but are never copied into public API envelopes by this module.

## Hard Success Criteria

| Area | Required evidence |
| --- | --- |
| Construction | Exact discriminated mode input; absolute foreground executable; canonical selected socket; strict resolved budget/deadline/port/clock contracts; extra keys, accessors, malformed callbacks, and unsupported platform fail loudly. |
| Foreground ownership | One fixed no-shell Unix-only spawn; active-socket and concurrent-owner rejection; owned-child readiness; no foreign pid/process signaling; exact child exit before/after ready. |
| Service ownership | Existing/delayed sibling readiness; no spawn, signal, reap, unlink, executable, or process capability on success, failure, abort, and close. |
| Socket security | Canonical mode-0700 current-uid parent; socket uid/type/link/mode/identity validation; mode repair; stale foreground cleanup; service preservation; replacement and wrong-type rejection. |
| Deadlines | Exact startup boundary, abort during inspect/probe/sleep, no deadline reset, bounded TERM-to-KILL escalation, and no retained timer/listener. |
| Failure truth | Missing/nonexecutable/wrong binary, sync/async spawn failure, zero/nonzero/signal exit, timeout, probe failure, port contract violation, cleanup failure, and aggregate primary-plus-cleanup evidence. |
| Lifecycle | Duplicate/repeated/concurrent start/close, close-during-start, unexpected exit, idempotent result, process claim release, socket cleanup, and later same-path restart. |
| Real boundary | Exact reviewed Codex 0.144.0 reaches compatibility-ready through the production supervisor plus Unix transport in foreground mode without a model call; service mode connects to an externally started exact sibling and closing HostDeck leaves it alive. Both paths end with explicit process/socket cleanup. |
| Ownership | No reconnect, restart, reconciliation, HostDeck composition, user-unit installation, package, UI, phone, or release claim. No dependency change. |

## Validation Plan

- Direct supervisor tests use deterministic fake process/socket/clock ports for every mode, state transition, deadline edge, process event, duplicate race, cleanup branch, malformed port response, counter, and snapshot privacy rule.
- Linux process/socket integration uses temporary owner-only runtime directories and generated executable fixtures to prove fixed argv, real spawn/exit signals, socket mode/identity, stale and active collisions, service non-ownership, escalation, reverse cleanup, and same-path restart.
- An opt-in no-model smoke uses the isolated exact Codex 0.144.0 binary twice: production foreground supervision plus compatibility handshake, then an externally started service sibling observed by the production service-mode supervisor. It inspects Unix socket type/mode, child survival across service-supervisor close, terminal process exit, and filesystem cleanup.
- Run focused tests, full unit/contract/integration/web suites, root and all-package typechecks, lint/exports, scaffold, planning, frozen offline install, exact binding, production dependency/license checks, `git diff --check`, active-handle/process/socket inspection, and manual mode/argument/privacy review.

## Implementation

- `packages/server/src/codex-runtime-supervisor.ts` implements the strict two-mode lifecycle state machine, process-local canonical-socket claim, deadline handling, readiness, exit observation, reverse cleanup, and privacy-safe snapshots.
- `packages/server/src/codex-runtime-supervisor-node.ts` isolates production Node process and Unix-socket operations. Foreground spawn is fixed to `app-server --listen unix://<socket>` with `shell: false`; service mode has no process capability.
- Unit tests cover strict construction, active/stale/duplicate ownership, service noninterference, sync/async process failures, child exit races, abort/timeout, TERM-to-KILL escalation, malformed ports, replacement-socket conflicts, late reap, restart, and snapshot privacy.
- Linux integration tests use real processes and Unix sockets for argv, socket identity/mode, foreground cleanup/restart, service sibling survival, insecure parent/symlink rejection, asynchronous `ENOENT`/`EACCES`, and ignored-TERM escalation.
- The exact-runtime smoke composes the production supervisor with the production Unix transport and compatibility connection in both modes. Foreground close reaps the owned process and removes its socket; service close leaves the externally started sibling alive until explicit test cleanup.
- Criteria commit: `9b7c7f4`. Implementation commit: `d0449fc`.

## Hardening Findings

- Cleanup initially could unlink the socket before a signaled child was reaped. Cleanup now waits for authoritative exit and performs deferred identity-safe removal after a late reap.
- A readiness microtask gap could publish ready after child exit. Foreground readiness now rechecks the authoritative child state immediately before publication.
- Claim release initially depended on diagnostic counts instead of settled resources. The claim now remains held until process and socket ownership are actually settled.
- Cleanup inspection could repair the mode of a replacement socket. Cleanup now observes identity without mutating a socket it does not own.
- Clock, socket-removal, and malformed-exit failures now retain stable supervisor classifications instead of leaking raw or contradictory state.

## Validation Evidence

| Check | Result |
| --- | --- |
| Focused supervisor unit | 18 passed. |
| Linux supervisor integration | 5 passed with real child processes and Unix sockets. |
| Exact Codex 0.144.0 supervisor smoke | 1 passed; foreground and service-owned compatibility-ready lifecycles completed without a model call and with explicit cleanup. |
| Full unit | 172 files passed, 23 skipped; 1,628 tests passed, 37 opt-in/external tests skipped. No Android device was required. |
| Full contract / integration / web | 276 / 31 / 33 passed. |
| Static and planning gates | Root and all nine package typechecks, lint/exports over 483 files, scaffold, planning (212 tasks, 84 requirements, 649 dependencies, 2 queued), frozen offline install, and `git diff --check` passed. |
| Exact binding | Codex 0.144.0 verified across 671 generated files at tree identity `e1a1a5cff3ab91862f9215dd06538eae1ea0b00bae48cbb7d87061faaee27e24`. |
| Production dependencies | No dependency changed. Production licenses are MIT, BSD, ISC, Apache, BlueOak, and compatible permissive combinations. `pnpm audit --prod` could not query advisories because npm's retired audit endpoint returned HTTP 410; it reported no vulnerability result. |
| Manual review | Fixed Unix-only argv, no shell/TCP/LAN fallback, mode-specific process capabilities, child-before-socket cleanup, replacement identity, bounded public diagnostics, and downstream exclusions pass. |

## Downstream Ownership

- `INT-V1-028` owns bounded reconnect/backoff after transport or process loss and never retries accepted mutations.
- `INT-V1-029` owns app-server crash/restart reconciliation and durable uncertainty.
- `INT-V1-030` owns HostDeck-only restart while a service-owned app-server continues.
- `INT-V1-031` owns real HostDeck plus laptop TUI coexistence.
- `INT-V1-032` owns aggregate runtime lifecycle acceptance.
- Interface lifecycle, build, service-unit, and release leaves own selected startup composition, installed user services, clean-machine operation, and device/release proof.
