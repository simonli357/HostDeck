# IFC-V1-053 Deterministic Dashboard Assets

Date: 2026-07-28

Status: complete; `WAP-01` to `WAP-24` pass.

## Scope

Build the completed Focus Rail React dashboard with the pinned Vite toolchain, place only its deployable output in `dist/hostdeck/web`, bind that output into the production package manifest and verifier, and serve it through the selected Fastify static boundary in both foreground and service-owned modes.

This leaf owns deterministic web output, a strict runtime web manifest, package and startup identity checks, explicit browser-route fallback, static cache/MIME/CSP policy, relocated read-only serving, a real packaged-browser smoke, and negative mutation evidence. It may tighten the static registration and production startup inputs where necessary to make package/version identity explicit.

Excluded: UI redesign or new dashboard behavior; source-map publication; code-splitting as an unmeasured optimization; install/upgrade/service commands owned by `IFC-V1-056`; uninstall owned by `IFC-V1-057`; clean-Ubuntu parity owned by `IFC-V1-058`; second-engine coverage owned by `FE-V1-040`; visual-diff and copy acceptance owned by `FE-V1-017` and `FE-V1-018`; physical-phone module acceptance owned by `FE-V1-090`; module/release hardening owned by `IFC-V1-091` and release leaves.

## Audit Findings

- Both production process entries already resolve the static root as `<package>/web`, but `scripts/build-production-package.mjs` deliberately excludes the web closure and emits no such directory. A built package therefore cannot start without test-created assets.
- Package schema 3 binds the command, service host, native modules, compiled outputs, and complete tree, but has no web descriptor. Its deferral list still includes `IFC-V1-053`, and the dependency-free verifier cannot distinguish an approved dashboard from arbitrary static files.
- `scripts/run-production-package-smoke.mjs`, `scripts/production-executable-serve.smoke.mjs`, service-host smoke, and user-unit smoke create synthetic `index.html` and JavaScript after copying or verifying the package. Those fixtures prove the static interface, not the shipped product.
- The static boundary already rejects noncanonical roots, symlinks, hard links, hidden/traversal paths, late files, oversized trees, API fallback, implicit index exposure, and unknown browser routes. It sets deterministic no-store or immutable cache policy and delegates MIME/HEAD handling to exact `@fastify/static`.
- The static boundary has no runtime asset manifest, package-version/build-tool check, per-file digest verification, exact inventory agreement, or document CSP. A stale or internally inconsistent web tree can pass startup if it retains one index and one asset.
- Two clean Vite 8.1.4 builds currently emit identical bytes: `index.html` (513 bytes), one CSS asset (115,247 bytes), and one JavaScript asset (1,095,649 bytes). The total deployable payload is 1,211,409 bytes; the JavaScript is 276.51 kB gzip and triggers Vite's 500 kB advisory.
- The current output contains no source maps, source TypeScript/TSX, `/src/` reference, Vite HMR client, `sourceMappingURL`, checkout/home path, or reviewed environment-key literal. The runtime bundle legitimately contains loopback-origin handling and public contract field names, so privacy checks must target values and private paths rather than broad words.
- Browser routes are duplicated in the foreground CLI and service host as `/` and `/sessions/:session_id`. Package output, runtime registration, and browser behavior do not yet share a checked identity for that allowlist.
- Existing Playwright shell evidence runs against `vite preview`, not against the relocated production package. Existing executable evidence checks a synthetic sentinel rather than booting the real React entry.

## Frozen Contract

### WAP-01 Exact Build Input

- `pnpm build` invokes the pinned local Vite 8.1.4 toolchain for `@hostdeck/web` from the frozen workspace and lockfile before package publication.
- The production package consumes a fresh task-owned staging output, never a pre-existing `packages/web/dist`, preview server, source loader, globally installed Vite, or network fetch.
- Build failure names the web-build stage, publishes no partial package, and preserves the last complete package exactly as the existing rollback contract requires.

### WAP-02 Clean Staging And Publication

