# INT-V1-019 Pending Model Control

Date: 2026-07-10

## Scope

- Runtime contract: exact `codex-cli 0.144.0`, experimental binding `codex-app-server-0.144.0-experimental:sha256:e1a1a5cff3ab91862f9215dd06538eae1ea0b00bae48cbb7d87061faaee27e24`.
- Product boundary: structured visible model catalog, confirmed current model/effort, revisioned pending next-turn selection, exact one-thread dispatch, settings/read-back reconciliation, and explicit failure states.
- Excluded: public HTTP/CLI routes, audit composition, Plan/Goal composition, general prompt/steer lifecycle, UI, runtime supervision, and release readiness. Those remain owned by downstream leaves.

## Implemented Boundary

- `@hostdeck/contracts` now separates catalog, confirmed current, and pending state. Catalog ids and runtime model names are distinct. Pending state carries a positive revision, selection operation id, resolved effort, phase, accepted turn id when known, and bounded error only for conflict/unknown.
- `@hostdeck/codex-adapter` implements strict visible-only `model/list` pagination, cursor-cycle and entry bounds, exact raw-field parsing, unique model/runtime identities, one catalog default, one effort default per model, stable catalog revision, and strict current-state read-back.
- Current state uses `thread/resume` only with `{threadId, excludeTurns: true}`. Passing `thread/resume.model` is absent from the implementation and asserted absent from unit and real wire requests.
- A null requested effort resolves to the selected catalog model's explicit default before pending state is stored.
- `@hostdeck/server` owns a bounded process-local per-session state machine. Selection and dispatch serialize per exact session, use optimistic pending revisions, reject stale replacement, re-read the current baseline immediately before mutation, and send the selected runtime model/effort through `turn/start` exactly once.
- The `turn/start` response is accepted only. Matching `thread/settings/updated` or later resume read-back clears pending. Known remote rejection restores pending. Timeout/disconnect latches unknown without retry. Catalog drift and mismatched settings become replaceable conflicts.
- Archived or missing owning sessions release pending capacity. Unknown current runtime values remain visible as unknown instead of being assigned an invented catalog id.

## Bounds And Failure Matrix

| Case | Result |
| --- | --- |
| Empty, hidden, duplicate-id, duplicate-runtime-name, ambiguous-default, malformed-effort, malformed-service-tier, cursor-cycle, page overflow, or more than 128 catalog entries | Adapter rejects without exposing partial catalog truth. |
| Unknown model id | `model_unknown`; no turn request. |
| Unsupported effort | `effort_unsupported`; no turn request. |
| Stale pending revision, active/unknown turn, in-flight/awaiting selection, or mismatched settings/read-back | `operation_conflict`; no automatic retry. |
| Unsupported model capability | `capability_unsupported`, distinct from model lookup and dispatch uncertainty. |
| Known remote rejection | Pending returns to `pending`; caller receives remote rejection/conflict. |
| Timeout/disconnect after possible send | Pending becomes `unknown`; retry is blocked until event/read-back reconciliation. |
| Unknown dispatch after an external change already made current state equal the desired value | Remains `unknown`; equal read-back is not accepted as proof because the pre-dispatch baseline is equal. |
| Matching settings event or accepted-turn later read-back | Pending clears; confirmed current remains Codex-owned. |
| HostDeck process restart before dispatch | Unapplied ephemeral selection is dropped; current Codex settings are re-read and no stale mutation is replayed. |

## Real Boundary Evidence

- Command: `HOSTDECK_CODEX_BIN=/home/simonli/.npm/_npx/b3578c5622a0f24c/node_modules/.bin/codex pnpm smoke:codex-model`.
- Isolation: temporary mode-`0700` runtime, Codex home, and Git project; private copied auth; private Unix socket; one materialized thread; one bounded turn; archive; connection/process/root cleanup.
- Probe policy: the disposable app-server starts with explicit `danger-full-access` and `never` settings because this host cannot create the default bubblewrap user namespace. The production model client does not supply or downgrade sandbox/approval policy.
- Assertions: exact reviewed version; non-empty visible catalog; one visible non-current model; exact resolved effort; one `turn/start` carrying the selected model/effort; matching settings notification; terminal turn event; later resume read-back; zero resume requests carrying `model`; archive and cleanup.
- A terminal prompt failure remains a structured turn result and is not treated as failure to apply or proof of applying the model setting. The smoke owns setting confirmation, not general prompt success.
- No prompt, response, model name, thread id, path, account value, credential, or raw protocol frame is retained in this artifact.

## Cross-Control Review

- `collaborationMode` takes precedence over top-level model/effort. `INT-V1-021` must embed a simultaneously pending model/effort into `collaborationMode.settings`; contradictory top-level fields are prohibited.
- Active goal set/resume can autonomously start a turn but cannot carry pending next-turn settings. `INT-V1-020` must reject agentic activation while model or Plan state is unapplied.
- `INT-V1-018` must consume model and Plan revisions atomically when assembling the normal prompt turn. The standalone model dispatch proves this task's exact boundary; it is not the final combined dispatcher.

## Validation

- Focused adapter/resource/server model tests: pass.
- Exact authenticated model smoke: pass on repeated isolated runs after the disposable sandbox policy was made explicit.
- Root and all-package typechecks: pass.
- Unit, contract, integration, and web suites: pass.
- Lint/format/package exports, scaffold, planning graph, exact 671-file binding check, and `git diff --check`: pass.

Final suite counts and implementation commit are recorded in the owning backlog row and `docs/status.md` after the coherent implementation commit.
