# INT-V1-031 HostDeck And TUI Coexistence

Date: 2026-07-16

Status: complete, with repeatability correction `BUG-011` in validation. Criteria were frozen in `37d6861`; the exact harness began in `55ca459`, was hardened through `692ca9d`, and emitted `artifacts/int-v1-031-hostdeck-tui-coexistence-evidence.json` from the clean production-default commit.

## Scope

Prove that exact Codex 0.144.0 supports the selected V1 multi-client contract on one user-private Unix socket: HostDeck and the normal laptop TUI concurrently address the same managed thread, ordered HostDeck projection remains valid, closing either client does not tear down the other, and unrelated runtime threads never become HostDeck sessions. This is an exact-runtime integration proof, not production service composition or a phone test.

`INT-V1-005` proves exact TUI resume of a materialized thread. `INT-V1-006` briefly overlaps a TUI with a raw semantic probe and reconnect. `INT-V1-027` renders an idle managed thread in the TUI while the assembled HostDeck connection remains ready. None proves a live turn through the production event pipeline while a TUI disconnects, the opposite HostDeck-disconnect direction, or explicit unmanaged-thread non-import under the same run.

## Frozen Topology

- The harness owns one temporary private root, isolated `CODEX_HOME`, two Git working directories, migrated SQLite state, one exact 0.144.0 app-server process, and one canonical Unix socket. No TCP listener, fake runtime, tmux runtime adapter, or second app-server may satisfy the proof.
- Tmux is used only as an isolated terminal emulator for the real immutable `codex resume --remote unix://PATH THREAD_ID` command. It is not HostDeck's runtime, event source, persistence layer, or product launcher.
- HostDeck connection A owns the production strict decoder, managed-thread identity gate, event normalizer, projection reducer, append port, repository, and post-commit pipeline. Its request wrapper records a bounded method/target ledger without content.
- The runtime contains exactly one durable HostDeck mapping and one deliberately unmanaged sibling thread. Both are no-model materialized through the exact thread client before live proof; only the managed identity may reach durable selected state.
- The model catalog selects one visible mini or spark entry and one declared reasoning effort. The whole proof may start exactly one bounded turn. The TUI never receives injected keys and never starts or steers work.
- Two sequential TUI attachments and two sequential HostDeck connections are required because teardown must be proven in both directions without pretending that a process which was already closed remained a client.

## Managed And Foreign Identity Matrix

1. HostDeck A connects at one stable positive generation and starts/materializes a managed thread plus an unmanaged sibling in distinct temporary repositories.
2. The selected repository stores exactly one mapping/projection for the managed identity. Buffered startup notifications drain only after that mapping exists.
3. Managed notifications deep-normalize and commit. Valid sibling notifications produce bounded identity-only unmanaged observations before payload projection; they create no mapping, event, publication, or inferred import.
4. Every later HostDeck and TUI read must return the exact managed thread and cwd. A different thread, path, generation, runtime version, or archive state fails the run.

## TUI-Disconnect Direction

1. Exact TUI A resumes the idle managed thread and remains alive on the same app-server socket. Its bounded pane output must show the Codex TUI and the exact temporary repository basename.
2. While TUI A is alive, HostDeck A dispatches exactly one bounded turn to the exact managed thread. The prompt carries one private sentinel and requests one shell command that writes `started`, sleeps long enough for teardown inspection, writes `finished`, and then returns.
3. HostDeck must durably observe one matching `turn/started` and an in-progress projection. TUI A must independently render the private sentinel while the same turn is active.
4. The harness closes TUI A during the command interval and proves its process and tmux socket are gone. It must not close or reconnect HostDeck A, signal app-server, alter the Unix socket, or issue another turn.
5. HostDeck A must retain the same generation and ready compatibility, observe the same turn complete, commit terminal projection after the TUI has exited, and read the exact thread back. This direction fails on a duplicate start/completion, event gap, pipeline failure, generation change, missing marker, or second turn.

## HostDeck-Disconnect Direction