- Every web staging/output directory begins empty, is canonical, and is removed on success or failure.
- Stale files in source `dist`, package output, prior staging, or a prior package cannot survive into the new web inventory.
- The complete server/CLI/web package is published as one atomic identity; no state can expose new code with old assets or old code with new assets.

### WAP-03 Deployable Output Only

- `dist/hostdeck/web` contains exactly one runtime web manifest, `index.html`, and the manifest-declared regular files under `assets/`.
- No source `.ts`/`.tsx`, declaration, source/declaration map, test, fixture, coverage, Vite cache/HMR/client, public debug file, `.env`, log, database, socket, lock, temporary, or package-manager metadata enters the web tree.
- Directories are `0755` and files are `0644`; no web file is executable, writable by group/other, linked, hard-linked, or outside package ownership.

### WAP-04 Structured Vite Inventory

- Packaging requests a Vite build manifest, parses it as bounded strict JSON, and proves exactly one HTML entry rooted at `packages/web/index.html` plus its emitted CSS/JavaScript/import assets.
- Vite's intermediate manifest is consumed as build evidence and is not shipped or served.
- Missing, malformed, duplicated, escaping, unhashed, undeclared, or unreferenced Vite output fails the build rather than being guessed from filenames.

### WAP-05 Runtime Web Manifest

- The shipped web manifest is deterministic strict JSON with exact schema/name, package version, Vite version, browser-route allowlist, index descriptor, sorted asset descriptors, aggregate file/byte identity, and no timestamp or absolute/private path.
- Every file descriptor binds portable relative path, byte count, SHA-256, media type, and cache policy. Paths are sorted and unique; aggregate counts and bytes are internally consistent.
- The manifest itself is outside its recursive file identity and is bound byte-for-byte by the root production package manifest.

### WAP-06 Version And Route Identity

- Root package version, rewritten `@hostdeck/cli` version, production-package web descriptor, runtime web-manifest version, foreground/service startup expectation, and rendered index version marker agree exactly.
- The web manifest's browser routes equal the one selected production allowlist in exact order and shape: `/` and `/sessions/:session_id`.
- Any schema, package, Vite, route, index-marker, or descriptor version mismatch fails build, package verification, or startup at its owning boundary.

### WAP-07 Index Integrity

- `index.html` is one bounded nonempty canonical regular file whose size and SHA-256 match the web manifest.
- It contains the selected viewport/theme/title/root entry, a package-version marker, and only root-relative manifest-declared `/assets/...` script/style references.
- It contains no inline executable script, external origin, base rewrite, development client, source path, secret, private path, or SPA/API fallback instruction.

### WAP-08 Hashed Asset Integrity

- Every shipped asset is beneath `assets/`, uses a Vite content-hash filename of at least eight safe characters, has an allowed production media type, and matches its descriptor size and SHA-256.
- The on-disk recursive inventory equals the manifest exactly: no missing, extra, late-added, hidden, linked, duplicate-case, traversal, or special entry is accepted.
- File count, per-file bytes, total bytes, depth, and entry limits are lower than or equal to the selected static-boundary ceilings and are checked before readiness.

### WAP-09 Deterministic Identity

- Two clean package builds from unchanged inputs emit identical Vite filenames/bytes, runtime web-manifest bytes, root package-manifest bytes, web identity, and complete package content identity.
- Identity excludes clocks, random values, cwd, checkout, staging, home, username, dirty-worktree state, and host-specific ordering.
- A source or toolchain change must change the relevant digest; rewriting only a manifest digest cannot make changed web bytes valid.

### WAP-10 Build Environment And Privacy

- Vite runs with a bounded build environment that cannot inject ambient `VITE_*`, HostDeck credential, pairing, CSRF, Tailscale, Codex, proxy, or private canary values into output.
- Build and acceptance scans reject checkout/staging/home paths, private-key markers, source maps, HMR/development clients, and explicit secret canaries in the complete package.
- Public contract names, product copy, and loopback-origin classification are not mislabeled as secret leakage; evidence records value-oriented checks.

### WAP-11 Root Package Descriptor

