# IFC-V1-054 Executable Production Audit

## Scope

- Target: runnable packaged `codexdeck`, complete required CLI surface, and selected foreground `serve` composition.
- Refs: `BLK-V1-04`, `FR-011`, `PR-009`, `PR-012`, `DEC-027`.
- Audit date: 2026-07-20.
- Current package input: the `IFC-V1-021` deterministic six-package runtime layout, mechanically expanded through `IFC-V1-085` to 605 sources and 1,217 owned outputs.

## Current Truth

- `IFC-V1-080` completes the exact required source grammar, help, duplicate/conflict rejection, and side-effect-free staging for commands without an implementation owner.
- The source CLI has 18 bounded client factories and 26 public operations. `IFC-V1-084` calls selected manifest routes `host_status`, `session_list`, and `device_revoke`; `IFC-V1-085` implements `devices` through a separate secure read-only local application path. The paired-cookie-only `device_list` route remains unchanged under `DEC-024`; only `serve` and reserved service actions remain staged in the source grammar.
- `packages/cli/src/shell.ts` exports a source-level `main`, but no production entry file invokes it.
- The compiled package deliberately has no HostDeck `bin`, executable file, generated command shim, or executable identity in its verifier manifest.
- The accepted 22-registration/35-route factory has no non-test production caller.
- No production composition root currently joins secure paths and lease, migrated SQLite, exact Codex supervision/reconnect, runtime controls, projection/SSE, selected routes, static boundary, remote lifecycle, or application shutdown.
- Real web assets, systemd user units, install/upgrade/uninstall, and clean-machine parity remain separate downstream owners.

## Granularity Correction

The prior `IFC-V1-054` row combined independently verifiable outcomes and was not a valid leaf task. Execution is now ordered as:

| Task | Single outcome |
| --- | --- |
| `IFC-V1-080` | Freeze the complete required CLI grammar, help, and side-effect-free reserved behavior. |
| `IFC-V1-084` | Add bounded host-status, session-list, and confirmed device-revoke API clients, rendering, and source dispatch. |
| `IFC-V1-085` | Add secure read-only local device listing, rendering, and source dispatch under `DEC-024`. |
| `IFC-V1-081` | Own secure foreground resource bootstrap and rollback. |
| `IFC-V1-082` | Compose the real selected application graph over bootstrapped resources. |
| `IFC-V1-083` | Run and drain the foreground Fastify/Tailscale lifecycle. |
| `IFC-V1-054` | Integrate the compiled process entry and package/bin invocation. |

## Cluster Success Criteria

### Command Contract

- Parse every `FR-011` top-level command and required subcommand before reading config, touching files, opening a socket, spawning a process, or invoking a client.
- Add bounded clients for host status, session list, and confirmed device revoke through the existing direct-loopback transport and shared response/error reader.
- Implement `devices` through a separate secure read-only local application path over the selected device-list repository. It must reject insecure, substituted, missing, unmigrated, or corrupt state without creating, repairing, migrating, or partially returning it; it must never weaken the paired-cookie-only HTTP route frozen by `DEC-024`.
- Keep confirmed `revoke` on the selected audited HTTP mutation route so durable revocation, live authority invalidation, terminal proof, and local-admin recovery remain intact.
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

- Focused parser/help/no-side-effect tests, bounded API-client/render/dispatch tests, and secure read-only local device-list path tests.
- Bootstrap rollback/ownership/path/runtime tests using real Linux files, flock, SQLite, sockets, and child processes.
- Exact-Codex no-model foreground lifecycle with selected route/static fixture, local HTTP checks, signal shutdown, restart, and residue inspection.
- Two-build package determinism, verifier negatives, packed/local/global-style invocation, unrelated-cwd/read-only execution, and command matrix.
- Root/package typechecks, lint/exports, unit, contract, integration, web, scaffold, planning, runtime-boundary, frozen install, binding, supply-chain, privacy, diff, and residue gates appropriate to each leaf.

## IFC-V1-084 Evidence

