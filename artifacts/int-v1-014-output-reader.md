# INT-V1-014 Output Reader And Replay Handoff

## Scope

- Added a real tmux `pipe-pane` controller for live pane output capture into an append-only file.
- Implemented real adapter `readOutput()` using bounded `capture-pane` snapshots with in-memory HostDeck cursors.
- Added a server-side output reader service that drains captured text into the existing retention repository.
- Added replay response mapping from stored output/retention rows into API output events and replay-boundary events.

## Behavior

- `createRealTmuxPipePaneController()` arms `tmux pipe-pane -o` for a specific HostDeck pane and can disarm it explicitly.
- Real `readOutput()` uses `tmux capture-pane -p -S -200`, trims terminal padding, assigns monotonic cursors, and rejects stale targets.
- `createOutputReader()` appends captured output to `RetentionRepository` with HostDeck-owned cursors and existing retention policy enforcement.
- If a new capture cannot be matched to retained output, the reader appends a stored `replay_boundary` event before appending the new snapshot.
- `replaySession()` maps retention cleanup boundaries to API `replay_boundary` events with reason `retention`.
- Reader capture failures are observable through `state()` and throw `HostDeckOutputReaderError` with code `capture_failed`.

## Validation

- `command -v codex && codex --version && command -v tmux && tmux -V` passed with `codex-cli 0.143.0` and `tmux 3.4`.
- `pnpm install --frozen-lockfile` passed.
- `pnpm check:scaffold` passed.
- `pnpm --filter @hostdeck/server typecheck` passed.
- `pnpm --filter @hostdeck/tmux-adapter typecheck` passed.
- `pnpm test:unit -- packages/server/src/output-reader.test.ts packages/tmux-adapter/src/index.test.ts` passed.
- `pnpm lint` passed.
- `pnpm -r --if-present typecheck` passed.
- `pnpm test` passed: 18 unit test files, 118 tests.
- `pnpm test:contract` passed: 4 contract test files, 37 tests.
- `git diff --check` passed.

## Test Coverage

- Real tmux live `pipe-pane` writes delayed fake Codex output to an ingestion file.
- Real adapter `readOutput()` captures fake Codex output and returns cursor-filtered events.
- Server output reader appends only newly captured output and assigns monotonic cursors.
- Retention cleanup becomes API replay-boundary output.
- Restart/continuity mismatch creates a stored replay-boundary event before the new snapshot.
- Capture failure updates observable reader state and fails loudly.

## Remaining Gaps

- Durable startup reconciliation that restarts readers for live sessions remains in `INT-V1-015`.
- Full real Ubuntu tmux smoke remains in `INT-V1-016`.
- Module hardening for repeated reader crash/restart and stale cursor edges remains in `INT-V1-090`.
- API stream fanout and route exposure remain in `IFC-V1-003`.
