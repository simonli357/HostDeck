# IFC-V1-021 Deterministic Production Package

## Purpose

Freeze the first production-output contract before changing the build. This leaf packages the already accepted selected server and source-CLI closure; it does not implement the dashboard, runnable `codexdeck` command, services, installation, or release acceptance.

## Baseline

- `pnpm build` still fails through `scripts/not-implemented.mjs`.
- Workspace package exports point at source TypeScript and no compiled package tree exists.
- The accepted selected production boundary contains 600 server/CLI-owned source modules after excluding the independent two-file web root. Its non-Node runtime dependencies are `@fastify/sse`, `@fastify/static`, `better-sqlite3`, `cookie`, `fastify`, `fs-ext`, `qrcode`, `ws`, and `zod`.
- `IFC-V1-053` owns real Vite assets and `IFC-V1-054` owns the executable, help/version surface, and complete command dispatch. This task must not absorb either outcome.

## Frozen Contract

### PKG-01 Exact Owned Closure

- One clean command emits `dist/hostdeck` from the selected runtime-boundary graph, not a broad source glob.
- HostDeck output contains exactly the production closure for `@hostdeck/core`, `@hostdeck/contracts`, `@hostdeck/codex-adapter`, `@hostdeck/storage`, `@hostdeck/server`, and `@hostdeck/cli`.
- `@hostdeck/web`, `@hostdeck/test-fixtures`, test/smoke/probe support, historical removed interfaces, and undeclared dynamic imports are absent.
- Every selected source emits ESM JavaScript and a declaration file. Package exports resolve only to emitted files.

### PKG-02 Self-Contained Runtime Layout

- The package includes the six rewritten private HostDeck manifests and the complete production dependency graph resolved from the frozen lockfile in offline mode.
- All HostDeck workspace dependency specifiers become exact package-version identities in the runtime manifests. All external direct dependencies remain exact versions; no range, tag, source workspace link, or development dependency survives.
- Every symlink is relative and resolves inside the package. No path, link, manifest, or loader reaches back into the checkout, pnpm store, home directory, or build staging tree.
- Patched Fastify/SSE code in the package is the frozen installed result; package construction does not fetch or silently re-resolve dependencies.

### PKG-03 Deterministic Identity

- The package records schema version, package version, exact Node/pnpm build contract, platform/architecture/Node ABI, reviewed Codex binding identity, selected source count and digest, output count and digest, entrypoints, direct dependencies, native modules, and explicit downstream deferrals.
- Identity contains no clock time, temporary path, username, home path, or dirty-worktree guess.
- Two clean builds from unchanged inputs produce the same owned file inventory and content digest.
- A failed build publishes no partial replacement; stale prior output cannot be mistaken for the current result.

### PKG-04 Source And Asset Policy

- HostDeck-owned output contains no `.ts`, source map, declaration map, inline source, test, fixture, coverage, `.env`, credential, log, SQLite, socket, lock, temporary, editor, or cache file.
- JavaScript source maps are intentionally omitted for this foundation. Declaration files remain because downstream package/type validation consumes them.
- Retained upstream dependency files remain byte-compatible with their published/installed content and may include declarations, maps, source, tests, licenses, or metadata; these are classified as third-party content and cannot satisfy HostDeck output requirements. Generated package-manager launch shims and native rebuild intermediates that are not runtime inputs are omitted rather than rewritten.
- No dashboard `index.html` or web asset is emitted. The package manifest records that assets remain `IFC-V1-053` work.

### PKG-05 Permission Policy

- Package directories are `0755`; ordinary regular files are `0644`; only native modules and dependency manifest-declared binaries are `0755`; group/other write bits are absent.
- HostDeck owns no executable in this leaf. No shebang, `bin` field, or executable HostDeck file may pre-claim `IFC-V1-054`.
- The verifier accepts an equivalent read-only relocation (`0555` directories, `0444` ordinary files) and rejects writable/escaping owned structure where authority would be ambiguous.

### PKG-06 Runtime Compatibility And Integrity

