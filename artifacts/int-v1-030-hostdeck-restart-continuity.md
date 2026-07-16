# INT-V1-030 HostDeck Restart Continuity

Date: 2026-07-16

Status: complete. Criteria were frozen before implementation in `5740b68`; implementation is `c4244b9`; redacted exact-runtime evidence is `artifacts/int-v1-030-hostdeck-restart-evidence.json`.

## Scope

Prove the selected process-ownership contract across real OS process lifetimes with exact Codex 0.144.0. In `service_owned` mode, one externally owned app-server, its private Unix socket, one managed thread, and one already-running turn must survive the complete exit of a first HostDeck process and be reconciled by a second HostDeck process from the same durable state directory. In `foreground_child` mode, each HostDeck process must own and terminate only its own app-server child, remove that child's socket, release the daemon lease, and permit a later HostDeck process to start a distinct exact-runtime child.

This task proves the runtime/state-owner boundary. App-server crash reconciliation remains `INT-V1-029`; laptop TUI coexistence remains `INT-V1-031`; aggregate lifecycle acceptance remains `INT-V1-032`; Fastify/startup/systemd/package composition remains `IFC-V1-036` to `IFC-V1-038`; phone and release proof remain downstream.

## Pre-Change Findings

- `INT-V1-007` proves foreground and service supervisor mechanics, but its real smoke closes and recreates supervisor objects inside one Vitest process. It does not prove a HostDeck process boundary, daemon-lease handoff, durable projection recovery, or active work continuity.
- `INT-V1-029` composes durable restart reconciliation against a scripted runtime in one process. It does not prove that a real service-owned app-server keeps an active turn alive while every HostDeck client and process-local state owner disappears.
- The current selected host startup path is not yet composed with the Codex runtime lifecycle; that integration belongs to later interface tasks. Calling historical tmux `startHostAgent` or the legacy service smoke would be false evidence.
- The production supervisor intentionally withholds child PIDs and process capabilities. A test harness may inspect Linux process descendants for proof, but production snapshots and committed artifacts must remain count/relationship only.
- A real active-turn proof requires one bounded model call. A no-turn thread, fake Codex process, sleep fixture, same-process object recreation, or app-server process restart cannot satisfy service continuity.

## Frozen Harness

- Add one opt-in outer smoke and one opt-in HostDeck worker test. The outer smoke owns temporary directories and the external service app-server, starts each worker through a separate Vitest OS process, validates strict bounded worker reports, and always performs reverse cleanup.
- Each worker uses production owner-only path preparation, the kernel-backed daemon lease, migrated SQLite, selected-state repository, runtime supervisor, Unix transport, strict adapter clients, projection/event pipeline, and bounded deadlines. A worker never communicates thread content through stdout or committed evidence.
- Worker coordination uses owner-only temporary state/result files with atomic publication. Reports contain only the temporary-process facts required by the parent; the committed redacted result contains booleans/counts and no PID, path, socket identity, thread/turn id, model, prompt, output, auth, or raw error.
- The exact Codex binary and isolated temporary `CODEX_HOME` are provided explicitly. Authentication is copied from the current private source file into the temporary home with mode `0600`; no auth content enters logs or artifacts.
- Linux `/proc` descendant inspection is test-only evidence that a foreground worker has exactly one matching app-server child. It does not change the production supervisor contract or expose a PID from product code.

## Service-Owned Matrix

