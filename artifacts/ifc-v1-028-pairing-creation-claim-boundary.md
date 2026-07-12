# IFC-V1-028 Pairing Creation And Claim Boundary

Date: 2026-07-12

Status: production-hardening criteria frozen; awaiting human approval. Implementation has not started.

## Purpose

Implement the two selected pairing routes over the completed request-trust gate, local-admin authentication, selected pairing repository, resource budget, route manifest, and security-mutation audit executor:

- `POST /api/v1/access/pairing-codes` creates one short-lived, one-time pairing code for an explicit read or write permission.
- `POST /api/v1/access/pairing-claims` consumes that code from the same-origin HTTPS dashboard, creates one device, and installs its bearer in one secure browser cookie.

This leaf owns the missing HTTP contracts, trusted peer-source derivation, claim-specific process-local concurrency admission, selected issue/claim orchestration, generic public failure mapping, cookie serialization, and direct route evidence. It does not implement the browser UI, CSRF bootstrap, device revocation, LAN lifecycle, aggregate write admission, production listener composition, packaging, or release acceptance.

## Audit Findings And Resolutions

| Finding | Frozen resolution |
| --- | --- |
| The historical route accepts six-character caller-generated codes, creates credentials before code validation, uses an insecure lax cookie, has no selected audit ordering, and exposes repository causes. | It is deprecated evidence only. The selected routes use only the version-1 manifest and `PairingCodeRepository`; no historical handler, schema, path, or legacy repository method is reused. |
| `DAT-V1-002` predates the HTTPS rebaseline and mentions plaintext LAN cookie behavior. | `DEC-020`, the current technical plan, request-auth contract, and `SFR-018` supersede it. Remote claim and every device-cookie issuance require socket-proven HTTPS. There is no LAN plaintext exception. |
| The selected audit contract currently requires `permission` in an accepted `pair_claim` record, but permission is trusted only after the atomic code claim. A pre-claim lookup would bypass durable attempt accounting and introduce a time-of-check race; accepting a client assertion would make the audit false. | Accepted claim intent requires only `client_label_present`. A succeeded terminal claim requires the storage-proven `permission`, `device_created: true`, and `device_id`. Failed/incomplete claims carry no permission. The action schema keeps `permission` optional, removes it only from the accepted-field requirement, and retains it as a required success field. |
| Valid request-trust origins can be longer than the audit actor's current 253-character ceiling. | Align `selectedAuditOriginSchema` with the canonical request-auth origin ceiling of 512 characters. The value must still be one exact HTTP(S) origin and is never derived from a reflected request header. |
| Manifest schema ids exist but no selected pair request/response schemas own them. | Add strict selected pairing contracts in `@hostdeck/contracts`; do not alias the deprecated `pairClaimRequestSchema` or `trustStateSchema`. |
| Storage owns a canonical hashed source key but HTTP has no source derivation and forwarded values must never become rate identity. | Derive one domain-separated SHA-256 key from the exact socket peer admitted by the trust gate. Store only that key in private request state and SQLite. |
| Durable attempt limits exist, while per-source/global in-flight limits are still unimplemented. | Add one claim-route-owned, process-local limiter using the resolved resource budget. It spans audit preflight, the claim transition, response preparation, and terminal audit, and releases on every path. |
| Pair claim creates an initial CSRF secret, while the selected browser flow separately requires CSRF bootstrap. Returning both cookie and CSRF here would duplicate authority paths. | Claim returns only non-secret device metadata and `csrf_bootstrap_required: true`. The initial CSRF value is never sent or retained by the route; the browser next calls the completed bootstrap route, which rotates generation 1 and returns generation 2 to page memory. |
| A session cookie can disappear when mobile Chrome closes while leaving an indefinite orphan device. That is not a reliable phone deployment contract. | Add `paired_device_lifetime_ms` to the resolved resource policy: 1-day minimum, 90-day default, 365-day maximum. Claim stores the exact absolute device expiry and emits the same absolute cookie `Expires`; server-side expiry remains authoritative. |
| A claim can commit before terminal audit or transport delivery fails. | Durable claim truth is never reversed or retried. No cookie/header/body is exposed before terminal audit proof. Later header/send failure remains an unknown, non-retryable delivery; recovery is a new pairing operation and later revocation of any orphan device. |