- The root production manifest advances to one exact supported schema and adds a strict `web` descriptor binding root, manifest path/hash/size, package/Vite versions, browser routes, file/byte identity, and index/asset counts.
- `IFC-V1-053` is removed from downstream deferrals while `IFC-V1-056` to `IFC-V1-058` remain explicit.
- Source/output counts retain their server/CLI meaning; complete package content identity includes every web directory/file and the web descriptor without pretending Vite output is TypeScript compiler output.

### WAP-12 Independent Package Verification

- The copied dependency-free verifier validates root schema, web descriptor, runtime web manifest, exact inventory, modes, hashes, versions, routes, index marker/references, and package-tree identity without importing HostDeck code, Vite, or workspace dependencies.
- Verification works from an unrelated read-only relocation and rejects missing/changed/extra web content before any package module is loaded.
- Verification output reports bounded web counts/bytes/digest alongside existing source/output/content facts without exposing private paths.

### WAP-13 Startup Preflight

- The selected static registration receives the expected package version and browser routes from both production entrypoints and verifies the runtime web manifest before listener readiness.
- Startup rechecks canonical manifest/index/assets, exact inventory, digest, version, and route identity. It never trusts only the root package verifier having run earlier.
- Missing, stale, malformed, mismatched, linked, changed, extra, or oversized web state fails before listen/readiness with bounded generic process output and no fallback fixture.

### WAP-14 Mutation Closure After Readiness

- Static serving uses only the startup-validated index and asset inventory, while each send rechecks the current file's canonical regular identity and declared size/hash.
- Replacing, deleting, linking, hard-linking, resizing, or changing a declared file after readiness yields a bounded non-HTML rejection and never serves unverified bytes.
- A late-added file remains unreachable; a changed manifest cannot expand the live inventory without restart and successful preflight.

### WAP-15 Explicit SPA Boundary

- GET/HEAD `/` and valid `/sessions/:session_id` targets return the same verified index; query strings do not alter identity.
- Unknown UI paths, trailing/case variants, malformed/encoded targets, `/assets` variants, and every `/api` or `/api/...` miss return the selected JSON error behavior, never `index.html`.
- POST or another unsupported method to a browser route retains the selected 405/Allow contract and cannot trigger file or API work.

### WAP-16 Cache, MIME, And Method Policy

- Index responses are `text/html`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, and identical for GET/HEAD apart from body semantics.
- Every content-hashed non-HTML asset uses its manifest-declared MIME and `public, max-age=31536000, immutable`; HTML or any deliberately unhashed asset cannot receive immutable caching.
- Missing or denied assets return JSON with no index bytes, sniffable fallback, stale cache success, or filesystem diagnostic.

### WAP-17 Document Security Policy

- Index responses carry one exact CSP that permits scripts, styles, images, fonts, and API/SSE connections only as required by the built same-origin app; it denies object, frame, base, form, media, and foreign network execution.
- No `unsafe-eval`, wildcard source, external origin, data script, blob script, or report endpoint is allowed. Any narrowly required inline-style allowance is explicit and browser-tested against the selected Radix/React behavior.
- Browser evidence records zero CSP violation, console error, page error, external request, or dev-server connection while Mission Control renders and opens one production dialog.

### WAP-18 Foreground And Service Parity

- Packaged `codexdeck serve` and the non-executable service host resolve the same verified package-owned web root, expected package version, and browser routes.
- Neither process accepts a user-supplied asset root, source checkout path, Vite server, or hidden fallback. Foreground/service ownership, loopback bind, Tailscale nonmutation, auth, API, SSE, and shutdown behavior remain unchanged.
- Exact-runtime executable and user-unit smokes use the real packaged dashboard; no post-verification synthetic asset creation remains.

### WAP-19 Relocation And Read-Only Serving

- A complete package copy at an unrelated absolute path is made read-only and serves index plus every declared asset from an unrelated cwd without workspace resolution.
- The verifier, compiled static lifecycle, direct executable, and service/unit paths need no write inside the package and leave package bytes/modes unchanged.
- Archive/package-manager/global-style layouts continue to find the package-owned web tree rather than cwd or install-parent guesses.

### WAP-20 Packaged Browser Smoke