1. The outer process starts one exact 0.144.0 app-server sibling on the canonical owner-only socket and records its PID plus socket device/inode privately.
2. HostDeck worker A acquires the daemon lease, opens the migrated database, observes the sibling through `service_owned`, performs compatibility handshake, creates/materializes exactly one managed thread, commits its selected mapping/projection, and starts one bounded turn.
3. The turn must start a shell command that writes a start marker, waits long enough for the process handoff, then writes a completion marker. Worker A publishes ready only after the exact turn-start projection and start marker are durable/visible.
4. While worker A is alive, a second lease acquisition must fail. The parent then requests an orderly HostDeck close. Worker A closes its adapter/database/state owner, releases its service supervisor and daemon lease, and exits without signaling, reaping, or unlinking the app-server.
5. After worker A exits, the exact app-server PID, socket identity, thread id, turn id, and active side effect remain unchanged. The lease is immediately acquirable by a new HostDeck process.
6. HostDeck worker B reacquires the same lease, opens the same database, observes the same sibling, and starts the production reconnect controller with the production reconciliation lifecycle, audit reconciliation, continuity port, event pipeline, approval service, model service, and Plan rehydration.
7. Before admission, worker B must read the exact managed mapping and in-progress turn, replace the unobservable interval with one `restart` boundary, issue exactly one no-override resume, drain event work, and publish ready. No thread or turn is created/retried during recovery.
8. The original command and turn then complete under the same app-server. Worker B must persist terminal projection truth after the boundary, close all HostDeck-owned resources, and leave the sibling/socket alive. Only the outer harness may terminate the sibling.

## Foreground Matrix

1. HostDeck worker C acquires a separate daemon lease and starts exact Codex through the production `foreground_child` supervisor's fixed no-shell Unix-only argv.
2. The worker proves compatibility, and test-only descendant inspection records one exact app-server child. A concurrent lease owner is rejected.
3. On orderly HostDeck close, worker C closes its client, terminates/reaps its owned child, removes only the matching socket, releases the daemon lease, and exits. The parent proves the child is gone and the socket is absent.
4. HostDeck worker D reacquires the same lease and starts a different exact app-server child on the same canonical path. Reuse of the prior PID/socket identity or a stale accepting socket fails the proof.
5. Worker D repeats bounded compatibility and complete reverse cleanup. No service-owned sibling, unrelated process, or replacement socket is signaled or removed.

## Hard Success Criteria

| Area | Required evidence |
| --- | --- |
| Process boundary | Four distinct HostDeck worker process lifetimes; no in-process lifecycle substitution; worker exit codes and bounded stdout/stderr are checked. |
| Exact runtime | Every app-server reports exact reviewed 0.144.0 compatibility; service uses one PID throughout; foreground uses a distinct owned child per HostDeck generation. |
| Lease/state ownership | One real kernel lease blocks a concurrent owner, releases on orderly close, records stale metadata replacement on reacquire, and never permits two database/state owners. |
| Service non-ownership | HostDeck service supervisors have zero spawn/TERM/KILL counts; two HostDeck exits leave the sibling and exact socket identity alive; only outer cleanup stops it. |
| Active continuity | One real managed thread, accepted turn, started command, and completion side effect survive worker A exit; worker B observes the same thread/turn and terminal result. No replacement thread/turn or mutation retry. |
| Durable recovery | Worker B opens the existing migrated database, runs the production restart lifecycle, creates exactly one first retained restart boundary, resumes exactly once without overrides, reaches admitted generation one, and appends terminal work after the boundary. |
| Foreground ownership | Each worker spawns exactly one child, reports one matching descendant, closes with expected child exit and absent socket, and permits a clean later same-path start with a different child. |
| Failure truth | Missing/wrong binary, incompatible version, malformed report/state, early worker/runtime exit, lease conflict/reacquire failure, socket/PID drift, turn not started/completed, missing boundary, unexpected mutation, timeout, and cleanup failure fail the smoke. |
| Bounds/cancellation | Parent, worker, compatibility, request, active-turn, marker, shutdown, and cleanup deadlines are fixed; output/report sizes and process counts are capped; no retry hides a failed proof. |
| Privacy/security | Temporary auth/state/result files are owner-only; committed evidence excludes raw identifiers, paths, PIDs, socket identity, prompts, model, output, auth, and error causes; no shell or TCP/LAN listener is introduced by HostDeck. |
| Cleanup | Every worker, exact app-server, adapter, supervisor, database, lease, timer, temporary socket/file/directory is closed or absence-proven even on failure; unrelated processes/sockets are untouched. |
| Ownership exclusions | No TUI coexistence, aggregate lifecycle, Fastify health, systemd installation, package, SSE, browser, phone, or release claim. No dependency change. |