## Frozen Selected Contracts

### Route Manifest

Both registrations must assert the exact deeply frozen manifest entries before route registration. Any method, path, schema id, auth, authority, audit action/executor, credential effect, handler, target, or owner drift fails app construction.

| Route | Exact selected policy |
| --- | --- |
| `pair_request` | `POST /api/v1/access/pairing-codes`; body `pair_request_v1`; response `pair_request_response_v1`; local-admin auth/authority; no CSRF or lock gate; host target; `security_executor/pair_request`; no credential effect; owner `IFC-V1-028`. |
| `pair_claim` | `POST /api/v1/access/pairing-claims`; body `pair_claim_v1`; response `pair_claim_response_v1`; pairing-code auth and pair-claim authority; no CSRF or lock gate; host target; `security_executor/pair_claim`; `set_device_cookie`; owner `IFC-V1-028`. |

Both routes use the app's no-store route marker. Successful and error responses retain `Cache-Control: no-store` and `Pragma: no-cache`; neither route emits CORS response headers.

### JSON Contracts

All objects are strict. Missing, extra, inherited, accessor-backed, wrong-type, malformed, noncanonical, or oversized values reject before entropy, audit, source admission, storage, or cookie work where the framework can determine that safely.

| Contract | Exact fields |
| --- | --- |
| `pair_request_v1` | `operation_id`: selected `op_` client operation id; `permission`: `read` or `write`; optional `client_label`: selected bounded label. |
| `pair_request_response_v1` | `pairing_id`, `code`, `permission`, nullable `client_label`, canonical `created_at`, canonical `expires_at`. |
| `pair_claim_v1` | `operation_id`: selected `op_` client operation id; `code`: exactly 22 unpadded base64url characters; optional `client_label`: selected bounded label. |
| `pair_claim_response_v1` | `device_id`, `permission`, nullable `client_label`, canonical `created_at`, canonical non-null `expires_at`, and `csrf_bootstrap_required: true`. |

Additional invariants:

- A selected pairing id is `pair_` plus exactly 24 base64url characters generated from 18 CSPRNG bytes. It is not caller-selected and is distinct from the operation id.
- A selected generated device id remains `client_` plus exactly 24 base64url characters and must be proven from the storage result before response preparation.
- Optional labels normalize only by omission to `null`; strings are not silently trimmed or case-folded. Selected labels are 1 to 120 characters, already trimmed, and contain no control, format, line-separator, or paragraph-separator code point.
- Canonical timestamps are UTC ISO strings. Pair-request expiry must equal creation plus the resolved `pairing_code_lifetime_ms` exactly and must preserve at least one full claim window when issuance begins.
- Device expiry must equal claim time plus the resolved `paired_device_lifetime_ms` exactly. The resource contract accepts only 86,400,000 through 31,536,000,000 milliseconds, defaults to 7,776,000,000 milliseconds, and requires pairing-code lifetime not to exceed device lifetime.
- No response contains an audit record/id, source key, code hash, device-token/CSRF hash, device bearer, raw CSRF token, cookie text, database classification, retry timestamp, or native cause.

### Authority And Transport

Pair request:

- Runs after global HTTP admission, request trust, and cookie intake.
- Requires the exact `local_admin` authentication context. That already means an admitted loopback `local_non_browser` unsafe request with no Cookie header and no Origin/fetch/proxy ambiguity.
- May use configured loopback HTTP or HTTPS because it returns a short-lived code only to the local-admin client and issues no browser credential.

Pair claim:

- Runs after global HTTP admission and request trust, but does not authenticate or trust any inbound device cookie.
- Requires `transport: https` and `origin_kind: same_origin`, including in loopback mode. Loopback HTTP returns `426 insecure_transport`; local non-browser and missing-Origin forms cannot become a pairing-client actor.
- Uses audit actor `{ type: "pairing_client", device_id: null, permission: null, origin: configured_origin }` and target `{ type: "host", host_id: "local_host" }`.
- May replace an existing valid, stale, revoked, unknown, or malformed target cookie only after a new code succeeds. Existing cookie authority is neither resolved nor used as a fallback for claim.
- Never accepts forwarding headers, wildcard/reflected Host or Origin, CORS preflight, cross-origin credentials, a code in the URL/query/header, or plaintext non-loopback transport.