- Current Chromium loads the verified relocated packaged index through the compiled selected Fastify static boundary, executes the real hashed entry, renders Mission Control from bounded intercepted API fixtures, navigates to a valid detail route, and rejects an API miss without SPA fallback.
- The test proves response CSP/cache/MIME/nosniff headers, exact loaded asset URLs, no source map/dev runtime, no external request, no browser storage credential, and no console/page/CSP error.
- Vite build or preview output alone cannot satisfy this criterion.

### WAP-21 Negative Matrix

- Focused tests mutate or remove: root web descriptor, runtime web manifest, manifest schema/version/routes/digest/counts/order, index marker/reference/content/mode, asset name/content/mode, extra/missing asset, Vite intermediate inventory, and package content identity.
- Every mutation fails at build, independent verification, or startup as specified; no source rebuild, broad rescan adoption, prior manifest, or stale successful response repairs it silently.
- Runtime mismatch and all existing command/service/native/link/config failures continue to reject at their original owners.

### WAP-22 Failure Atomicity And Cleanup

- Web build, copy, manifest generation, package verification, static startup, browser startup, listener close, and mutation probes clean every staging root, process, listener, browser, socket, and temporary state on success or failure.
- Repeated package builds and two same-port starts pass with no changed package bytes, active handles, or undeclared files.
- Existing protected user screenshot changes remain unstaged and byte-identical to their preserved backup throughout browser validation.

### WAP-23 Validation Depth

- Required evidence includes focused manifest/build/verifier/static tests; two-build package acceptance; asset-tree/mode/hash/privacy inspection; relocated read-only compiled lifecycle; packaged Chromium smoke; exact-Codex executable and user-unit paths where available; and full unit/contract/integration/web/type/lint/static/package/install/supply-chain gates.
- Manual inspection records actual index/asset names, bytes, hashes, MIME/cache/CSP headers, loaded browser resources, package manifest identities, bundle advisory, privacy findings, and residue.
- A skipped required gate is an explicit blocker or named downstream deferral, never implicit success.

### WAP-24 Scope And Release Truth

- Completion proves only deterministic real dashboard shipping and serving for `IFC-V1-053`, and unblocks dependency-ready install/parity leaves.
- It does not claim persistent installation, uninstall, clean Ubuntu, second-browser support, visual fidelity, final phone acceptance, aggregate interface hardening, or V1 release readiness.
- Owning task, command/developer references, status, artifact, package deferrals, and validation counts agree with the committed implementation. Completed coherent units are committed and pushed without staging protected user artifacts.

## Required Evidence

- Focused Node/Vitest tests for web-manifest construction/parsing, package schema/verification, static preflight and response policy, runtime-version propagation, and mutation closure.
- Two unchanged clean Vite/package builds with exact manifest and package digest comparison plus stale-output and failed-publication probes.
- Relocated read-only package verification/import/static lifecycle and full inventory/mode/hash/source/dev/private-value inspection.
- Real packaged Chromium load through compiled Fastify with Mission Control/detail rendering, response headers, resource inventory, API non-fallback, and zero browser diagnostics.
- Exact packaged executable/service/user-unit smokes using real assets where the already selected Codex/runtime environment is available.
- Full repository tests, root/package typechecks, lint/exports, scaffold, planning, selected runtime boundary, exact Codex binding, frozen install, audit/license, diff/privacy, protected-artifact, process/listener, and temporary-residue checks.

## Implementation Status

- `pnpm build` runs a fresh pinned Vite 8.1.4 build, consumes one strict reachable Vite graph, and atomically publishes schema-4 `dist/hostdeck` with a schema-1 `web/hostdeck-web.json` identity.
- The dependency-free package verifier enforces exact package/web identity, modes, bounds, canonical inventory, hashes, and selected document/response metadata. Fastify startup independently rechecks expected version/routes, strict UTF-8 document structure, safe case-unique hashed assets, bounds, canonical inventory, hashes, media/cache policy, and aggregate identity.
- Foreground, service-host, and user-unit paths use the same package-owned browser routes, expected package version, and read-only web root. Synthetic post-verification assets were removed from every production smoke.
- Static responses revalidate startup-owned files, expose only `/` and `/sessions/:session_id` as browser routes, never fall back for API/unknown paths, and apply exact no-store/immutable, MIME, nosniff, and CSP policy.
- The web entry configures Zod's CSP-safe JIT-less mode before application modules evaluate; packaged Chromium executes Mission Control and Session Detail with no `unsafe-eval` or other CSP violation.