1. Exact TUI B resumes the same now-terminal managed thread. The strict resume builder and bounded process command line must carry the exact managed thread id, the TUI must render the exact managed cwd, and later HostDeck read-back must match both identities; model reply text and viewport history are not identity authorities.
2. HostDeck A drains its event pipeline and closes only its client connection. App-server PID/socket identity and TUI B process remain unchanged; TUI B must still answer pane liveness and bounded capture checks.
3. While TUI B is still alive, HostDeck connection B performs a fresh exact handshake and reads the same thread/cwd/terminal turn. It must not create, import, resume with overrides, or mutate a replacement thread.
4. TUI B then closes completely. HostDeck B remains ready and performs another exact read of the same thread before cleanup. This separates TUI client lifetime from runtime and HostDeck client lifetime in both orders.

## Hard Success Criteria

| Area | Required evidence |
| --- | --- |
| Exact runtime | One reviewed Codex 0.144.0 app-server PID and one private Unix socket identity remain stable until outer cleanup; every HostDeck connection reports ready exact compatibility. |
| Client identity | Two distinct exact TUI process lifetimes and two HostDeck connection lifetimes address one unchanged managed thread/cwd. TUI commands come only from the strict builder. |
| Shared live work | Exactly one HostDeck `turn/start`; one returned turn id; one durable in-progress and one terminal event for that id; start/finish markers; TUI A renders the private turn sentinel while active. |
| TUI teardown isolation | TUI A exits during the active turn, its tmux socket disappears, HostDeck generation stays fixed, and the same turn completes through the same pipeline afterward. |
| HostDeck teardown isolation | HostDeck A closes while TUI B remains live; app-server and socket stay unchanged; HostDeck B connects and reads the same terminal thread before and after TUI B closes. |
| Subscription/event integrity | HostDeck pipeline has no failure, pending work drains, retained cursors are contiguous, turn lifecycle has no duplicate id/state, and TUI subscribe/unsubscribe creates no replay boundary or lost terminal event. |
| Foreign-thread isolation | One exact unmanaged sibling exists in runtime but selected storage remains one mapping. At least one identity-only unmanaged observation is recorded and no sibling event/publication/mapping is durable. |
| Bounds | One model turn, fixed process/request/notification/event/output/report limits, per-step and overall deadlines, exact generations, and no retry or fallback after a failed proof. |
| Privacy | Auth, paths, PIDs, socket identity, thread/turn ids, model, prompt/sentinel, pane output, raw notifications, and error causes remain temporary. Committed evidence contains only version, commit, booleans, and bounded counts. |
| Cleanup | Both TUI processes and tmux servers, both HostDeck connections, database, managed/unmanaged runtime threads, app-server, Unix socket, timers, temporary files, and root are closed or absence-proven. Failure cleanup cannot signal an unrelated process or unlink a replacement socket. |
| Exclusions | No phone, Tailscale, browser, SSE, Fastify registration, systemd, package, aggregate runtime, UI, or release claim. No dependency or lockfile change. |

## Failure Truth

- Missing/wrong binary, non-0.144.0 version, missing/private-auth violation, missing tmux, insecure root/socket, incompatible handshake, or early app-server exit fails before evidence.
- TUI wrong-thread/wrong-cwd identity, early pane death, output overflow, duplicate/reused TUI process, missing active-turn sentinel in TUI A, or incomplete tmux cleanup fails.
- Any model-budget excess, wrong turn target, second turn, malformed/duplicate/out-of-order managed event, managed classification race, pipeline/storage/publication failure, foreign durable state, or request/generation drift fails.
- HostDeck close that stops app-server/TUI, TUI close that disconnects HostDeck or loses terminal events, replacement socket identity, timeout, cleanup failure, or dirty-worktree evidence attempt fails without a passing artifact.
- No retry, fake notification, direct projection rewrite, terminal-text parsing as HostDeck state, literal slash input, hidden fallback, or in-process fake client may convert failure into success.

## Evidence Contract

- The exact smoke writes `artifacts/int-v1-031-hostdeck-tui-coexistence-evidence.json` only after all runtime and temporary cleanup succeeds and only from a clean implementation commit.
- The machine artifact records schema/task/time/commit, exact runtime version, client counts, stable-identity booleans, one-turn counts, event/foreign-isolation counts, bidirectional teardown booleans, privacy declarations, and zero remaining resources.
- The artifact must contain no numeric PID, path, socket device/inode, thread/turn identity, model, prompt/sentinel, pane output, auth, raw request/notification, or error text. Strict owner-only atomic publication and post-write parse/equality checks are required.

