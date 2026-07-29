# IFC-V1-056 Service Lifecycle And Install

## Purpose

Freeze the persistent, unprivileged HostDeck installation and service-lifecycle contract before implementation. This task owns install, upgrade, status, start, stop, and HostDeck-only restart. Safe uninstall and retained-release cleanup remain `IFC-V1-057`; clean-machine parity remains `IFC-V1-058`.

## Audited Baseline

- The production package is a dependency-free-verifiable schema-4 tree with one `codexdeck` executable, one non-executable service host, real Vite assets, exact runtime identity, and current downstream deferrals `IFC-V1-056` to `IFC-V1-058`.
- `IFC-V1-055` supplies a pure schema-1 generator for exactly `hostdeck-codex.service` and `hostdeck.service`. It intentionally writes no persistent files and contacts no manager.
- The accepted process topology keeps Codex independently service-owned. Starting HostDeck may pull Codex in; stopping the complete HostDeck product stops both exact units; restarting HostDeck must not restart Codex.
- Systemd `active` proves process setup, not application readiness. The selected loopback host-status API remains the only application-readiness authority.
- The current CLI grammar already reserves the exact lifecycle commands and rejects malformed input before side effects. `service uninstall` must remain explicit non-success until `IFC-V1-057`.

## Frozen Installed Layout

All paths are per-user and derived without root privileges. `$XDG_DATA_HOME` defaults to `$HOME/.local/share`; `$XDG_CONFIG_HOME` defaults to `$HOME/.config`.

| Owned path | Type and mode | Purpose |
| --- | --- | --- |
| `$XDG_DATA_HOME/hostdeck/` | directory `0700` | Lifecycle ownership root. |
| `$XDG_DATA_HOME/hostdeck/lifecycle.lock` | regular file `0600` | Nonblocking advisory lifecycle-operation lock. |
| `$XDG_DATA_HOME/hostdeck/releases/<version>-<manifest-sha256>/` | directory `0700` | One immutable-identity retained release. |
| `.../package/` | verified package tree | Byte-for-byte verifier-approved production package. |
| `.../units/{hostdeck-codex,hostdeck}.service` | regular files `0644` | Exact generated unit descriptors for that release. |
| `.../install.json` | regular file `0600` | Strict owner manifest for that release and all stable anchors. |
| `$XDG_DATA_HOME/hostdeck/current` | relative symbolic link | Atomic active-release selector. |
| `$XDG_DATA_HOME/hostdeck/install.json` | symbolic link through `current` | Stable owner-manifest locator. |
| `$XDG_CONFIG_HOME/hostdeck/service.env` | regular file `0600` | Installer-owned, non-secret service environment. |
| `$XDG_CONFIG_HOME/systemd/user/{hostdeck-codex,hostdeck}.service` | symbolic links through `current` | Stable persistent unit anchors. |
| `$HOME/.local/bin/codexdeck` | symbolic link through `current` | Installed command anchor; no wrapper or second executable. |

The active selector is the only release pointer changed by upgrade. Unit, command, and manifest anchors all traverse that selector, so one atomic symlink replacement changes their release together. Systemd enablement may create only the expected `default.target.wants/hostdeck.service` link. Every stable anchor and expected enablement link is declared in the owner manifest.

## Owner Manifest

- Use exact schema version 1 and a timestamp-free canonical JSON encoding with a self-hash. Reject accessors, extra/missing fields, duplicate keys, unsupported schema, unbounded values, unsafe path components, and identity mismatch.
- Bind package version, package-manifest SHA-256, package-content SHA-256, release id, package-relative root, exact Node and Codex executable identities, both generated unit names/modes/hashes, environment-file mode/hash, active-selector target, stable anchor paths/targets, enabled unit, and manifest identity.
- Paths required for later uninstall are retained only in the owner-only manifest. Status and lifecycle output must not disclose home, package, executable, config, state, database, socket, or environment paths.
- Treat the environment file and stable anchors as installer-owned. A foreign, substituted, hard-linked, wrong-mode, or content-drifted owned regular file is not repaired or overwritten; mutation refuses with bounded recovery guidance.
- A release directory is append-only after publication. Upgrade creates a new release and retains the prior release for rollback and `IFC-V1-057` cleanup.

## Environment Contract

