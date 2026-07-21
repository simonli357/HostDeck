# IFC-V1-051 CLI Loopback Transport And Error Bounds

Date: 2026-07-20

## Hardening Target

- Owning block: `BLK-V1-04`.
- Requirements: `FR-011`, `NFR-005`, `NFR-011`, and `SFR-017`.
- Accepted inputs: the CLI resource fields from `IFC-V1-020`; exact selected API manifest and production composition from `IFC-V1-019` and `IFC-V1-046`; direct-loopback local-admin authority and selected-only closure from `IFC-V1-067`; remote state/control and fragment-safe pairing from `IFC-V1-076` and `IFC-V1-077`; end-to-end server deadline truth from `IFC-V1-050`.
- Target state: every selected source CLI HTTP request uses one bounded direct-loopback transport and one stable response/error boundary. Connect, complete-request, response-idle, byte, concurrency, abort, parsing, output, and cleanup behavior is explicit and tested without adding retry or an alternate transport.

## Baseline Audit

| Boundary | Current behavior | Required correction |
| --- | --- | --- |
| Inventory | The accepted `IFC-V1-046` artifact records 21 selected method/path pairs. Later selected lock/unlock work added two routes, while task and queue wording retained the old count. | Freeze the current 15 factories, 23 public client operations, and 23 distinct selected manifest route ids: 9 GET and 14 POST. Exercising every operation once makes 25 requests because pairing performs status/issue/status. Fail structural validation on drift. |
| Default transport | `loopback-http.ts` enforces exact IPv4 loopback, no agent reuse, a request-body cap, connect/request timers, response byte counting, and a per-factory in-flight cap. It has no dedicated test file. | Make the transport the tested shared owner for all selected clients and process-local capacity; retain direct `http://127.0.0.1:PORT` only. |
| Time and cancellation | Connect and whole-request timers exist, but the selected stream-idle budget is unused and callers cannot provide an abort signal. | Enforce three distinct monotonic bounds and one optional caller signal from before allocation through complete response consumption. |
| Response framing | Declared and observed oversize bodies reject, but declared/observed length mismatch, unsupported encoding/media type, fatal UTF-8 decoding, empty JSON, and incremental idle behavior are not owned together. | Validate framing before parsing, count wire bytes incrementally, decode UTF-8 fatally, and parse once only after a complete bounded body. |
| Failure classification | Raw request/response errors can escape the transport and are then classified by each client as daemon unavailable, including failures after a connection or response began. | Classify by boundary reached. A refused/pre-connect daemon differs from a timed-out, aborted, incomplete, oversized, or malformed response. Never print the raw cause. |
| Error parsing | Fifteen clients repeat fetch, response assertion, JSON read, typed-error parsing, and untyped-error handling. Route-local canonical error messages are already privacy preserving. | Add one shared request/response reader while retaining each operation's local code-to-message sanitizer and exact success schema/correlation checks. |
| Retry truth | Selected clients make one request per operation and pairing makes a fixed status/issue/status sequence. There is no automatic retry, but transport-generated retryability is not method/stage specific. | Keep zero automatic retries. POST timeout/abort/incomplete outcomes are never marked retryable; safe pre-connect failure and GET-only transport outcomes may be reported retryable without executing another request. |
| Output | Several complex renderers enforce the selected byte cap, while simple renderers and final success/failure assembly do not share one final bound. Failure text does not escape hostile control characters. | Bound final stdout and stderr for every command and both human/JSON modes. Escape error text and prevent body/cause/credential leakage. |
| Remote distinction | Remote status/control uses the local loopback API and canonicalizes returned API errors. | Preserve three separate truths: local daemon unavailable, successful observed Tailscale/profile/Serve state, and typed remote mutation failure. Never invoke Tailscale or reinterpret a local transport failure as remote state. |

## Frozen Selected Inventory

| Client factory | Public operations | Distinct selected manifest ids |
| --- | --- | --- |
| Start | `start` | `session_start` |
| Archive | `archive` | `session_archive` |
| Prompt | `send` | `prompt_dispatch` |
| Resume | `read` | `session_resume_metadata` |
| Model | `read`, `select` | `model_read`, `model_select` |
| Goal | `read`, `mutate` | `goal_read`, `goal_mutate` |
| Plan | `read`, `select` | `plan_read`, `plan_select` |
| Usage | `read` | `usage_read` |
| Compact | `read`, `start` | `compact_read`, `compact_start` |
| Skills | `list` | `skills_read` |
| Approval | `list`, `respond` | `approval_list`, `approval_respond` |
| Interrupt | `interrupt` | `turn_interrupt` |
| Remote control | `status`, `enable`, `disable` | `remote_status`, `remote_enable`, `remote_disable` |
| Pairing link | `issue` | `remote_status`, then `pair_request`, then `remote_status` |
| Host lock | `lock`, `unlock` | `host_lock`, `host_unlock` |

