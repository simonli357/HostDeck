# Architecture And Implementation Review — 2026-08-21

Repository review at `2b80f38`. Records what was found, what was fixed in place, and the
verified constraints that block the remaining items from being done as ad-hoc sweeps.

Findings were produced by direct source inspection and measurement. Every proposed
remediation was then put through independent adversarial verification; three of the
proposed designs were refuted, and those refutations are recorded here because they are
the binding constraints on the follow-up tasks.

## Fixed In This Pass

| ID | Defect | Fix | Evidence |
| --- | --- | --- | --- |
| `BUG-090` | `packages/core/src/remote-ingress.test.ts` fails intermittently at its explicit 10,000 ms limit. | Accumulate mismatches in the loop; assert once. | 54,432 assertions to 4; 5,200 ms to 42 ms of test time. Mutation-verified: reverting `serve_drifted` to fall through is caught and reports `enabled/current/available/dedicated/drifted/true/null -> admission=open availability=ready reason=null`. |
| `BUG-091` | `docs/planning/04-technical-plan.md` states nine facts that no longer match the workspace. | Correct all nine; add `scripts/technical-plan-facts.mjs` and wire it into `pnpm check:planning`. | 23 facts now machine-checked. Mutation-verified against version drift, count drift, and claim rewording. |

### `BUG-090` detail

Seven nested loops over `2 x 3 x 4 x 6 x 7 x 2 x 9 = 18,144` tuples with three `expect()`
calls each. The function under test is not slow: the loop body alone costs 13.8 ms.
Roughly 99.6 percent of the runtime was `expect()` overhead at about 58 microseconds per
call. The same pattern in `packages/web/src/mission-control.test.tsx` (3,782 assertions,
3,026 ms measured under load against the 5,000 ms default) was fixed identically.

All four Vitest configs use the 5,000 ms default; none sets `testTimeout`. The 10,000 ms
seen on the failing test was a per-test literal, which overrides even a CLI
`--testTimeout`. Exactly one test in the repository exceeded 5,000 assertions; the
runner-up was 3,782 and third place dropped to 500, so this was one acute outlier plus
one near-miss rather than a widespread pattern.

### `BUG-092` — attempted and reverted

`sensitiveDetailKeyPattern` (`packages/core/src/errors.ts:91`) is
`/(authorization|cookie|password|secret|token)/iu`. Measured, it accepts `credential`,
`csrf`, `csrf_hash`, `bearer`, `pairing_code`, `passphrase`, `signature`, `nonce`, `otp`,
`pin`, `api_key`, `node_key`, and `private_key`. In a codebase whose doctrine is that no
secret is reflected, the guard is close to cosmetic. No production code passes `details`
at all, so it is latent rather than live.

Widening it to 23 credential shapes, anchoring `key`/`pin`/`otp` to the final `_` segment
so `key_count_total` and `pinned` stay usable, was implemented and then **reverted**
because it broke 10 CLI client suites. The cause is a real design constraint, not a bad
pattern:

`throwCliApiFailure` (`packages/cli/src/loopback-http.ts:161`) validates the *inbound*
server envelope through `apiRouteErrorBodySchema`, whose `superRefine` calls the same core
guard. Widening it makes a hostile-but-typed server response fail structural validation, so
a `validation_error` collapses to `internal_error` and the caller loses the actionable
code and message. The ten affected tests deliberately feed a hostile envelope
(`details: { private_key: "private" }`) and assert the CLI sanitises rather than collapses.
`:170` already discards `details` entirely before the second parse, so rejecting on a key
name at `:161` gains no privacy and costs error fidelity.

The guard belongs on the producing path only. Splitting produce-side from parse-side
validation is a contract change across `@hostdeck/core` and `@hostdeck/contracts` with its
own tests, which is why it is `FND-V1-106` rather than an in-place edit.

### `BUG-091` detail

| Claim | Stated | Actual |
| --- | --- | --- |
| `@fastify/static` | 9.3.0 | 10.1.2 |
| React Router | 8.2.0 | 8.3.0 |
| `better-sqlite3` | unpinned | 12.11.1 |
| `cookie` | absent from the plan | 1.1.1 |
| Node docs reference | v22.15.0 | 22.22.2 is the pinned runtime |
| `codexResourceOptionsFromBudget` protocol values | 20 | 26 |
| Production source modules | 633 | 638 |
| Selected API routes | 35 | 38 |
| Route registrations | 22 | 23 |

