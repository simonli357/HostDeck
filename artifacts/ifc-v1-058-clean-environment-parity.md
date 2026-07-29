# IFC-V1-058 Clean Environment Package And Service Parity

## Purpose

Record the clean-source, supported-Ubuntu, toolchain, foreground/service parity, restart, upgrade, uninstall, Tailscale-noninterference, cleanup, and evidence acceptance for the packaged HostDeck host surface. This leaf does not claim aggregate interface hardening, the full release smoke, or a new physical-phone run; those remain `IFC-V1-091`, `REL-V1-006`, and `FE-V1-090`.

## Audited Baseline

- `IFC-V1-052` closes the selected production resource aggregate. `IFC-V1-053` to `IFC-V1-057` and `IFC-V1-086` provide manifest-verified dashboard assets, one compiled command, foreground and service-owned process entries, exact systemd user units, persistent lifecycle, safe uninstall, and active-plus-previous release retention.
- Existing package, executable, user-unit, and lifecycle smokes run from relocated verified packages but use the development checkout, dependency tree, and user manager. They are strong module evidence, not clean-checkout parity.
- The supported release host remains Ubuntu 24.04/Linux x86-64 with Node 22.22.2, pnpm 10.29.2, exact Codex 0.144.0, an unprivileged systemd user manager, and separately installed Tailscale 1.98.8. HostDeck never owns `tailscaled`, a profile switch, or implicit Serve mutation.
- A disposable Ubuntu Noble container probe starts systemd 255 as PID 1, reaches `running`, starts a real UID-1000 user manager, and runs/stops a user unit under cgroup v2. The container is a clean-userspace acceptance substrate, not an independent kernel/VM claim.
- The host Tailscale daemon is reachable through its world-accessible Unix socket and currently has a selected saved profile. Acceptance may expose that socket read-only at the mount boundary for observation, but must compare sanitized profile/Serve identities before and after and must never request a switch or Serve mutation.

## Frozen Substrate And Ownership

| Layer | Exact contract |
| --- | --- |
| Host runner | Linux x86-64, Git, Docker Engine with cgroup v2, and the pinned base-image digest. It snapshots source and Tailscale identity, starts/stops the disposable substrate, bounds output/time, and publishes evidence only after cleanup. |
| Clean OS | Pinned Ubuntu 24.04 image; exact observed image id/digest, `/etc/os-release`, package versions, architecture, systemd version, and container configuration are recorded. No host package tree, `node_modules`, build output, home, user manager, or HostDeck state is reused. |
| Bootstrap root | Installs OS prerequisites, exact Node/pnpm/Codex/Tailscale client versions, starts systemd and the UID-1000 manager, and performs no HostDeck product lifecycle action. Privileged container mode is validation infrastructure only. |
| Ordinary user | Clones the exact committed source into an empty home and alone performs frozen install, build, verify, foreground, service install/start/status/restart/upgrade/stop/uninstall, HTTP inspection, and residue checks. No sudo, root unit, capability, router, firewall, CA, or public bind is permitted. |
| External Tailscale | The host daemon/profile/Serve state is observation-only. Container-local absence of its socket proves degraded remote access without local failure; later read-only socket exposure proves observation and byte-stable host identity without profile or Serve mutation. |

## Frozen Success Criteria

