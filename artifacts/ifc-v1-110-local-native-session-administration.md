# IFC-V1-110 Local Native Session Administration

Status: passed

## Result

- `codexdeck discover`, confirmed `adopt`, and confirmed `unmanage` each issue one bounded direct-loopback request with explicit local CLI authority.
- Discovery returns only eligible unmanaged native identity metadata. Adoption retains the exact Codex thread id and bounded projection; unmanage removes only HostDeck membership/state.
- The three routes require a ready, unlocked host. Remote, paired-browser, origin/cookie, malformed, stale-target, duplicate, audit, deadline, overload, storage, and uncertain-response paths fail closed without retry.
- Production composition now owns 38 routes through 23 API/SSE registrations. The browser contract remains 34 JSON routes plus one SSE route and contains no native-session administration surface.
- The deterministic non-web package closure is 638 sources and includes the five native-session contract, adapter, service, route, and CLI modules.

## Validation

| Gate | Result |
| --- | --- |
| Workspace | Typecheck passed; unit 3,217 passed with 31 intentional skips; contract 287 passed; integration 36 passed. |
| Control plane | Parser/client/render, hostile input, exact request, route trust/auth/health/lock/write/audit/deadline, composition, inventory, and real listening-loopback adoption lifecycle passed. |
| Package boundary | Selected runtime boundary passed at 638 sources/23 external modules; package contract layer passed 43 tests. A clean checkout of `ff5af5f` produced a verified deterministic package with 6,303 entries, 1,283 owned outputs, and three web files (1,221,224 bytes), and its copied read-only tree passed verification plus imports, descriptor, config/static failure, native operation, and lifecycle-restart smoke. The aggregate uninstall probe was inapplicable because the host has an active user installation; ownership checks correctly refused it and no live state was changed. |
| Exact Codex | Two isolated no-model smokes passed against pinned Codex 0.144.0: a closed native CLI thread retained its id through read/resume, adoption survived SQLite reopen, unmanage preserved native readability, and all temporary resources were removed. |
| Privacy/destruction | Discovery exposes no transcript; CLI errors sanitize server detail; no browser route was added; no create/fork/archive/delete request is used; no transcript or private runtime artifact is retained as evidence. |

## Remaining Boundary

- `INT-V1-109` owns the full exact-runtime prompt, ordered stream, dashboard reads, HostDeck restart, shared-TUI resume, response-loss/race matrix, Windows transport contract, and final interoperability hardening.
