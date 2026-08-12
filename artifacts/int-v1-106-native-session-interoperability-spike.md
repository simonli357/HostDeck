# INT-V1-106 Native Session Interoperability Spike

Status: passed

## Result

- Exact Codex `0.144.0` persisted a thread created by the native CLI with source `cli`, a stable UUIDv7 thread id, an absolute cwd, null parent/fork ids, `ephemeral: false`, `historyMode: legacy`, and the exact creator version.
- A no-turn, shell-only, or interrupted-only CLI thread remained directly readable and resumable by id but was intentionally absent from `thread/list`. After one bounded completed turn, the same thread became discoverable through `thread/list { sourceKinds: ["cli"] }` with no identity change.
- A distinct app-server resumed the closed native thread by exact id and returned its bounded initial turn page. The product path needs no create, fork, rename, archive, delete, transcript copy, rollout-file read, or Codex SQLite read.
- Two independent app-servers could both resume the same idle persisted thread. Codex `0.144.0` therefore provides no exclusive-ownership signal HostDeck can rely on; V1 must require explicit closed-client handoff and must not claim automatic overlap detection.
- Discovery can omit transcript preview and rollout path. Eligibility can be decided from strict source, parent/fork, ephemeral, archive, cwd, creator-version, status, and durable HostDeck-mapping facts.

## Validation

| Probe | Result |
| --- | --- |
| Native creation | Exact CLI created one isolated persisted root thread with unchanged source/id metadata. |
| Visibility boundary | Empty/shell/interrupted states were not listed; one completed bounded turn made the same id visible. |
| Exact read/resume | `thread/read` and `thread/resume` succeeded from a separate exact app-server; bounded initial history returned three terminal turns. |
| Overlap observation | Two isolated app-servers concurrently resumed the same idle id; both succeeded, so overlap is unsafe rather than rejected. |
| Privacy | Evidence retains only protocol shape and bounded counts; no prompt, response, auth material, rollout path, or private cwd is retained. |
| Cleanup | Both TUI/app-server probe lifetimes ended and the copied isolated Codex home was removed. The production HostDeck app-server was not touched. |

The original no-model discovery assumption was disproved by the exact runtime: Codex does not list a CLI thread until it has a completed conversational turn. The implementation and hardening smoke must therefore create one bounded native conversation when proving discovery, while deterministic tests cover no-turn exclusion without model use.
