# IFC-V1-065 Read-Only Skills API And CLI

Date: 2026-07-15

## Target

Expose the completed structured skills runtime through the exact authenticated selected GET route and a laptop-local `codexdeck skills <session-id> [--json]` command. The boundary must retain only path-redacted public summaries for the selected managed session and remain incapable of accepting a cwd, discovering files, mutating runtime settings, auditing a mutation, retrying, or sending slash/terminal text.

## Pre-Change Findings

- The selected manifest already freezes `GET /api/v1/sessions/:session_id/skills` with loopback-or-device-cookie read authority, no CSRF, lock, audit, credential effect, query, or body.
- `skillsSnapshotSchema`, `createCodexSkillsClient`, and `createCodexSkillsControlService` already enforce one exact selected cwd, one forced-refresh `skills/list` read, strict runtime generation and target checks before and after the await, deterministic unique names, bounded public metadata, and explicit `content`, `empty`, `partial`, and `error` states.
- The adapter validates but discards cwd, skill/error/icon paths, default prompts, dependency commands/URLs/transports/values, and raw error messages. The public snapshot retains only target/runtime/time, name, nullable description, scope, enabled state, state, and redacted error count.
- The public route identifies a HostDeck session, while the control service intentionally requires a complete managed session/thread target plus an internal operation id. No selected bridge currently resolves that identity without accepting a caller-supplied thread id or cwd.
- No selected skills route, loopback skills client, skills CLI command, or bounded text renderer exists. Production aggregate registration remains downstream `IFC-V1-046`.

## Hard Success Criteria

| Area | Required evidence |
| --- | --- |
| Session target | The route accepts one valid HostDeck session id only, resolves its current durable Codex thread internally, validates mapping/projection identity, and gives the runtime service a strict internal skills intent. The caller cannot supply or override a thread id, cwd, operation id, path, scope, reload policy, or protocol request. |
| Read semantics | One admitted request performs at most one `skills.list` call with the unchanged managed request abort signal. It has no write-gate, lock, CSRF, audit, terminal, turn, retry, timer, filesystem, shell, process, or settings-mutation port. |
| Runtime truth | The returned snapshot must parse through `skillsSnapshotSchema` and match the resolved session/thread exactly. Name order and uniqueness, nullable descriptions, known scope, boolean enabled truth, redacted error count, and content/empty/partial/error consistency remain contract-owned. |
| Route contract | Registration refuses drift from the exact `skills_read` manifest row, disables implicit `HEAD`, rejects query/method/path variants, sets `no-store`, and authenticates before parameter, state, or runtime access. |
| Authorization | Safe loopback plus paired read/write devices may read. Invalid, expired, revoked, duplicate, or absent remote credentials and Tailscale identity without a valid HostDeck device cookie cannot reach state or runtime ports. |
| Public failures | Malformed params, missing target, archived/unreadable target, stale/mismatched target, unsupported capability, unavailable runtime, service overload, storage failure, malformed protocol/service output, and unexpected internal failure remain distinct where public truth permits and never expose causes, credentials, thread ids, cwd/path data, dependency metadata, prompts, or raw runtime errors. |
| CLI client | Only one exact direct-loopback HTTP base is accepted. The session id is validated before request, one bounded no-store GET is issued, no retry occurs, typed API errors are sanitized, and malformed, oversized, cross-session, incomplete, or invalid JSON cannot reach rendering. |
| CLI surface | Parser/help expose only `codexdeck skills SESSION_ID [--json]`; no cwd, thread-id, path, scope, reload, raw slash, command, terminal, remote-origin, mutation, or extra positional override is accepted. This branch runs before legacy API/local-admin construction. |
| Rendering | Text and JSON revalidate the complete snapshot and stay within the CLI output budget. Text distinguishes content, empty, partial, and error; shows exact skill count, redacted error count, scope, enabled/disabled state, and nullable description without inventing error details or paths. JSON preserves only the exact public contract. |
| Validation | Direct route, target-resolution, auth/Tailscale, real runtime-service composition, CLI client/parser/shell/render, all four states, hostile input, privacy, and no-retry tests pass, followed by affected/full workspace gates, exact Codex 0.144.0 skills smoke, and manual source/output inspection. |

## Planned Scope

- Add one standalone selected skills Fastify registration that snapshots only selected-state `get` and skills-service `list` ports, resolves the managed target internally, and maps every typed failure.
- Add one bounded direct-loopback skills client plus parser/help/shell/render support with human and JSON output.
- Add focused contract-boundary tests and update package exports and the source-command reference.
- Do not add production aggregate wiring, mobile UI, persistence, audit records, mutation gates, dependencies, setup changes, runtime protocol changes, cwd/path output, or filesystem discovery.

## Evidence

### Implemented Boundary