### Canonical Claim Source

The trust gate snapshots source identity from the same raw socket observation used for request admission and retains no raw address in its public context.

1. Require a bounded socket `remoteAddress`; undefined, non-IP, scoped/link-local zone text, or unparsable values fail before claim admission.
2. Canonicalize with the pinned Node runtime's `net.SocketAddress` parser. Canonical IPv4 uses dotted decimal; canonical IPv6 uses compressed lowercase text; IPv4-mapped IPv6 collapses to the same IPv4 identity.
3. Hash the exact ASCII domain-separated input `hostdeck:pair-claim-source:v1\0<family>\0<canonical-address>` with SHA-256.
4. Expose only `sha256:` plus 64 lowercase hex characters through a private request helper after trust succeeds.

Equivalent IPv6 forms and IPv4-mapped forms cannot gain extra source budgets. Different peer addresses differ. Host, Origin, mode, transport, request id, labels, forwarded headers, and caller body values never influence the key. Raw/canonical addresses and source keys never enter audit, public errors, route snapshots, ordinary logs, or response metadata; only the hash may enter selected durable rate storage.

### Process-Local Claim Admission

- One limiter instance belongs to one registered app and consumes only the resolved `pair_claim_max_in_flight_per_source` and `pair_claim_max_in_flight` values.
- Acquisition is synchronous and atomic on the Node event loop after trust/body/source validation and before audit execution or storage. Per-source capacity is checked before global capacity so one source receives one stable classification.
- Active state contains only source hash to positive count plus one global count. Zero-count entries are deleted immediately; active key cardinality cannot exceed the global in-flight limit.
- A rejected in-flight request returns fixed `503 service_overloaded`, sets no cookie, invokes no audit executor or pairing repository, consumes no durable attempt slot, and retains only a saturating count. It is request admission, not an accepted security mutation.
- A successful acquisition spans accepted audit, one transition, response preparation, and terminal audit. A `finally` release covers explicit failure, throw, malformed port result, audit failure, response-preparation failure, request abort, and normal success.
- There is no queue, wait, retry, fairness claim, durable lease, timer, TTL entry, source eviction policy, or fallback limit. Durable sequential attempts remain owned by the selected repository.

## Exact Operation Order

### Pairing-Code Creation

1. Apply no-store response policy and require local-admin authority before handler work.
2. Validate the exact body and snapshot the route clock once as `created_at`; derive the policy expiry with safe-integer arithmetic.
3. Execute `pair_request` with the caller operation id, CLI actor, host target, and accepted summary `{ schema_version: 1, permission, client_label_present, expires_at }`; emergency audit bypass is false.
4. Only after accepted audit proof, snapshot the clock again. Regression returns a failed `operation_conflict`; less than one full claim window remaining returns a failed `operation_timeout`. Neither path reaches entropy or storage.
5. Generate one exact pairing id and invoke selected `issue` exactly once with that id, permission, nullable label, and the original creation time. Do not retry id/code collision, generator failure, storage contention, or uncertain commit.
6. Descriptor-first validate the exact frozen issued result and full selected record. It must match id, permission, label, creation, expiry, unused/unrevoked version-1 provenance, no owner, and one exact raw code.
7. Return transition success summary `{ schema_version: 1, pairing_id }`; prepare and freeze the exact response without copying the code into audit/error/diagnostics.
8. Return the response only after terminal succeeded audit is proven.

### Remote Claim

1. Apply no-store policy, require same-origin HTTPS, validate the exact body, obtain the trust-owned source hash, and acquire claim admission.
2. Execute `pair_claim` with the body operation id, pairing-client actor, host target, and accepted summary `{ schema_version: 1, client_label_present }`; emergency audit bypass is false.
3. Only after accepted audit proof, snapshot one valid route clock, derive the exact policy-bounded device expiry with safe-integer arithmetic, and invoke selected `claim` exactly once with the exact raw code, source key, time, nullable label, and that `deviceExpiresAt`.
4. Every syntactically valid attempt that clears process admission and accepted-audit proof reaches the repository. Durable source/global counters, code lookup, lifecycle classification, credential generation, device insert, and one-winner code consumption retain the frozen `DAT-V1-026` transaction order.
5. Map a known repository rejection to one explicit failed transition. Unknown throws or malformed/contradictory returned state become `incomplete/internal_error`; no caller cause or value is reflected.
6. On success, descriptor-first validate the exact frozen claim, pairing owner/device coherence, label precedence, permission, timestamps, nullable expiry, generation-1 CSRF state, raw bearer syntax, and raw CSRF syntax.
7. Return success summary `{ schema_version: 1, permission, device_created: true, device_id }`. Response preparation serializes one cookie from the raw bearer and freezes only the non-secret body plus serialized header handoff. The initial raw CSRF value is not copied.
8. After terminal succeeded audit proof, validate the prepared handoff again, set exactly one `Set-Cookie` header, and return the body. No route code may reconstruct credentials, call storage again, or set a header on a failed/incomplete result.
9. Release claim admission in all cases. A later socket/send failure does not undo state or audit and is never automatically retried.

