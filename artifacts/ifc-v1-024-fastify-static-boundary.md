# IFC-V1-024 Fastify Static Boundary

Date: 2026-07-10

## Scope

Implement one explicit `static` route registration over `@fastify/static` 9.3.0 and a required built-asset fixture. This leaf owns build-root admission, asset inventory, request-path denial, explicit browser shell routes, static response policy, and API/not-found separation. It does not own Vite output, production listener composition, package integrity, browser security headers, or phone UI fidelity.

## Harsh Success Criteria

- Registration accepts only exact-key plain input, one canonical absolute build root, a bounded explicit route allowlist containing `/`, and literal or whole-segment parameter route templates. Duplicate routes, equivalent dynamic shapes, API/assets overlap, wildcards, hidden paths, and oversized templates fail before Fastify composition.
- Readiness requires a canonical real build directory, one nonempty bounded canonical `index.html`, one canonical `assets/` directory, and a bounded nonempty tree containing only visible regular non-linked files and real directories. File, entry, depth, per-file, and aggregate-byte ceilings fail closed.
- Only asset paths inventoried at readiness are addressable. The send callback rechecks current file type, link count, byte ceiling, and canonical path; post-ready additions and file/index replacement by symlink fail as JSON 404 without content disclosure.
- Raw asset targets are decoded once and reject malformed/residual encoding, empty/dot/dot-prefixed segments, backslashes, controls, and traversal. Plugin-level `dotfiles: "deny"`, `serveDotFiles: false`, and `allowedPath` enforcement remain defense in depth.
- Only explicit GET/HEAD browser routes receive `index.html`. API misses, unknown browser paths, trailing-slash variants, missing assets, reserved index lookup under `/assets/`, and wrong methods remain stable JSON errors and never fall through to HTML.
- Hashed non-HTML assets receive one-year immutable caching; HTML and unhashed assets receive `no-store`. MIME, `nosniff`, GET, HEAD, body length, nested files, and query-bearing asset URLs match the pinned plugin.
- The app remains unbound until an owner explicitly listens. A test-owned ephemeral loopback socket is used only to preserve literal/encoded dot segments that the injection client canonicalizes.

## Pre-Change Findings

- The pinned plugin passes `allowedPath` a relative pathname with one leading slash. Rejecting every leading slash denied valid assets; accepting more than one would admit duplicate-slash normalization. The adapter now permits exactly the plugin-owned leading slash.
- The same callback is used by `reply.sendFile()` with its explicit root override. Root identity must therefore be part of admission: the build root can serve exactly `index.html`, while the assets root can serve only inventoried paths.
- When a matched static wildcard calls Fastify's not-found handler, the app factory previously found the wildcard's automatic `HEAD` route and misclassified a GET miss as 405. `allowedMethodsForUrl` now returns 404 when the current method already matched a route; a pinned-plugin missing-file regression covers `BUG-003`.
- Light-my-request canonicalizes literal and percent-encoded dot segments in some injected URLs before Fastify receives them. Literal wire-target denial is therefore proven with Node's raw HTTP `path` option against a loopback listener, not inferred from injection.
- Parallel validation exposed an unrelated fixture defect: monotonic `performance.now()` timestamps are fractional, so subtracting expiry/start can differ infinitesimally from an integer timeout. The fixture now validates a positive number and asserts close-to policy instead of requiring exact integer serialization (`BUG-004`).

## Implemented Contract

### Registration And Startup

`createHostDeckStaticBoundaryRegistration` returns a frozen `HostDeckRoutePluginRegistration` with surface `static`. It copies a maximum-64 browser route allowlist and rejects reserved `/api` and `/assets` families. Route templates are bounded to 512 bytes, 16 segments, 64 bytes per segment, canonical literal segments, or canonical named parameters; equivalent parameter shapes cannot be registered twice.

