# IFC-V1-054 Executable Production Audit

## Scope

- Target: runnable packaged `codexdeck`, complete required CLI surface, and selected foreground `serve` composition.
- Refs: `BLK-V1-04`, `FR-011`, `PR-009`, `PR-012`, `DEC-027`.
- Audit date: 2026-07-21.
- Current package input: the `IFC-V1-021` deterministic six-package runtime layout, expanded through `IFC-V1-054` to 608 sources and 1,223 owned outputs.

## Current Truth

- `IFC-V1-080` completes the exact required source grammar, help, duplicate/conflict rejection, and side-effect-free staging for commands without an implementation owner.
- The CLI has 18 bounded client factories and 26 public operations. `IFC-V1-084` calls selected manifest routes `host_status`, `session_list`, and `device_revoke`; `IFC-V1-085` implements `devices` through a separate secure read-only local application path. The paired-cookie-only `device_list` route remains unchanged under `DEC-024`; only reserved service actions remain staged.
- `packages/cli/src/shell.ts` is the direct process entry and remains inert when imported. The source manifest declares only `codexdeck -> ./src/shell.ts`; the emitted manifest rewrites only that command to `./dist/shell.js`.
- The compiled package has one HostDeck executable with an exact shebang, executable mode, version, size, and SHA-256 identity in the verifier manifest. No generated shim, TypeScript loader, source target, checkout path, or second HostDeck command is accepted.
- `codexdeck serve` composes the accepted foreground resources, production application, loopback Fastify/Tailscale lifecycle, package-relative static root, process-signal ownership, readiness output, and terminal-state handling. Invalid startup has no alternate listener, runtime, asset, cwd, LAN, certificate, tmux, or profile-switch path.
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

## IFC-V1-054 Frozen Criteria

- The source and emitted `@hostdeck/cli` manifests declare exactly one command, `codexdeck`, and the runtime target is exactly `./dist/shell.js`. The emitted target is regular compiled ESM JavaScript, starts with `#!/usr/bin/env node`, is executable, and has no TypeScript loader, source path, generated launcher, checkout path, or second HostDeck bin. Importing any package root remains side-effect free; only direct execution runs the process boundary.
- Argument grammar is fully parsed before config/package metadata/filesystem/network/process access. Empty args, `--help`, `help`, `--version`, and `version` remain daemon-independent; help performs no file access and version lazily reads and strictly validates only the colocated runtime manifest. Unknown, duplicated, conflicting, injected, missing, or extra input retains the accepted bounded stdout/stderr and stable exit-code contract with zero command side effects.
- Non-serve commands continue through the accepted source dispatcher without changing API authority, retries, output/privacy limits, or local-device administration. Reserved service lifecycle forms return explicit non-success before `systemctl` or filesystem mutation until `IFC-V1-056`; remote forms use only the loopback API and never invoke Tailscale or switch a profile.
- `serve` resolves the existing CLI config precedence, requires an absolute secure XDG runtime directory, resolves one canonical executable Codex candidate from an explicit absolute `HOSTDECK_CODEX_BIN` or an absolute-entry `PATH`, fixes browser routes to `/` and `/sessions/:session_id`, and derives the static root only from the executable package root. It passes one resolved default resource budget and a non-throwing secret-free issue observer to `startHostDeckProductionForegroundServe`, invokes that accepted owner once, publishes one bounded loopback readiness line, waits for its terminal snapshot, and returns non-success for failed or contradictory termination. Invalid config, Codex, runtime, package, assets, startup, output, or termination truth starts no alternate listener/runtime and exposes no private path or raw cause.
- The production verifier binds the CLI manifest bin name/target, compiled target path, shebang, executable mode, and package version to the existing package identity. Missing/modified/non-executable/escaping/source-targeted/multiply declared bins, unlisted HostDeck executable output, manifest disagreement, or stale package content fail before runtime load. Dependency-declared executables and the two native modules retain their separate exact inventory.
- Direct executable-path, Node-path, package-manager, packed-runtime, and temporary global-style invocations run help/version from an unrelated cwd and a read-only relocated package. Command/config/service/serve dispatch probes cover success and failure without requiring real dashboard assets; a missing package-relative static tree remains an explicit `IFC-V1-053` startup failure, not an external/dev fallback.
- Two unchanged offline builds are byte-identical; a failed build preserves the prior accepted package; verifier mutations restore cleanly. Validation leaves no staging/packed-install/global-prefix/config/state/runtime/database/socket/listener/process residue and emits no checkout/home/staging path, credential, pairing value, prompt, transcript, Tailscale identity, or child stderr.
- Completion requires focused source/process tests, package helper and verifier negatives, the invocation matrix, one exact Codex 0.144.0 no-model executable serve smoke against a test-owned package-layout asset fixture, full workspace/static/package gates, manual mode/shebang/output/privacy/no-fallback inspection, owner-doc closure, coherent commits, and push. This leaf does not claim real Vite assets, service units/lifecycle, install/uninstall, clean Ubuntu parity, browser UI, or phone deployment.

