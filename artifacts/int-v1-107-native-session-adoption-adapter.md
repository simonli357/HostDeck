# INT-V1-107 Native Session Adoption Adapter

Status: passed

## Result

- A dedicated adapter discovers only non-archived root `cli` threads from exact Codex `0.144.0`, normalizes metadata into the strict public identity, and omits preview, rollout path, Git metadata, title, and provider-private fields.
- Discovery, history, item counts, text, pagination, entries, deadlines, and resume metadata are bounded. Malformed or additive generated shapes, repeated identities/cursors, and capacity exhaustion fail explicitly.
- Adoption history is bracketed by two exact identity reads. It retains only bounded user/agent text and terminal turn state; reasoning, commands, output, tool data, paths, prompts, citations, and failure detail are validated then discarded. Any identity drift or newly ineligible state rejects.
- Resume sends exactly `thread/resume { threadId, excludeTurns: true }`; the client exposes no create, fork, rename, archive, or delete operation.
- The exact-runtime no-model smoke creates one isolated native shell-only thread, closes that TUI, confirms it is absent from discovery, then reads and resumes the unchanged id through a distinct app-server. Temporary auth/state/runtime files and processes are removed.

## Validation

| Gate | Result |
| --- | --- |
| Focused adapter | 10/10 passed. |
| Full adapter | 370 passed; 9 intentional smoke skips. |
| Contract | Native-session contract suite passed, including frozen default limit 50 and maximum 100. |
| Exact Codex smoke | Pinned `0.144.0` shell-only read/resume passed without a model turn. |
| Static | Adapter typecheck, focused Biome, runtime boundary, and root typecheck passed. |
| Privacy/cleanup | Sentinel matrix retained no private non-message content; exact smoke retained no transcript and removed its temporary root/socket/processes. |
