# IFC-V1-055 Systemd User Units

## Purpose

Freeze and prove the exact unprivileged two-unit topology before service installation, lifecycle commands, or clean-machine parity.

## Audited Baseline

- Target baseline: Ubuntu systemd 255.4 (`255.4-1ubuntu8.16`) with a reachable user manager.
- The current user manager is already `degraded` only because the unrelated `update-notifier-crash.path` is failed. A uniquely named transient `Type=oneshot` probe completed successfully and was collected; task evidence must preserve the pre-existing failed-unit set rather than hiding or repairing it.
- No `hostdeck*.service` unit, loaded HostDeck unit, or `/run/user/1000/hostdeck` runtime path existed at audit time.
- The package exposes one executable `codexdeck` foreground command and one non-executable `dist/service-host.js`. The service unit must invoke the latter through Node and must not invoke `codexdeck serve`.

## Generator Contract

- Add one pure production generator under `@hostdeck/cli`. It accepts an exact plain object containing canonical absolute Node, Codex, package-root, optional-environment-file, and expected-package-version inputs.
- Node and Codex must be current-user-accessible canonical regular executable files. The package root must be a canonical directory containing schema-3 package identity and the exact manifest-bound mode-`0644` service-host content for the expected version.
- The optional environment-file path must be canonical and absolute. The generator emits it with the systemd `-` prefix so absence is allowed; `IFC-V1-056` owns creation, mode, reserved-variable validation, and updates. It may contain non-secret configuration but must not override `HOSTDECK_CODEX_BIN` or `XDG_RUNTIME_DIR`.
- Reject accessors, extra/missing fields, control characters, traversal, symlinks, wrong owner/type/mode/version/hash, unsafe executable state, and systemd injection before output. Errors expose only bounded code/stage truth, never input paths or environment values.
- Support valid spaces, quotes, backslashes, percent specifiers, and dollar signs through one tested systemd word encoder. Every emitted unit must parse under the supported systemd baseline.
- Return one deeply frozen, deterministic versioned bundle containing exactly two mode-`0644` descriptors in this order: `hostdeck-codex.service`, then `hostdeck.service`. Each descriptor binds name, content bytes, SHA-256, and mode. Generation performs no write, process, manager, socket, Tailscale, or network mutation.

## Frozen Unit Policy

Both files begin with one generated-version comment, end with one newline, and use only the directives below. Numeric policy is fixed: `StartLimitIntervalSec=60s`, `StartLimitBurst=5`, `Restart=always`, `RestartSec=2s`, `TimeoutStartSec=90s`, `TimeoutStopSec=30s`, `KillMode=control-group`, `UMask=0077`, and journal stdout/stderr.

### `hostdeck-codex.service`

- `[Unit]`: versioned description and start-limit policy only. It has no dependency on HostDeck, Tailscale, a network target, or a system service.
- `[Service]`: `Type=exec`, `WorkingDirectory=%h`, optional `EnvironmentFile`, fixed runtime/log/restart/timeout policy, `RuntimeDirectory=hostdeck`, and `RuntimeDirectoryMode=0700`.
- `ExecStart` is exactly the canonical Codex executable plus `app-server --listen unix://%t/hostdeck/app-server.sock`; no shell, wrapper, alternate transport, or extra argument exists.
- It has no `[Install]` section. It is a static dependency owned through `hostdeck.service`, but remains directly startable/restartable for recovery and testing.

### `hostdeck.service`

- `[Unit]`: versioned description, `Wants=hostdeck-codex.service`, `After=hostdeck-codex.service`, and start-limit policy. It must not contain `Requires=`, `Requisite=`, `BindsTo=`, `PartOf=`, `Upholds=`, or stop/restart propagation.
- `[Service]`: `Type=exec`, `WorkingDirectory=%h`, optional `EnvironmentFile`, exact `Environment=HOSTDECK_CODEX_BIN=<canonical Codex>`, fixed log/restart/timeout policy, and no runtime-directory ownership.
- `ExecStart` is exactly canonical Node plus the manifest-verified absolute `dist/service-host.js` path. There is no shell, second command, command grammar, foreground fallback, or source loader.
- `[Install]` contains only `WantedBy=default.target`. No root/system scope, `User=`, `Group=`, `sudo`, `tailscaled`, public listener, TLS, LAN, custom-CA, or profile-switch directive exists.

`Type=exec` reports successful process setup, not HostDeck application readiness. The selected loopback health endpoint remains the readiness authority. Explicit `systemctl --user stop` suppresses `Restart=always`; unexpected clean or failed exits restart within the fixed start limit.

## Required Evidence

### Deterministic and parser evidence

- Exact snapshots and SHA-256 repeatability for both units, including a package/path fixture requiring systemd quoting and specifier escaping.
- Hostile input matrices for object shape, path bounds/canonicality, owner/type/mode/executable state, package schema/version/service-host identity, environment-file path, and attempted line/specifier/argument injection.
- Structural assertions for exact sections/directives/order, one `ExecStart` per unit, one HostDeck runtime-directory owner, exact weak dependency direction, no propagation/root/Tailscale/shell/source-loader tokens, and no extra HostDeck executable.
- `systemd-analyze verify --user` on both generated files and `systemd-analyze security --user` inspection. Security findings must distinguish the intentional same-user Codex project/command authority from accidental root, capability, public-network, or filesystem ownership.

### Real user-manager smoke

- Use runtime-only linked exact unit names after refusing any pre-existing HostDeck unit/runtime collision. Snapshot the pre-existing failed-unit set and preserve it exactly.
- Run a read-only relocated package with test-owned assets/config/state, exact Codex 0.144.0, a private `PATH` without Tailscale, one dynamic loopback port, and no model turn.
- Starting `hostdeck.service` must pull in Codex, create a current-user `0700` runtime directory and `0600` socket, then reach local health/static readiness. Repeated start must not duplicate either process.
- Restart HostDeck and prove Codex PID/socket identity survives. Restart Codex and prove HostDeck PID survives while local readiness recovers against the replacement socket.
- Stop Codex and prove HostDeck remains active/live but not runtime-ready; start Codex and prove readiness recovers without a HostDeck restart. Stop HostDeck and prove Codex remains active with its socket usable.
- A concurrent manual foreground owner using the same state must fail through the shared lease before runtime mutation and leave both unit PIDs/socket/listener unchanged.
- Cleanup must stop both exact units, remove runtime links/unit state/runtime directory/socket/listener/lease ownership/temp paths, preserve the original failed-unit set, and leave Tailscale/profile/Serve/browser/ADB/phone state untouched.

## Non-Goals

- No persistent unit installation, environment-file write, daemon enablement, lifecycle CLI dispatch, upgrade, rollback, status command, uninstall, or clean Ubuntu claim. These remain `IFC-V1-056` to `IFC-V1-058`.
- No real dashboard asset claim, system service, privileged helper, automatic Tailscale profile selection, or security sandbox that would silently remove required Codex development capabilities.

## Completion Record

- Criteria frozen from the accepted service-host/package boundary, systemd 255.4 local manuals/parser, current user-manager audit, and a collected transient execution probe.
- Implementation and validation evidence: pending.