`scripts/check-planning.mjs` reads only the backlog, block filenames,
`02-requirements.md`, and `06-tasks.md`. It never opens `04-technical-plan.md`, never
reads a `package.json`, and never counts anything in code, so every drift above could
persist with all gates green. The numbers under machine enforcement were exactly the
numbers the plan had fallen behind.

`docs/delivery/10-repo-guide.md` also described `packages/web`, `packages/cli`, and
`packages/server` as unimplemented or downstream, several epics after they shipped; those
rows were corrected in the same pass.

## Open Findings With Verified Constraints

### No runtime diagnostic channel — `IFC-V1-111`

`packages/server`, `packages/storage`, and `packages/codex-adapter` contain zero
`console.*`, `process.stdout`, or `process.stderr` writes in production code. Fastify is
constructed at `packages/server/src/fastify-app.ts:208` with no `logger` option. An
internal 500 flows `handleHostDeckFastifyError` to `observeInternalFailure` to
`reportHttpIssue` (`production-foreground-serve.ts:981`) to `report("http",
"internal_error")`, discarding the `Error`, its message, and its stack.
`createIssueReporter` (`:955`) then retains only a count and the single most recent issue.
A `req_<uuid>` is minted per request at `fastify-app.ts:189` and correlated to nothing.

A local file sink was designed and **refuted on both security and architecture grounds**.
Binding constraints for the implementing task:

1. Error messages carry private paths. `packages/storage/src/branch-metadata.ts:55`
   interpolates `cwd` verbatim, and Node errno messages embed absolute paths (measured:
   `ENOENT: no such file or directory, open '/home/…/no-such-file-xyz'`). Free-form
   `error.message` must never reach the sink.
2. `HostDeckInternalErrorObservation` (`fastify-error-policy.ts:17-21`) is exactly
   `{ error, request_id, framework_code? }`. It carries no route, so any route-template
   promise is unobtainable at that seam without a contract change.
3. `production-application-composition.ts:250-256` enforces an exact `inputKeys`
   allowlist; adding a field throws.
4. `packages/storage/src/linux-secure-local-path-adapter.ts` contains no `O_APPEND`. The
   secure-open helpers give no append descriptor, so "reuse the existing secure open" is
   not available as stated.
5. `selectedHostLocalHealthCauses` (`contracts/src/host-health.ts:34-60`) is a closed
   26-member enum; a sink-degradation cause is not expressible without a wire-schema
   change.
6. Uninstall's exact-entry allowlist does not cover a new state-directory file, so the
   sink would be permanent residue and would contradict `IFC-V1-057`.
7. `SFR-006`, via `REL-V1-005` criterion `SPR-17`, explicitly bans retained prompt or
   transcript text, raw output, and private origin, IP, or path values.
8. The serve unit-test harness `resources` fixture
   (`production-foreground-serve.test.ts:489-530`) has no `paths` property, and the
   startup `catch` at `:488-524` runs before the owner that would close the sink exists.

### Duplicated deep-freeze and option-parser helpers — `FND-V1-103`

102 `deepFreeze` definitions (98 non-test: server 45, cli 19, web 15, scripts 6,
codex-adapter 5, test-fixtures 4, storage 3, contracts 1), 19 `readExactOptions`
definitions all in `packages/cli`, and 103 files using `Object.getOwnPropertyDescriptors`
for option parsing.

A new shared module was proposed and **refuted**. Binding constraints:

1. `packages/contracts/src/exact-data-object.ts` already exists and is the repo's
   established shared exact-data module, exporting `exactDataObject`, `exactDataArray`,
   and `exactDataTree` and consumed by six sibling modules by relative path. Extend it
   rather than creating a new one.
2. The 102 definitions are 18 text-distinct groups collapsing to 7 behaviour classes, not
   one. `packages/codex-adapter/src/reconnect-controller.ts:1468` throws on `null` and
   `undefined` where every other variant returns the argument. `security-mutation-audit-validation.ts:260`
   is the only exported one and is public surface across a module boundary.
3. The repo's actual doctrine for deep traversal is a WeakSet cycle guard plus depth 64
   and node 8,192 bounds plus descriptor and prototype checks, duplicated verbatim
   between `contracts/src/exact-data-object.ts:6-7,99` and
   `server/src/session-read-routes.ts:592`. That pair is the consolidation worth doing.
4. `productionPackageSourceCount = 638` is asserted in five places
   (`verify-production-package.mjs:14`, `build-production-package.mjs`,
   `run-production-package-smoke.mjs`, `production-package.test.mjs:103`,
   `production-service-lifecycle.smoke.mjs:95`) and cited in six docs and artifacts.
   Adding or removing a production module must update all of them in the same commit.