| ID | Required behavior |
| --- | --- |
| `CEP-01` | Add one explicit opt-in `pnpm smoke:clean-environment` entrypoint. Missing Docker, wrong host architecture/cgroup mode, unavailable pinned image, unsupported source state, missing exact prerequisite, occupied task-owned name, timeout, signal, or cleanup failure exits nonzero with a bounded stage and no fallback to the development user, fake manager, alternate image, root product run, or partial success. |
| `CEP-02` | Keep one strict machine-readable acceptance manifest with schema version, pinned Ubuntu digest, platform, Node 22.22.2, pnpm 10.29.2, Codex 0.144.0, Tailscale 1.98.8, expected source/package schema, required commands, bounds, and evidence fields. Parser tests reject missing, extra, duplicate, malformed, mutable-tag-only, unsupported-platform, unsafe-name/path, and version/hash drift. |
| `CEP-03` | Derive one exact committed source identity before startup and clone committed bytes through Git into an empty container home. Reject dirty tracked acceptance inputs, a commit unavailable to the clone, commit mismatch, submodule/LFS requirement, unsafe ownership, pre-existing checkout, or any mounted host `node_modules`, `dist`, package output, XDG state, config, runtime, or pnpm store. Unstaged user artifacts cannot enter the clone or evidence. |
| `CEP-04` | Prove the substrate is the pinned Ubuntu 24.04 linux/amd64 image by digest, systemd is PID 1 and `running`, cgroup v2 is active, UID/GID 1000 has a private empty home and `XDG_RUNTIME_DIR`, and its real user manager and D-Bus are `running`. No mocked `systemctl`, host user bus, host PID namespace, or development-user unit path is accepted. |
| `CEP-05` | Record every root bootstrap command separately from product commands. Root may install pinned prerequisites and start the disposable managers; all source install/build/package/runtime/lifecycle commands execute as UID/GID 1000 with empty supplementary groups, no sudo binary use, no effective/permitted capabilities, and owner-private HOME/XDG paths. Generated HostDeck system and root units must remain absent. |
| `CEP-06` | From the fresh clone run the documented `corepack enable` and `pnpm install --frozen-lockfile` path using Node 22.22.2 and pnpm 10.29.2. Reject lockfile mutation, lifecycle-script drift, install warnings treated as hidden manual repair, unavailable native modules, host store reuse, or an install that succeeds only online after the frozen dependency graph changes. Record sanitized command status/duration and lockfile identity. |
| `CEP-07` | Build two versioned packages from the same clean source through the production builder, verify both independently, and prove deterministic repeated identity for the primary build. Record source/output/entry/web counts and content/manifest/web hashes. After this leaf, the package and verifier expose no `IFC-V1-058` deferral and introduce no clean-environment-only runtime dependency or helper shell. |
| `CEP-08` | Exercise the primary package from an unrelated working directory and read-only relocated tree through its manifest-bound executable and verifier. Runtime may load only emitted JavaScript, declared production dependencies, native binaries, and packaged dashboard assets; source TypeScript, tsx/ts-node loaders, workspace imports, cwd assets, dev server, source Vite output, or host-global HostDeck modules fail the acceptance. |
| `CEP-09` | Before product startup, prove no HostDeck process, socket, listener, unit, enablement, command, manifest, release, database, config, state, runtime, transaction, staging, or temp residue exists in the clean user. Snapshot unrelated failed units and a task sentinel so later checks can prove noninterference. |
| `CEP-10` | Start the primary package directly in foreground mode as UID 1000 with exact Codex and fresh owner-only config/state/runtime. Prove one HostDeck process owns one dedicated app-server child, the private Unix socket, one loopback-only HTTP listener, local live/ready status, exact supported compatibility, selected API status, and the manifest-verified dashboard. Stop it boundedly and prove complete foreground process/socket/listener/lease cleanup. |
| `CEP-11` | Install the same verified primary package through its compiled `codexdeck service install` command. Prove exact owner manifest, immutable release, command/unit/manifest selectors, service environment, modes/uid/link targets, daemon reload, HostDeck-only enablement, and both units initially inactive. No root/system unit, login-shell edit, PATH mutation, source checkout link, or implicit start is allowed. |
| `CEP-12` | Start through the installed command and real user manager. Foreground and service paths must expose the same package version, web manifest/hash and bytes, route inventory, local health/compatibility semantics, state/database contract, loopback port policy, and no-cache/security headers. Differences in process ownership are explicit; behavior must not silently fall back from service to foreground. |
| `CEP-13` | While active, inventory exact unit fragments, enablement, cgroups, PIDs/PPIDs/UIDs, executable arguments, open Unix socket, TCP/TCP6 listeners, files, and effective capabilities. Exactly one HostDeck main process and one Codex app-server launcher tree exist; the socket is owner-only and HTTP is `127.0.0.1` only with no `0.0.0.0`, `::`, LAN, tailnet-IP, privileged, app-server TCP, duplicate, or undeclared listener. |
| `CEP-14` | `codexdeck service restart` replaces only the HostDeck PID/cgroup member, retains the exact Codex PID and socket identity, preserves state/database/sentinels, returns to bounded local readiness, and leaves package/profile/listener ownership coherent. Repeated status is read-only and human/JSON output contains no home, token, socket, private config, raw manager stderr, or source path. |
| `CEP-15` | Restart `hostdeck-codex.service` through the same real user manager and prove HostDeck remains independently alive, the Codex PID/socket identity changes, compatibility/readiness becomes truthfully degraded during loss when observed, and bounded automatic reconnect restores exact supported local readiness without a second HostDeck process, mutation retry, state loss, or manual repair. |
| `CEP-16` | With an exact Tailscale CLI installed but no daemon socket visible, foreground and service local live/ready/API/dashboard behavior remains available, remote state is explicit unavailable/degraded, lifecycle commands remain functional, and no alternate LAN/public/custom-CA path appears. Tailscale absence must not stop Codex, rewrite config, or weaken app authorization. |
| `CEP-17` | Expose the pre-existing host Tailscale socket only for a later observation phase, without switching profiles or enabling/disabling Serve. Compare sanitized hashes of backend/current-profile/profile-list/Serve identity before exposure, after HostDeck observation/restart, and after container teardown. Host and container observations must stay coherent; any mutation, raw secret in output, unrecognized ownership, or company-profile change fails the run and cannot be cleaned up by guessing. |
| `CEP-18` | While service mode is active, upgrade to the second verified package through the compiled command. Prove the selector/manifest/package/status move together, HostDeck restarts, Codex PID/socket and state/database/sentinels survive, the dashboard/API use the new package, exactly active plus immediate-previous releases remain, and no source/runtime/package-manager path is introduced. |
| `CEP-19` | Exercise idempotent install/start/status/stop and inactive start again around the clean run. Unchanged actions report `changed: false` without manager, selector, release, state, profile, or Serve mutation. Invalid lifecycle ordering or package identity fails loudly and never reports a coherent installed/running result from partial state. |
| `CEP-20` | Uninstall the active upgraded service through the compiled installed command. Prove HostDeck-before-Codex stop, disable, exact anchor/environment/release removal, daemon reload, inactive/zero-PID/not-found units, absent process/socket/listener/lease/transaction/staging residue, and retention of only the lifecycle root/lock. Preserve state/database/config/Codex and unrelated-unit sentinels byte-for-byte. |
| `CEP-21` | Repeat uninstall from the verified package and require truthful unchanged `not_installed` output with no manager/filesystem/Tailscale mutation. Final inventory contains no installed command, stable anchors, releases, unit fragments, enablement, API listener, process, socket, temporary clone output outside the task root, or root-owned HostDeck artifact; only documented preserved user data and lifecycle coordination remain until the disposable home is removed. |
| `CEP-22` | Bound every host/container command, readiness poll, output buffer, HTTP body, file/process/listener walk, and teardown. Signal and stage failures still stop HostDeck units/processes, terminate the container, remove task-owned transient resources, compare host Tailscale state, and report both primary and cleanup failures. No broad catch, ignored cleanup error, retry-until-green loop, Docker host-network mode, or kill of an unproven process is allowed. |
| `CEP-23` | Direct tests cover manifest validation, command construction without shell interpolation, source/commit and image identity, UID/capability/root separation, timeout/output/redaction, host Tailscale snapshot comparison, evidence schema, failure cleanup, and exact success parsing. The real acceptance runs once without in-place retry; focused/package/lifecycle plus complete workspace/static/supply-chain/browser regressions pass after implementation. |
| `CEP-24` | Publish a sanitized commit-bound artifact only after success and complete cleanup. It records criteria/implementation/evidence/closure commits, host and image identities, exact OS/tool versions, clean-clone proof, command stages/durations, package hashes/counts, foreground/service parity, unit/process/socket/listener/file observations, restart/upgrade/uninstall outcomes, Tailscale identity hashes, preserved/removed inventories, regressions, and explicit Docker-userspace/phone/release limits without auth, tokens, raw profile JSON, source-private paths, or false release readiness. |

