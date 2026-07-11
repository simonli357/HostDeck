# INT-V1-024 Structured Skills Control

Date: 2026-07-11

## Outcome

- `createCodexSkillsClient` requires the available exact `skills` capability and a positive stable connection generation. It sends exactly one read-only `skills/list` request with `{ cwds: [selectedCwd], forceReload: true }` and never retries, scans HostDeck files, changes settings, or starts a turn.
- The adapter requires exactly one returned cwd entry and byte-for-byte cwd identity. It validates strict required keys plus the observed omitted, null, or valid forms for optional short-description, interface, and dependency data.
- Raw skills, errors, paths, prompts, icons, commands, URLs, transports, and dependency details are bounded and validation-only. The returned summary contains only `name`, bounded `description`, `scope`, and `enabled`.
- `createCodexSkillsControlService` resolves cwd only from one current selected managed session. It checks target, runtime version, and connection generation across the await and returns no partial snapshot when any identity changes.
- The frozen public snapshot carries exact target/runtime/generation/time, strict name ordering, unique public names, redacted error count, and one coherent `content`, `empty`, `partial`, or `error` state.

Criteria: `9ea02cd`. Reviewed nullable wire shape: `c308272`. Implementation: `06eccdd`.

## Hard Success Criteria

| Criterion | Evidence |
| --- | --- |
| Exact request | One selected-state cwd becomes one `skills/list` read with exactly one cwd and `forceReload: true`; signal and configured read deadline propagate unchanged. |
| Target policy | Missing, mismatched, archived, recovery, stale, cwd-conflicting, and wrong-runtime selected state reject before IPC. Archive, freshness, cwd, and runtime races reject after one read. |
| Runtime continuity | Unsupported/disconnected capability and invalid generation reject before IPC. Live runtime-version drift, generation drift, and a valid listing tagged with another runtime identity reject after exactly one read. |
| Strict wire shape | Response, entry, skill, error, interface, dependency container, and dependency-tool keys are exact. Missing required, unknown, undefined optional, unsupported scope, non-boolean enabled, duplicate name, and wrong cwd fail closed. |
| Reviewed nullability | Generated optional short-description/interface/dependency fields accept only omission, observed null, or a fully valid value. Present `undefined` is rejected as invalid wire data. |
| Resource bounds | Policy defaults are 256 skills, 64 errors, and 64 dependencies per skill, with reviewed maxima of 1,024, 256, and 256. All retained and validation-only text has a UTF-8 byte ceiling. |
| Public state | Snapshot state is derived only from public skill count and redacted error count. Contradictory state/count combinations, invalid identity/time, unsorted names, and duplicates fail contract validation. |
| Privacy | Raw cwd, skill/error/icon paths, prompts, dependency details, error messages, and unknown fields never enter the public result or retained artifact. |
| Isolation/repeat | Two selected sessions resolve only their own cwd. Repeated reads are stateless, deterministic after sorting, and retain no prior raw response. |
| No fallback | There is no caller path, filesystem discovery, mutation, turn, slash command, hidden retry, partial response, or inferred success path. |

## Runtime Evidence

- Exact reviewed runtime: `codex-cli 0.144.0`; generated binding SHA-256 `e1a1a5cff3ab91862f9215dd06538eae1ea0b00bae48cbb7d87061faaee27e24` across 671 files.
- Repeated authenticated smokes used one owner-private temporary Codex home/socket and two isolated temporary Git repositories with two managed threads.
- Every final run issued exactly three independent `skills/list` reads: project A, project B, then project A again. Both projects returned bounded coherent content; the repeated A listing was stable after removing capture time.
- No `turn/started`, item lifecycle, server request, protocol issue, archive side effect, raw temporary path, or retained discovery metadata appeared. Both threads remained idle and unarchived until explicit cleanup.
- The first exact smoke exposed a real description longer than the provisional 512-byte limit. The adapter failed closed, retained no response, and the reviewed description ceiling was corrected to 4,096 bytes before repeated unchanged smoke success.
- Cleanup archived both temporary threads, closed the connection and child process, and removed the temporary runtime, authentication copy, socket, and repositories.

## Validation

- Direct adapter/control/resource matrix: 21 tests. Direct skills/resource contracts: 11 tests.
- Exact authenticated 0.144.0 two-cwd skills-control smoke: 1 passed repeatedly.
- Unit: 742 passed; 28 explicit external tests skipped.
- Contract: 130 passed; integration: 16 passed; web: 14 passed.
- All 9 package typechecks passed. Lint/package exports checked 263 files and 9 packages.
- Scaffold reported 9 packages and 18 root scripts. Planning reported 196 tasks, 84 requirements, 631 dependencies, and 4 queued tasks before and after closure as the completed skills leaf unblocked the assembled vertical.
- Frozen offline install, exact binding check, production audit with no known vulnerabilities, manual target/runtime/shape/bounds/privacy/fallback review, and diff checks passed.

## Remaining Ownership

- `INT-V1-027` assembles skills with the other proven structured ports through the real connection callback vertical.
- `IFC-V1-065` owns the authenticated selected skills read route and public error mapping.
- `FE-V1-030` owns the approved mobile skills surface after the replacement visual direction is selected.
- `INT-V1-028` to `INT-V1-032` own reconnect, restart, lifecycle, and aggregate runtime acceptance; this read does not infer continuity across a connection generation.
- `INT-V1-091` reruns aggregate runtime hardening after assembly, supervision, restart, and legacy disposition.
