# IFC-V1-079 Remote Ingress Security And Android Acceptance

Date: 2026-07-17
Status: criteria frozen; phone-runner implementation complete; physical evidence pending

## Objective

Prove the selected V1 remote-ingress leaves as one hostile security boundary and one physical Android workflow. The aggregate must preserve loopback-only HostDeck ownership, private Tailscale Serve HTTPS, application pairing, source and global limits, CSRF, lock, revoke, write auditing, lifecycle generation currentness, local-runtime independence, and deterministic cleanup.

Requirement refs: `NFR-001`, `NFR-002`, `NFR-005`, `NFR-011`, `NFR-013`, `PR-002`, `PR-003`, `PR-005`, `PR-007`, `SFR-001` to `SFR-008`, `SFR-012` to `SFR-018`, `DEC-027`, and the HTTP/SSE/security matrix in `docs/planning/04b-test-plan.md`.

Depends on: `IFC-V1-059`, `IFC-V1-066`, `IFC-V1-072` to `IFC-V1-074`, and `IFC-V1-076` to `IFC-V1-078`.

## Scope Boundary

- Automated evidence is one L2 acceptance-only composition over the selected production contracts, repositories, policies, route registrations, and lifecycle owners. Real SQLite, a real loopback Fastify listener, and the selected HTTP/SSE adapters are required.
- The only test-specific routes may be a bounded protected read sentinel, exact-target audited write sentinel, bounded SSE source, and a secret-free phone driver. The phone driver is limited to fixed authenticated GET checkpoints and fixed host-selected commands held only in test memory; it accepts no arbitrary phone payload. These routes must pass through every applicable selected ingress, device, permission, CSRF, lock, generation, request-authority, write-gate, deadline, audit, and cancellation boundary used by product routes.
- Deterministic Tailscale observation and command fixtures may replace the external CLI only in the automated matrix. They must implement the frozen observer/manager contracts and expose exact call accounting. Tests may not mutate lifecycle state, request provenance, admission, authority, repositories, or audit rows behind the production owners.
- Physical evidence uses the installed Tailscale 1.98.8 CLI/daemon, one human-authorized saved HostDeck profile, one saved non-HostDeck profile, real private Serve HTTPS, Android Chrome, and the selected lifecycle. No fake proxy headers, direct LAN request, certificate bypass, custom CA, plaintext fallback, public listener, Funnel, router change, or HostDeck relay may satisfy a physical row.
- This task does not claim the full 35-route production app, the dashboard UI, packaged `codexdeck`, user services, clean install, or release readiness. Those remain downstream in `IFC-V1-046`, frontend tasks, interface hardening, and release tasks.

## Aggregate Construction Contract

1. Acquire owner-only temporary state and open the migrated SQLite database before app construction.
2. Compose durable remote state/proof/audit, pairing/device/CSRF/lock/revoke, proxy trust, request authentication, remote request authority, remote control, host health, selected write gate, and remote lifecycle through their public production factories.
3. Start through `startHostDeckTailscaleServeFastifyLifecycle` on exact IPv4 loopback HTTP. Listener verification must precede remote observation; local readiness must not await Tailscale.
4. Register the selected remote status/control, pair claim, CSRF bootstrap, device list/revoke, lock, and bounded acceptance sentinel routes through normal Fastify plugin registration. Every acceptance-only API route declares at least one strict Zod response schema and the ordinary non-device test gate enumerates the complete fixed driver route set. Local-admin and remote browser authority stay distinct.
5. Drive remote requests through a raw loopback socket carrying only the exact spike-proven Serve forwarding form. Injection may cover malformed application inputs, but it cannot be the sole evidence for proxy parsing, duplicate headers, socket ownership, connection closure, SSE disconnect, or Node limits.
6. Use fixed clocks, explicit barriers, bounded schedulers, and counted observer/manager/repository/dispatch/audit adapters for race and failure rows. Sleeping, retries, random race timing, or polling an assertion until it happens is not deterministic evidence.
7. Close through the selected lifecycle. The harness must inspect authority leases, request/SSE owners, listener sockets, timers, database handles, temporary paths, manager attempts, and retained private values after every case, including setup failure.

## Automated Hostile Matrix

Every rejected request asserts the response and all applicable negative side effects: no protected bytes, no dispatch, no device/cookie/CSRF creation, no success audit, no stale-success response, no authority leak, and no raw-value retention.