Legacy local database administration and the post-metadata `codex resume` launcher do not use the selected HTTP transport and remain outside this leaf. No selected CLI SSE operation exists yet; the stream-idle budget here governs gaps while consuming any incremental HTTP response body and cannot be claimed as CLI SSE acceptance.

## Frozen Failure And Exit Model

| Winning condition | Stable public family | Retry truth |
| --- | --- | --- |
| Invalid base/request URL or port | `invalid_config`, exit 78; no socket | No automatic retry; no request occurred. |
| Impossible internal method/header/body or transport-policy shape | `internal_error`, exit 1; no socket | No automatic retry; no request occurred. |
| In-flight cap or request body over selected bytes | API error `service_overloaded` or `request_too_large`, exit 70 | No request occurred; CLI still performs no retry. |
| Refused/reset/failed before a loopback socket connects, including connect timeout | `daemon_unavailable`, exit 69, generic loopback-only message | Safe to retry manually; no automatic retry. |
| Caller abort before or during transport | API error `unknown_error`, exit 70, generic cancelled message | GET may be manually retryable; POST is non-retryable unless no-send is independently proven. No automatic retry. |
| Complete-request deadline or response-idle timeout | API error `operation_timeout`, exit 70 | GET may be manually retryable; POST is non-retryable. No automatic retry. |
| Connected reset, truncated/mismatched response, or close before complete body | API error `unknown_error`, exit 70 | GET may be manually retryable; POST is non-retryable. No automatic retry. |
| Declared or observed response exceeds selected bytes | API error `service_overloaded`, exit 70 | Non-retryable by the CLI; body is destroyed and never parsed or rendered. |
| Invalid status/framing/media/encoding/UTF-8/JSON/error envelope or success schema | Bounded internal contract failure, exit 1 | Non-retryable; raw bytes, parser diagnostics, and causes are not printed. |
| Valid typed non-2xx API envelope | API error, exit 70, exact status/code and operation-owned canonical message | Preserve the sanitized server retry flag for user information; never retry automatically. |
| Successful remote status with unavailable/degraded observed state | Success, exit 0, bounded structured state | This is state observation, not a local transport or mutation failure. |

## Harsh Success Criteria

### CLT-01 Exact Selected Coverage

- A single structural inventory proves all 15 selected client factories and 23 public operations traverse the shared transport/error reader and exactly the 23 current selected manifest ids above.
- The inventory asserts method/path, GET/POST class, expected success status, request-body presence, and local canonical error sanitizer ownership. Pairing alone owns the fixed three-request status/issue/status sequence.
- Selected clients import no global `fetch`, `https`, TLS, proxy, redirect, DNS-selected host, Tailscale CLI, SQLite, server service, or alternate transport path. Historical local-only administration stays isolated.
- Adding/removing a selected client, method, route id, or direct request call without updating this task's explicit inventory fails tests.

### CLT-02 One Strict Loopback Transport

- The transport accepts only canonical `http://127.0.0.1:1024-65535` origins and exact `/api/` request paths with no credentials, query, fragment, alternate IP spelling, hostname, IPv6, path prefix, or inherited URL component.
- Method, headers, and body are exact own-data inputs. GET sends no body/content type; POST uses fixed JSON and accurate byte length. Unknown/accessor/prototype-bearing transport options fail before allocation.
- `agent: false`, no redirect, no proxy/environment proxy, no compression negotiation, and no keep-alive pool remain structural requirements. A response cannot redirect the client or change authority.
- The selected CLI budget is snapshotted once per transport from the validated resource contract; tests can inject only a fully validated bounded budget and controlled timer/request ports.

### CLT-03 Complete Time Budget

- Connect timeout starts before request allocation can yield and ends only on a proven socket connect or terminal failure. Whole-request timeout covers allocation, connect, request write, response headers, every body chunk, and completion.
- Response-idle timeout starts when response headers arrive and resets after each non-empty body chunk. A zero-body or stalled chunked response cannot hang. Resetting idle time never resets or extends the whole-request deadline.
- Exact-boundary races settle once under a documented precedence; late socket, response, data, end, close, error, timeout, or abort events cannot replace the first outcome.
- Every timer is cleared on every outcome. Timer handles, sockets, requests, responses, and listeners are not retained after settlement.

### CLT-04 Abort And Capacity Ownership

- A pre-aborted caller rejects before request/socket/timer allocation. An active caller signal has one listener, destroys the owned request/response once, and removes that listener on every terminal path.
- Process-local selected transport capacity is capped by `cli_max_in_flight_requests` across client factories, not independently multiplied by each factory. A rejected excess request allocates no network resource and consumes no slot.
- Capacity releases exactly once after complete settlement, including synchronous request construction failure, connect refusal, all timeout/abort races, response parse failure, and explicit transport close.
- Repeated and concurrent commands leave no `Timeout`, `TCPSocketWrap`, HTTP parser/request, signal listener, or process listener owned by the task.