- `@hostdeck/server` now owns one standalone `selected-skills-read` registration. It snapshots only exact `state.get` and `skills.list` methods, resolves the Codex thread from one schema-validated selected mapping/projection, creates an internal skills intent, passes the managed request signal, reparses the complete response, and rejects cross-session/thread output.
- The route binds only `GET /api/v1/sessions/:session_id/skills`, rejects all query fields and adjacent methods/paths, disables implicit `HEAD`, sets `no-store`, and authenticates before params, state, or runtime access. Its manifest assertion fixes read authority, no CSRF/lock/audit, no credential effect, and `IFC-V1-065` ownership.
- Every typed control failure has a fixed public status/code/message. Missing, unreadable, stale, mismatched, unsupported, unavailable, overloaded, storage-failed, protocol-invalid, malformed-output, and unexpected states remain bounded and cause-free.
- `@hostdeck/cli` now owns a dedicated exact-loopback skills client and `codexdeck skills SESSION_ID [--json]`. The branch validates the target before client access and executes before legacy API/local-admin construction. It performs one bounded GET, never retries, strips server details from typed errors, and rejects malformed, path-bearing, oversized, or cross-session output before rendering.
- Text rendering distinguishes content, empty, partial, and error states; reports exact skill/error counts; shows deterministic scope/enabled/nullable-description summaries; and keeps error details redacted. C0/ANSI, C1, line-separator, and bidirectional controls are escaped as terminal-safe literals. JSON preserves the exact public contract. Both forms are reparsed and byte-bounded.

### Hardening Outcome

| Area | Outcome |
| --- | --- |
| Target and read semantics | Pass: the caller can provide only one session id; query cwd/thread/reload overrides reject. The route creates a valid unique internal skills intent, validates durable mapping/projection identity, calls one receiverless runtime read with one request signal, and reparses the exact target. |
| Route and authorization | Pass: seven direct route cases cover strict accessor-free port snapshots, canonical/adjacent route inventory, real control-service composition with only the selected cwd, auth-before-validation, loopback plus paired read/write access, Tailscale identity non-authority, missing/corrupt state, all 10 typed control failures, malformed/path-bearing output, and internal-error observation. |
| CLI client and surface | Pass: 14 client/command cases cover exact accessor-free options, loopback-only URL policy, one no-store GET, invalid targets, parser/help exclusions, receiverless handoff, no legacy/local-admin access, all four public states, sanitized typed/untyped/fetch/JSON failures, hostile/path-bearing/oversized output, no retry, and exact JSON. |
| Rendering | Pass: direct command assertions cover deterministic content, null and empty descriptions, empty/partial/error states, redacted error counts, output byte exhaustion, and terminal control escaping without invented paths or raw error details. |
| Mutation/privacy inspection | Pass: the standalone skills route/client import no write gate, audit executor, filesystem, process, shell, terminal, timer, retry, raw protocol method, reload option, dependency metadata, prompt, icon, or raw error-message path. Cwd exists only inside selected mapping/projection consistency and the pre-existing runtime service. Manifest `audit === null`, authentication names, retryability fields, and one guarded local TypeError message comparison are the only matching production terms. No dependency, package manifest, or lockfile changed. |

### Validation

| Gate | Result |
| --- | --- |
| Focused skills route/client/CLI | Pass: 3 files, 21 tests. |
| Focused adjacent skills runtime | Pass: adapter/control/route/client/CLI, 5 files and 39 tests; the skills contract also passes in the full contract suite. |
| `pnpm test:unit` | Pass: 141 files and 1,330 tests; 22 opt-in device/smoke files and 36 tests skipped. |
| `pnpm test:contract` | Pass: 30 files, 257 tests, including the updated all-V1-CLI-command scenario. |
| `pnpm test:integration` | Pass: 2 files, 16 tests. |
| `pnpm test:web` | Pass: 3 files, 33 tests. |
| `pnpm typecheck` | Pass across the workspace. |
| `pnpm lint` | Pass across 415 files plus all 9 package exports. |
| Scaffold/planning | Pass: 9 packages, 18 root scripts; 212 tasks, 84 requirements, 649 dependencies, and 13 queued tasks before closure. |
| Exact runtime | Pass: isolated Codex 0.144.0 verifies 671 generated binding files at SHA-256 `e1a1a5cff3ab91862f9215dd06538eae1ea0b00bae48cbb7d87061faaee27e24`; real no-model structured skills smoke passes 1 test. The default Codex 0.144.3 installation was not changed. |
| Install/diff | `pnpm install --offline --frozen-lockfile`, targeted Biome, manual source/output review, forbidden-path/privacy scans, and `git diff --check` pass. The documented packaging gap was rechecked: `pnpm exec codexdeck --help` still reports command not found. |
| `pnpm audit --prod` | Unavailable: npm's retired legacy audit endpoint returned HTTP 410 and directed clients to the bulk advisory endpoint. No dependency or lockfile changed. |

## Downstream Ownership

- `IFC-V1-046` owns production aggregate service/route registration and remote vertical acceptance.
- `IFC-V1-050` owns CLI stress/resource-limit aggregation; `IFC-V1-021` and packaging leaves own an installed `codexdeck` executable.
- `FE-V1-030` owns the approved mobile loading, content, empty, partial, error, unsupported, and failure presentation.