| ID | Required assertion |
| --- | --- |
| `NET-01` | The only HostDeck TCP listener is exact `127.0.0.1`; wildcard, IPv6-any, LAN/private-address, and public binds reject before remote observation or Serve mutation. The Codex app-server boundary remains Unix-only and no HostDeck TLS key exists. |
| `NET-02` | Local loopback HTTP remains healthy while remote ingress is disabled, unavailable, expired, profile-away, drifted, failing, or draining. Remote state never participates in local mutation readiness. |
| `NET-03` | Exact private Serve state maps one canonical HTTPS origin and `/` path to the selected loopback origin. Funnel/public/foreign/colliding/drifted descriptors never admit a request or trigger automatic repair. |
| `PROXY-01` | One exact external Host, HTTPS Origin where required, forwarded host/proto/source, physical loopback socket, origin-form target, and optional all-or-none standard identity bundle produce remote provenance only while two equal admission reads are open. |
| `PROXY-02` | The Cartesian hostile set rejects absent/duplicate/comma-joined/contradictory forwarding fields; partial or duplicate identity; every reserved/lookalike header; Funnel; wrong socket/TLS/target; non-CGNAT source; foreign/reflected/malformed Host or Origin; `null`; DNS rebinding; unsafe missing Origin; and preflight. |
| `PROXY-03` | Requests with no reserved proxy signal follow local policy without reading remote admission. Proxy-shaped requests cannot fall back to local-admin authority, and loopback header imitation cannot manufacture a paired device. |
| `PROXY-04` | No response reflects an origin or emits wildcard credentialed CORS. Tailscale identity changes do not change source limits, permission, device authority, audit actor, or response data. |
| `AUTH-01` | An unpaired admitted tailnet peer can read only the bounded unpaired/access and claim surfaces. Protected read, write, SSE, CSRF, device list, lock, revoke, and local-admin controls reject. |
| `AUTH-02` | A current read device can read and stream but cannot write, lock, revoke, unlock, or invoke local-admin remote controls. A current writer additionally requires current CSRF and unlocked state for mutation. |
| `AUTH-03` | Missing, malformed, duplicate, unknown, expired, revoked, wrong-device, stale-generation, wrong-profile, or wrong-origin credentials fail before protected work. Tailnet membership and identity alone grant no authority. |
| `AUTH-04` | The bearer is issued only as a Secure, HttpOnly, host-only, SameSite=Strict cookie over admitted external HTTPS. It is absent from JSON, URL, fragment, JavaScript-readable storage, audit, diagnostics, logs, and raw SQLite. |
| `PAIR-01` | A local-admin pair request emits one high-entropy, one-time, bounded-lifetime fragment link only while exact ingress is ready. The fragment is removed before the first network request and is absent from request target, Referer, browser history, resources, logs, process arguments, and retained evidence. |
| `PAIR-02` | Invalid, expired, used, concurrent, source-limited, and globally limited claims are generic. Exactly one concurrent valid claim wins and creates one device/cookie; response uncertainty cannot create a second credential. |
| `RATE-01` | Same verified source across sockets/identity changes shares the durable source bucket; different verified sources remain distinct; spoofed/unverified sources create no bucket; independent global limits prevent source rotation bypass. |
| `RATE-02` | Pair and mutation concurrency ceilings reject overflow immediately, release exactly once on completion/abort/throw, and do not serialize an unbounded queue. One stalled source does not consume another source's allowance beyond the global cap. |
| `CSRF-01` | Reload rotates CSRF through the HttpOnly device cookie. Missing, malformed, stale, wrong-device, revoked, or generation-changed token pairs fail before lock, audit acceptance, or dispatch. No raw CSRF value persists client-side or server-side. |
| `LOCK-01` | One writer lock persists before response, synchronously blocks later writes, and records accepted plus terminal truth. Remote unlock always rejects; explicit local-admin unlock restores writes without changing remote profile or Serve state. |
| `REVOKE-01` | Revoke persists and invalidates opening and active HTTP/SSE device authority synchronously. Self-revoke emits only the deletion cookie, returns once, and makes subsequent read/CSRF/write/SSE fail; another current device remains valid. |
| `WRITE-01` | The bounded sentinel write uses exact-target parse/auth/lock/currentness/audit/dispatch/terminal ordering and dispatches at most once. Every boundary throw/abort/timeout preserves failed or incomplete truth without retry, success response, or contradictory audit. |
| `LIFE-01` | Disabled and unavailable-at-boot reach local ready with closed remote authority. Exact enabled state opens only after durable intent, matching terminal proof, exact fresh observation, and current unexpired lease agree. |
| `LIFE-02` | Stop, logout, profile-away, Serve absent/foreign/drifted, observer failure, generation change, lease expiry, disable, and shutdown close admission and all generation leases once before stale response/cookie publication. |
| `LIFE-03` | Same-generation exact renewal preserves active work. Slow refresh cannot extend the prior lease past its exact expiry. Profile return reopens only by observing exact persisted state and valid proof; absent/drifted/unproven return requires explicit local enable. |
| `LIFE-04` | Profile switch before/during/after enable or disable, nonzero-with-change, unchanged, timeout, abort, oversize, partial output, audit/storage/proof/response failure, and cleanup conflict are bounded and truthful. No operation retries, compensates, switches profile, stops Tailscale, resets Serve, or mutates a foreign profile. |
| `SSE-01` | Authenticated SSE proves replay/live handoff, heartbeat, Readable backpressure, bounded queue/subscribers, request disconnect, profile-generation invalidation, device revoke, and shutdown cleanup. Network/client loss affects only that request and never cancels Codex work or global remote health. |
| `LIMIT-01` | Oversized URL/header/body/response, slow body, request deadline, idle connection, max connection/in-flight/subscriber/source/global limits, and noncooperative cleanup map to bounded public errors and settle by the owning deadline. |
| `FAIL-01` | Startup failure at state/DB/policy/plugin/listen/verification/observer/scheduler leaves no listener, lease, timer, request authority, manager command, or temporary resource. Runtime failures remain visible and cannot be converted to ready by stale state. |
| `AUDIT-01` | Every accepted pair, CSRF, lock/unlock, revoke, remote enable/disable, and sentinel write has exactly one terminal succeeded, failed, or incomplete outcome. Pre-admission rejection has no accepted/success audit; actors/targets/results contain no secrets or proxy identity. |
| `PRIV-01` | Object graphs, responses, error causes, logs, audit rows, raw DB/WAL/SHM bytes, command captures, process arguments, browser storage/history, and evidence contain no raw source, identity, profile/account/DNS value, pairing code/link, bearer, CSRF token, node key, reusable Tailscale credential, protected sentinel, or unbounded payload. |
| `CLEAN-01` | Repeated/concurrent close uses one bounded transition, closes remote authority/work before storage, continues after each cleanup failure, and leaves zero listener/SSE/request/timer/DB/temp/ADB-forward/Serve resource. The selected saved profile is restored and foreign Serve bytes are unchanged. |