- A dependency-free verifier checks manifest shape, package version, current Node version/platform/architecture/ABI, required entrypoints/native modules, relative in-tree symlinks, and the package content digest before load.
- Missing or changed manifest/owned output, source-map drift, wrong runtime identity, missing native binary, or an escaping/absolute symlink fails nonzero with a bounded diagnostic.
- `better-sqlite3` and `fs-ext` load and perform a minimal real operation from the relocated package; a fabricated native-module success is not acceptable.

### PKG-07 Relocation And Read-Only Execution

- Copy the package to an unrelated absolute path, remove write permission from the complete tree, use an unrelated current working directory, and run without a TypeScript loader or checkout-relative module resolution.
- All six package roots import. The selected composition descriptor remains exactly 22 registrations over the 35-route manifest.
- Compiled Fastify code starts one real IPv4-loopback fixture lifecycle, serves a request, closes cleanly, and restarts on the same port while all writable state/assets remain outside the package tree.
- Package verification and runtime smoke leave no listener, process, socket, database, or temporary root behind.

### PKG-08 Loud Failure Boundaries

- An explicit missing config file fails before command-side effects.
- A missing/noncanonical static build fails before listener readiness; a valid external fixture proves the boundary without claiming built product assets.
- Missing/corrupt native module and incompatible Node/platform/architecture/ABI fail before readiness.
- Missing dependency, package file, or manifest field never falls back to source TypeScript, a global workspace package, a dev server, or a larger/default runtime.

### PKG-09 Build Isolation And Repetition

- The build uses the pinned local Node, pnpm, TypeScript, lockfile, and installed package store in offline mode. Missing prerequisites fail with the owning stage and no partial output.
- Repeated build, verification, relocation, failure injection, and cleanup pass. Existing output containing an undeclared sentinel is replaced rather than retained.
- The package has no absolute link or text reference to the repository and continues to load after relocation.

### PKG-10 Scope And Evidence Truth

- Focused build/manifest/verifier tests, two-build comparison, package-tree inspection, relocation/read-only lifecycle, negative config/asset/native/runtime cases, full workspace/static/install/supply-chain checks, privacy scan, and residue inspection pass.
- Evidence records exact commands, counts, hashes, output size, native identities, changed files, dependency/lockfile truth, remaining gaps, commits, and push state.
- Completion unblocks `IFC-V1-053` to `IFC-V1-058` only. It does not claim a runnable `codexdeck`, full daemon composition, web UI, service unit, installer, clean Ubuntu parity, physical phone behavior, module hardening, or release readiness.

## Required Validation

- Focused build helper/verifier tests.
- `pnpm build` twice with identical package digest and exact stale-output replacement.
- Package inventory, manifests, dependency closure, modes, symlinks, source/map/test/secret scan, native binary inspection, and verifier success.
- Relocated read-only package imports plus real loopback lifecycle/restart.
- Missing config, missing asset, missing/corrupt native module, wrong runtime identity, modified owned file, and escaping-symlink rejection.
- Full unit, contract, integration, web, root/all-package typecheck, lint/exports, scaffold, planning, runtime-boundary, exact Codex binding, frozen offline install, production audit/license, diff, privacy, and residue gates.

## Implementation Status

- Complete. Criteria commit: `a1e5224`; implementation and command-doc commit: `59faa01`.
- `pnpm build` emits and verifies `dist/hostdeck`; `pnpm test:package` owns deterministic repetition, rollback, relocation, runtime smoke, and negative probes.
- No dependency, lockfile, Tailscale state, browser state, phone state, web asset, HostDeck executable, service, or installer changed.

## Implementation Evidence

### Package Identity

| Fact | Result |
| --- | --- |
| Selected source | 600 modules; SHA-256 `3994e39af1623723888b31a6bab887e69909c2d630d56c0cdb0ea3eb144b6521` |
| Owned output | 1,207 files; SHA-256 `3eec1deddf999d6936af9e41f6fa29bb99405ced17b13ce09f490abefd589997` |
| Complete content | 6,409 entries / 38,413,228 bytes; SHA-256 `d94bcbe65ca9f9dc6942653a2048185f2d27b51f0d434528c66a885b43b520b9` |
| Manifest | SHA-256 `d0cf4b33ab97f8eb95fc9273af93340cbe7a02c2576d297e03e9b6a8a5194cd6` |
| Disk usage | 55 MB on the validation filesystem |
| Runtime | Node 22.22.2, pnpm 10.29.2, Linux x64, Node ABI 127 |
| Codex binding | Exact experimental 0.144.0; 671 files; tree SHA-256 `e1a1a5cff3ab91862f9215dd06538eae1ea0b00bae48cbb7d87061faaee27e24` |
| `better-sqlite3` native | 2,118,144 bytes; SHA-256 `df9fbd0d061f360d81fb51e265c53c9605020bd68219e34f33c07c85de15719a` |
| `fs-ext` native | 42,432 bytes; SHA-256 `0883627be339266e1ccd2449b57a54318ff3f576226076c9fbeedce56c8c3025` |

