# IFC-V1-054 Executable Production Audit

## Scope

- Target: runnable packaged `codexdeck`, complete required CLI surface, and selected foreground `serve` composition.
- Refs: `BLK-V1-04`, `FR-011`, `PR-009`, `PR-012`, `DEC-027`.
- Audit date: 2026-07-20.
- Current package input: completed `IFC-V1-021` deterministic six-package compiled runtime.

## Current Truth

- `packages/cli/src/parser.ts` has no `serve`, `status`, `list`, `devices`, `revoke`, or `service` command.
- The source CLI has 15 bounded client factories and 23 public operations. It does not call selected manifest routes `host_status`, `session_list`, `device_list`, or `device_revoke`.
- `packages/cli/src/shell.ts` exports a source-level `main`, but no production entry file invokes it.
- The compiled package deliberately has no HostDeck `bin`, executable file, generated command shim, or executable identity in its verifier manifest.
- The accepted 22-registration/35-route factory has no non-test production caller.
- No production composition root currently joins secure paths and lease, migrated SQLite, exact Codex supervision/reconnect, runtime controls, projection/SSE, selected routes, static boundary, remote lifecycle, or application shutdown.
- Real web assets, systemd user units, install/upgrade/uninstall, and clean-machine parity remain separate downstream owners.

## Granularity Correction

The prior `IFC-V1-054` row combined independently verifiable outcomes and was not a valid leaf task. Execution is now ordered as:

| Task | Single outcome |
| --- | --- |
| `IFC-V1-080` | Complete required parser/client/render/source-dispatch contracts. |
| `IFC-V1-081` | Own secure foreground resource bootstrap and rollback. |
| `IFC-V1-082` | Compose the real selected application graph over bootstrapped resources. |
| `IFC-V1-083` | Run and drain the foreground Fastify/Tailscale lifecycle. |
| `IFC-V1-054` | Integrate the compiled process entry and package/bin invocation. |

## Cluster Success Criteria

### Command Contract

- Parse every `FR-011` top-level command and required subcommand before reading config, touching files, opening a socket, spawning a process, or invoking a client.
- Add bounded clients for host status, session list, device list, and confirmed device revoke through the existing direct-loopback transport and shared response/error reader.
- Keep `model`, `goal`, and `plan` as first-class commands and preserve all accepted operation commands and stable exit/output bounds.
- Reject duplicate/conflicting options, missing confirmations, unknown commands, unsupported `lan`, option injection, and extra arguments with usage failure and zero side effects.
- `help` and `version` work with an empty environment, inaccessible cwd/config/state paths, and an unavailable daemon.
- Service lifecycle syntax is reserved exactly for `IFC-V1-056`; before that owner lands, dispatch is explicit non-success with no `systemctl` or filesystem mutation.

### Foreground Bootstrap

- Resolve one frozen resource budget and all config/state/runtime/database/Codex inputs before owned mutation.
- Require Linux, an absolute secure runtime parent, loopback-only bind, an in-state database, and an absolute executable exact-Codex candidate.
- Acquire the state lease before config/runtime/database/listener/socket/Codex mutation, then prepare owner-only paths, migrate SQLite, and start only one foreground-owned app-server socket.
- Held lease, insecure/substituted paths, invalid config, missing/wrong Codex, migration failure, startup abort, and repeated start fail loudly and rollback every resource already acquired.
- Cleanup is idempotent, reverse ordered, deadline bounded, and never kills a service-owned or foreign process.

### Application Composition

- Build every production repository, trust/security policy, selected control service, projection append/fanout/replay/subscriber path, runtime reconciliation controller, remote lifecycle, host health source, and route registration with real ports rather than test stubs.
- Start exact compatibility and durable reconciliation before mutation admission or listener readiness; retained uncertainty remains stale/interrupted rather than inferred ready.
- Register the exact selected 22 registrations/35 API and SSE routes once plus one validated static registration. No tmux, raw shell, direct-LAN TLS, certificate, private-IP bind, or historical listener path is reachable.
- Missing or invalid built assets fail before listener publication. A test-owned external asset fixture may validate this cluster until `IFC-V1-053` supplies package assets; this is not a real-dashboard claim.
- Tailscale observation begins only after local listen, remains independently degradable, and never switches a profile or mutates Serve without explicit local `remote enable`/`disable`.

### Foreground Lifecycle

- `serve` starts one IPv4 loopback listener at the validated configured port only after lease, storage, exact runtime compatibility, reconciliation, routes, and static inventory are ready.
- Shutdown synchronously closes mutation admission, refuses listener work, drains subscribers/approvals/reconnect/writes/audit/projection/runtime, closes storage, and releases the lease last.
- SIGINT/SIGTERM, app-server exit, listener bind failure, runtime disconnect, Tailscale absence, close-stage failure, repeated close, and same-port restart preserve explicit health and complete cleanup.
- Diagnostics are bounded and secret-free; no config content, token, prompt, transcript, Tailscale account/profile identity, private path, or raw child stderr reaches normal CLI output.

### Executable And Package

- The emitted CLI manifest declares exactly one `codexdeck` bin targeting compiled JavaScript with a shebang and executable mode; source TypeScript and runtime loaders remain absent.
- Local path invocation, package-manager invocation, a packed temporary install, and a temporary global-style install all run from unrelated cwd/read-only package content.
- `--help`, `help`, `--version`, and `version` return stable bounded output and the exact package version without loading config or contacting the daemon.
- Package identity and the dependency-free verifier cover the executable path, mode, content, and manifest metadata; missing, modified, non-executable, escaping, or source-targeted bins fail verification.
- Failed builds preserve the prior package. Repeated builds remain deterministic and leave no staging, process, listener, socket, database, or temporary install residue.

## Explicit Deferrals

- Real Vite assets and browser rendering: `IFC-V1-053`.
- Generated systemd user units: `IFC-V1-055`.
- Install/upgrade/start/stop/restart/status lifecycle implementation: `IFC-V1-056`.
- Uninstall and version cleanup: `IFC-V1-057`.
- Clean Ubuntu foreground/service parity and release use: `IFC-V1-058` and release tasks.
- Physical phone validation is not evidence for this cluster and is not required while these laptop-side leaves are active.

## Required Evidence

- Focused parser/client/render and no-side-effect tests.
- Bootstrap rollback/ownership/path/runtime tests using real Linux files, flock, SQLite, sockets, and child processes.
- Exact-Codex no-model foreground lifecycle with selected route/static fixture, local HTTP checks, signal shutdown, restart, and residue inspection.
- Two-build package determinism, verifier negatives, packed/local/global-style invocation, unrelated-cwd/read-only execution, and command matrix.
- Root/package typechecks, lint/exports, unit, contract, integration, web, scaffold, planning, runtime-boundary, frozen install, binding, supply-chain, privacy, diff, and residue gates appropriate to each leaf.
