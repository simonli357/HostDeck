# INT-V1-114 Shared Runtime Hardening

Status: criteria frozen; implementation in progress

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

## Known Gaps Before Implementation

- Existing leaf tests are strong but no selected shared-runtime aggregate binds them to one clean commit and report.
- The real enrollment smoke uses one project, creates two new roots, and does not prove plain existing-thread resume across three projects.
- Real broker/enrollment evidence does not yet compose selected API/catalog behavior or broker-crash truth in one report.
- The broker smoke emergency cleanup can suppress an explicit stop failure instead of reporting it.

## Manual Inspection

- Inspect process trees, command lines, standard-socket inode/mode/listeners, tmux servers, temporary roots, browser console/page errors, and retained evidence content.
- Confirm HostDeck-only close preserves the exact broker PID/socket and each TUI; final cleanup must remove only proven-owned resources.

## Remaining Boundary

- Phone-on-unrelated-network bidirectional acceptance remains `FE-V1-108` after `IFC-V1-113` produces the immutable Ubuntu candidate.