## Cookie Contract

Use the existing direct `cookie@1.1.1` serializer, with the already selected `hostdeck_device` name and exact raw 43-character base64url bearer.

- Include `Path=/`, `HttpOnly`, `Secure`, `SameSite=Strict`, and `Expires` equal to the stored device expiry rendered as canonical IMF-fixdate.
- Omit `Domain`, `Max-Age`, `Partitioned`, and any nonselected attribute. Omitted `Domain` is the host-only requirement. Absolute expiry avoids a relative-age extension between claim commit and delayed response delivery; the server rejects the bearer at or after stored expiry regardless of client clock behavior.
- Emit exactly one canonical `Set-Cookie` value only after proven terminal success. Never append a second target cookie or use a caller-provided attribute/value.
- Validate the serialized value before executor response preparation succeeds. CR/LF, delimiter, encoding, alternate token, malformed serializer output, extra attributes, and duplicate-header states fail closed.
- A successful replacement overwrites the browser's prior same-name/path cookie. It does not revoke the prior durable device; explicit device revocation remains `IFC-V1-059`.
- The bearer appears only in the transient storage result, prepared cookie handoff, and successful wire header. It never appears in the JSON body, JavaScript-readable storage, audit, errors, snapshots, logs, artifacts, or SQLite bytes.

## Public Failure Contract

| Boundary | Public result | Side-effect truth |
| --- | --- | --- |
| Global trust/Host/Origin/CORS | Existing fixed `403 invalid_origin` or trust-owned transport result | No route body operation, source state, audit, storage, entropy, or cookie. |
| Missing or noncanonical socket source after trust | Fixed `403 invalid_origin`, non-retryable | No source hash, admission state, audit, durable attempt, storage lookup, or cookie. |
| Claim over admitted loopback HTTP | `426 insecure_transport`, non-retryable | No source state, audit, durable attempt, storage lookup, or cookie. |
| Local-admin issue authority | Existing fixed `403 permission_denied` | No clock, audit, id/code entropy, storage, or response code. |
| Body/code/label/operation syntax | `400 validation_error`, non-retryable, fixed field family | No route clock, source acquisition, audit, durable attempt, storage, or cookie. |
| Per-source/global in-flight capacity | `503 service_overloaded`, retryable | No audit or durable attempt; current acquired work is unchanged. |
| Unknown, expired, revoked, used, or legacy valid-shape code | One identical `401 permission_denied`, non-retryable, apart from request id | Accepted plus failed terminal audit; exactly the storage-permitted counters, no device/code mutation, no cookie. |
| Durable source/global rate ceiling | `429 rate_limited`, retryable, no precise counter/source/code disclosure | Accepted plus failed terminal audit; no lookup/entropy at an already exhausted ceiling and no cookie. |
| Durable tracked-source capacity | `503 service_overloaded`, retryable | Accepted plus failed terminal audit; no counter/code lookup/entropy and no cookie. |
| Clock/state contention | `409 operation_conflict` or fixed executor result, non-retryable unless the executor explicitly proves otherwise | No hidden retry; prior durable winner remains authoritative. |
| Known storage/generator/contract failure | Fixed `500 storage_error` or `internal_error`, non-retryable | Failed or incomplete terminal audit when possible; no raw material or native cause returned. |
| Accepted audit unavailable/unproven | Executor-derived fixed error and retry truth | No pairing transition or cookie. Emergency-lock bypass is never enabled. |
| Terminal audit failure after mutation | Executor-derived fixed non-success with mutation/audit truth, `retryable: false` | Issue/claim may be committed; response and cookie are suppressed and mutation is not reversed. |
| Response preparation failure | Fixed non-success, `retryable: false` | State and succeeded terminal audit remain truthful; no header/body delivery claim. |
| Disconnect/send failure after terminal proof | Transport failure with unknown client delivery | Durable state/audit remain succeeded; no route retry or compensating revoke. |

