# INT-V1-109 Native Session Interoperability Hardening

Status: passed

## Result

- One standalone Codex 0.144.0 thread keeps the same native id through discovery, HostDeck adoption, prompt dispatch, service restart, laptop TUI resume, unmanage, and direct native read/resume.
- Existing authenticated phone-facing list, detail, event-page, and SSE routes expose the adopted session and ordered HostDeck turn without transcript copying.
- Unmanage removes HostDeck membership only. It issues no Codex archive, delete, fork, or replacement request.
- `BUG-082` now admits the valid cursor-1 adoption boundary while retaining strict corruption rejection.
- `BUG-083` makes shared-home startup independent of malformed unrelated history, restores managed `notLoaded` threads by exact id, and admits compatible histories created by nearby Codex versions without rewriting their provenance.
- `BUG-086` admits ordinary top-level user-facing CLI forks by unchanged id while preserving exact fork provenance, excluding parent/subagent sessions, and retaining an explicit bounded suffix from mature or interrupted history.

## Validation

| Gate | Result |
| --- | --- |
| Exact runtime | Pinned 0.144.0 model-backed aggregate: 1/1 passed in 22.58 seconds with complete isolated cleanup. |
| Deterministic behavior | Focused native adoption cluster: 82 passed; duplicate/race/post-commit loss/active/uncertain/malformed/unmanage cases remain covered by owning suites. |
| Workspace | Unit 3,217 passed/32 opt-in skipped; contract 287 passed; integration 36 passed. |
| Platform | Focused Unix/WebSocket/TUI/Windows-supervisor contracts 9 passed; native Linux/Windows CI evidence gate 8 passed. |
| Static | Root typecheck; Biome and eight-package exports across 897 files; 638-module runtime boundary; exact 671-file Codex binding. |
| Package | Commit `76f5016` built and independently verified a deterministic Linux package with 6,303 entries and 1,283 owned outputs. All 43 package contract tests passed. |
| Supply chain | Six metadata and real-package tests passed. |
| Live shared home | Preserved-state deployment is ready with both managed sessions current, paired write authority retained, and ordinary CLI sessions from Codex 0.130.0 through 0.146.0 discoverable. Exact read/resume probes preserved id and cwd for 0.144.5 and 0.146.0 histories; a full 20-turn 0.130.0 adoption snapshot parsed under the pinned 0.144.0 controller without mutation. |
| Live SideCue fork | Exact thread `019fc8bd-25ef-74c3-a3bf-c6e59e4122a4` parsed through three read-only requests: top-level fork provenance retained, four recent turns and 82 user/agent messages bounded to 20,734 text bytes, and earlier history marked truncated without transcript output or mutation. |

## Remaining Boundary

- V1 adopts an eligible inactive standalone CLI thread through laptop-only `discover` and confirmed `adopt`; it does not take over a concurrently active standalone client.
- The package harness's synthetic uninstalled-service invocation cannot pass on this laptop while the real HostDeck user units are active. The committed package itself builds and verifies; validation did not stop or alter the installed service.
- Native model-backed Windows execution remains owned by blocked `INT-V1-104`; deterministic Windows transport and package contracts pass here.

## Physical Phone Follow-Up

- Installed `0.0.5` fixes `BUG-085`, where a recent stream requested at cursor zero rejected the valid nullable initial adoption boundary.
- One standalone Codex 0.144.0 thread was adopted by unchanged id, retained its original turn, accepted and streamed exact `ADOPTED_PHONE_OK` from the physical phone, reopened through the shared HostDeck TUI, unmanaged, and reopened as a normal Codex session with both turns intact.
- SideCue, MarketPilot, and ScandyControl histories are discoverable from the shared home. They were not adopted because V1 deliberately requires the separately running owner to be closed before confirmed handoff.
