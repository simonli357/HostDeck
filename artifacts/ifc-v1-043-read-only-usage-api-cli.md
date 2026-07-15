# IFC-V1-043 Read-Only Usage API And CLI

Date: 2026-07-15

## Target

Expose the completed structured usage runtime through the exact authenticated selected GET route and a laptop-local `codexdeck usage <session-id> [--json]` command. The boundary must preserve account, thread, and runtime scope; report missing observations honestly; and remain incapable of starting, steering, mutating, auditing, retrying, or parsing terminal output.

## Pre-Change Findings

- The selected manifest already freezes `GET /api/v1/sessions/:session_id/usage` with loopback-or-device-cookie read authority, no CSRF, lock, audit, credential effect, query, or body.
- `usageSnapshotSchema`, `createCodexUsageClient`, and `createCodexUsageControlService` already enforce bounded account counters/buckets, exact target and runtime generation, explicit thread/rate-limit observation absence, target checks before and after the runtime read, and no retry or mutation.
- The public route identifies a HostDeck session, while the control service intentionally requires a complete managed session/thread target plus an internal operation id. No selected bridge currently resolves that identity without accepting a caller-supplied Codex thread id.
- No selected usage route, loopback usage client, usage CLI command, or truthful text renderer exists. Production aggregate registration remains downstream `IFC-V1-046`.

## Hard Success Criteria

| Area | Required evidence |
| --- | --- |
| Session target | The route accepts one valid HostDeck session id only, resolves its current durable Codex thread internally, validates mapping/projection identity, and gives the runtime service a strict internal usage intent. The caller cannot supply or override a thread id or operation id. |
| Read semantics | One admitted request performs at most one `usage.read` call with the unchanged managed request abort signal. It has no write-gate, lock, CSRF, audit, terminal, turn, retry, filesystem, or shell port. |
| Runtime truth | The returned snapshot must parse through `usageSnapshotSchema` and match the resolved session/thread exactly. Account totals remain account-scoped; thread/context and rate-limit observations remain optional same-generation observations; null is never rendered as zero or unlimited. |
| Route contract | Registration refuses drift from the exact `usage_read` manifest row, disables implicit `HEAD`, rejects query/method/path variants, sets `no-store`, and authenticates before parameter, state, or runtime access. |
| Authorization | Safe loopback plus paired read/write devices may read. Invalid, expired, revoked, duplicate, or absent remote credentials and Tailscale identity without a valid HostDeck device cookie cannot reach state or runtime ports. |
| Public failures | Malformed params, missing target, archived/unreadable target, stale/mismatched target, unsupported capability, unavailable runtime, service overload, protocol/observation conflict, storage failure, malformed service output, and unexpected internal failure remain distinct where public truth permits and never expose causes, credentials, thread ids, paths, or raw runtime text. |
| CLI client | Only one exact direct-loopback HTTP base is accepted. The session id is validated before request, one bounded no-store GET is issued, no retry occurs, typed API errors are sanitized, and malformed, oversized, cross-session, incomplete, or invalid JSON cannot reach rendering. |
| CLI surface | Parser/help expose only `codexdeck usage SESSION_ID [--json]`; no thread-id, raw slash, command, terminal, remote-origin, mutation, or extra positional override is accepted. This branch runs before legacy API/local-admin construction. |
| Rendering | Text and JSON revalidate the complete snapshot and stay within the CLI output budget. Text distinguishes null account history, empty history, unobserved thread/rate state, nullable context, nullable windows/reset times, and actual zero values without monetary or unlimited-quota inference. |
| Validation | Direct route, target-resolution, auth/Tailscale, runtime-service composition, CLI client/parser/shell/render, hostile input, privacy, and no-retry tests pass, followed by affected/full workspace gates and manual source/output inspection. |

## Planned Scope

- Add one standalone selected usage Fastify registration that snapshots only selected-state `get` and usage-service `read` ports, resolves the managed target internally, and maps typed failures.
- Add one bounded direct-loopback usage client plus parser/help/shell/render support with human and JSON output.
- Add focused contract-boundary tests and update package exports and the source-command reference.
- Do not add production aggregate wiring, mobile UI, persistence, audit records, mutation gates, dependencies, setup changes, or runtime protocol changes.

## Evidence

### Implemented Boundary

