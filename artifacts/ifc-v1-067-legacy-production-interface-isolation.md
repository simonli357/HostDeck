# IFC-V1-067 Legacy Production-Interface Isolation

## Hardening Target

- Owning block: `BLK-V1-04`.
- Requirements and decisions: `PR-004`, `SFR-009`, `DEC-018`, and `DEC-027`.
- Behavior oracle: accepted 22-registration/35-route selected composition from `IFC-V1-046`.
- Target state: production package roots, listener lifecycle, request authority, CLI, and web-facing contracts expose only the loopback HTTP plus private Tailscale Serve path. Historical data remains inert and explicitly administered; no legacy runtime or network fallback remains.

## Baseline Audit

The accepted selected composition exists, but the production boundary is not yet exclusive:

| Area | Current production reachability | Required disposition |
| --- | --- | --- |
| Server package root | Exports the historical 17-route tmux/raw manifest and synchronous legacy security routes. | Delete both modules, tests, and exports. |
| Fastify factory/lifecycle | Accepts LAN certificate material, constructs HTTPS, and permits arbitrary HTTP/HTTPS listener binds. | Remove TLS input and HTTPS construction; require exact IPv4 loopback HTTP before app creation or listen. |
| Request/auth contracts | Selected network modes still include `lan`; local request trust supports LAN HTTPS. | Selected modes become exactly `loopback` and `remote`; local trust becomes loopback HTTP only. |
| Direct-LAN implementation | Certificate generation, LAN configuration repository/service/routes, and Android/security harness remain in source and default tests. | Delete implementation, tests, harness, scripts, and production dependencies. |
| Route tests | Multiple selected route tests borrow the retired certificate policy to fabricate remote HTTPS. | Remove those legacy cases/helpers; preserve or replace their assertions through the selected admitted-Serve boundary. |
| CLI configuration | `--host`, `HOSTDECK_HOST`, config `host`, and arbitrary HTTP(S) API origins remain accepted. | Keep configurable loopback port/origin only; reject HTTPS and non-loopback at config load before a client is built. |
| CLI administration | `lock`/`unlock` can mutate SQLite directly through `createLocalAdmin`; the same module retains obsolete legacy pairing creation. | Route lock/unlock through exact selected loopback HTTP handlers; retain only bounded local legacy session status/reset storage access. |
| Public web/contracts | Package roots still export desktop-led tmux/raw/slash/LAN view models, fixtures, and contracts. | Delete or stop exporting obsolete interface modules; selected mobile and pairing contracts remain. |
| Storage | Public LAN configuration mutation and settings `setLanEnabled` remain; published schemas retain historical rows/columns. | Delete LAN mutation APIs. Add one additive retirement migration for obsolete LAN settings/table while preserving published migration text and required historical rows. |
| Dependencies | `@peculiar/x509` and `reflect-metadata` exist solely for retired certificate production/tests. | Remove both dependencies and all lockfile entries not required elsewhere. |
| Static gate | Current runtime checker rejects only executable tmux remnants. | Extend it to reject all legacy production-interface files, exports, imports, config, dependencies, scripts, and selected-contract LAN drift. |

## Frozen Disposition

### Remove

- `packages/server/src/api-route-contracts.ts`, `security-routes.ts`, all `lan-*` implementation, and the old security-acceptance harness plus their direct tests/smokes/probes.
- LAN TLS support from `fastify-app.ts` and `fastify-host-lifecycle.ts`, including HTTPS listener types, branches, and tests.
- `lan` from selected request-authentication, access-state, host-health, and selected-session-read contracts and tests.
- LAN mode from the local request-trust policy. The local factory supports one canonical loopback HTTP origin only; Tailscale Serve owns external HTTPS separately.
- Historical server/root exports and contract/storage exports that make LAN, certificate, raw input, slash injection, or tmux handler surfaces reachable from production roots.
- The LAN configuration repository/service/route/certificate dependency chain and the obsolete LAN Android smoke command.
- CLI arbitrary-host configuration and the combined local pairing/lock/session administrator.
- Direct SQLite pairing and lock/unlock code. Selected `pair`, `lock`, and `unlock` use exact loopback API routes and selected audit/auth policy.
- Rejected desktop-led web view models and fixtures that expose raw input, slash injection, tmux state, or direct-LAN state.

### Retain

- Published migration SQL and checksums 1-17 unchanged.
- Historical `sessions`, child rows, `legacy_session_dispositions`, and bounded local `legacy status` plus confirmed `legacy reset --confirm` until their rows can be explicitly removed.
- Historical audit rows and the minimum parsers required by `DR-010`, including LAN/certificate action decoding. They remain readable but cannot be created through selected production interfaces.
- Selected pairing/device, lock, remote-ingress, projection, and audit storage.
- Tmux only inside already isolated opt-in exact Codex TUI terminal harnesses; no product package, config, route, or default command may invoke it.
- The loopback port as selected listener configuration. Host and transport are fixed by code, not durable LAN configuration.

### Data Retirement