- Persist only a sorted allowlist needed for service parity: `HOME`, `PATH`, `HOSTDECK_PORT`, `HOSTDECK_STATE_DIR`, `HOSTDECK_DATABASE_PATH`, and present non-empty `CODEX_HOME`, `XDG_CONFIG_HOME`, or `XDG_STATE_HOME` values.
- Resolve and validate the selected loopback port plus canonical state/database paths before mutation. Preserve the resulting environment file byte-for-byte on upgrade.
- Reject controls, newlines, NUL, unbounded values, relative/empty required paths, unsafe `PATH`, unsupported variables, and duplicate keys. Encode systemd environment values without shell evaluation.
- Never write raw auth, pairing, CSRF, Tailscale, API, model-provider, or Codex account secrets. Never place `HOSTDECK_CODEX_BIN` or `XDG_RUNTIME_DIR` in the file; the unit and user manager own those values respectively.

## Frozen Success Criteria

| ID | Required behavior |
| --- | --- |
| `SLC-01` | Before mutation, require Linux, the current unprivileged user, a canonical executable Node matching package runtime identity, a canonical supported Codex executable, absolute bounded XDG/home inputs, and an available exact `systemctl --user` adapter. No `sudo`, root, system unit, or alternate init path exists. |
| `SLC-02` | Fully verify the source package before any owned write, parse only schema-4 identity, and bind version/content/manifest/command/service-host facts. A source mutation, wrong runtime, wrong deferral/schema, link escape, or verifier failure causes zero manager mutation and no active-release change. |
| `SLC-03` | Inspect every existing ancestor and target with no-follow semantics. Reject foreign ownership, group/other-writable parents, symlinked ownership roots, hard-linked regular files, wrong types/modes, traversal, controls, noncanonical executable inputs, and path substitution before destructive or replacing operations. |
| `SLC-04` | Implement exactly the frozen layout above. Create directories/files with explicit modes under `umask 0077`; fsync completed files and containing directories before publication. No checkout, cwd, package-store, source TypeScript, temporary-home, or private build path enters installed content. |
| `SLC-05` | Generate and strictly validate the schema-1 owner manifest. It must account for every persistent path this task creates or enables and bind every release, unit, command-anchor, environment, and executable identity needed by status, rollback, upgrade, and later uninstall. |
| `SLC-06` | Create the exact non-secret allowlisted environment file on first install. Existing foreign or drifted content refuses installation; exact owned content is idempotent. Upgrade never rewrites it and never mutates user config, state, database, Codex home, or Tailscale state. |
| `SLC-07` | Serialize install, upgrade, start, stop, and restart with one nonblocking advisory lock. Contention returns deterministic non-success without waiting indefinitely. Status is read-only and may run concurrently from one frozen observation. Every lock and descriptor closes on success, failure, abort, and repeated invocation. |
| `SLC-08` | Copy into a same-filesystem staging release without dereferencing links, normalize only required container modes, fully verify the staged package, generate/verify both unit files against that staged package, write/verify the manifest, then atomically rename the complete release. Failure before publication removes only task-owned staging. |
| `SLC-09` | Create stable links only when absent or already exact and owned. Any foreign file/link, wrong target, dangling substitution outside the frozen layout, modified enabled link, or pre-existing HostDeck unit collision refuses replacement. No broad repair or arbitrary user-unit edit is allowed. |
| `SLC-10` | Use a bounded owner-only write-ahead transaction record for selector/manager transitions. On the next mutation, deterministically finish safe pre-publication cleanup or roll back to the manifest-bound prior selector before new work. If neither side verifies, refuse all mutation as `recovery_required`; status reports that truth without guessing. |
| `SLC-11` | `service install` publishes one verified release, stable anchors, and owner manifest; runs exact daemon reload; enables only `hostdeck.service` without `--now`; and leaves both units stopped. It reports success only after exact unit/enablement read-back. Failure compensates manager changes and restores the pre-install selector/anchors where possible. |
| `SLC-12` | Repeating install for the exact package, environment, manifest, anchors, and enablement is a strict idempotent success with no package recopy, selector churn, service start/restart, or state/config change. Same version with different content, a downgrade, or install over a different active version is rejected with an explicit instruction to use upgrade. |
| `SLC-13` | `service upgrade` requires a coherent existing schema-1 installation, a strictly newer semantic version, and a fully verified new release. It preserves the environment, config, state/database, enabled state, remote configuration, and prior release. Exact same release is idempotent; same-version drift and downgrade reject. |
| `SLC-14` | Upgrade atomically switches only `current`, reloads the manager, and leaves an inactive installation inactive. If HostDeck was active, restart only `hostdeck.service`, preserve the running Codex PID/socket, and require bounded API readiness. On reload/restart/readiness failure, restore the prior selector, reload, and restore prior HostDeck readiness; report whether rollback succeeded. |
| `SLC-15` | The manager adapter spawns canonical `systemctl` directly with fixed `--user --no-pager` arguments, no shell/environment interpolation, bounded stdout/stderr, deadline and abort handling, forced cleanup, and sanitized stage/code failures. No mutation retries. Exact unit names are constants and user input never reaches argv. |
| `SLC-16` | `service start` validates the coherent installation, starts only `hostdeck.service`, waits for both required unit states, then probes the selected loopback host-status API until bounded ready or terminal failure. Already-ready start is idempotent. Active-but-not-ready is explicit non-success and is not mislabeled ready or automatically stopped. |
| `SLC-17` | `service stop` stops `hostdeck.service` and then `hostdeck-codex.service`, waits until both are inactive with zero main PID, and succeeds idempotently when already stopped. It does not disable units, remove runtime/state, kill foreign processes, or infer completion from one unit. |
| `SLC-18` | `service restart` restarts only `hostdeck.service`, starts it if inactive, and requires the same bounded manager/API postcondition as start. When Codex was active, its PID and private socket identity must survive; no Codex stop/restart command is issued. |
| `SLC-19` | `service status` performs no write, lock acquisition, daemon reload, enablement, start, or repair. It distinguishes not-installed, coherent, partial, corrupt, and recovery-required install state; enabled/load/active/sub/main-PID/daemon-reload truth for both exact units; and API not-probed/unreachable/not-ready/ready truth. `active` alone never sets ready. |
| `SLC-20` | Human and `--json` lifecycle output use one exact bounded contract, deterministic ordering, terminal escaping, and stable exit families. Include release version/id, install health, enabled state, unit state, API readiness, and rollback truth; omit raw command output, causes, environment, secrets, private paths, profile/account identity, and Serve details. |
| `SLC-21` | Preserve user-owned `config.json`, SQLite main/WAL/SHM data, audit/auth/session state, Codex home, and selected remote-ingress state byte-for-byte across install failure, repeated install, lifecycle commands, successful upgrade, failed upgrade, and rollback. This task never migrates or deletes those paths itself. |
| `SLC-22` | Never invoke or mutate Tailscale, profiles, Serve, DNS, firewall, certificates, browser/phone/ADB state, system services, login lingering, or router/network configuration. Tailscale unavailable or on another profile cannot block local install/start/readiness except through separately reported remote health. |
| `SLC-23` | Temporary-home tests cover exact install and every command; malformed manifests/environment/manager output; hostile links/types/modes/owners; package drift; every transaction failure point; lock contention; abort/timeout/oversize; idempotence; active/inactive upgrade; rollback success/failure; read-only status; privacy; and zero leaked handles/processes/staging paths. |
| `SLC-24` | Real user-manager evidence uses a relocated verified package and exact supported Codex: install/enable without start, start/readiness, status, repeated operations, HostDeck-only restart with stable Codex identity, full stop, inactive and active upgrade fixtures, injected rollback, same-user process/listener/file inspection, and cleanup that preserves the pre-existing failed-unit set and all Tailscale state. Full package/workspace/planning/static/supply-chain gates pass. |

