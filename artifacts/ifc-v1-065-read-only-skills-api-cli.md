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

Pending implementation and validation.

## Downstream Ownership

- `IFC-V1-046` owns production aggregate service/route registration and remote vertical acceptance.
- `IFC-V1-050` owns CLI stress/resource-limit aggregation; `IFC-V1-021` and packaging leaves own an installed `codexdeck` executable.
- `FE-V1-030` owns the approved mobile loading, content, empty, partial, error, unsupported, and failure presentation.