## Implementation And Result

1. One strict schema-1 manifest, parser, Dockerfile renderer, bounded host runner, and ordinary-user acceptance driver own the complete run.
2. The host runner bundles the exact committed source, starts the pinned Noble systemd substrate, snapshots host Tailscale identity, and publishes evidence only after teardown.
3. UID/GID 1000 alone performs the frozen install, two deterministic builds, package verification, foreground execution, service lifecycle, active upgrade, retention, and uninstall.
4. The package has no clean-environment deferral. Invalid configuration, lifecycle order, package identity, privacy, or cleanup remains terminal.

## Acceptance Evidence

| Area | Result |
| --- | --- |
| Authoritative run | One no-retry `pnpm smoke:clean-environment` run passed from source commit `eb77647e8b1e77e42b16fef21b65da0d1b65ea8e`; sanitized evidence is `artifacts/ifc-v1-058-clean-environment-parity/evidence.json`. |
| Substrate/toolchain | Pinned Ubuntu 24.04 digest, systemd 255, private cgroup/PID namespaces, real UID-1000 user manager, Node 22.22.2, pnpm 10.29.2, Codex 0.144.0, and Tailscale 1.98.8 passed. Root performed bootstrap only; product processes had UID 1000 and zero capabilities. |
| Package | Two deterministic builds each contained 619 sources, 1,245 outputs, 6,466 verified entries, and three dashboard files. Independent verification, immutable relocation, manifest/content/web identity, and source/runtime isolation passed. |
| Runtime/lifecycle | Foreground and real systemd user-service paths matched HTTP, dashboard, compatibility, process, socket, and listener truth. Independent HostDeck/Codex restarts, app-server-loss recovery, active upgrade, two-release retention, active uninstall, repeated uninstall, and invalid pre-install ordering passed. |
| Tailscale/cleanup | Local operation passed with no daemon socket. Later read-only host-socket observation left the profile/Serve identity hash unchanged. No test container, image, process, listener, runtime, installed command, unit, or Serve configuration remained. |
| Aggregate regressions | Direct clean contract 11; package direct 41 plus deterministic package acceptance; unit 2,880/28 intentional external skips; contract 245; integration 36; web 920; shell Chromium 168; relocated packaged Chromium 1; supported Chromium/Firefox phone/desktop 76. Root/eight-package typechecks, lint/exports over 809 files, scaffold, planning, 619-module runtime boundary, frozen offline install, zero-vulnerability production audit, and 172-record permissive license inventory passed. |
| Limits | Docker shares the host kernel; no independent VM/kernel, new physical-phone run, aggregate interface hardening, or release readiness is claimed. The host-default Codex 0.145.0 remains ineligible for exact-runtime evidence; the clean run used exact 0.144.0. |

