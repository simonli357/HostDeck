# IFC-V1-072 Ownership-Safe Tailscale Serve Manager Evidence

## Outcome

- Implementation: `f09a0d4`; prerequisite observer correction: `8e7491d` (`BUG-008`).
- Added one explicit manager with only `enable` and `disable` entrypoints. Construction, observation, startup, profile return, and polling have no mutation path.
- Every call validates one stable expected-profile comparison key and one canonical private HTTPS-443/root-to-loopback descriptor. Overlapping calls reject without queueing.
- Preflight requires the exact supported 1.98.8 observer result, running dedicated-profile match, expected external origin, no `AllowFunnel`, and action-compatible Serve ownership. Incompatible client, profile, origin, foreign/colliding/drifted/public, schema, and observation states issue no command.
- Enable runs only `/usr/bin/tailscale serve --bg <exact-loopback-origin>` from absent state. Disable runs only `/usr/bin/tailscale serve --https=443 --set-path=/ off` from exact state. Already-exact enable and already-absent disable are proven unchanged without mutation.

## Mutation Boundary

- The real runner accepts only the two frozen argv forms and `/usr/bin/tailscale`; reset, Funnel, profile, login/logout, up/down, service, certificate, listener, and network-fallback requests reject structurally.
- Commands run with no shell, no stdin, `/` cwd, the exact four-variable environment, one lifecycle signal, and existing aggregate byte/per-command time bounds. Raw stdout/stderr and error causes are never returned, logged, audited, or retained.
- Bounded output scanning recognizes only fixed consent and permission indicators. Output overflow and cancellation outrank untrusted markers.
- At most one mutation command is attempted. There is no retry, compensation, broad reset, overwrite, deletion of ambiguous state, profile switch, or automatic repair.

## Result Truth

| Observation | Result |
| --- | --- |
| Desired post-state | `succeeded` with `applied` or `removed`; read-back outranks command exit. |
| Already desired before dispatch | `succeeded` with `unchanged`; no command. |
| Original state unchanged after dispatch | `failed` with a bounded consent/permission/timeout/oversize/schema/command/abort reason. |
| Profile, origin, version, schema, observer, or conflicting Serve ambiguity after dispatch | `incomplete` with `unknown`; no retry or compensation. |
| Incompatible preflight | `rejected` with `not_attempted`; no command. |

Malformed or thrown preflight observations become one typed no-mutation error without cause retention. Any post-dispatch observation failure becomes a redacted incomplete result; lifecycle cancellation remains distinct. Internal result-shape guards reject contradictory outcome/command/read-back combinations.

## Real Evidence

- Exact dedicated-profile smoke started an ephemeral `127.0.0.1` HTTP target from an empty Serve baseline, enabled private Serve, read back `exact`, repeated enable without a command, reached the target through trusted Tailscale HTTPS with the expected external Host and loopback source, removed only root, repeated disable without a command, and independently proved final absent state.
- The smoke ran again after final hardening and left no `ChildProcess` resource active.
- A controlled alternate-profile audit selected the one saved other profile outside product code. Manager enable and disable both rejected with zero runner calls; alternate ServeConfig/profile metadata were semantically unchanged; the original dedicated profile and empty ServeConfig were restored exactly.
- A controlled dedicated-profile foreign-state audit added one `/foreign` handler outside product code. Both manager actions rejected as drift with zero runner calls; the full ServeConfig and saved profiles remained unchanged; exact `/foreign` cleanup restored the empty baseline.
- `BUG-008` corrected the completed observer after live enable exposed that exact 1.98.8 routes both Serve/Funnel JSON status commands through the same ServeConfig reader. Equality is now a consistency check and only `AllowFunnel` marks public state.
- No account, profile, node, DNS, address, credential, consent URL, identity header, raw CLI output, or foreign payload is retained in code, test output, docs, or artifacts.

## Validation

- Focused manager: 47 passed. Corrected focused observer: 23 passed. Real manager lifecycle: 1 passed on repeated final runs. Real active observer, alternate-profile, and foreign-state checks passed.
- Contract: 228 passed. Unit: 1,126 passed and 32 explicit device/external skips across 136 files. Integration: 16 passed. Web: 14 passed.
- Root and all-package typechecks passed. Lint/exports passed for 355 files and 9 packages. Scaffold passed for 9 packages and 18 root scripts.
- Planning passed with 212 tasks, 84 requirements, 649 dependencies, and 19 queued before closure. Focused tests, typecheck, lint, live smoke, command/privacy review, active-resource inspection, and `git diff --check` passed after the final invariant change.

## Remaining Gate

- This leaf owns the local-admin mutation boundary, not durable intent/audit orchestration, selected API/CLI handlers, proxy-source trust, browser pairing, lifecycle composition, or physical phone acceptance. Those remain in `IFC-V1-073` to `IFC-V1-079`.
- ADB did not enumerate the connected phone during aggregate validation. No physical-phone result is claimed by this leaf.