Lifecycle denial bodies never distinguish unknown, expired, revoked, used, or legacy codes. The implementation does not claim constant-time SQLite behavior; 128-bit entropy, generic output, durable per-source/global limits, and concurrency caps are the brute-force boundary.

## Hard Success Criteria

| Criterion | Required evidence |
| --- | --- |
| Exact shared contracts | Contract tests prove all four selected schemas, exact keys, selected ids/secrets, canonical timestamps, label restrictions, nullable fields, bootstrap marker, malformed/extra/accessor rejection, and absence of bearer/CSRF/hash/audit/source fields. Deprecated schemas remain distinct. |
| Audit contract correction | Accepted claim with only `client_label_present` passes; accepted permission is neither required nor trusted; succeeded claim still requires storage-proven permission/device fields. Canonical audit origins up to 512 characters compose with request trust, while malformed/noncanonical origins fail. |
| Manifest and construction | Both registrations assert every manifest field. Constructor/port/policy inputs reject missing, extra, inherited, accessor, unbranded audit executor, invalid clock/generator, mutable/wrong methods, duplicate registration, and invalid resource context before listen. Registrations and public snapshots are frozen. |
| Authority and HTTPS | Local CLI issue passes on admitted loopback HTTP/HTTPS; browser/cookie/Origin/fetch/proxy ambiguity cannot become local admin. Claim passes only same-origin HTTPS, including loopback; plaintext, safe-no-Origin, local non-browser, cross-origin, preflight, forwarding, Host mismatch, and CORS forms invoke no claim side effect. |
| Source identity | IPv4, expanded/compressed IPv6, IPv4-mapped IPv6, invalid/undefined/zone values, distinct peers, and hostile forwarding inputs prove one canonical domain-separated key after trust. Only the hash reaches rate storage; raw addresses are absent elsewhere. |
| In-flight admission | Exact below/at/over per-source and global limits, independent sources, same-source contention, release after every return/throw/audit/storage/preparation/abort path, zero-entry deletion, bounded active keys, no queue/retry/timer, and count saturation pass. Rejected admission invokes no repository/audit and consumes no durable attempt. |
| High-entropy issue | Accepted audit precedes id/code entropy and one selected issue call. Exact creation/expiry and full-window freshness, read/write/label propagation, frozen post-commit raw response, collision/generator/clock/storage/returned-contract failure, and no retry pass. |
| Durable claim mapping | Every syntactically valid claim that clears process admission and accepted audit enters one selected transaction. Lifecycle denials share one public response; rate/capacity/time/internal classes map exactly; malformed syntax consumes no durable attempt; no outcome returns a cookie or device data unless claim succeeds. |
| One-winner races | Same code across independent sources/connections creates one device/owner and one cookie-capable success; every loser has accepted plus terminal failure and no credential. Same-source overlap is rejected by process admission. Claim-versus-revoke and restart retain the storage-proven winner. |
| Cookie fidelity | Injection and a real TLS listener prove exactly one host-only `hostdeck_device` cookie with Path, Secure, HttpOnly, Strict, and exact absolute expiry attributes and no Domain/Max-Age/extra attribute. The response and stored device expiry agree. Plaintext and every non-success have no Set-Cookie. Existing-cookie replacement is deterministic. |
| CSRF separation | Claim response has no raw CSRF and requires bootstrap. Initial generation-1 hash exists, the discarded raw initial value appears nowhere, and the completed bootstrap rotates to generation 2 for read/write devices using the newly issued cookie. Claim never calls bootstrap itself. |
| Audit ordering and truth | Pair request/claim cover succeeded, known failed, incomplete, standalone pre-handler absence, accepted preflight failure, terminal failure, response preparation failure, crash-pending reconciliation, duplicate operation id, and unknown delivery. Actor/action/target/summary continuity is exact and no emergency bypass occurs. |
| Failure privacy | Unique raw code, bearer, CSRF, raw/canonical peer, source hash, label, cookie/header, native error, and forged-port sentinels are searched across public errors, observer/log capture, snapshots, audit rows, ordinary rows, and SQLite main/WAL/SHM bytes. Only explicitly allowed locations contain each value: labels in pairing/device rows and selected bodies, source hashes in rate rows, raw codes in successful issue bodies, and bearers in successful cookie headers. |
| Cache and wire behavior | Exact methods/paths/media/body/query, 404/405/415/malformed/oversized behavior, no-store/no-cache on success/error, no CORS headers, no secret URL, response schema serialization, request-id behavior, abort, and real raw HTTPS framing pass. |
| Restart and unavailable state | Reopen preserves issued/spent code, owner device, attempt windows, expiry, and auth usability before expiry; authentication rejects at/after expiry even if the browser still sends the cookie. Closed/read-only/corrupt storage and pending audit fail without partial response/cookie; source in-flight state is intentionally process-local and starts empty after restart. |
| Diagnostics | Frozen saturating snapshots expose only active/global counts and coarse issue/claim/admission/failure totals. They retain no operation/request/record/pair/device id, permission, label, origin, address/source key, retry time, code/token/CSRF/cookie, path, message, or cause. |
| Ownership boundaries | No browser UI, QR/image asset, device-revoke behavior, lock/LAN mutation, aggregate operation idempotency, SSE authority recheck, production listener assembly, packaging, physical-phone claim acceptance, or release claim is implemented or marked complete. |

