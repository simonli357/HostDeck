# INT-V1-006 Exact Codex Operation Semantics

Date: 2026-07-10

## Scope And Bounds

- Runtime: exact `codex-cli 0.144.0`, experimental generated binding `codex-app-server-0.144.0-experimental:sha256:e1a1a5cff3ab91862f9215dd06538eae1ea0b00bae48cbb7d87061faaee27e24`.
- Isolation: one temporary mode-`0700` `CODEX_HOME`, private mode-`0600` auth copy, private Unix socket, two temporary Git repositories, and isolated tmux TUI.
- Capture: 612 JSON-RPC frames, 390,180 UTF-8 bytes, zero malformed frames. Prompt, response text, ids, paths, approval payload text, and account totals are not retained.
- Model use: eight observed `turn/started` notifications across discovery, plan/approval, and control/compact captures. One of those turns was manual compaction. Two turns exposed the previously hidden active-goal materialization bug.
- Time: 132,416 ms of recorded live-operation windows. No model mutation was automatically retried.
- Cost: app-server exposes account token-activity shape and per-thread token updates, but no monetary cost. Exact token values were intentionally excluded from wire evidence, so no currency or token estimate is invented.

Machine evidence:

| Capture | Purpose | SHA-256 |
| --- | --- | --- |
| `artifacts/int-v1-006-goal-activation-observation.json` | Active-goal/materialization discovery. | `8a507d7914c04c47e063512da1f9e9c77a337b04db3dd042c9f510ff87815b0f` |
| `artifacts/int-v1-006-plan-approval-observation.json` | Plan, stale control, unsupported method, approve/deny, and event catalog. | `30a4bbf74fdc94f079df16170a14aeb1f3b68b76d41205253f3be7ddaa0becd7` |
| `artifacts/int-v1-006-control-observation.json` | Event-gated steer, model persistence, TUI coexistence, reconnect, interrupt, and compact start. | `9c6b3eaa7c0667f7008013b800e3899a0c317e27b74e7f5669ffabe7e94b46dc` |

`codex-operation-semantics-evidence.test.ts` loads all three captures in the deterministic unit gate and verifies version, binding, coverage, redaction, semantic facts, malformed-frame count, and cleanup.

## Selected Operation Matrix

| Product control | Exact observed boundary | Selected HostDeck behavior | Rejected behavior |
| --- | --- | --- | --- |
| Managed thread | `thread/start` with legacy history; paused internal `thread/goal/set`, clear, stored read/list. | Materialize with a paused marker, verify idle plus empty turns, then expose the durable mapping. | An active internal goal; name-only materialization; permanent ownership from transient `threadSource`. |
| Prompt | `turn/start` response is initially `inProgress`; matching `turn/started` follows. | Treat the response as accepted, and the event as the first active/steerable proof. Correlate thread and turn ids. | Reporting running/steerable from the response alone or redispatching an uncertain start. |
| Steer | `turn/steer` with `expectedTurnId` succeeds only after matching `turn/started` and returns that turn id without another `turn/started`. | Gate steer on the projected active turn and exact id. | Steer immediately after `turn/start`, stale/completed steer, or implicit new-turn fallback. |
| Model | `model/list` returned a live catalog. `thread/resume.model` on an already loaded thread was accepted but read back the old model. `turn/start.model` read back after reconnect. | Select a catalog model as pending next-turn state, send it on `turn/start`, and verify later settings/resume state. | Claiming an immediate loaded-thread model change from `thread/resume.model`; invented models; slash text. |
| Goal | Paused objective set/get and paused-to-complete-to-clear are structured. An active objective autonomously starts turns. | Treat paused goal edits as state changes. Treat resume/active as agentic work acceptance with projected turns, budget, and explicit audit. | Treating active goal as passive metadata, using it for materialization, or claiming pause interrupts an active turn without separate proof. |
| Plan | `collaborationMode/list` returned Plan/Default masks. Plan on `turn/start` emitted `thread/settings/updated`, plan item lifecycle/deltas, and completed. Explicit Default on a later turn exited Plan. | Store a pending next-turn mode, build exact settings from the mask, apply on `turn/start`, and verify the settings event. | Literal `/plan`, a zero-turn toggle claim, or completion inferred from a mode request alone. |
| Usage | `account/usage/read` returned `summary` plus `dailyUsageBuckets`; turns emitted thread token and account rate-limit updates. | Present capture time, account/runtime scope, bounded fields, and unsupported/stale states. | Per-thread monetary cost or quota inference from account totals. |
| Compact | `thread/compact/start` returned `{}` immediately, then emitted a new turn and `contextCompaction` item start. No item completion was observed in 45 seconds for interrupted short history. | Require confirmation, mark accepted/in-progress, and claim reduction only after authoritative item/turn completion. Timeout/disconnect remains incomplete and interruptible. | Reporting compacted from `{}`, relying on deprecated `thread/compacted`, or automatic retry. |
| Skills | `skills/list` returned two cwd entries, 58 discovered skills, and zero errors. | Validate bounded per-cwd entries, deduplicate, redact paths, and support explicit empty/error. | Arbitrary filesystem scans or terminal parsing. |
| Approval | `item/commandExecution/requestApproval` carried thread/turn/item identity and `startedAtMs`; no expiry. `decline` prevented the side effect; `accept` permitted it; each emitted `serverRequest/resolved`; duplicate response was locally rejected. | HostDeck owns pending expiry and connection generation, responds exactly once, and projects authoritative item completion. | App-server-owned expiry assumptions, duplicate response, wrong-generation response, or response success as command success. |
| Interrupt | Active exact `turn/interrupt` returned `{}` and emitted `turn/completed: interrupted`; the thread remained unarchived and the other thread unchanged. | Require projected active identity and confirmation; terminal truth comes from the event. | Completed/stale interrupt success, archive equivalence, or generic completion. |
| TUI/reconnect | TUI and HostDeck read the same active thread. Explicit HostDeck reconnect advanced generation while TUI/runtime survived; `thread/resume` rejoined the exact turn/model before interrupt. | Expire connection-bound approvals, re-handshake, resume/reconcile, and never retry mutation automatically. | Treating client disconnect as runtime death or cross-generation request ownership. |
| Unsupported | Unknown local method was rejected before wire. Completed steer/interrupt returned remote `-32600`. | Preserve local-versus-remote rejection and retry safety. | Text fallback or generic success/error collapse. |