## Validation Evidence

| Evidence | Result |
| --- | --- |
| Final package identity | 614 sources; 1,235 owned outputs; 6,455 entries; 40,010,806 bytes; schema 4; SHA-256 `9d6245f8fd710cedb5a3dfae550b704b6b09bff72a495eb2e727214de89b8c54`; root manifest SHA-256 `f43d822d9e43417a0d635e1348a845efc9944111c6b0b3f4ed5d925864163c25`. |
| Final web identity | 3 files; 1,211,359 bytes; SHA-256 `09c04fc54c8d88ded7dff55f54e8228fc65e6eb01e851a65674bf920a3461752`; manifest 1,142 bytes, SHA-256 `a7ade3f058a5eb8b66d6b9293abeee806c6e2b27250f9c7724004ec45000cb90`. |
| Emitted files | `index.html`: 574 bytes, `3c42c78da55a914c6ebf85e822529548c2386ec868bc4ce4c76587a93f48f995`; `index-3LzRk23X.css`: 115,247 bytes, `cb7969b8b54e43913bf68787b4f76f57dae04fe6744362b602a8065d80375740`; `index-B1DO8ZXw.js`: 1,095,538 bytes, `7510091f740a5baf4315d4724bde930115cb25e024c62138e940f39e0f37684d`. |
| Determinism and mutations | `pnpm test:package` passes two byte-identical clean builds, unrelated-cwd read-only relocation, runtime imports, and root/web/schema/version/route/order/count/index/asset/mode/inventory/native/config/link mutation rejection. The focused Node suite passes 26 checks, including Vite graph reachability and unique ownership, bounded process/env-file/config discovery, strict document and UTF-8, exact directory inventory, root-symlink rejection, and coherently resigned mutations. |
| Runtime/static | Focused affected Vitest: 53 passed, 2 intentional opt-in skips; direct static suite: 5 passed. Exact 0.144.0 executable, service-host, and systemd user-unit smokes pass real package assets; systemd security scores are `9.7/9.7`. |
| Browser | Packaged mobile Chromium: 1 passed through relocated compiled Fastify with exact headers/assets, direct detail navigation, API non-fallback, and zero external request, storage, console, page, or CSP violation. Full production shell Chromium: 168 passed; all generated artifacts were removed and 18 pre-existing user PNG changes remained byte-identical and unstaged. |
| Repository gates | Unit 2,806 passed/28 intentional skips; contract 245; integration 36; web 920; typecheck, lint/8-package exports, scaffold 8 packages/21 scripts, planning 220 tasks/84 requirements/683 dependencies, and selected runtime 614 modules/22 externals pass. |
| Reproducibility and supply chain | Nine-workspace offline frozen install passes. Production audit reports 0 vulnerabilities across 184 dependencies. License inventory contains 172 permissive package records across 175 paths. Exact Codex 0.144.0 binding verifies 671 files at `e1a1a5cff3ab91862f9215dd06538eae1ea0b00bae48cbb7d87061faaee27e24`; default 0.145.0 remains correctly rejected as exact evidence. |
| Reviewed limitation | Vite reports the existing 1,095,538-byte JavaScript chunk advisory (276.57 kB gzip). Code splitting remains an explicit unmeasured optimization outside this leaf; no runtime or package failure is hidden. |

## Remaining Scope

- `IFC-V1-056` to `IFC-V1-058`: persistent lifecycle/install, uninstall, and clean-environment parity.
- `FE-V1-040`, `FE-V1-017`, `FE-V1-018`, `FE-V1-090`: browser matrix, fidelity, workflow/copy acceptance, and final physical-phone hardening.
- `IFC-V1-091` and `REL-V1-004` to `REL-V1-010`: aggregate interface and release hardening.