The package has six exact private runtime manifests and no HostDeck `bin`. Internal workspace specifiers are rewritten to exact `0.0.0` package identities; all direct external versions remain exact. All package links are relative, resolve inside the relocated tree, and contain no checkout, store, home, or staging target. HostDeck output consists only of paired ESM JavaScript/declarations and runtime manifests. Web/test roots, source TypeScript, maps, tests, fixtures, credentials, logs, state, and temporary files are absent.

Generated `.bin` shims were omitted because pnpm embeds staging paths in launchers that this library-only package does not use. The installed `fs-ext` node-gyp Makefile/config/object/dependency intermediates were also omitted because they embed checkout/home paths and are not loaded at runtime; the canonical `build/Release/fs_ext.node` is retained byte-for-byte and verified. Other retained third-party files are copied without content rewriting.

### Package Acceptance

- Six focused Node tests pass for exact closure selection, runtime-manifest rewriting, path-sensitive deterministic identity, canonical manifest hashing, exact dependency rejection, and successful/rollback publication behavior.
- Two consecutive offline frozen-lock builds produce identical manifest bytes and content identity. An undeclared stale sentinel is removed; a simulated failed publication restores the prior tree; no staging/previous directory remains.
- A fresh copy at an unrelated absolute path is made fully read-only and run from an unrelated current working directory with `NODE_PATH`, `NODE_OPTIONS`, and TypeScript-loader variables absent. The copied dependency-free verifier passes before and after runtime smoke.
- All six compiled package roots import. The compiled Codex binding equals the package manifest, and the selected descriptor remains 22 registrations over exactly 35 route ids.
- Relocated `better-sqlite3` creates/queries/closes a real external SQLite database; relocated `fs-ext` acquires/releases a real external file lock.
- Compiled Fastify rejects a missing external static root before listener readiness, then starts against a valid external fixture, serves API/static requests, closes, and restarts on the same IPv4-loopback port.
- Explicit missing config, missing manifest field, modified owned output, absolute symlink, missing/corrupt native addon, missing dependency, and mismatched Node/platform/architecture/ABI all fail nonzero without source/global/dev fallback. Diagnostics are bounded and path-independent.

### Repository Validation

| Gate | Result |
| --- | --- |
| Unit | 181 files / 1,773 tests pass; 25 files / 26 intentional external-device tests skip |
| Contract | 32 files / 238 tests pass |
| Integration | 16 files / 25 tests pass |
| Web | 2 files / 20 tests pass |
| Type/lint | Root and all eight package typechecks pass; Biome/package exports pass over 511 files |
| Static planning | Scaffold 8 packages / 21 scripts; planning 212 tasks / 84 requirements / 649 dependencies; selected boundary 602 modules total and exact 600 packaged modules |
| Reproducibility | `pnpm install --offline --frozen-lockfile` passes for all nine workspace projects with no lockfile change |
| Supply chain | Production audit reports no known vulnerabilities; 137 production license entries use MIT, ISC, Apache-2.0, BSD-3-Clause, BlueOak-1.0.0, or recorded permissive choice expressions |
| Privacy/residue | No absolute symlink, checkout/staging reference, package build residue, listener/process/socket/database, or test temporary root remains; the three earlier deploy probes were removed |

## Remaining Scope

- `IFC-V1-053`: real approved Vite dashboard assets.
- `IFC-V1-054`: runnable `codexdeck`, foreground composition, help/version, and command dispatch.
- `IFC-V1-055` to `IFC-V1-058`: user units, install/upgrade/service lifecycle, uninstall, and clean Ubuntu parity.
- No physical phone evidence is required or claimed for this headless package leaf.