### CLT-05 Wire, Byte, And Parse Bounds

- Request JSON is measured in UTF-8 bytes before socket allocation and must not exceed `cli_request_body_max_bytes`. Exact-limit succeeds; one byte over rejects without a request.
- Response bytes are capped before allocation from a valid canonical `Content-Length` and incrementally for fixed/chunked bodies. Exact-limit succeeds; one byte over destroys the stream. Declared/actual mismatch, duplicate/invalid length, or incomplete framing rejects.
- Selected responses must be JSON with supported identity encoding. The complete bounded body is decoded with fatal UTF-8 and parsed once; empty, invalid, accessor/prototype-hostile injected response objects, and malformed JSON reject generically.
- Non-2xx bodies must match the strict API error wrapper. Success bodies remain subject to the route-local strict schema, expected status, target/operation correlation, and deep-freeze rules.

### CLT-06 Stable Failure And Retry Truth

- Every row in the frozen failure table has direct tests for exact `CliFailure.kind`, code, exit code, status presence/absence, retryability, and bounded canonical message.
- Connection stage is tracked explicitly so a post-connect reset or response error cannot be mislabeled daemon unavailable. Raw Node error code/message/address/port/stack never reaches stdout/stderr or an API envelope.
- No transport or client contains a retry loop. Every public operation attempts each frozen request at most once; pairing attempts exactly its next stage only after the prior validated success and never retries a timed-out issue mutation.
- POST timeout, abort, incomplete response, response loss, and malformed response never claim safe retry or success. Existing operation ids preserve server idempotency but do not authorize an automatic client retry.

### CLT-07 Bounded Privacy-Safe Output

- One final output boundary checks every success stdout and failure stderr in human and JSON modes against `cli_response_max_bytes`; overflow becomes a bounded internal failure with no partial output.
- API error bodies are reparsed and reduced to status, code, retryability, optional approved field, and the operation-owned canonical message. Details, session ids, server messages, response snippets, headers, cookies, paths, prompt/objective text, raw causes, and parser diagnostics are never printed.
- Human failure fields and messages escape terminal controls. JSON output is valid complete JSON plus one newline; no truncation creates partial JSON.
- The sole credential-output exception is a successful explicit `pair` command's one-time fragment link/QR. That fragment may appear only in its bounded stdout, never stderr, logs, thrown errors, snapshots, test names, or evidence. Failed pairing emits no link fragment.

### CLT-08 Remote And Multi-Stage Truth

- `remote status|enable|disable` and `pair` contact only the local selected loopback API. A local refusal/connect failure is exit 69 and cannot be rendered as Tailscale/profile/Serve state.
- A validated remote status response, including unavailable/stopped/profile-away/Serve-conflict state, remains exit 0 and renders the structured observed state. A typed enable/disable API rejection remains exit 70 with canonical remote wording.
- Pairing requires validated ready state before issue, one issue mutation, then validated same-generation ready state. Abort/timeout/failure at any stage prevents every later stage and cannot print a pairing credential unless issue and post-check both succeed.
- Remote mutation timeout and pairing issue timeout never retry, invoke Tailscale, switch profiles, repair Serve, choose another URL, or infer whether the daemon-side mutation committed.

### CLT-09 Adversarial And Aggregate Evidence

- Direct transport tests cover hostile options/init, exact/over request bytes, capacity, pre-abort, connect refusal/timeout, header stall, body stall/dribble, exact/over response bytes, fixed/chunked framing, length mismatch, invalid status/media/encoding/UTF-8/JSON, early close, response error, and all event-order races.
- A real Node loopback server drives complete success/error and hostile response cases. Fake request/timer ports cover otherwise nondeterministic connect and simultaneous-event boundaries without substituting for real socket evidence.
- The aggregate invokes all 23 public operations, records all 25 requests and 23 selected method/path pairs, proves no mutation retry, and checks valid success, typed error, malformed error, timeout, abort, and remote-state distinctions.
- Cleanup evidence compares active resources/listeners before and after repeated sequential/concurrent matrices and confirms the test server itself is closed separately from client ownership.

### CLT-10 Validation And Scope Truth

- Focused CLI transport/inventory/client/shell/render tests plus full unit, contract, integration, web, root/all-package typecheck, lint/exports, scaffold, planning, runtime-boundary, exact binding, frozen install, production audit/license, privacy, diff, and residue checks pass.
- The artifact records exact files, commands, counts, residual risks, commits, and push state. Owner docs are synchronized only where task, validation, or block truth changed.
- No route/schema/authority/audit/runtime/Tailscale behavior, dependency, daemon/server timeout, browser API client, or selected mobile UI changes in this task.
- This leaf does not claim the still-missing runnable CLI commands, compiled package/bin, SSE CLI, service lifecycle, aggregate resource stress, UI, phone workflow, install, or release readiness owned downstream.