- `@hostdeck/server` now owns one standalone `selected-usage-read` registration. It snapshots only exact `state.get` and `usage.read` methods, resolves the Codex thread from one schema-validated selected mapping/projection, creates an internal usage intent, passes the managed request signal, reparses the complete response, and rejects cross-session/thread output.
- The route binds only `GET /api/v1/sessions/:session_id/usage`, rejects all query fields and adjacent methods/paths, disables implicit `HEAD`, sets `no-store`, and authenticates before params, state, or runtime access. Its manifest assertion fixes read authority, no CSRF/lock/audit, no credential effect, and `IFC-V1-043` ownership.
- Every typed control failure has a fixed public status/code/message. Missing, unreadable, stale, mismatched, unsupported, unavailable, overloaded, protocol-conflicting, storage-failed, malformed-output, and unexpected states remain bounded and cause-free.
- `@hostdeck/cli` now owns a dedicated exact-loopback usage client and `codexdeck usage SESSION_ID [--json]`. The branch validates the target before client access and executes before legacy API/local-admin construction. It performs one bounded GET, never retries, strips server details from typed errors, and rejects malformed or cross-session output before rendering.
- Text rendering distinguishes null account history, empty history, actual zero, unobserved thread/rate state, nullable context/window/reset values, and observed values. JSON preserves the exact contract. Both outputs are reparsed and byte-bounded; neither infers money or unlimited quota.

### Hardening Outcome

| Area | Outcome |
| --- | --- |
| Target and read semantics | Pass: the caller can provide only one session id; query thread/operation overrides reject. The route creates a valid unique internal usage intent, validates durable mapping/projection identity, calls one receiverless runtime read with one request signal, and reparses the exact target. |
| Route and authorization | Pass: seven direct route cases cover strict accessor-free port snapshots, canonical/adjacent route inventory, real control-service composition, auth-before-validation, loopback plus paired read/write access, Tailscale identity non-authority, missing/corrupt state, all 11 typed control failures, malformed output, and internal-error observation. |
| CLI client and surface | Pass: 14 client/command cases cover exact accessor-free options, loopback-only URL policy, one no-store GET, invalid targets, parser/help exclusions, receiverless handoff, no legacy/local-admin access, sanitized typed/untyped/fetch/JSON failures, hostile output, no retry, and exact JSON. |
| Rendering | Pass: direct command assertions cover populated history, null history, empty history, zero counters, observed/unobserved thread and rate state, nullable context/windows/resets, and absence of monetary/unlimited claims. |
| Mutation/privacy inspection | Pass: production usage route/client imports contain no write gate, mutation, turn, terminal, shell, process, audit executor, timer, or retry path. Manifest-only `audit === null`, authentication mechanism names, and typed retryability flags are the only matching control terms. No dependency, package manifest, or lockfile changed. |

### Validation

| Gate | Result |
| --- | --- |
| Focused usage route/client/CLI | Pass: 3 files, 21 tests. |
| Focused adjacent usage runtime | Pass: route/client/CLI plus existing adapter/control tests, 5 files and 40 tests. |
| `pnpm test:unit` | Pass: 138 files and 1,309 tests; 22 opt-in device/smoke files and 36 tests skipped. |
| `pnpm test:contract` | Pass: 30 files, 257 tests, including the updated all-V1-CLI-command scenario. |
| `pnpm test:integration` | Pass: 2 files, 16 tests. |
| `pnpm test:web` | Pass: 3 files, 33 tests. |
| `pnpm typecheck` | Pass across the workspace. |
| `pnpm lint` | Pass across 410 files plus all 9 package exports. |
| Scaffold/planning | Pass: 9 packages, 18 root scripts; 212 tasks, 84 requirements, 649 dependencies, and 14 queued tasks before closure. |
| Exact runtime | Pass: isolated Codex 0.144.0 verifies 671 generated binding files at SHA-256 `e1a1a5cff3ab91862f9215dd06538eae1ea0b00bae48cbb7d87061faaee27e24`; real no-model structured usage smoke passes 1 test. The default Codex 0.144.3 installation was not changed. |
| Install/diff | `pnpm install --offline --frozen-lockfile`, targeted Biome, manual source/output review, forbidden-path/privacy scans, and `git diff --check` pass. |
| `pnpm audit --prod` | Unavailable: npm's retired legacy audit endpoint returned HTTP 410 and directed clients to the bulk advisory endpoint. No dependency or lockfile changed. |

### Downstream Ownership

- `IFC-V1-046` owns production aggregate service/route registration and remote vertical acceptance.
- `IFC-V1-050` owns CLI stress/resource-limit aggregation; `IFC-V1-021` and packaging leaves own an installed `codexdeck` executable.
- `FE-V1-028` owns the approved mobile loading, stale, empty, unsupported, failure, token/context, and rate-limit presentation.