## Required Event Classification

Selected required notifications now include:

- `account/rateLimits/updated`
- `item/agentMessage/delta`
- `item/plan/delta`
- `item/started`
- `item/completed`
- `serverRequest/resolved`
- `thread/started`, `thread/status/changed`, `thread/settings/updated`, `thread/name/updated`
- `thread/goal/updated`, `thread/goal/cleared`, `thread/tokenUsage/updated`, `thread/archived`
- `turn/started`, `turn/completed`, `turn/plan/updated`

Observed but optional/operator-facing notifications such as `configWarning`, `mcpServer/startupStatus/updated`, `remoteControl/status/changed`, and `app/list/updated` remain generated-but-unhandled until an owning leaf selects them.

## Bugs Closed

- `BUG-006`: exact Codex can emit notifications after the initialize response but before `initialized`. Connection now queues that narrow window in order under a bound while still rejecting pre-response messages and overflow.
- `BUG-007`: active internal goals autonomously start model work. Legacy materialization now uses a paused marker, pauses recoverable prior active markers, and proves idle/empty/no-token behavior in the real lifecycle smoke.

## Cleanup

- Discovery and plan/approval captures archived both managed threads before shutdown.
- The control capture reached bounded compact incompleteness before archive; its isolated app-server, connection, TUI, socket, repositories, auth copy, and entire temporary `CODEX_HOME` were still terminated/removed.
- Every capture reports app-server stopped, connection closed, recorder disposed, and temporary root removed. No retained real thread exists because each runtime home was disposable and deleted.

## Validation

- Focused broker/connection/thread/recorder/evidence tests.
- Exact isolated `pnpm smoke:codex-ipc`.
- Exact isolated `pnpm smoke:codex-threads`, including idle state, empty turn history, and no turn/token/message event before TUI.
- Exact authenticated live capture commands used `HOSTDECK_CODEX_BIN` pointing to isolated 0.144.0 and explicit report paths; no default 0.144.1 acceptance was introduced.
- Root and all-package typechecks, lint/exports, scaffold, planning (196 tasks, 84 requirements, 622 dependencies, 11 queued), exact binding verification, unit (426 passed, 19 explicit external tests skipped), contract (111), integration (16), web (14), production audit, evidence hashes, manual diff review, and diff checks pass.

Official references:

- <https://learn.chatgpt.com/docs/app-server>
- <https://learn.chatgpt.com/docs/remote-connections>

Observed exact 0.144.0 bindings and captures override newer documentation when their schemas or timing differ.