## Failure Conditions

- Any selected source client bypasses the shared bounded transport/error reader or the exact selected-route inventory remains stale.
- A request can outlive connect, whole-request, response-idle, or caller-abort ownership; a timer/listener/socket/capacity slot survives settlement.
- A post-connect failure becomes daemon unavailable, a mutation transport failure is retried/marked safely retryable, or a remote-state failure is confused with local daemon reachability.
- Size checks occur only after buffering/parsing, malformed UTF-8 is replacement-decoded, framing mismatch is accepted, or output can exceed the selected cap.
- Raw response/error/cause/private data reaches output, or a failed pair operation emits its one-time fragment.
- Evidence uses only injected fetch mocks and does not exercise a real loopback HTTP stream and active-resource cleanup.

## Required Evidence

- Exact 15-factory/23-operation/23-route selected inventory and structural no-bypass gate.
- Deterministic transport state/race tests plus real-loopback hostile framing, timeout, byte, abort, and cleanup tests.
- Shared error-envelope/output tests and operation aggregate proving request counts, stable exits, privacy, and remote distinction.
- Full repository/static/install/supply-chain validation and zero task-owned process/socket/timer/temp residue.

## Completion Evidence

- Implementation: `ef2a80e` (`[hardening] Bound selected CLI transport`), built from criteria `14a217a` and inventory correction `350d15b`; all three commits are pushed to `origin/main`.
- Production scope: `loopback-http.ts` owns one strict IPv4-loopback transport, process-global capacity, connect/whole-request/response-idle deadlines, caller cancellation, bounded framing and fatal UTF-8/JSON parsing, stage-aware failures, and cleanup. All 15 selected client factories use its shared request and typed-error readers. `shell.ts` shares one transport per invocation and applies the final stdout/stderr boundary; `render.ts` terminal-escapes failure fields.
- Selected inventory: the structural aggregate invokes all 23 public operations and observes the exact 25 requests, 23 selected route ids, 11 GET requests over 9 distinct GET routes, and 14 POST requests over 14 distinct POST routes. GET bodies are absent, POST bodies are valid JSON, expected success statuses are exact, pairing remains status/issue/status, and no selected client bypass is reachable.
- Focused evidence: `pnpm exec vitest run packages/cli/src` passes 252 tests with 2 intentional skips across 35 passing and 1 skipped files. Real and controlled loopback cases cover hostile configuration, exact/over bytes, refusal, all three deadlines, one-byte dribble, abort, capacity, synchronous construction/write failures, fixed/chunked framing, media/encoding/UTF-8/JSON failures, truncation, trailers, header bounds, repeated concurrency, listener/resource cleanup, bounded output, and privacy-safe errors.
- Workspace evidence: unit passes 1,773 tests with 26 intentional skips; contract 238, integration 19, and web 20 pass. Root and all-package typechecks, lint/exports (505 files and 8 packages), scaffold (8 packages and 20 scripts), planning (212 tasks, 84 requirements, and 649 dependencies before closure), and the 602-production-module/21-external-module runtime boundary pass.
- Reproducibility and supply chain: frozen offline install passes with no lockfile change; production audit reports no known vulnerabilities; all 137 production license entries are permissive. The isolated exact Codex 0.144.0 binding passes over 671 files with hash `e1a1a5cff3ab91862f9215dd06538eae1ea0b00bae48cbb7d87061faaee27e24`; the user's default 0.144.5 binary correctly remains ineligible for exact binding evidence.
- Manual/static inspection finds no selected global fetch, HTTPS, proxy/Tailscale invocation, retry loop, response-text fallback, or console output. Tailscale Serve remains empty. No task process, socket, timer, signal listener, ADB state, phone state, or task temp root remains; pre-existing phone and binding artifacts were left untouched.
- Residual scope: aggregate production resource stress is owned by `IFC-V1-052`. Runnable command parsing, compiled package/bin, CLI SSE, service lifecycle, dashboard UI, physical phone workflow, clean install, and release acceptance remain downstream. This task changed no route/schema/authority/audit/server/Tailscale behavior, dependency, lockfile, setup, or phone configuration.

## Explicit Non-Goals

- No remote/public/LAN/TLS/custom-CA client, direct Tailscale invocation, profile switch, Serve repair, redirect, proxy, fallback URL, or global fetch path.
- No automatic retry, mutation result inference, new command, new API route, new error code, or changed server operation semantics.
- No packaged executable/service/install claim and no physical phone requirement for this headless transport leaf.
