# INT-V1-109 Native Session Interoperability Hardening

Status: passed

## Result

- One standalone Codex 0.144.0 thread keeps the same native id through discovery, HostDeck adoption, prompt dispatch, service restart, laptop TUI resume, unmanage, and direct native read/resume.
- Existing authenticated phone-facing list, detail, event-page, and SSE routes expose the adopted session and ordered HostDeck turn without transcript copying.
- Unmanage removes HostDeck membership only. It issues no Codex archive, delete, fork, or replacement request.
- `BUG-082` now admits the valid cursor-1 adoption boundary while retaining strict corruption rejection.
- `BUG-083` makes shared-home startup independent of malformed unrelated history, restores managed `notLoaded` threads by exact id, and admits compatible histories created by nearby Codex versions without rewriting their provenance.
- `BUG-086` admits ordinary top-level user-facing CLI forks by unchanged id while preserving exact fork provenance, excluding parent/subagent sessions, and retaining an explicit bounded suffix from mature or interrupted history.
- `BUG-087` centralizes replay-boundary reasons in the shared contract so a valid adoption boundary cannot crash strict Session Detail controls.

## Validation

| Gate | Result |
| --- | --- |
| Exact runtime | Pinned 0.144.0 model-backed aggregate: 1/1 passed in 22.58 seconds with complete isolated cleanup. |
| Deterministic behavior | Focused native adoption cluster: 82 passed; duplicate/race/post-commit loss/active/uncertain/malformed/unmanage cases remain covered by owning suites. |
| Workspace | Unit 3,227 passed/32 opt-in skipped; web 911 passed; contract 287 passed; integration 36 passed. |
| Platform | Focused Unix/WebSocket/TUI/Windows-supervisor contracts 9 passed; native Linux/Windows CI evidence gate 8 passed. |
| Static | Root typecheck; Biome and eight-package exports across 897 files; 638-module runtime boundary; exact 671-file Codex binding. |
| Package | Commit `f923874` built and independently verified `0.0.7`: 6,303 entries, 1,283 owned outputs, 638 sources, three web files, package SHA-256 `40b6fa57db736260473f8d8c47ae92baaf5ae6e02d24d09dcc8e4c39f0bb066f`. |
| Supply chain | Six metadata and real-package tests passed. |
| Live shared home | Preserved-state deployment is ready with both managed sessions current, paired write authority retained, and ordinary CLI sessions from Codex 0.130.0 through 0.146.0 discoverable. Exact read/resume probes preserved id and cwd for 0.144.5 and 0.146.0 histories; a full 20-turn 0.130.0 adoption snapshot parsed under the pinned 0.144.0 controller without mutation. |
| Live SideCue fork | Exact thread `019fc8bd-25ef-74c3-a3bf-c6e59e4122a4` parsed through three read-only requests, retained top-level fork provenance, and was adopted unchanged as `sess_f3ce8660795f47a23dc3`. The mapping survived upgrade and opened through managed-id `codexdeck resume` with the same cwd and native id. |

## Remaining Boundary

- V1 adopts an eligible inactive standalone CLI thread through laptop-only `discover` and confirmed `adopt`; it does not take over a concurrently active standalone client.
- The package harness's synthetic uninstalled-service invocation cannot pass on this laptop while the real HostDeck user units are active. The committed package itself builds and verifies; validation did not stop or alter the installed service.
- Native model-backed Windows execution remains owned by blocked `INT-V1-104`; deterministic Windows transport and package contracts pass here.

## Physical Phone Follow-Up

- Installed `0.0.7` preserves the shared Codex PID/socket while upgrading HostDeck and retaining all managed sessions.
- A cache-disabled Xiaomi 15 Pro reload of exact `sidecue_sol` used the new JS/CSS assets and returned `200` for authenticated access, host, detail, approval, CSRF, and SSE requests. The 384 by 736 page rendered `Current`, an enabled composer, and `Ready to send` with no current runtime exception, console error, request failure, or failure banner.
- SideCue is adopted. MarketPilot and ScandyControl remain discoverable and require their separately running owner to close before confirmed handoff.
