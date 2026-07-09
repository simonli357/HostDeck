# INT-V1-001 Tmux Capture Spike

Date: 2026-07-08

## Scope

- Prototyped real tmux output capture on Ubuntu 24.04 with fake Codex-like output.
- Resolved `SPK-ARCH-001`: use tmux `pipe-pane` for live ordered output ingestion and bounded `capture-pane` snapshots for startup/restart recovery.
- Kept the prototype isolated on throwaway tmux sockets and temporary directories; no user tmux sessions were touched.

## Environment

- Host OS: Ubuntu 24.04.4 LTS.
- Codex CLI: `codex-cli 0.143.0` at `/home/simonli/.local/bin/codex`.
- `sudo -n true` requires a password, so system package installation was not available.
- Downloaded the Ubuntu `tmux 3.4-1ubuntu0.1` package with `apt-get download`, extracted it under `/home/simonli/.local/hostdeck-tools/tmux`, and symlinked `/home/simonli/.local/bin/tmux`.
- Blocker check now passes: `command -v tmux && tmux -V` returns `/home/simonli/.local/bin/tmux` and `tmux 3.4`.

## Prototype Results

### Live `pipe-pane`

- Scenario: attach `pipe-pane` before fake output starts.
- Result: 6 emitted lines were captured in exact order.
- Observed order: `0001,0002,0003,0004,0005,0006`.

### Reader Restart / Gap Recovery

- Scenario: attach `pipe-pane`, start 12 ordered fake output lines, detach the pipe mid-stream, then reattach it.
- Result: the pipe logs missed lines emitted while detached, but `capture-pane -p -S -200` recovered the bounded pane history in order.
- First pipe log: `0001`.
- Reattached pipe log: `0005,0006,0007,0008,0009,0010,0011,0012`.
- Bounded capture snapshot: `0001,0002,0003,0004,0005,0006,0007,0008,0009,0010,0011,0012`.

### Failure Modes

- Missing tmux server exits nonzero; sample stderr: `No such file or directory`.
- Missing target in an existing tmux server exits nonzero; sample stderr: `can't find session: missing-session`.
- `pipe-pane` alone is not reconnect-safe because output emitted while the pipe is detached is not appended to the pipe log.
- `capture-pane` is bounded by tmux history and cannot prove full continuity after pane history loss, pane clear, target loss, or an anchor mismatch.

## Decision

- Use `pipe-pane` as the primary live capture mechanism for V1 managed panes.
- On daemon startup, output-reader startup, and reader restart, run a bounded `capture-pane` snapshot before rearming `pipe-pane`.
- Assign HostDeck output cursors at storage ingest time; tmux output does not provide durable cursors.
- Recover gaps only when the bounded snapshot can be matched against the last retained HostDeck output anchor.
- Emit a replay/truncation boundary when continuity cannot be proven because the anchor is absent, tmux history was pruned, the pane was cleared, or the target is stale/missing.
- Keep `capture-pane` polling as a fallback/snapshot path, not the normal live ingestion path.
- Do not replace tmux with direct PTY management in V1; tmux remains the lifecycle and attach boundary.

## Rejected Options

- `pipe-pane` only: rejected because reader downtime creates silent output gaps.
- `capture-pane` polling only: rejected as the default because it increases duplicate detection complexity and loses live event timing; it remains useful for bounded recovery snapshots.
- Direct PTY ownership: rejected for V1 because it would bypass the approved tmux lifecycle, detach, and laptop attach model.

## Validation

- `command -v tmux && tmux -V` passed with user-local `tmux 3.4`.
- Live `pipe-pane` prototype captured 6 of 6 lines in order.
- Reader restart prototype showed `pipe-pane` missed detached output while `capture-pane` recovered 12 of 12 bounded-history lines in order.
- Missing-server and missing-target probes returned nonzero errors suitable for typed adapter failures.
- `pnpm test` passed with 102 tests across 17 files.
- `pnpm test:contract` passed with 37 tests across 4 files.
- `pnpm lint` passed.
- `pnpm typecheck` passed.
- `git diff --check` passed.

## Follow-Up

- `INT-V1-014` should implement the output reader using live `pipe-pane` plus bounded `capture-pane` startup/restart recovery and explicit replay-boundary emission.
- `IFC-V1-003` should expose stream replay boundaries and stale cursor behavior using the persisted HostDeck cursors, not tmux line numbers.
- `INT-V1-011` remains the next tmux implementation leaf because stable target naming/listing is needed before real session start, reconciliation, and reader ownership.
