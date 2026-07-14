# IFC-V1-071 Tailscale Observer Evidence

## Outcome

- Implementation: `54646b5`.
- Added one read-only observer for the spike-frozen Tailscale 1.98.8 shape. It invokes only `/usr/bin/tailscale version`, `status --json`, `switch --list --json`, `serve status --json`, and `funnel status --json`.
- Every process uses `/` as cwd, an exact four-variable environment, bounded aggregate stdout/stderr bytes, a per-command timeout within one complete-cycle deadline, and the observer lifecycle `AbortSignal`.
- Strict parsing requires the exact client/daemon version, exactly one selected saved profile, status/profile agreement, and stable identity across bracket reads. Output contains only normalized state, a domain-separated SHA-256 comparison key, canonical origin, Serve class, bounded failure, and timestamp.
- `BackendState` is authoritative for stopped and signed-out states. The exact observed stopped shape permits nullable retained status fields while keeping the selected profile list authoritative.
- Selected-profile Serve is classified as absent, exact, foreign, colliding, drifted, or public. On exact 1.98.8, both Serve and Funnel JSON status forms return the same complete ServeConfig; the observer requires equality across those bounded reads and treats any `AllowFunnel` field as public. A different selected profile is reported without reading its Serve state.
- Concurrent identical observations coalesce; a distinct concurrent observation rejects. Broken clocks/configuration fail loudly. Unsupported versions, process/schema failures, timeout, oversize, and profile changes are explicit and retain no raw output or error cause.

## Ownership And Safety

- The adapter contains no profile switch, `up`, `down`, login/logout, Serve/Funnel mutation, daemon/service control, node-key access, listener, certificate, or network-fallback path.
- The real runner rejects any request whose executable, arguments, cwd, environment, bounds, or signal do not match the frozen read inventory.
- Profile comparison excludes mutable nickname and never exposes account, profile id, tailnet, node, peer, IP, certificate domain, or raw JSON.
- The controlled lifecycle smoke changed daemon/profile state outside the product adapter, restored the original selected profile and running state, and proved the nonselected profile metadata plus dedicated Serve and Funnel state were semantically unchanged.

## Defects Found During Real Validation

- The first live version probe exposed an incorrect empty argument vector. The frozen command is now exactly `version`, covered by fake and live tests.
- The other saved profile exposed the exact stopped 1.98.8 shape with nullable current-tailnet, user, peer, certificate-domain, and IP fields. Parsing is now state-aware and rejects partial or contradictory retained identity.
- Final audit added a post-run cancellation check and stopped translating impossible internal clock failures into ordinary command failures.
- `BUG-008`: the initial fixtures incorrectly modeled `funnel status --json` as a distinct empty projection while private Serve was configured. Exact source and live reads proved both status commands return the same ServeConfig. The observer now requires parsed equality, classifies public state only from `AllowFunnel`, fails disagreement as `schema_invalid`, and has a focused regression plus real private enable/read-back/remove smoke.

## Validation

- Focused observer tests: 22 passed, including commands/environment/bounds, all normalized states, six Serve classes, Funnel handling, ambiguity, profile race, coalescing, cancellation, cycle deadline, hostile values, privacy, and mutation-request rejection.
- Contract tests: 228 passed. Resource policy now has 84 definitions, including five remote-observer bounds and command-within-cycle validation.
- Full unit suite: 1,078 passed and 31 device/external tests skipped across 134 files.
- Integration: 16 passed. Web: 14 passed. Root and all-package typechecks passed.
- Lint/export check: 352 files and 9 packages passed. Scaffold: 9 packages and 18 root scripts. Planning: 212 tasks, 84 requirements, 649 dependencies, and 19 queued.
- Real active-profile observer smoke passed after final hardening and left no child-process resource active.
- Controlled real lifecycle matrix passed for dedicated active, dedicated stopped, another selected saved profile, restore, and dedicated active again. Profile, Serve, and Funnel noninterference checks passed after restoration.
- `git diff --check` and manual command/privacy/failure/cleanup review passed.

## Remaining Gate

- No remote-phone acceptance is claimed here. The phone was not enumerated by ADB during the final rerun; physical unrelated-network browser acceptance remains owned by `IFC-V1-079` after the complete ingress path exists.
