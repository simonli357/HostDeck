# DAT-V1-003 Output And Audit Retention Caps Spike

Date: 2026-07-08

## Decision

- Use the exported `defaultRetentionPolicy` in `@hostdeck/contracts`:
  - `output_event_limit`: 10,000 retained output events per session.
  - `output_byte_limit`: 10,000,000 retained UTF-8 output payload bytes per session.
  - `audit_event_limit`: 5,000 retained audit events globally.
  - `audit_retention_days`: 30 days.
- Output retention uses a hybrid cap: keep the newest records until both the event count and byte count are within limits.
- Audit retention uses a hybrid cap: keep the newest audit records until both the event count and age window are within limits.
- Existing payload bounds remain V1 limits:
  - Output event payload text max: 12,000 characters.
  - Audit payload summary max: 16 fields, 64-character keys, 256-character string values, primitive values only, sensitive key names rejected.

## Cleanup Rules

- Run output cleanup after appending output for the affected session when either output cap is exceeded.
- Run audit cleanup after appending an audit record when either audit cap is exceeded.
- Run cleanup at daemon startup after migrations and before the service reports ready.
- Run cleanup after retention settings change.
- Cleanup must write a visible retention boundary record in the same logical operation as the delete/prune step.
- Cleanup failure degrades storage health and must not be silently ignored.

## Replay And Boundary Semantics

- Output cursors stay monotonically increasing; pruning never renumbers retained output.
- For output cleanup, store a boundary with:
  - `scope: "output"`.
  - `session_id`.
  - `reason`: `event_limit` or `byte_limit`.
  - `truncated_before_cursor`: the highest cursor removed.
  - `retained_record_count`.
  - `applied_at`.
- If a client asks for output before the retained range, API replay returns a `replay_boundary` event before retained events.
- The replay boundary's `next_cursor` is the first retained cursor after pruning; it must not imply contiguous history.
- UI must show the output boundary as missing older output, not as an empty or healthy continuous stream.
- Audit cleanup stores a boundary with `scope: "audit"`, `session_id: null`, the event/age reason, and `truncated_before_at` when an age cutoff applies.

## Fixture Estimate

Measured with:

```sh
node --input-type=module <<'EOF'
import { codexOutputFixtures } from './packages/test-fixtures/src/codex-output.ts';
// Measures UTF-8 bytes for current Codex-like output fixtures and runs bounded retention simulations.
EOF
```

| Fixture | Bytes | Lines |
| --- | ---: | ---: |
| `codex_question_waiting` | 123 | 7 |
| `codex_approval_waiting` | 80 | 5 |
| `codex_command_running` | 87 | 5 |
| `codex_tests_passed` | 84 | 5 |
| `codex_tests_failed` | 112 | 4 |
| `codex_compact_warning` | 81 | 1 |
| `codex_idle_no_output` | 0 | 0 |
| `codex_unknown_output` | 71 | 3 |

- Total fixture bytes: 638.
- Average all fixtures: 80 bytes.
- Average non-empty fixture: 91 bytes.
- Largest current fixture: 123 bytes.

These fixtures prove categories, not real-world volume. The 10 MB byte cap is sized for noisy sessions where many retained chunks are much larger than the current sample strings.

## Bounded Append / Replay Simulation

Simulation input:

- 12,050 output events for one session.
- Every 10th event is 12,000 bytes; other events are 900 bytes.
- Policy: 10,000 events or 10,000,000 bytes per session, whichever is lower.

Result:

- Retained output events: 4,979.
- Retained output bytes: 9,997,800.
- Highest removed cursor: 7,071.
- First retained cursor: 7,072.
- Last retained cursor: 12,050.

This means the byte cap dominates for noisy output, and a replay request before cursor 7,072 must receive a visible retention boundary.

Audit simulation:

- 6,200 appended audit events.
- Policy: 5,000 retained events or 30 days, whichever is lower.
- Result: 5,000 retained events, 1,200 dropped by event cap, and records older than day 30 are eligible for age cleanup.

## Follow-On Task Updates

- `DAT-V1-015` can start after `DAT-V1-010` because retention caps and boundary semantics are now resolved.
- `INT-V1-014` must preserve monotonic cursors and hand storage/API the first-retained-cursor boundary.
- `FE-V1-015` must render replay boundaries visibly and must not treat truncated output as complete history.

## Validation

- `node --input-type=module ...` fixture measurement and retention simulation.
- `pnpm check:scaffold`
- `pnpm typecheck`
- `pnpm -r --if-present typecheck`
- `pnpm lint`
- `pnpm test`: 6 files, 43 tests passed.
- `pnpm test:unit`: 6 files, 43 tests passed.
- `pnpm test:contract`
- `git diff --check`