Readiness canonicalizes the build, index, and assets roots. The index is nonempty, regular, single-linked, canonical, and at most 2 MiB. Recursive asset inventory allows at most 16 directory levels, 20,000 entries, 10,000 files, 32 MiB per file, and 256 MiB total. Hidden/residual-encoded names, controls, symlinks, hard links, special files, and canonical-path escape fail registration through the app factory's causal startup error.

### Send Boundary

The plugin root is exactly `<build>/assets` with prefix `/assets/`; directory index and redirect behavior are disabled. Raw request admission decodes the path once and emits the stable `route_not_found` envelope before file lookup for malformed, duplicate-slash, dot, traversal, backslash, or residual-encoding targets.

The plugin callback admits only the startup inventory and rechecks the current file with `lstat` plus `realpath`. A build-root override is accepted only for the constant `index.html` shell path. This prevents serving safe-named files added after readiness and rejects path replacement by symlink, hard link, directory, oversized file, or canonical escape. Same-inode content mutation and cryptographic package integrity remain packaging/release responsibilities.

### Response And Fallback Policy

Explicit browser GET/HEAD routes send only the validated shell. Hashed JS/CSS and other non-HTML assets receive `public, max-age=31536000, immutable`; all HTML and unhashed assets receive `no-store`. Every successful static response sets `X-Content-Type-Options: nosniff`, while the plugin owns MIME, content length, and HEAD behavior.

There is no SPA catch-all. `/api/*`, unknown routes, trailing-slash variants, missing files, and static attempts to reach the root index flow through the app factory's stable JSON 404/405 policy. The request-id and in-flight accounting contracts remain intact after successful, denied, missing, HEAD, and raw-socket cases.

## Validation

| Command / inspection | Result |
| --- | --- |
| Focused static boundary matrix | Pass; 4 tests cover strict input copying, browser/API separation, MIME/cache/HEAD, hashed HTML precedence, raw/encoded traversal, post-ready additions/replacements, and 15 hostile startup fixtures. |
| Pinned app-factory/static regression | Pass; valid static GET and handler-declared missing-file 404 coexist without false 405. |
| Test-owned raw HTTP probe | Pass; literal and encoded parent traversal receive bounded JSON denial and disclose neither shell nor outside content. |
| Manual implementation/diff review | Pass; only two validated roots are reachable, no implicit index/catch-all/build/listener dependency exists, and downstream ownership remains explicit. |
| `pnpm check:scaffold` / `pnpm check:planning` / `pnpm check:codex-bindings` | Pass; 9 packages/18 scripts, 196 tasks/84 requirements/622 dependencies/5 queued before task transition, and exact 0.144.0 identity across 671 files. |
| `pnpm typecheck` and `pnpm -r typecheck` | Pass for root and all 9 packages. |
| `pnpm test:unit` | Pass; 408 tests, 18 explicit external/real-process tests skipped. |
| `pnpm test:contract` | Pass; 111 tests. |
| `pnpm test:integration` / `pnpm test:web` | Pass; 16 integration and 14 web tests. |
| `pnpm lint` | Pass; repository formatting/lint and all 9 package exports. |
| `pnpm audit --prod --json` | Pass; 0 vulnerabilities across 121 production dependencies. |
| `git diff --check` | Pass. |

## Remaining Ownership

- `IFC-V1-021` supplies deterministic real Vite output and proves the actual emitted asset layout against this boundary.
- `IFC-V1-025` composes this registration into startup/listen/readiness/drain/close ownership. The loopback test here is not production listener evidence.
- `IFC-V1-017`, `IFC-V1-026` to `IFC-V1-031`, and `IFC-V1-045` own transport trust, authentication, CSRF, rate limits, browser security headers, and aggregate security review.
- `IFC-V1-053`, packaging tasks, and release hardening own installed build-root permissions, content/package integrity, compiled layout, and clean-machine evidence.
- Reopened `FE-V1-002` and the later UI-fidelity leaves own mobile-first visual direction, real phone states, and screenshots; this task serves bytes only.