## Command Outcomes

- `install`: installed and enabled, deliberately stopped.
- `upgrade`: upgraded and either still stopped or restored to ready according to the pre-upgrade HostDeck state.
- `status`: truthful observation; coherent `not_installed` is not treated as corruption.
- `start`: both units active and local API ready.
- `stop`: both units inactive.
- `restart`: HostDeck replaced and locally ready; an already-active Codex owner is unchanged.
- `uninstall`: `capability_unavailable` with zero lifecycle/filesystem/manager mutation until `IFC-V1-057`.

## Non-Goals

- Removing stable anchors, releases, environment, or enablement is `IFC-V1-057`.
- Clean Ubuntu checkout/install/uninstall parity is `IFC-V1-058`.
- Automatic Tailscale install, profile switching, Serve repair, public ingress, custom certificates, root services, and login lingering are not V1 lifecycle behavior.
- Package retention limits and old-release garbage collection are not implemented in this leaf; prior releases remain available for rollback.

## Evidence To Record

- Criteria, implementation, hardening, and closure commit ids.
- Exact focused and aggregate test counts plus failure-injection stage inventory.
- Installed owner-manifest/package/unit hashes and manager/API state transitions using redacted paths.
- Real manager process/socket/listener, Codex continuity, rollback, Tailscale noninterference, and residue results.
- Remaining `IFC-V1-057`, `IFC-V1-058`, and release-readiness limits without a clean-machine or release claim.

## Implemented Surface