- Add migration 18; do not edit any earlier migration.
- Migration 18 rebuilds `settings` with selected fields only: id, schema version, state directory, loopback port, lock state, retention limits, and update timestamp. It preserves those values exactly and removes `bind_mode`, `bind_host`, and `lan_enabled`.
- Migration 18 drops the obsolete `selected_lan_configuration` table. It does not delete or reinterpret historical session or audit rows.
- Databases with either historical loopback or LAN settings migrate to the same selected loopback-only settings shape. The preserved port is used only for a loopback listener.
- Legacy session reset remains explicit, confirmed, transactional, idempotent, process-free, and limited to the declared historical session graph.

## Harsh Success Criteria

### ISO-01 Production Root Closure

- The transitive source and emitted-module closure of `@hostdeck/server`, `@hostdeck/cli`, `@hostdeck/web`, `@hostdeck/contracts`, `@hostdeck/core`, and `@hostdeck/storage` contains no legacy listener, LAN route/service/certificate, raw-input route, slash-injection route, tmux handler, or direct local pairing/lock implementation.
- Explicitly retained migration/data decoders and the legacy session reset repository are allowlisted by exact path, cannot import runtime/process/network adapters, and expose no fallback selector.
- Static checks fail on forbidden file reintroduction, root export, dependency, config key, command, import, transport enum, or package script.

### ISO-02 Listener And Ingress Exclusivity

- Both local and Tailscale-aware lifecycles accept only `host: "127.0.0.1"`, `transport: "http"`, and a valid nonprivileged configured port before app creation or bind.
- Fastify never receives certificate/private-key material and cannot construct a HostDeck HTTPS server.
- Wildcard, private-IP, IPv6-loopback, hostname, HTTPS, extra TLS property, or post-start bind mismatch fails before route dispatch; cleanup still runs exactly once.
- External HTTPS remains solely Tailscale Serve termination to the loopback HTTP origin.

### ISO-03 Selected Authority Contracts

- Selected network-mode enums are exactly `loopback | remote`; local-admin authority is loopback-only and remote paired authority is admitted-Serve-only.
- LAN-shaped authentication/access/session-read/health values reject schema parsing and cannot be manufactured by local trust.
- The exact selected manifest remains 35 routes and selected composition remains 22 registrations with no raw/slash/tmux/LAN route id or fallback.

### ISO-04 CLI Exclusivity

- `--host`, `HOSTDECK_HOST`, config `host`, HTTPS API origins, credentials, paths, query/fragment, wildcard, and non-loopback origins reject during config loading.
- Default, `--port`, `HOSTDECK_PORT`, and exact loopback `--api-url`/environment/config origins remain supported with bounded validation.
- `pair`, `lock`, and `unlock` issue exact selected loopback HTTP requests. Lock/unlock carry generated operation ids and confirmation, use local-admin request authority, validate typed responses, and never open SQLite.
- Only `legacy status/reset` may open SQLite from the source CLI. Its module exports no pairing, lock, audit append, process, or network capability.
- Source-client inventory includes lock and unlock and maps every observed operation to one exact selected manifest row.

### ISO-05 Legacy Source And Dependency Removal

- All frozen remove-list files and direct tests are absent.
- `@peculiar/x509`, `reflect-metadata`, obsolete certificate state directories, custom CA enrollment, and direct-LAN Android command are absent from package manifests, lockfile, default scripts, and production closure.
- Default test and web commands no longer execute rejected direct-LAN or desktop/raw-interface tests.

### ISO-06 Migration And Historical Data Integrity

- Migration 18 upgrades empty, loopback-configured, LAN-configured, and populated historical databases atomically without changing checksums 1-17.
- Selected settings retain state directory, port, lock, retention, and chronology while exposing no LAN fields or mutation method.
- Historical LAN/certificate audit records remain decodable and immutable; selected writers reject those actions.
- Legacy session status/reset still prove bounded counts, confirmation, immediate transaction, foreign-key behavior, selected-state preservation, idempotence, and zero process action.
- Migration failure rolls back without a half-rebuilt settings table or lost historical data.

### ISO-07 Coverage Replacement

- Removing certificate-backed route tests may not remove selected authority, CSRF, lock, response-loss, audit, or exact-target assertions. Equivalent local and admitted-Serve coverage must remain in direct route, selected-composition, or remote-security tests.
- Focused tests cover every changed contract, listener rejection, CLI config/client/dispatch path, migration, package boundary, and privacy/failure branch.
- Full unit, contract, integration, web, typecheck, lint/exports, scaffold, planning, runtime-boundary, exact binding, frozen install, production audit/license, and diff checks pass.

### ISO-08 Manual Inspection And Residue

- Inspect package roots, transitive import closure, emitted candidate output, production dependency tree, CLI help/failures, migration schema/rows, listener inventory, and sanitized outputs.
- No HostDeck test listener, certificate directory, Android/ADB process, Tailscale Serve mutation, tmux test process/socket, or temporary build directory remains after validation.
- The task records exact removed/retained files, commands, counts, residual risks, commit, and push state. It makes no final packaging or release-ready claim; `IFC-V1-021`, `IFC-V1-053` to `IFC-V1-058`, and release tasks own those gates.

