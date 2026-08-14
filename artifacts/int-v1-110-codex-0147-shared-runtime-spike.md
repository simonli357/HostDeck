# INT-V1-110 Codex 0.147 Shared Runtime Spike

- Runtime: `codex-cli 0.147.0`; upstream tag `rust-v0.147.0`, commit `be6e8eac029b183056b7e4402879f15d2c85f61b`.
- Reproduction: `CODEX_BIN=/absolute/path/to/codex pnpm spike:codex-shared-runtime` on Ubuntu x64.
- Safety: isolated `CODEX_HOME`, fake credential, no prompt/model turn, bounded RPC/process deadlines, output credential scan, and mandatory process/socket/temp cleanup.

## Frozen Observations

| Boundary | Result |
| --- | --- |
| Standard endpoint | `$CODEX_HOME/app-server-control/app-server-control.sock`; directory `0700`, socket `0600`. |
| Startup ownership | Codex serializes Unix startup with `app-server-startup.lock`, rejects a live socket, removes a stale socket, and supports concurrent WebSocket clients. |
| Ordinary TUI | `strace` proves both plain `codex` and `codex resume <native-uuid>` connect to the standard socket without `--remote`. |
| Reuse bypasses | Implicit reuse is skipped for any `-c` override, non-default config loader/profile, `--strict-config`, hook-trust bypass, PSP, explicit remote endpoint, or non-Unix host. These invocations must remain visibly outside HostDeck's shared-runtime guarantee. |
| Loaded-before discovery | Paged `thread/loaded/list` returns sorted native UUIDs currently held by the broker. |
| Created-after discovery | `thread/started` reaches an initialized concurrent client because Codex attaches initialized connections when the thread manager announces a new thread. |
| Existing subscription | `thread/resume` on a materialized loaded thread subscribes the caller atomically and starts no turn; `excludeTurns: true` returns metadata with zero turns. |
| Unmaterialized startup | A loaded no-prompt thread is available through `thread/read(includeTurns: false)`, but `thread/resume` returns `no rollout found`. Retrying after Codex materializes the rollout succeeds with zero turns. HostDeck must represent this as bounded pending enrollment, not drop it or mutate the thread. |
| Multiple clients | Two RPC clients and ordinary TUI clients coexist; either RPC client remains usable after its peer disconnects. |
| Cleanup | Both clients close, the broker exits, its socket disappears, and the isolated tree is removed. |

Source anchors: `codex-rs/tui/src/lib.rs` (`maybe_probe_default_daemon_socket`, `can_reuse_implicit_local_daemon`), `codex-rs/app-server-transport/src/transport/{mod,unix_socket}.rs`, and `codex-rs/app-server/src/{lib,request_processors/thread_processor,request_processors/thread_lifecycle}.rs`.

## Implementation Constraints

- HostDeck attaches to one exact compatible broker; closing HostDeck must not imply broker shutdown.
- Startup reconciliation pages `thread/loaded/list`, reads metadata without turns, then subscribes with metadata-only resume when a rollout exists.
- `no rollout found` is one explicit pending state retried on bounded reconciliation. Other resume failures remain errors.
- New-thread notifications are processed concurrently with startup paging and deduplicated by native UUID.
- Notification receiver lag is not self-healed by Codex 0.147; HostDeck must emit a boundary and reconcile instead of silently losing a session.
