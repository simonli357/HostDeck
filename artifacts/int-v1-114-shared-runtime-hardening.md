# INT-V1-114 Shared Runtime Hardening

Status: passed on 2026-08-15; evidence is bound to clean code commit `4296e26d8ae1214e81fd9c3f17550808e915beef`

## Target

One exact Codex 0.147.0 standard-socket runtime must let ordinary laptop Codex clients and HostDeck share native thread identities across several projects without an adoption ceremony, hidden fallback, leaked content, orphaned resources, or desktop-window side effects.

## Frozen Criteria

| ID | Required proof |
| --- | --- |
| `SRH-01` | One clean-commit, no-retry aggregate binds exact Codex/binding identity and a fixed deterministic test inventory. |
| `SRH-02` | Socket directory, socket, lock, and ownership proof reject insecure, stale, replaced, malformed, foreign, duplicate-start, and pre-readiness-crash states without unsafe unlink or kill. |
| `SRH-03` | Ordinary `codex` start plus `codex resume <native-uuid>` for SideCue-, MarketPilot-, and ScandyControl-style roots all use one standard socket and preserve exact native identity. |
| `SRH-04` | Loaded-before and created/resumed-after roots enroll once; duplicate notifications, reconnect, concurrent enrollment, and internal/native dual targeting never create a second mapping or turn. |
| `SRH-05` | Child, ephemeral, archived, incompatible, invalid-cwd, malformed, paginated, oversized, and notification-before-mapping inputs reject or reach one explicit bounded boundary. No eligible event is silently dropped. |
| `SRH-06` | Recent-history import is bounded and visible as a boundary; no full transcript copy, raw prompt, native UUID, private path, credential, or raw frame enters evidence or diagnostics. |
| `SRH-07` | Projection and catalog commit order, reset/upsert/remove/ready/boundary continuity, slow-consumer limits, reconnect cursors, and selected-detail removal remain exact without polling. |
| `SRH-08` | HostDeck detach/restart leaves broker and ordinary TUI clients alive. Broker crash, reconnect, and accepted/pending mutation loss remain explicit and never retry a possible send. |
| `SRH-09` | API, CLI, browser, storage, and event paths resolve one exact native/internal identity pair; conflicting pairs and superseded discover/adopt/unmanage surfaces reject. |
| `SRH-10` | Repeated and concurrent runs stay within process, socket, subscriber, pending-event, history, frame, deadline, and database bounds; teardown proves zero owned process/socket/tmux/temp residue. |
| `SRH-11` | The real run is headless and process-inspected: it opens no terminal emulator, browser, or random desktop window. |
| `SRH-12` | Full focused/workspace/browser/static/package validation and manual process/socket/privacy inspection pass before task closure. |

## Result

- One no-retry aggregate binds 32 fixed files and 443 tests to exact Codex 0.147.0 and its 723-file generated binding.
- The exact run covers SideCue-, MarketPilot-, and ScandyControl-style roots: two loaded before HostDeck, one created after, one ordinary native-UUID resume, three unique enrollments, HostDeck detach/reconnect, and zero turns or retries.
- Cleanup failures are no longer suppressed. Report size, location, mode, ownership, schema, timestamps, privacy, process ownership, output, and deadlines are bounded and fail closed.
- Deterministic API/catalog/browser state coverage and focused live-browser continuity/removal tests pass without polling or hidden fallback.

## Manual Inspection

- `artifacts/int-v1-114-shared-runtime-hardening-evidence.json` is a single-link owner-only file (`0600`, 2,681 bytes) and contains no native/internal id, path/socket, PID/process identity, prompt/transcript, credential, or raw protocol data.
- Process, `/tmp`, Unix-socket, and tmux inspection found no aggregate-owned residue. The exact report records zero app-server, browser, temporary-root, tmux, TUI, and socket residue and no desktop-window process launch.
- Focused Chromium catalog continuity/removal inspection passed `2/2`; HostDeck detach retained the exact broker socket/PID and ordinary TUI lifetimes before final owned cleanup.

## Validation

- Aggregate: `pnpm test:shared-runtime-hardening` passed the 32-file/443-test deterministic inventory plus one exact three-project lifecycle.
- Workspace: typecheck; Biome/package exports over 927 files; unit `3266/3266` with 32 intentional smoke skips; contract `309/309`; integration `36/36`; web `960/960`; scaffold, exact binding, and selected-runtime boundary checks.
- Package: 43 package-contract tests; two deterministic 6,353-entry builds; six supply-chain tests; relocated production-package Chromium execution; focused live-catalog browser `2/2`.

## Remaining Boundary

- Phone-on-unrelated-network bidirectional acceptance remains `FE-V1-108` after `IFC-V1-113` produces the immutable Ubuntu candidate.
