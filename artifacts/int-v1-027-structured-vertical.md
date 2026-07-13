# INT-V1-027 Assembled Structured Vertical

Date: 2026-07-13

Status: complete.

## Accepted Assembly

- One connection callback serializes selected raw notifications through strict normalization, durable projection append/publication, and one fixed post-commit control-observer fanout.
- Startup and mapping-time callbacks enter one bounded generation-tagged queue until both durable mappings and the shared pipeline exist. The queue drains in order through that pipeline before live callback admission.
- Exact repeated thread status, name, settings, and goal snapshots become bounded content-free `redundant_state` observations. Lifecycle duplicates and callback/control contradictions remain fatal.
- One exact private-socket app-server lifecycle owns two isolated Git cwd mappings in one migrated SQLite repository. It permits exactly three bounded model turns and one compact request.
- The Plan turn selects a noncurrent catalog model that supports minimal or low reasoning effort. Plan and selected-model success require matching normalized and durable event evidence.
- The same lifecycle proves passive goal set/read without a model turn, usage, two-cwd skills, command approval plus sandboxed side effect, exact interrupt, compact running/completed usage handling, thread-B isolation, live TUI coexistence, archive read-back, and reverse cleanup.
- The proof ledger is bounded to static claims and eight reviewed source labels. Generation drift, protocol issues, extra turns, disclosure, timeout, command failure, or incomplete cleanup fail the run; there is no sandbox, approval, or fake-adapter downgrade.

Implementation: `f8ebcfc`, `d765855`, `fe83654`; redacted acceptance output: `1045383`.

## Hardening Corrections

- Live catalog drift invalidated name-based low-cost model selection. The harness now requires the first noncurrent model with explicit minimal/low effort and independently requires Plan event evidence.
- Goal set is correctly proven as one structured `thread/goal/set` dispatch plus read-back with no `turn/start`.
- Approval response remains `responding` with no decision until matching resolution and item-terminal evidence jointly prove the final decision.
- Compact `last` and cumulative `total` token observations remain independently bounded; neither is assumed larger than the other.
- Durable terminal lookup paginates bounded 100-event pages through the committed high-water cursor. It fails a nonadvancing cursor instead of silently missing later terminal evidence.

Focused affected control/pipeline tests pass (103); the model-selection, paginated-evidence, and usage subset passes (18).

## Exact Runtime Acceptance

- Runtime: exact `codex-cli 0.144.0`.
- Executable SHA-256: `134063e133f0b4244fa3b251acf973d4fe4b4aeeacbdc135211bf480f59f1477`.
- Reviewed generated binding SHA-256: `e1a1a5cff3ab91862f9215dd06538eae1ea0b00bae48cbb7d87061faaee27e24` across 671 files.
- The packaged `bwrap-userns-restrict` profile is installed and loaded while `kernel.apparmor_restrict_unprivileged_userns=1` remains enabled. Strict read-only/on-request command execution reached the real approval and side-effect proof.
- Four complete aggregate runs passed across materially different command durations: 29.22 seconds, 87.41 seconds, 102.57 seconds, and 34.90 seconds.
- The final post-cleanup record reports a 30.931-second lifecycle, 58 protocol requests, 137 raw notifications, 121 observer receipts, and 117 durable publications across two sessions.
- The final record also reports exactly three `turn/start` requests, one `thread/compact/start`, one server request, 16 proof claims, all eight proof-source classes, approved sandbox side effect, TUI pass, and cleanup pass.
- Usage/token values, model values, prompts, credentials, paths, and thread/session/operation identifiers are not retained in this artifact. The cost bound is the fixed three-turn plus one-compact ceiling.

## Validation

- Unit: 964 passed; 29 explicit external tests skipped across 107 passing and 16 skipped files.
- Contract: 176 passed; integration: 16 passed; web: 14 passed.
- All-package typechecks, lint/package exports, scaffold, planning, exact binding, frozen offline install, zero-vulnerability production audit, and diff checks pass.
- Final acceptance-output change additionally passed the server typecheck, lint, and exact aggregate.

## Residual Scope

- Runtime process supervision, reconnect/restart reconciliation, production API composition, and selected-runtime module hardening remain owned by downstream leaves.
- This artifact proves the assembled exact operation vertical only; it does not claim package, service, dashboard, or release acceptance.