## Validation Plan

- Direct contract suites for pairing, security audit, route manifest, and package exports.
- Direct headless source-key and process-local admission suites with hostile descriptors, canonical address equivalence, count saturation, deferred concurrency, abort, and cleanup.
- Direct route suites over branded fakes for exact order, call count, frozen values, malformed returned contracts, every public mapping, audit phases, response preparation, header timing, and secret scrubbing.
- Real migrated SQLite composition for issue, invalid/rate/capacity claim, one-winner claim, claim-versus-revoke, audit pending/terminal/reconciliation, bootstrap generation 2, restart, closed/read-only/corrupt behavior, and main/WAL/SHM privacy.
- Injection plus real loopback TLS/raw-HTTP evidence for transport, Host/Origin, cookie attributes, cache policy, duplicate/existing cookies, no CORS, no plaintext cookie, disconnect, and wire-secret location.
- Focused contracts/storage/server regression, then root/package typecheck, lint/exports, scaffold, unit, contract, integration, web, planning, exact Codex binding, frozen install, production audit/license inventory, and `git diff --check`.
- Manual descriptor/order/privacy inspection of every retained reference to raw code, bearer, CSRF, peer/source, prepared cookie, audit summary, and route error. Physical Android/browser pairing remains the aggregate `IFC-V1-033` gate and is not claimed by this leaf.

## Reuse And Dependency Decision

Reuse Zod, Fastify, Node `crypto` and `net.SocketAddress`, `cookie@1.1.1`, the selected request-trust/authentication context, resolved resource budget, `PairingCodeRepository`, security-mutation audit executor, no-store/error policies, and existing CSRF bootstrap. No dependency is added.

Do not use a generic rate-limit package: durable attempts and atomic ownership already live in SQLite, while the remaining in-flight state is a four-entry-default process-local counter with HostDeck-specific audit and secret-ordering requirements. Do not reuse the historical security route, trust-state response, caller-generated credential helpers, legacy pairing repository, or hand-written cookie format.

## Remaining Ownership

- `IFC-V1-033` owns aggregate browser/LAN/security acceptance, including physical-phone pair/reload behavior.
- `IFC-V1-048`/`IFC-V1-049` own aggregate subscriber/mutation admission and operation idempotency; this leaf owns only pair-claim concurrency.
- `IFC-V1-059` owns device revocation and active authority invalidation.
- `IFC-V1-031` owns LAN configuration/listener/certificate composition.
- `FE-V1-013`, `FE-V1-024`, and `FE-V1-031` own pairing/access UI, page-memory CSRF state, and visual/browser fidelity.
- `IFC-V1-054` owns the packaged selected `pair` CLI; this leaf supplies the selected local-admin API route it will consume.

Implementation may begin only after the human approves these frozen criteria.