## IFC-V1-054 Evidence

- Implementation `2b888ec` adds the one direct ESM process boundary, lazy colocated package-version validation, accepted foreground `serve` dispatch, package-relative assets, bounded canonical Codex resolution, exact readiness/termination handling, config-path redaction, and explicit pre-service non-success. Importing the compiled command is inert; direct execution reports `codexdeck 0.0.0` from an unrelated cwd.
- The schema-2 package manifest binds `codexdeck`, `dist/shell.js`, `#!/usr/bin/env node`, mode, version, size `60212`, and command SHA-256 `74d2461c8ba1158553751f71f3d2a1e3b5ba3c6f789f5af6d9a043e1a4c45e6f`. Missing, multiple, source-targeted, non-executable, shebang-modified, escaping, stale, or unlisted HostDeck command state rejects and restores cleanly.
- Package acceptance passes two deterministic offline builds and direct, Node-path, package-manager-link, packed-runtime, and temporary global-style invocation from unrelated cwd/read-only content. The final tree has 608 sources, 1,223 owned outputs, and 6,425 entries; source identity is `9fc4d1e59905ce7f855066a212c6a0d921501cd8273105e8d1fb81e77d8a0ec8`, output identity `84c7b2f3de67a637a2ef5ec4bd9d776a3f7c086456dd6e5556f4c0482438eee4`, content identity `d1bdadaec3b837c5bb00bca2391bc51c8fd0e228703e6cb82766c0b0fc2983fb`, and manifest identity `ad80a1a7220593cd5e1acc5030332fa95b8d500205947ead4d71a6f7eb1b8111`.
- Eight focused executable-dispatch tests plus the config privacy regression pass. Full gates pass 1,843 unit tests with 28 intentional skips, 240 contract, 26 integration, and 20 web tests, plus root/CLI typechecks, lint/exports over 533 files and 8 packages, scaffold, planning, runtime boundary, frozen offline install, exact 0.144.0 binding over 671 files, package helpers/verifier negatives, diff, privacy, no-fallback, and zero-residue review.
- The direct packaged command exact-Codex smoke runs twice from one read-only relocated package through the real shebang, serves test-owned index/hashed assets on IPv4 loopback, reports readiness once, handles `SIGTERM`, releases the socket/port, writes no transcript, and performs no model turn. Tailscale, its selected profile/Serve state, the phone, dependencies, and the lockfile were not changed. Real Vite assets, user units, installation, clean Ubuntu parity, browser UI, and phone deployment remain downstream.

## IFC-V1-083 Frozen Criteria