## Validation Plan

- Add the opt-in exact coexistence smoke plus direct tests for any reusable coordination/report helper introduced. Reuse production thread clients, command builder, transport/connection, event pipeline, storage, and bounded resource policy.
- Run focused TUI-command/pipeline/storage tests; full unit, contract, integration, and web suites; root/all-package typechecks; lint/exports; scaffold/planning; exact 0.144.0 binding and relevant no-model/IPC/TUI smokes; frozen offline install and production license/audit checks where available; diff/privacy/process/socket/temp inspection; and manual request/event/ownership review.
- The physical phone may remain disconnected for this runtime leaf.

## Implementation Findings

- The app-server launcher and each TUI terminal required explicit process-tree ownership. Cleanup now isolates the app-server process group, verifies the TUI pane/process group/session, stops only owned groups, and removes a stale tmux socket inode only after its daemon is gone and its recorded identity is unchanged.
- Early exact failures that looked like peer-client teardown were a HostDeck transport defect: Codex emitted a legitimate message above the old 1 MiB default, so `ws` closed HostDeck with `WS_ERR_UNSUPPORTED_MESSAGE_LENGTH` while app-server and its socket remained alive. The measured exact high-water mark was about 2.95 MB.
- The shared resource contract now uses the existing 8 MiB hard ceiling as the default inbound frame bound and an 8 MiB buffered-write bound. Protocol and scripted transports consume that one default, a 3,000,000-byte regression protects it, and the exact smoke proves the production default rather than a test override.
- Private evidence is published only after reverse cleanup and a clean-commit check. Failure diagnostics retain bounded classifications and counts rather than paths, identifiers, prompts, pane output, auth, or raw protocol content.
- `BUG-011` found three repeatability hazards when `INT-V1-032` reran this proof: a 20-second command paired with a one-call prompt could outlive the model's initial tool wait, second-TUI identity depended on model reply replay, and a fresh test home could enter Codex's startup update path. The corrected harness uses an eight-second command with a required 15-second initial wait, direct resume-id/cwd/read-back identity, a private `check_for_update_on_startup = false` test setting, a bounded history-load deadline, and content-free readiness diagnostics.

## Validation Result

- Focused protocol/resource/transport coverage passed 44 tests, including the 3,000,000-byte default-bound regression. Full unit passed 1,699 with 40 opt-in skips; contract passed 277; integration passed 33; web passed 33.
- Root and all-package typechecks, lint/package exports, scaffold, frozen offline install, diff checks, and the isolated exact Codex 0.144.0 671-file binding check passed. The default installed 0.144.3 binary correctly remains ineligible for reviewed-binding evidence.
- The production-default exact coexistence smoke passed against clean commit `692ca9d16d13790cbddb88f24f128af9ad820569` in 54.99 seconds. It proves one model turn, two HostDeck connections, two distinct sequential TUI processes, both teardown directions, contiguous durable publication, unmanaged-thread non-import, and complete outer-owner cleanup.
- The evidence file is one owner-only regular link at mode `0600`, records a 2,951,421-byte maximum inbound message and zero remaining resources, and contains no retained path, PID, socket identity, thread/turn id, model, prompt, TUI output, or auth value. No matching process or temporary smoke root remained after validation.
- Corrective `BUG-011` dirty-worktree probes complete both teardown directions and reach only the intentional clean-commit evidence guard. Clean corrective and aggregate evidence remain pending before `BUG-011` closure.

## Downstream Ownership

- `INT-V1-032` combines foreground/service ownership, reconnect, app-server crash, HostDeck restart, active/approval/incomplete outcomes, TUI coexistence, and cleanup under one aggregate lifecycle acceptance matrix.
- `INT-V1-008` owns legacy tmux-runtime disposition after lifecycle acceptance; this test-only terminal emulator is not evidence that tmux remains a selected runtime.
- `INT-V1-091` owns selected-runtime module hardening. `IFC-V1-036` to `IFC-V1-038` own production HostDeck startup/shutdown composition. Phone, package, and release proof remain downstream.