- `codexdeck service install|upgrade|status|start|stop|restart` now dispatches through one strict lifecycle owner. `uninstall` remains a side-effect-free `capability_unavailable` result owned by `IFC-V1-057`.
- Schema-1 install manifests bind immutable verified releases, generated units, the preserved service environment, exact Node/Codex identities, stable anchors, enablement, and the atomic `current` selector.
- Install and upgrade use a nonblocking advisory lock, same-filesystem staged publication, a bounded write-ahead transaction, exact manager read-back, active/inactive upgrade paths, and rollback to the prior verified selector.
- The direct user-manager adapter executes canonical `systemctl` without a shell under a fixed minimal environment, bounded output/deadlines, process-group cleanup, strict result parsing, and fixed HostDeck unit names.
- Start, stop, restart, and status validate installation and manager identity before action. Readiness comes from the loopback host-status API; HostDeck restart preserves an already-running Codex PID and socket.
- The package builder supports isolated versioned fixtures for the real upgrade/rollback smoke while preserving ordinary deterministic package behavior. Package metadata now defers only uninstall and clean-machine parity to `IFC-V1-057` and `IFC-V1-058`.

## Hardening Findings Closed

- Real systemd reports linked generated units as `linked`, not the fake manager's earlier `static` assumption. The parser and postconditions now require the real state.
- `systemctl stop` can return before a unit leaves `deactivating`. Stop now requires bounded consecutive inactive/zero-PID observations instead of trusting one snapshot.
- Lifecycle mutations now reject manager identity drift before start, stop, or restart and re-check exact active/inactive, PID, API-readiness, selector, and rollback postconditions after each transition.
- Semantic-version comparison handles prerelease precedence without unsafe numeric coercion. Manifests and manager records reject accessors, extras, unsafe overlap, oversized values, and insecure ancestors.
- Package verification and manager execution reject stderr-on-success, malformed UTF-8, aggregate output overflow, timeout/abort leaks, and descendants that outlive the bounded process group.
- Active and inactive upgrade paths preserve config, SQLite sidecars, runtime identity, Codex continuity, Tailscale profile/Serve state, enabled state, and the prior release needed for rollback.

## Validation Evidence

| Gate | Result |
| --- | --- |
| Focused lifecycle | 49 tests pass across manifest, lock, lifecycle, package verifier, direct manager, manager contract, and generated-unit suites. |
| Workspace | Unit: 2,856 passed/28 intentional skips; contract: 245; explicit CLI contract: 12; integration: 36; web: 920. Root/package typechecks and lint/exports pass. |
| Static planning/boundary | Scaffold: 8 packages/21 scripts; planning: 220 tasks/84 requirements/683 dependencies; runtime boundary: 619 production modules/22 externals. |
| Package | Two deterministic builds, relocation/read-only acceptance, verifier negatives, packaged browser smoke, and 6,466-entry package acceptance pass. The three-file web identity remains SHA-256 `09c04fc54c8d88ded7dff55f54e8228fc65e6eb01e851a65674bf920a3461752`. |
| Runtime binding | Isolated exact Codex 0.144.0 passes 671-file binding SHA-256 `e1a1a5cff3ab91862f9215dd06538eae1ea0b00bae48cbb7d87061faaee27e24`; the host-default 0.145.0 binary is correctly rejected as unsupported evidence. |
| Real user manager | Two consecutive full lifecycle runs pass actual install/idempotence/start/status/restart/stop, inactive and active upgrades, injected real-manager rollback, stable Codex PID/socket, private output, and exact unit/enablement read-back. The lower-level user-unit smoke remains 9.7/9.7 under `systemd-analyze security`. |
| Noninterference and cleanup | Config/state/database/Codex sentinels, stable Tailscale backend/tailnet/profile/Serve identity, and the pre-existing failed-unit set remain unchanged. Both exact units finish `not-found`; no owned install, runtime, process, listener, transaction, staging, or temporary-home residue remains. |
| Supply chain and source hygiene | Frozen offline install, production audit with zero known vulnerabilities, production-license inventory, diff check, and protected pre-existing mockup byte comparison pass. |

## Closure

- `SLC-01` to `SLC-24` are satisfied for the supported current-user Linux/systemd environment.
- This does not claim safe uninstall, clean-machine parity, release readiness, or store/device deployment. Those remain owned by `IFC-V1-057`, `IFC-V1-058`, and release tasks.
- Criteria commit: `8ff639b`. Implementation and hardening commit: `c9845c3`. The task-closing documentation commit is recorded in a follow-up traceability entry after its id exists.