## Physical Android Matrix

The physical run is one uninterrupted, no-retry acceptance sequence. A failed row fails the run and remains a named gap; rerunning requires complete cleanup and a new evidence instance.

| ID | Required assertion |
| --- | --- |
| `PHONE-01` | Record bounded host commit, Ubuntu/Node/Tailscale versions, Android model/API/release, Chrome version, and evidence timestamps. Store no serial, account, profile id/name, tailnet DNS name, IP address, node key, cookie, code, token, or raw command output. |
| `PHONE-02` | Exactly one authorized USB-debug device is present for bounded device-state inspection, browser launch/close, and screenshots only. Wi-Fi is disabled or has no laptop-LAN route; cellular or unrelated Wi-Fi plus Tailscale VPN routes are active. No app request may use ADB forwarding, USB networking, laptop LAN, plaintext HTTP, or a custom CA. |
| `PHONE-03` | Before state records the selected dedicated profile, byte-counted Serve state, foreign-profile Serve state, HostDeck listeners/processes, and browser-runner/site-data policy in redacted form. The dedicated profile starts with the HostDeck path absent. The run does not depend on desktop Chrome, CDP, remote browser debugging, or browser-storage extraction from the laptop. |
| `PHONE-04` | Selected lifecycle reaches local ready first. One explicit local enable creates exact private Serve HTTPS, and Android Chrome trusts it without warning, bypass, downloaded certificate, or user CA. An unpaired protected read fails. |
| `PHONE-05` | An in-memory QR contains the fragment-only canonical link. The human scans it with the phone camera; Chrome removes the fragment before any request, proves an unpaired protected read fails, creates one writer device, receives the hardened cookie, and exposes only a fixed authenticated checkpoint after success. No secret crosses ADB arguments, checkpoints, screenshots, files, logs, referrer, or evidence. |
| `PHONE-06` | Reload starts fragment-free, bootstraps fresh in-memory CSRF from the HttpOnly cookie, completes protected reads and one bounded audited write, and shows no bearer/CSRF value in JavaScript durable storage. After one explicit human start gesture, the phone runner enters fullscreen and executes the remaining fixed sequence without desktop browser control. |
| `PHONE-07` | A real authenticated EventSource receives at least one event and heartbeat. Phone-side Tailscale/network loss or laptop profile-away closes it; local HostDeck stays healthy and local CLI remains available. No Codex/sentinel work is canceled by the client disconnect. |
| `PHONE-08` | Manual switch to the saved non-HostDeck profile makes private HostDeck HTTPS unavailable, closes active authority, performs zero manager mutation, and leaves the foreign profile's Serve status byte-identical. No browser success is accepted during the away interval. |
| `PHONE-09` | Manual return to the dedicated profile recovers by observation only when exact persisted mapping/proof remain. The phone reconnects SSE and completes a protected read without re-pairing; manager command count is unchanged. Any non-exact return instead remains closed and requires explicit enable. |
| `PHONE-10` | Current writer self-revocation closes active SSE, emits the deletion cookie, and makes read/bootstrap/write/reconnect fail. The phone runner clears and verifies JavaScript-readable storage, then its fixed post-revoke checkpoint is rejected by current device authority. The redacted audit subset and SQLite truth agree. |
| `PHONE-11` | One explicit local disable removes only the exact HostDeck Serve path. Chrome is closed after runner-owned storage cleanup, ADB forwarding/reversing is absent, temporary state is removed, dedicated profile selection is restored, foreign Serve bytes are unchanged, final dedicated Serve is absent, and no test process/listener remains. |
| `PHONE-12` | Versioned repo evidence includes secret-free screenshots of the acceptance state at paired/ready, profile-away, recovered, and revoked/cleaned milestones plus bounded redacted command/result excerpts. QR, browser address bar, device ids, profile/account/DNS/IP values, notifications, and credentials must not appear. |