- One production foreground serve owner performs strict data-only input and static-boundary preflight, installs bounded termination ownership, starts `IFC-V1-081` resources, creates exactly one accepted `IFC-V1-082` application, and invokes only the selected Tailscale Serve Fastify lifecycle. Invalid/accessor/extra/unresolved input starts no resource, signal listener, process, socket, database, Tailscale command, or TCP listener.
- Startup order is exact: lease and owner-only paths, migrated storage, foreground-owned exact Codex process/Unix socket, compatibility handshake, durable audit/session reconciliation, exact 22-registration/35-route plus static readiness, IPv4 `127.0.0.1` bind verification, post-listen remote-observation scheduling, then listener-health publication before the owner returns. The first remote observation never gates local readiness, and the returned service requires runtime/application/listener/local-health consistency and open health-gated mutation admission.
- Missing, changed, or invalid assets; held lease; exact-Codex failure; reconciliation failure; route/app readiness failure; occupied/wrong listener bind; post-listen invariant failure; and startup abort each reject with one bounded stage/code and reverse-clean every acquired owner. No failed startup leaves a listener, child, Unix socket, database handle, lease, signal listener, timer, or temporary root.
- Tailscale absence, stopped/signed-out state, wrong profile, observation failure, or slow first observation leaves verified local HTTP/static/API readiness available and remote admission closed/degraded. Observation starts only after listen and never switches profiles, starts/stops `tailscaled`, repairs Serve, or mutates Serve without an explicit accepted local control operation.
- The owner handles `SIGINT`, `SIGTERM`, caller abort, and unexpected app-server exit during startup or ready operation. Startup cancellation reaches the active resource/listener deadline; ready-state termination initiates one close promise. Expected child exit during owned close is ignored, while unexpected exit/rejected exit observation marks bounded failure truth, fails listener health, and drains the service.
- Close synchronously closes remote/request and selected-write admission before listener refusal, then preserves the accepted subscriber, approval, reconnect, write, audit, projection, foreground runtime, Fastify, storage, and lease ordering. Repeated/concurrent close or repeated signals reuse one transition; every stage is deadline-bounded, later cleanup still runs after any failure, and one aggregate failure remains visible.
- Local real-listener evidence covers liveness, built index/assets, one authenticated selected SSE connection, active-stream shutdown, exact loopback-only inventory, same-port/state restart, and no LAN/public or app-server TCP listener. The exact-Codex smoke performs no model turn and Tailscale-absent evidence performs no remote mutation.
- Snapshots, observer events, thrown public messages, retained test output, and normal process output are bounded and omit config contents, credentials, cookies/CSRF/pairing values, prompt/transcript data, Tailscale account/profile/origin/source identity, child stderr, private paths, and raw causes. Detailed causes remain internal only.
- Completion requires focused ownership/failure/signal tests, adjacent lifecycle/shutdown/remote/SSE/application suites, one exact Codex 0.144.0 no-model production serve smoke, full workspace/static/binding/package gates, manual order/privacy/no-fallback review, zero process/listener/socket/lease/temp residue, owner-doc closure, coherent commits, and push. This leaf does not claim a packaged executable, real dashboard build, service unit, install path, or phone deployment.

## IFC-V1-083 Evidence

- Implementation `58a99f6` adds one production foreground serve owner over the accepted foreground resources, production application, and Tailscale Serve Fastify lifecycle. Strict descriptor-safe preflight, native caller cancellation, `SIGINT`/`SIGTERM` ownership, unexpected/rejected child-exit handling, readiness consistency checks, bounded redacted snapshots, coalesced close, and failure-continuing outer cleanup are explicit. The existing Fastify lifecycle now accepts the same parent startup signal without changing callers that omit it.
- Focused ownership, stage-failure, cancellation, signal, child-exit, observer, privacy, and cleanup tests pass 14/14. The adjacent Fastify/Tailscale lifecycle, application shutdown, remote lifecycle, production graph, health, static, SSE, and subscriber aggregate passes 150/150. Manual inspection confirms startup has no Tailscale mutation/profile/daemon path and reaches only IPv4 loopback HTTP plus the private Codex Unix socket.
- The final exact Codex 0.144.0 no-model smoke runs in an isolated mount namespace with `/usr/bin/tailscale` absent while leaving the host installation/profile untouched. It proves local liveness, index and hashed asset delivery, one authenticated selected SSE stream, remote `client_not_installed` degradation without gating local readiness, `SIGTERM` drain, stream/socket cleanup, same-port/state restart, no transcript file, and temporary-root removal. Post-close SQLite inspection retains only the seeded successful enable audit, records one observation-only unavailable generation, and proves no enable/disable mutation was added.
- Full gates pass 1,834 unit tests with 28 intentional external/smoke skips, 240 contract, 26 integration, and 20 web tests, plus root/all-package typechecks, lint/exports over 531 files and 8 packages, scaffold, planning (218 tasks/84 requirements/670 dependencies/2 queued before closure), runtime-boundary tests with 610 production modules/21 externals, frozen offline install, exact isolated 0.144.0 binding over 671 files, package export, diff/privacy/no-fallback review, and zero task process/socket/temp residue. The default Codex 0.144.5 correctly fails the exact-version gate.
- Deterministic package acceptance passes two builds with 608 sources, 1,223 owned outputs, and 6,425 entries. Source identity is `63948b20ad6040cfd3a84c85a4e64b9b867398b2e2acb59647ce92c2207f3516`; output identity is `7b4078d972df144a9dd4714945aa398566c0205f141c63ac6171bcf96a42bd33`; content identity is `05230265966fa4777923a092474063a12b330f89c74463aa4584c7ebe6d93ddb`; manifest identity is `2893e631ff57c96ec051e177b58a3860e5b7947b61ac59f6d0e310071f0aefd5`. No dependency, lockfile, setup, Tailscale Serve/profile, browser, or phone state changed. A packaged executable, real dashboard build, user unit, install path, and phone deployment remain downstream.

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

## IFC-V1-081 Evidence

