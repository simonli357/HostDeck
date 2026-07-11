# INT-V1-025 Approval Routing Evidence

Date: 2026-07-10

## Scope

- Registers exact Codex 0.144.0 command-execution and file-change approval callbacks for one managed session.
- Routes one confirmed HostDeck approve/deny decision to one app-server request and waits for authoritative terminal evidence.
- Owns ephemeral request state, connection generation, capacity, and HostDeck TTL behavior.
- Does not assemble API/audit/projection wiring, reconnect recovery, or phone UI. Those remain with `DAT-V1-023`, `INT-V1-027` to `INT-V1-029`, `IFC-V1-019`, `IFC-V1-044`, and `FE-V1-022`.

## Hard Success Criteria

| Area | Required proof |
| --- | --- |
| Decode | Both reviewed request methods and every accepted nested generated field validate strictly; malformed, added, oversized, unsafe-display, or incomplete data fails before registration. |
| Identity | Raw string and numeric request ids remain distinct and map with thread, session, turn, item, and positive connection generation identity. |
| Inspection | Full command/action, working directory or affected permission scope, reason, risk, one-time grant, start time, and HostDeck expiry fit the selected contract without hidden truncation. |
| Exactly once | Per-request serialization permits one response attempt; approve maps only to `accept`, deny only to `decline`, and duplicate/terminal responses never send. |
| Outcome truth | Proven not-sent user responses can return to pending; a possible send stays responding without retry. Approved/denied requires matching request resolution plus matching item terminal evidence. |
| Expiry | Already-due requests are immediately read-only; timer/sweep expiry sends one system decline, remains visibly expired, records no user decision, and retries only a proven-not-sent system response. |
| Invalid state | Missing, stale, archived, superseded, disconnected, capacity-exhausted, foreign, wrong-category, and wrong-generation cases reject or reconcile explicitly. |
| Real boundary | Pinned 0.144.0 proves deny, approve, duplicate rejection, automatic expiry, late-response rejection, side effects, terminal events, archive, process stop, and temporary-state cleanup. |

## Protocol Contract

- Supported callbacks are exactly `item/commandExecution/requestApproval` and `item/fileChange/requestApproval`.
- Numeric id `7` becomes `number:7`; string id `"7"` becomes `string:7`. The raw id is retained for the protocol response and rechecked before dispatch.
- Command, command-action, network context, additional network/filesystem permission, exec-policy amendment, network-policy amendment, and available-decision shapes mirror the reviewed generated types with explicit bounds.
- Requested current network/filesystem permissions are rendered into the complete bounded scope. A synthesized scope over the contract limit rejects rather than truncating.
- HostDeck sends only one-time `accept` or `decline`. Proposed session/exec/network policy choices are validated but never selected.
- `availableDecisions` is advisory. The observed runtime omitted plain `accept` in one callback, while the reviewed response union permits it and repeated exact-runtime acceptance succeeded. Treating that list as an authorization gate would reject a valid one-time decision.
- C0/C1 controls, NUL, bidi overrides/isolates, and invisible display controls reject in action, scope, reason, and nested display fields so an approval cannot show a visually misleading command.

## State And Failure Semantics

| Boundary | Result |
| --- | --- |
| Registration | Validates compatibility, generation, managed writable identity, clock skew, expiry, contract shape, duplicate id, and bounded capacity before insertion. |
| User response accepted by local send | State remains `responding`; no terminal decision is claimed yet. |
| User response proven not sent | Returns to `pending` only if no terminal runtime fact arrived; explicit retry may send once. |
| User response possibly sent | Remains `responding`; no automatic or user retry can produce a second response. |
| Matching `serverRequest/resolved` plus matching item terminal | Finalizes the recorded user choice as `approved` or `denied`; either event alone is insufficient. |
| Resolution or item terminal before a local response | Becomes `superseded` and cannot send. |
| TTL reached | Becomes `expired`, sends a system `decline`, and retains `decision: null` even after terminal proof. |
| Disconnect/generation change/archive/turn ends without item | Becomes `superseded`; an in-flight possible send reports unknown. |
| File/network send failure | Preserves adapter outcome and retry safety; raw payloads are absent from bounded public errors and smoke diagnostics. |

## Hardening Audit

The first passing implementation was not accepted as complete. Manual production-hardening found and closed these gaps:

- Replaced permissive `unknown` nested fields with exact generated-shape runtime schemas and bounded lists/text.
- Surfaced current network and filesystem permission details instead of reducing them to a broad-risk label.
- Stopped counting unselected future policy amendments as the one-time grant while still validating their wire shape.
- Made item completion before a local response supersede the request; the prior path could leave it actionable indefinitely.
- Required a possible/sent response outcome before terminal events can settle the intended user decision.
- Preserved closed approval history when an invalid replacement registration reuses its protocol id.
- Registered already-due callbacks as expired immediately and compared RFC 3339 offsets by instant rather than lexical text.
- Rechecked generation access through the service error boundary and rejected generation zero at adapter construction.
- Added a real one-second expiry turn with system decline, no side effect, no user decision, and rejected late approval.

## Real Boundary

`HOSTDECK_CODEX_BIN=<exact-0.144.0> pnpm smoke:codex-approval` passed repeatedly against an isolated authenticated app-server on a private Unix socket.

- The smoke uses Codex `use_legacy_landlock`, `read-only` sandboxing, and `on-request` approvals. This host cannot use the default bubblewrap user-namespace path; a direct Landlock probe ran `/bin/true` and denied a write outside the allowed sandbox before the smoke was accepted.
- One command was denied and its marker remained absent.
- One command was approved and its marker existed only after matching terminal runtime evidence.
- A third command received no user response, expired after one second, was system-declined, remained `expired` with no decision, rejected a late approve, and left its marker absent.
- The live callback carried the exact thread, turn, and item identity. Duplicate response, protocol issues, background expiry errors, failed cleanup, and extra callback methods were absent.
- Diagnostics retain bounded method/status/shape data only; prompts, output, authentication, and approval payloads are not recorded in this artifact.

## Validation

- Focused approval adapter/service: 25 passed.
- Affected adapter/broker/connection/event/projection/pipeline matrix: 84 passed.
- Exact approval smoke: 1 passed in 17.34 seconds, including 16.02 seconds of runtime assertions.
- Unit: 596 passed; 24 explicit external tests skipped by default.
- Contract: 115 passed.
- Integration: 16 passed.
- Web: 14 passed.
- Root and all nine package typechecks, lint over 231 files, package exports, scaffold, planning, frozen offline install, and diff checks passed.
- Planning graph: 196 tasks, 84 requirements, 626 dependencies, 10 queued.
- Exact binding: Codex 0.144.0, 671 generated files, reviewed tree identity `e1a1a5cff3ab91862f9215dd06538eae1ea0b00bae48cbb7d87061faaee27e24`.
- `pnpm audit --prod`: no known vulnerabilities.

## Remaining Ownership

- `DAT-V1-023` owns accepted-to-terminal audit persistence; this leaf does not claim durable audit completion.
- `INT-V1-027` owns assembled callback/event/control composition, and `INT-V1-028` owns stale-generation rejection after reconnect.
- `IFC-V1-019`/`IFC-V1-044` own public routes, trust/lock mutation gates, and response/audit contracts.
- `FE-V1-022` owns the approved mobile inline card, confirmation flow, duplicate-tap behavior, and screenshot/fidelity evidence after the visual-direction gate.
- A real file-change callback is not forced by this bounded model smoke; its reviewed generated shape and response mapping are covered deterministically, while real command deny/approve/expiry side effects prove the shared server-request path.