## Manual Inspection

- Inspect the image config, PID-1/user-manager state, root bootstrap transcript, UID/capability evidence, and exact committed clone before accepting "clean Ubuntu user."
- Compare foreground and service HTTP/dashboard identity, process trees, unit fragments, cgroups, socket modes, listeners, and state/database identities.
- Review restart and upgrade chronology for independent ownership, bounded degraded truth, recovery, retention, and no duplicate process or mutation retry.
- Compare pre/post host Tailscale identity hashes and inspect every runner/product argument for profile-switch or Serve mutation verbs.
- Inspect uninstall and final container/host residue, sanitized output, evidence schema, and failure cleanup; do not treat Docker userspace as a physical-phone or independent-kernel release pass.

## Remaining Boundary

- The proven substrate reuses the host kernel and Docker daemon. `REL-V1-006` still owns the full release smoke and real packaged phone workflow.
- `IFC-V1-091` still owns aggregate production interface hardening, and `FE-V1-090` still owns complete physical-device mobile hardening.

## Commit Record

- Criteria: `2aa21e9`.
- Harness and production corrections: `d070796` through `eb77647`.
- Authoritative clean evidence source: `eb77647`.
- Supported-browser package repin and aggregate evidence: `eda62ae`.
- Owner-doc closure: pending this closure commit.
