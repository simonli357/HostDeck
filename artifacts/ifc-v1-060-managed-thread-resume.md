# IFC-V1-060 Managed-Thread Resume Metadata API And CLI

Date: 2026-07-15

## Target

Expose one exact managed thread as bounded read-only laptop-resume metadata and implement `codexdeck resume <session-id>` as a laptop-local direct process launch. A paired phone may read/copy the command but cannot execute a shell, spawn a process, import a thread, or mutate Codex through this route.

## Pre-Change Findings

- The selected manifest already freezes `GET /api/v1/sessions/:session_id/resume`, loopback-or-device-cookie read authority, no audit/mutation, handler `sessions.resumeMetadata`, and `IFC-V1-060` ownership.
- `buildCodexTuiResumeCommand` already creates an immutable shell-free exact-thread descriptor over the private Unix socket, and `INT-V1-005` proves that descriptor against exact Codex 0.144.0. No selected API response or CLI consumer currently exposes it.
- `selectedLaptopResumeSchema` owns the phone view-model subset, while the wire/CLI boundary also needs a structured launch descriptor so the CLI never parses or executes a display string through a shell.
- The selected state and compatibility repositories already own durable mapping and reviewed-runtime truth. Production aggregate registration remains downstream `IFC-V1-046`; this leaf owns the standalone contracts, service, route, CLI client/launcher, and evidence.

## Hard Success Criteria

| Area | Required evidence |
| --- | --- |
| Wire contract | One strict response identifies the requested HostDeck session, marks the descriptor `local_only`, and contains either an available canonical display command plus exact executable/argv or one bounded unavailable reason. Extra/raw mapping, cwd, runtime binding, credential, shell, and transcript fields reject. |
| Canonical command | The display command is deterministically derived from the structured launch descriptor with POSIX-safe token quoting. Spaces, apostrophes, metacharacters, Unicode, control characters, oversized tokens, wrong verbs/options, non-Unix remotes, and command/argv disagreement are covered. |
| Managed target | The service requires one internally identity-consistent selected mapping/projection for the exact session. Missing, archived, recovery-required/unmanaged, malformed, cross-session, or corrupt state never yields a command or replacement thread. Arbitrary caller-supplied Codex thread ids are impossible. |
| Runtime truth | Availability requires active/current projection, ready or safely degraded compatible runtime, allowed policy, matching runtime version, and available thread-lifecycle plus multi-client capabilities. Disconnected, incompatible, stale, starting, unknown, version drift, or capability loss returns explicit unavailable metadata, not invented readiness. |
| Consistency | State and runtime are bracketed under a bounded retry count. Archive, identity, freshness, compatibility, or version change during materialization cannot publish stale launch metadata; repeated instability returns one sanitized retryable failure. |
| Route | Registration refuses drift from the exact selected manifest row, disables implicit `HEAD`, sets `no-store`, and authenticates before params/service access. Safe loopback plus paired read/write devices may read; unpaired/invalid/expired/revoked credentials may not. Tailscale identity alone grants nothing. |
| Phone boundary | The API and service have no child-process, shell, write-gate, audit, CSRF, lock, or runtime-mutation port. Remote reads only return metadata. No route or response can cause laptop execution. |
| CLI client | Only one exact loopback HTTP(S) base is accepted. Session id is validated before request; one bounded GET is issued; typed API errors and malformed, cross-target, oversized, incomplete, or invalid JSON responses remain sanitized and cannot reach the launcher. |
| Laptop launch | Only the local CLI invokes one validated executable with the exact argv using `shell: false` and inherited terminal stdio. It never uses the display command as executable input, never retries, and maps spawn error, signal, and nonzero exit without claiming success. |
| CLI surface | Parser/help expose `codexdeck resume SESSION_ID` with no alias/import/thread-id override, remote URL, shell, command, or extra argument option. Unavailable metadata exits without spawning. Existing legacy `attach` behavior is not reused as selected proof. |
| Validation | Contract, service, route, CLI client/launcher/shell, real SQLite/runtime-record, selected Tailscale authorization, raw listener, command-escaping, and affected/full workspace tests pass. Existing exact-Codex TUI smoke is rerun when the reviewed 0.144.0 binary is available. |

## Planned Scope

- Add selected resume params/launch/response contracts and canonical display formatting under `@hostdeck/contracts`.
- Add one headless mapping/runtime resume metadata reader and one exact Fastify registration under `@hostdeck/server`.
- Add one bounded loopback resume client, direct no-shell launcher, parser/help/rendering, and shell orchestration under `@hostdeck/cli`.
- Do not add phone execution, app-server mutation, arbitrary import, production aggregate registration, packaging/service files, UI implementation, or a new dependency.

## Evidence

### Implemented Boundary