5. Serving `cli`, `server`, `storage`, and `web` from one copy requires promoting the
   helper to the public `@hostdeck/contracts` index, which is pinned to exactly 24
   specifiers in `check-selected-runtime-boundary.mjs:97-124`.

### Nine-fold operation vertical — `FND-V1-104`

Each of nine Codex operations carries a `codex-*-control-service.ts` (405 to 1,208
lines), an `*-routes.ts` (435 to 793), a `cli/*-client.ts` (about 200 to 260), a
`web/*-control-state.ts` (801 to 1,397), and a `web/*-control.tsx` (320 to 843): about 45
files and 30,000 lines of one repeated shape. `packages/cli/src/model-client.ts` and
`plan-client.ts` differ by 42 diff lines out of about 250 once the operation name is
normalised, and the same `case "session_not_writable"` error switch appears at 36 sites.

`selectedApiRouteManifest` already proves the table-driven approach for routes. The
per-operation correlation assertions such as `assertSelectionCorrelation` encode real
`DEC-023` semantics and must stay as descriptor callbacks rather than being generalised.

This is explicitly too broad for one leaf task under `AGENTS.md`; `FND-V1-104` owns the
descriptor design and the decomposition, not the sweep.

### Exact Codex version equality — `INT-V1-110`

`packages/codex-adapter/src/compatibility.ts:127` rejects any version other than the exact
pin. The development machine has already drifted to 0.146.0, and `BUG-083` records real
sessions from 0.130.0 through 0.146.0. A shipped package therefore stops working on the
next Codex release, with reinstalling one exact version as the only remedy.

`capabilityRules` in the same file already enumerates the required client methods, server
notifications, and turn fields, so a capability-verified acceptance band is expressible
today. Changing the gate supersedes `DEC-021` and needs evidence first, which is what
`INT-V1-110` produces.

### Resource observations are specified but never emitted — `IFC-V1-112`

`docs/planning/04-technical-plan.md` gives all 99 resource limits a
`hostdeck.resource.<key>` observation name. That string occurs three times in source, all
in `packages/contracts/src/resource-policy.ts` and its contract test. Nothing emits.

### Credential-named error details — `FND-V1-106`

See `BUG-092` above. The widened pattern is recorded there; the task owns the produce
versus parse split that makes it landable.

### Process vocabulary in permanent identifiers — `FND-V1-105`

Twenty non-test files are named `selected-*`, and the prefix reaches public types such as
`SelectedSessionListResponse` and `compareSelectedSessionListOrder`. It meant "the chosen
path, not the rejected tmux or LAN path"; tmux was removed in `INT-V1-008`, so the word
now carries no information. `docs/tracking/backlog/tmux-output.md` likewise still carries
the name of a removed backend.

## Not Addressed Here

- `packages/cli/src/service-lifecycle.test.ts:640` fails independently of this work with
  `promise rejected "HostDeckServiceLifecycleError" instead of resolving`, from
  `requireUninstallStopped` at `service-lifecycle.ts:1390`. Pre-existing; not a timeout
  and not the loop pattern.
- `BUG-093` / `FND-V1-107`: the unit gate is not deterministic. A clean sequential
  `pnpm test:unit` on an idle 16-core machine failed 14 tests across 11 files, every one a
  5,000 ms timeout with zero assertion failures, clustered at 5,000 to 5,800 ms. The same
  ten files then passed 112/112 in isolation both with and without the remediation
  changes, and those changes have no import reachability into them (`scripts/**` is in no
  vitest include; the two edited test files are imported by nothing). Running two suites
  concurrently raised it to 42 failures. Because every completion claim in this repo cites
  a unit-suite pass, this undermines the evidence model itself and is filed as its own
  task rather than absorbed into `BUG-090`.
- Three genuinely I/O-bound slow tests are unrelated to assertion overhead and need
  separate attention. `selected-session-read-repository.test.ts:271` seeds 4,096 real
  SQLite rows and ran 107,394 ms against a 90,000 ms budget in the clean run, having been
  measured at 77,952 ms earlier.
- `packages/storage` uses synchronous `better-sqlite3` on the event loop while SSE fanout
  is live. Acceptable for one user; worth measuring under real token-streaming event
  rates before release.
- Several files exceed what `docs/engineering-style.md` calls testable size:
  `cli/service-lifecycle.ts` at 3,584 lines, `web/connection-state.ts` at 2,621,
  `cli/shell.ts` at 2,177, and `createHostDeckProductionApplication` as a single 743-line
  function.