## Failure Conditions

- A selected package root can still import or export a legacy handler or construct a non-loopback listener.
- A LAN-shaped value remains legal in a selected authority contract.
- CLI config accepts a non-loopback host, or pair/lock/unlock bypass selected HTTP policy/audit.
- A migration rewrites prior SQL/checksums, silently converts a tmux row, deletes historical audit truth, or leaves legacy reset ineffective.
- Tests pass only because remote/certificate assertions were deleted without selected replacement evidence.
- A static allowlist is directory-wide, token-based without exact path ownership, or broad enough to hide new production fallback code.

## Required Evidence

- Exact removed/retained file, export, dependency, config, and command inventory.
- Focused contract/listener/CLI/migration/static-gate tests and selected aggregate regression.
- Candidate emitted production-root closure and production dependency inspection.
- Full workspace validation plus manual listener/process/temp/privacy inspection.
- Owning task, queue/status handoff, command reference, developer guide, block maturity, and artifact synchronized only where their owned facts change.

## Completion

`IFC-V1-067` is complete. Criteria were frozen in `a72e65c`; listener, TLS, LAN, storage, and migration retirement landed in `a037ba5`; pair/lock/unlock became HTTP-only in `fec797b`; and selected public-interface closure plus the static gate landed in `dcd5fcb`. All four commits are pushed to `origin/main`.

### Final Inventory

- The canonical exact removed-file inventory is the `removedPaths` array in `scripts/check-selected-runtime-boundary.mjs`. It covers the retired tmux package manifest; legacy CLI administrator; generic API/UI/LAN contracts; desktop session/classifier/command core; legacy listener, LAN certificate/configuration, raw/slash/tmux routes and harnesses; superseded storage repositories; desktop fixtures/view models; and every direct test named by those surfaces. The gate fails if any exact path returns.
- The only exact historical-token/import exceptions are `packages/storage/src/migrations.ts`, `packages/contracts/src/security-audit.ts`, `packages/contracts/src/selected-storage.ts`, `packages/core/src/selected-runtime.ts`, `packages/storage/src/legacy-session-repository.ts`, and `packages/cli/src/legacy-session-admin.ts`. Their allowed imports are exact and machine checked; none can import a network, listener, process, or runtime adapter.
- Removed dependencies are exactly `@hostdeck/tmux-adapter`, `@peculiar/x509`, and `reflect-metadata`. Removed scripts are exactly `smoke:android-security`, `smoke:lan-android`, and `test:tmux`.
- Selected production roots are exactly server, CLI, web, contracts, core, and storage. The exact public module sets for core, contracts, web, and test fixtures are frozen by the same gate; the resulting transitive production closure contains 600 source modules and 21 external modules.
- Published migrations 1-17 and checksums are unchanged. Migration 18 removes obsolete LAN settings/table state while preserving selected settings and historical session/audit truth. Only confirmed `legacy status/reset` retains local SQLite access.

### Validation Evidence

| Boundary | Result |
| --- | --- |
| Focused behavior | Migration/history/reset: 38 passed; documented CLI/config/inventory/admin: 36 passed; SSE regression: 10 passed. |
| Workspace | Unit: 1,730 passed and 26 intentional skips across 176 files; contract: 235 passed; integration: 19 passed; web: 20 passed; root and all-package typechecks passed. |
| Static structure | Lint/export checks passed across 497 files and 8 packages; scaffold and planning checks passed; mutation-tested runtime boundary passed with the 600-module/21-external closure. |
| Binding and build closure | Exact isolated Codex 0.144.0 binding passed across 671 files with hash `e1a1a5cff3ab91862f9215dd06538eae1ea0b00bae48cbb7d87061faaee27e24`; emitted candidate closure contained the same 600 modules with zero missing or forbidden modules. The installed default 0.144.5 binary correctly remains ineligible as exact evidence. |
| Install and supply chain | Frozen offline install passed; production audit reported zero known vulnerabilities; dependency inventory contained 9 workspaces and 146 unique named nodes; all 137 production package records across 140 paths had allowlisted permissive licenses. |
| Manual and residue | Package roots, CLI/config failures, migration/history behavior, dependency tree, emitted closure, listener/config state, diffs, and sanitized output were inspected. No port 3777 listener, HostDeck/test/Codex/tmux/ADB task process, task build directory, certificate directory, or Tailscale Serve handler remained. |

### Residual Scope

This task proves interface isolation, not an executable package or release. `IFC-V1-050` to `IFC-V1-052` own aggregate deadline, CLI transport, and resource closure; `IFC-V1-021` owns compiled startup/package composition; `IFC-V1-053` to `IFC-V1-058` and `IFC-V1-091` own downstream module and release hardening. Production UI implementation still requires the recorded human visual-direction selection.