## Validation Plan

- Deterministic worker-report and parent-orchestration tests cover strict environment/report parsing, atomic coordination, process exit/timeout, PID/socket identity comparisons, lease contention/reacquisition, and failure cleanup without a model call where possible.
- The opt-in exact-runtime smoke runs the full service and foreground matrices. It emits one redacted machine-readable evidence file after cleanup succeeds; a failed or partially cleaned run emits no passing artifact.
- Run focused process/storage/reconnect/reconciliation tests; full unit/contract/integration/web suites; root and all-package typechecks; lint/exports; scaffold/planning; exact 0.144.0 binding and compatibility; frozen offline install; production license/audit check; diff/secret/process/socket/active-handle inspection; and manual ownership/privacy/failure review.
- The physical phone is not required for this runtime leaf.

## Implementation Findings

- The first exact run exposed invalid chronology when second-precision Codex turn activity preceded a millisecond-precision durable session creation time. Reconciliation now clamps observed activity to durable chronology, boundary timestamps advance past activity, and append/boundary storage paths independently reject impossible chronology before mutation.
- A fresh HostDeck event normalizer did not know the turn that survived the process gap. Reconciliation now installs strict managed-thread/active-turn state before held notifications drain, resets only gap-sensitive item/request/token state, accepts lifecycle evidence that can truthfully have started during the gap, and consumes the one missed-compaction token exception on the first post-gap usage snapshot.
- The test worker's Vitest body can spawn from a non-leader Linux thread, so direct-child inventory now examines bounded `/proc/<pid>/task/*/children`. Failed workers run in isolated process groups so cleanup also owns an unpublished foreground grandchild; final service close reasserts zero spawn/TERM/KILL counts.
- Worker environment/report parsing is exact and bounded. Reports and evidence use owner-only atomic publication, copied auth must be a private current-owner regular file, service stdio is not retained, and evidence generation refuses a dirty worktree.

## Validation Result

- Focused restart/reconciliation/storage coverage: 61 passed, 2 opt-in smokes skipped. Full unit: 1,698 passed, 39 skipped; contract: 277; integration: 33; web: 33.
- Root and all-package typechecks, lint/package exports, scaffold, planning (212 tasks, 84 requirements, 649 dependencies), diff checks, and the exact Codex 0.144.0 671-file binding check pass.
- The exact four-process smoke passed against clean pushed commit `c4244b9` in 58.26 seconds. It proves four distinct HostDeck processes, stable service PID/socket/thread/turn, one restart boundary and no-override resume, original-turn completion after restart, two distinct foreground children, final owner cleanup, and no retained PID/path/socket/thread/turn/model/prompt/output/auth value.
- The evidence file is one owner-only regular link, mode `0600`, bound to full commit `c4244b9047a69acd2f11473286d4d26e68651b20`. No matching runtime process or smoke temporary root remained after validation. npm audit still has no advisory result because the configured retired endpoint returns HTTP 410; no dependency or lockfile changed.

## Downstream Ownership

- `INT-V1-031` proves real HostDeck plus laptop TUI multi-client behavior.
- `INT-V1-032` combines foreground/service ownership, reconnect, app-server crash, HostDeck restart, active/approval/incomplete outcomes, TUI coexistence, and cleanup.
- `IFC-V1-036` to `IFC-V1-038` wire selected runtime startup/recovery/shutdown into the actual loopback host service and installed user-service lifecycle.
- Interface, frontend, device, packaging, security, and release tasks own the remaining V1 proof.