- Implementation `44635eb` adds one server-owned foreground resource bootstrap. It validates one frozen budget, canonical non-overlapping paths, a non-privileged loopback port, and a canonical executable before owned filesystem mutation; acquires the state lease before later paths, SQLite, socket, or process work; then starts only the fixed foreground-child runtime owner.
- SQLite is created/migrated through the selected owner-only path contract while a separate descriptor guard spans open and migration. Returned bind, migration, repair, and runtime state are normalized and frozen. No Fastify app, TCP listener, Tailscale read or mutation, route registration, compatibility claim, or executable entrypoint is introduced.
- Held lease, hostile/accessor input, missing/non-executable/symlink binary, insecure runtime parent, corrupt or substituted database, runtime rejection/abort/invalid state, and cleanup failure all fail explicitly. Rollback closes the attempted runtime, database, and lease in reverse order; repeated close returns one promise and later owners are still released after a close-stage failure.
- Focused direct tests pass 8/8 and the real Linux process/socket integration passes 1/1, including fixed child argv, owner-only modes, exclusive flock, no TCP listener, idempotent close, same-path restart, process exit, socket removal, privacy, and zero task residue. Full gates pass 1,815 unit tests with 26 intentional external/smoke skips, 240 contract, 26 integration, and 20 web tests, plus root typecheck, lint/exports over 525 files and 8 packages, scaffold, planning, six runtime-boundary mutation tests, the exact 608-module/21-external boundary, and the isolated exact Codex 0.144.0 binding check over 671 files.
- Deterministic package acceptance passes twice with 606 sources, 1,219 owned outputs, and 6,421 entries, including relocated read-only runtime and runtime/config/static/integrity rejection. Source identity is `c66f6e4dbedccf196609f1d99d27827533b2445b2cca9721a1c37330080a421a`; output identity is `d75904cbe50d872c6e06ff068fe6b11fcc91250b775d5c92fa83c023bb0c4c35`; content identity is `90c33369f0e5f6c301b4604a5d68926499fc075e18e2ab9a659b1bfd6c569151`; manifest identity is `20aba4034f6bb6dc908e7dd58361f4b345e630cbff944d892c3d6e6e884517e5`. No dependency, lockfile, setup, Tailscale, Serve, browser, or phone state changed.

## IFC-V1-082 Evidence

- Implementation `66f91f4` adds one frozen production application context over branded foreground resources. It constructs only real migrated repositories, auth/CSRF/lock/pairing and audit policies, host-health admission, projection append/continuity/fanout/replay/subscribers, exact Unix-socket reconnect/reconciliation clients and controls, remote lifecycle, the exact 22 selected registrations, one validated static registration, and the accepted ten-stage shutdown.
- Strict preflight rejects extra/accessor/sparse/forged/invalid input before settings mutation. Startup requires exact compatibility, persisted compatibility, durable audit/session reconciliation, ready storage, and healthy projection before returning runtime-ready; listener health remains not-ready and mutation admission closed. Missing assets fail during Fastify readiness before any TCP bind, remote observation remains idle, and the configured loopback port remains bindable.
- Direct composition tests pass 8/8 and the adjacent lifecycle/reconciliation/static/health/shutdown/write aggregate passes 167/167. The real exact Codex 0.144.0 no-model smoke uses an empty temporary Codex home, reconciles one pending audit and one missing managed thread to explicit terminal/stale truth, starts no Tailscale observation or TCP listener, then removes the process, Unix socket, database handle, lease, and temporary root. Runtime-start timeout, rejected process-exit observation, listener failure, hostile input, privacy, repeated cleanup, and static-fixture failure remain bounded and explicit.
- Full gates pass 1,826 unit tests with 27 intentional skips, 240 contract, 26 integration, and 20 web tests, plus root typecheck, lint/exports over 528 files and 8 packages, scaffold, planning, six runtime-boundary mutation tests with 609 production modules/21 external modules, exact Codex 0.144.0 binding over 671 files, and diff/residue review. Deterministic package acceptance passes twice with 607 sources, 1,221 owned outputs, and 6,423 entries. Source identity is `ef5b1864133ffc86316a1de1cd97b2f6cfbb96b3e66c3af60ff62db0533f3641`; output identity is `3179b691599a30eb73d69cd80543d83ae476ed7be1b0114253e88ff619f8a49d`; content identity is `ad0598a3db8fb8910b42d946cc55d8fb0f0bc01260ab49a2fbca0455f1447733`; manifest identity is `9edf7b942d938b3c7b97746c1b627ecb17642577aaf18c7d8c2cd9af07a4419a`. No dependency, lockfile, setup, Tailscale profile/Serve, browser, or phone state changed.