- Implementation `6ae4f96` adds strict direct-loopback clients for `GET /api/v1/host/status`, canonical `GET /api/v1/sessions`, and audited local-admin `POST /api/v1/access/devices/:device_id/revoke`. The reads send no local-admin header; revoke requires exact confirmation, a generated operation id, correlated terminal response, and no retry.
- Client and shell boundaries reject accessors, extra keys, alternate authorities, malformed responses, wrong status, cross-operation/device data, invalid pagination continuation, and local-admin self-revoke success. Shared bounded transport, error sanitization, response freezing, and one-dispatch behavior remain enforced.
- Both human and JSON host-status output omit the private external origin. Human session output omits cwd, runtime thread id, objective, and summary, while session-list JSON preserves the selected response contract. Device-revoke output contains only the selected public receipt fields. The paired-cookie-only `device_list` HTTP route and all Tailscale, Serve, browser, and phone behavior are unchanged.
- The aggregate source inventory is exact at 18 factories, 26 public operations, 26 selected route ids, and 28 requests. Focused client/render/dispatch/inventory tests pass 19/19 and the focused CLI contract passes 12/12; full gates pass 1,790 unit tests with 26 intentional external skips, 240 contract, 25 integration, and 20 web tests, plus root/package typechecks, lint/exports over 518 files and 8 packages, scaffold, planning, runtime-boundary, and diff checks.
- Deterministic package acceptance passes twice with 603 source modules, 1,213 owned outputs, and 6,415 entries, including relocated read-only runtime and verifier/config/static/integrity rejection. Source identity is `dcaf0d41bf18d4bf1b9acac49ef8f86278a5afe671c11b842d12a290f2b3b956`; output identity is `9b1c2c62fad91486879dbd90565aedd3d809531a210f42d26a37671814f0b864`; content identity is `5e34ab4abe966b605768db224c6a1fa01e17d95452366e8cabb4bcf8bce4e7de`; manifest identity is `1cb11d8c5c0bb0c6447c391e457ec93426d992f44e2fcbe166989edabd6edf47`. No dependency or lockfile changed.

## IFC-V1-085 Evidence

- Implementation `fc70423` adds one non-creating local `devices` path over the existing bounded device-list repository. It validates exact pagination, maps only selected public lifecycle metadata, closes storage before returning, and never constructs or invokes HTTP transport.
- The storage owner accepts only an existing canonical owner-owned `0700` state path and guarded `0600` current-schema database. SQLite is opened with `readonly`, `query_only`, in-memory temporary state, disabled trusted schema, exact migration/checksum inspection, and retained file-identity guards. WAL databases require already-secure WAL/SHM sidecars; missing sidecars reject before SQLite can create them.
- Missing, insecure, hard-linked, stale, corrupt, substituted, hostile, close-failure, and live concurrent-writer cases return no page; they do not create or repair paths, migrate SQLite, or expose state. Real WAL evidence reads a pre-commit snapshot during an active writer transaction and the committed value on the next open. The paired-cookie-only `device_list` route, selected manifest, Tailscale, Serve, browser, and phone behavior remain unchanged.
- Focused storage/CLI tests pass 17/17, including a real shell-to-SQLite path and zero HTTP calls. Full gates pass 1,807 unit tests with 26 intentional external/smoke skips, 240 contract, 25 integration, and 20 web tests, plus root/affected typechecks, lint/exports over 522 files and 8 packages, scaffold, planning (218 tasks/84 requirements/670 dependencies/2 queued), six runtime-boundary mutation tests, the exact 607-module/21-external boundary, diff checks, and temporary-state residue inspection.
- Deterministic package acceptance passes twice with 605 sources, 1,217 owned outputs, and 6,419 entries, including relocated read-only runtime and runtime/config/static/integrity rejection. Source identity is `88015eb96492bef56d165397ddd6ea7e39bf9abaf4ebf3dbd3c6608e6d11ba1b`; output identity is `d29e4707b9c145a6a9fc6e9875b869757fe9affe0b0e474a816fade1e06f8131`; content identity is `bff399fd7cc1cc6220096b153d51ca808ae74fb20bbe1e702d7d1eb5613ee1ab`; manifest identity is `0996d213c68a5e9d69b66f9b6e6a5474be8e7203c26fc13dd1881917fd02a35b`. No dependency, lockfile, or setup changed.