## Evidence And Privacy Contract

- Automated results name exact files, assertions, seed, clock, and command. Physical evidence is bound to one commit and one run identifier generated without a secret.
- Machine evidence may be written first to a mode-`0600` temporary file. A validator must reject unknown keys, private-value patterns, raw addresses/origins, nonterminal rows, retries, missing cleanup, mismatched commit, or an incomplete matrix before publishing a bounded repo artifact.
- Screenshots are captured directly from the fullscreen phone state through ADB and inspected before staging. They must show only the purpose-built secret-free acceptance state; browser address bars, notifications, and private system values are forbidden.
- After QR creation, browser foreground checks may read only bounded WindowManager display state with an exact Chrome component match. ActivityManager task/activity/intent dumps are forbidden because they can serialize the fragment-bearing launch intent even after page history is scrubbed.
- The run records counts and normalized reason families, never raw Tailscale `status`, `switch`, `serve`, DNS, certificate, identity, or proxy-header output.
- A skipped device row, disconnected phone, unavailable saved profile, inability to prove no LAN route, or cleanup uncertainty is a failure, not an automated pass or prior-evidence substitute.

## Validation Gates

1. Focused aggregate tests pass with no skip, retry, fake timer leak, open handle, or selected-policy bypass.
2. Adjacent remote control, proxy trust, authorization, pairing/browser, revoke, write-gate, lifecycle, SSE, listener, storage, and shutdown suites pass.
3. Unit, contract, integration, web, Chromium pairing, typecheck, lint/exports, scaffold, planning, runtime-boundary, and exact Codex binding gates pass.
4. Frozen install, production dependency audit, production license inventory, diff/privacy review, process/listener/socket/timer/temp inspection, and Tailscale/Serve/profile cleanup pass.
5. The physical matrix passes on the target Android over an unrelated network and its sanitized evidence validates against the exact committed implementation.
6. Implementation and evidence are committed and pushed. Only then may `IFC-V1-079` become `done` and unblock production composition, interface hardening, frontend remote-access work, and release acceptance.

## Explicit Non-Goals

- No direct-LAN/custom-CA path is restored or used as selected evidence.
- No company profile is configured, enabled, disabled, repaired, logged out, or reset by HostDeck or the harness.
- No public HostDeck listener, Funnel, router port, cloud relay, certificate owner, or Tailscale credential store is added.
- No product UI, general browser reconnect reducer, full selected route assembly, package/service installation, or V1 release claim is added.
