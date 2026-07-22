# IFC-V1-086 Service-Owned HostDeck Process

## Purpose

Freeze and prove the packaged process boundary required by the two-unit V1 topology before systemd unit generation.

## Audit Finding

- `codexdeck serve` is correctly foreground-only. `startHostDeckForegroundResources` always creates a `foreground_child` supervisor, and foreground serve requires its non-null process-exit observation.
- `hostdeck.service` cannot invoke that command while `hostdeck-codex.service` also owns an app-server. Doing so would create competing socket/process owners, terminate the child on HostDeck restart, and contradict restart continuity.
- The accepted supervisor already supports the needed lower-level boundary: `service_owned` waits for the private socket, never spawns or signals a process, never removes the sibling socket, and releases only its process-local claim.
- The production application already treats a null process-exit observation as externally owned and has accepted reconnect/reconciliation behavior. The missing work is a selected resource/serve composition and packaged process entry that choose that mode.

## Frozen Boundary

### Production resources

- Reuse the canonical config/state/runtime/database/socket derivation, state lease, guarded migrated SQLite, resource budget, production application, selected route/static registration, loopback listener, remote lifecycle, and ordered shutdown owners.
- Validate one canonical absolute executable Codex path before mutable startup. The path remains required for exact compatibility and resume metadata even though HostDeck does not execute it in service mode.
- Acquire the shared HostDeck state lease before config/database/listener/socket inspection. A second service process or manual foreground owner fails through that lease before runtime mutation.
- Require the service runtime directory to exist already as a canonical current-user directory with mode `0700`. Service HostDeck does not create, chmod, replace, preserve, or remove this externally owned directory.
- Create the runtime supervisor with exactly `{ mode: "service_owned", socket_path }`. No process port or Codex executable is passed to it.
- Require returned runtime identity to be exactly `service_owned`, the selected socket path, and `process_exit: null`. Any foreground identity or process observer is an impossible branch and fails startup.
- Missing/refused socket waits only within the existing startup budget. Timeout or abort rolls back HostDeck storage/lease ownership and does not remove or repair socket state.

### Serve lifecycle

- Compose the same selected production application and Fastify/Tailscale-Serve lifecycle as foreground mode.
- Listener publication remains after socket readiness, compatibility, reconciliation, startup maintenance, route/static registration, and local health readiness.
- Tailscale observation starts after local listen and remains degradable. Service startup does not require `tailscaled`, mutate Serve, switch profiles, or use a LAN/custom-CA fallback.
- Do not attach an app-server process-exit termination trigger in service mode. App-server disconnect/restart is handled by the accepted reconnect/reconciliation owners while HostDeck remains alive.
- SIGINT, SIGTERM, caller abort, and manual close use the same bounded shutdown sequence. Runtime close releases only the service-owned supervisor claim; it sends no signal and unlinks no socket.
- Startup and shutdown failures expose bounded stage/code truth without paths, environment values, raw protocol data, credentials, or Tailscale identity.

### Packaged process entry

- Emit one `dist/service-host.js` module in the top-level private runtime package.
- The module has no shebang, is mode `0644`, is absent from `bin`, and is not in the executable inventory. `codexdeck` remains the only HostDeck bin and executable.
- Import is inert. Direct execution is through the verified absolute Node executable plus the absolute module path; any process argument rejects before config, filesystem, socket, process, or listener access.
- Direct execution resolves only package-relative static assets, canonical config/state/runtime paths, and a canonical Codex executable. It has no checkout/cwd/source-loader fallback.
- Emit exactly one bounded readiness line after selected local readiness. Normal SIGTERM exits zero only after a consistent closed snapshot; startup, failed termination, contradictory state, output failure, or cleanup failure exits nonzero with one generic bounded message.
- Add an exact manifest descriptor for service-host path, package, version, size, SHA-256, and non-executable mode. The dependency-free verifier rejects descriptor/content/mode/path/version drift and a second HostDeck bin/executable.

## Required Evidence

### Deterministic tests

- Foreground behavior remains unchanged, including child argv, process-exit handling, socket ownership, and cleanup.
- Service resource tests cover exact factory input/output, existing/missing/insecure runtime directory, missing/refused/replaced socket, timeout/abort, held lease, database failure, close order, repeated close, and no process/socket mutation.
- Service serve tests cover no process-exit requirement, ready/close snapshots, signal/caller abort, listener/application failure cleanup, app-server disconnect without automatic HostDeck termination, local readiness with remote unavailable, and bounded diagnostics.
- Process-entry tests cover argument rejection before side effects, config/package/Codex preflight, inert import, readiness/output failure, terminal consistency, injected owner rejection, same-port restart, and generic errors.
- Package tests cover deterministic build, exact source/output inventories, descriptor mutations, file/mode/content/bin/executable mutations, read-only relocation, and no TypeScript runtime loader.

### Exact process smoke

Run with the reviewed exact Codex 0.144.0 binary and no model turn:

1. Build and verify the package, copy it to an unrelated read-only location, and add only test-owned static assets.
2. Create a private service runtime directory and start one external `codex app-server` on the selected Unix socket.
3. Start HostDeck A through absolute Node plus `dist/service-host.js`; prove loopback health/static readiness while Tailscale is absent.
4. Stop app-server A, remove/recreate only the test-owned runtime directory as systemd would, and start app-server B. HostDeck A must remain alive and recover local runtime readiness without a second process entry or mutation replay.
5. Stop HostDeck A. App-server B PID and socket must remain alive and usable.
6. Start then stop HostDeck B against app-server B. The same sibling PID/socket must remain alive, the state lease must transfer once, and startup reconciliation must remain truthful.
7. Stop the external app-server owner and verify zero HostDeck/Codex child processes, sockets, listeners, lease holders, temporary paths, model turns, private output, or Tailscale/profile/phone changes.

## Non-Goals

- No systemd unit content, install path, daemon reload, enable/start/stop command, upgrade, uninstall, or clean-machine claim. These remain `IFC-V1-055` to `IFC-V1-058`.
- No second public or hidden CLI command and no environment-selected ownership switch inside `codexdeck serve`.
- No Tailscale daemon ownership, automatic profile switching, public listener, LAN fallback, custom CA, tmux, source TypeScript execution, or phone work.

## Completion Record

- Criteria frozen after tracing the packaged foreground entry, production composition, service-owned supervisor close behavior, restart acceptance worker, package builder, and verifier.
- Implementation and validation evidence: pending.