- `@hostdeck/contracts` now owns strict session params, a structured exact `codex resume --remote unix://... THREAD_ID` launch descriptor, a deterministic POSIX-safe display command, and a mutually exclusive available/unavailable response. Command/descriptor drift, extra fields, controls, oversized values, unsafe relative executables, non-Unix remotes, and malformed targets reject.
- `@hostdeck/server` now owns a headless resume reader over snapshotted selected-state and runtime ports. It validates durable mapping/projection identity, selected/nonarchived disposition, active/current projection, matching compatible runtime version, allowed policy, and required thread-lifecycle/multi-client capabilities under a three-attempt state/runtime consistency bracket.
- The standalone selected Fastify registration binds only `GET /api/v1/sessions/:session_id/resume`, rejects query and method drift, disables implicit `HEAD`, sets `no-store`, authenticates before validation/reader access, validates returned target identity, and maps reader failures to bounded selected errors. It has no process, shell, write-gate, lock, CSRF, audit, or runtime-mutation dependency.
- `@hostdeck/cli` now exposes only `codexdeck resume SESSION_ID`. Its dedicated client accepts direct loopback HTTP only, issues one bounded no-store GET, sanitizes typed errors, and rejects malformed/cross-target output. Its dedicated launcher reparses the structured descriptor and starts exactly one process with `shell: false`, inherited stdio, exact argv, no display-command parsing, and no retry. The shell selects this path before legacy API/local-admin construction.

### Hardening Outcome

| Area | Outcome |
| --- | --- |
| Wire and command | Pass: four direct contract cases cover canonical/escaped/Unicode commands, available/unavailable discrimination, controls, URL delimiters, wrong argv, oversize, extra fields, and command/descriptor disagreement. |
| Managed target and runtime truth | Pass: eight reader cases cover exact frozen ports, construction-time config validation, durable identity, active/current and safely degraded readiness, unavailable state matrix, missing/archived/recovery/cross-target/corrupt state, malformed runtime, one-change retry, repeated instability, and real migrated SQLite state/runtime records. |
| Route and phone boundary | Pass: seven route cases cover exact manifest/path/method/query/cache behavior, auth-before-validation, loopback and paired read/write cookies, expired/revoked/duplicate/storage failures, admitted Tailscale identity non-authority, bounded error mapping, malformed/cross-target output, raw listener privacy, and no remote execution side effect. |
| CLI client and launch | Pass: 21 focused cases cover exact loopback request and option snapshots, invalid/non-loopback targets, available/unavailable and malformed/oversized/cross-target output, sanitized API/fetch/JSON failures, parser/help exclusions, no local-admin/legacy-client use, unavailable no-spawn, exact receiverless descriptor handoff, `shell: false`, inherited stdio, synchronous/asynchronous spawn failure, signal, nonzero/null exit, malformed handle, and no retry/fallback. |
| Real Codex | Pass: the existing no-turn managed-thread lifecycle smoke starts exact Codex 0.144.0 on a private Unix socket, creates/materializes one thread, opens the exact TUI resume command, observes the expected screen, preserves thread identity, archives it, and cleans up. No model call is made. |

### Validation

| Gate | Result |
| --- | --- |
| `pnpm test:unit` | Pass: 135 files, 1,288 tests; 22 files/36 opt-in device or smoke tests skipped. |
| `pnpm test:contract` | Pass: 30 files, 257 tests. |
| `pnpm test:integration` | Pass: 2 files, 16 tests. |
| `pnpm test:web` | Pass: 3 files, 33 tests. |
| `pnpm typecheck` | Pass across the workspace. |
| `pnpm lint` | Pass across 405 files plus all 9 package exports. |
| `pnpm check:scaffold` | Pass: 9 packages and 18 root scripts. |
| Exact binding | Pass with the existing isolated Codex 0.144.0 binary: 671 generated files and SHA-256 `e1a1a5cff3ab91862f9215dd06538eae1ea0b00bae48cbb7d87061faaee27e24`. The default 0.144.3 binary correctly fails the exact-version gate and was not accepted or modified. |
| Exact TUI smoke | Pass: 1 real `codex-thread-lifecycle.smoke` case against isolated 0.144.0. |
| `pnpm install --offline --frozen-lockfile` | Pass; lockfile unchanged. |
| `pnpm audit --prod` | Unavailable: npm's legacy audit endpoint returned HTTP 410 and directed clients to the bulk advisory endpoint. No dependency or lockfile changed in this task. |

### Downstream Ownership

- `IFC-V1-046` owns production aggregate route/service wiring; this leaf intentionally provides a standalone registration and composable reader only.
- `IFC-V1-054` owns the compiled runnable `codexdeck` package/bin acceptance. This leaf proves the source command contract and direct launcher.
- `FE-V1-019` and `FE-V1-038` own dashboard consumption and copy affordance. This leaf exposes read/copy metadata only; no phone shell or mobile execution path exists, so a connected phone is not required for this validation.
