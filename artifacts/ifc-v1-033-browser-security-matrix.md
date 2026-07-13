# IFC-V1-033 Browser Security Matrix

Date: 2026-07-13

Status: in progress. This matrix is the frozen acceptance contract; blank physical results are release evidence gaps, not passes.

## Scope Boundary

This task proves the selected browser trust and security policies together through an acceptance-only Fastify composition and one physical Android Chrome run. It does not prove the product dashboard, the selected production route aggregate, packaging, service installation, or V1 release readiness.

The acceptance app may add only bounded sentinel read, write, SSE, and phone-driver routes. Trust, device authentication, CSRF, pairing, device list/revoke, lock, LAN state, certificate, audit, and SQLite behavior must use the selected production policies and repositories without bypasses.

## Evidence Legend

- `A`: deterministic aggregate app test using real production policies and SQLite.
- `L`: exact-IP real HTTPS listener or raw-socket inspection.
- `P`: attached Android Chrome evidence from the current aggregate run.
- `O`: prior task owns the proof; the referenced artifact remains applicable.
- `pending`: required evidence has not yet been captured.

## Frozen Matrix

| Row | Required behavior | Automated evidence | Listener evidence | Phone or prior evidence | Result |
| --- | --- | --- | --- | --- | --- |
| `BIND-01` | Loopback requests obtain local-admin authority only from a loopback peer, unsafe missing-Origin request, and no browser fetch metadata. | `A` | Raw loopback request and browser-shaped denial (`L`) | Not applicable | pending |
| `BIND-02` | LAN listener binds one currently assigned private IPv4 address and the selected port, never wildcard, unspecified, or loopback. | Startup assertions (`A`) | Process/socket inventory (`L`) | Host and phone addresses recorded (`P`) | pending |
| `BIND-03` | No app-server TCP listener is exposed by the acceptance composition. | Port-owner assertion (`A`) | Process/socket inventory (`L`) | Not applicable | pending |
| `TRUST-01` | Exact configured Host and same Origin pass; duplicate, malformed, foreign, substituted, and DNS-rebinding Host/Origin forms fail before route work. | Full hostile matrix (`A`) | Raw parser and HTTPS requests (`L`) | Foreign-origin credentialed fetch denied (`P`) | pending |
| `TRUST-02` | Browser-like unsafe missing Origin, `null` Origin, preflight, and proxy-spoof headers do not acquire authority or CORS access. | Full hostile matrix (`A`) | Raw HTTPS requests (`L`) | Foreign-origin result inaccessible (`P`) | pending |
| `TRUST-03` | Responses never contain wildcard or reflected permissive CORS headers. | All matrix responses inspected (`A`) | Accepted and rejected headers (`L`) | DevTools network metadata (`P`) | pending |
| `TLS-01` | The current exact LAN origin uses the selected certificate identity and trusted public root. | Certificate descriptor match (`A`) | Verified TLS connection and fingerprint (`L`) | Chrome secure connection without bypass (`P`) | pending |
| `TLS-02` | Plain HTTP on the selected LAN address is refused and never reaches a route. | Dispatch counters unchanged (`A`) | Plaintext socket/request refusal (`L`) | Chrome plaintext navigation fails (`P`) | pending |
| `TLS-03` | Invalid chain, SAN/date/authority, renewal, trust removal, and reinstall remain owned by the certificate task. | Not duplicated | Not duplicated | `O`: `artifacts/ifc-v1-015-https-phone-enrollment.md` | prior-owned |
| `AUTH-01` | Unpaired LAN browser can reach only allowed public/optional access surfaces; protected sentinel data, device list, CSRF, write, and SSE are denied. | Aggregate route matrix (`A`) | HTTPS bodies and dispatch counters (`L`) | Cold Chrome denial before pairing (`P`) | pending |
| `AUTH-02` | Valid read device can read protected state but cannot write, lock, revoke, or acquire write effects. | Seeded read-device matrix (`A`) | HTTPS denial and zero side effects (`L`) | Not required | pending |
| `AUTH-03` | Valid write device can read and perform only admitted current-CSRF writes while unlocked. | Seeded and claimed writer matrix (`A`) | HTTPS success and exact side effect (`L`) | Paired writer path (`P`) | pending |
| `AUTH-04` | Expired, revoked, malformed, duplicate-cookie, and unknown credentials fail closed without protected data or write effects. | Credential matrix (`A`) | Raw cookie requests (`L`) | Post-self-revoke denial (`P`) | pending |
| `AUTH-05` | Device credential exists only in the Secure, HttpOnly, host-only, SameSite=Strict cookie and never in response JSON or JavaScript storage. | Header/body/storage-source assertions (`A`) | Set-Cookie metadata with value redacted (`L`) | Cookie metadata and browser storage inventory (`P`) | pending |
| `PAIR-01` | Local admin issues one bounded, expiring read or write code through the selected route and secret-free audit. | Issue route and audit (`A`) | Local-only request (`L`) | Human sees code only in ephemeral host UI | pending |
| `PAIR-02` | One valid claim wins, consumes the code, creates one device, emits one cookie, and requires CSRF bootstrap. | Aggregate claim (`A`) | Real HTTPS claim (`L`) | Human enters code directly on phone (`P`) | pending |
| `PAIR-03` | Invalid, expired, used, source/global rate-limited, and concurrent claims remain generic and create no extra device/cookie. | Deterministic clock/race matrix (`A`) | Selected failures sampled (`L`) | Not required | pending |
| `PAIR-04` | Raw pairing code never enters ADB, process arguments, shell history, screenshots, logs, repository files, artifacts, or assistant output. | Secret canaries and retained-file scan (`A`) | Process/log inspection (`L`) | Human-entry procedure and screenshot exclusion (`P`) | pending |
| `CSRF-01` | Bootstrap requires an active paired cookie and exact Origin, rotates atomically, and returns a no-store in-memory token/generation only. | Bootstrap matrix (`A`) | HTTPS headers/body (`L`) | Fresh bootstrap after reload (`P`) | pending |
| `CSRF-02` | Current token/generation succeeds; missing, malformed, stale, and wrong-device combinations fail before lock, audit, or sentinel dispatch. | Full CSRF matrix and counters (`A`) | Selected HTTPS failures (`L`) | Stale token after rotation denied (`P`) | pending |
| `CSRF-03` | Raw CSRF values never enter cookies, URLs, persistent browser storage, audits, logs, retained artifacts, or raw SQLite bytes. | Canary scans (`A`) | Raw response/log/database inspection (`L`) | Browser storage and URL inventory (`P`) | pending |
| `LOCK-01` | Paired writer can lock; lock becomes durable before response and blocks later protected writes before dispatch. | Route/order/counter assertions (`A`) | Real HTTPS write before/after lock (`L`) | Phone lock then denied write (`P`) | pending |
| `LOCK-02` | Paired/read/unpaired browser cannot unlock; only explicit local-admin authority can unlock. | Authority matrix (`A`) | Remote HTTPS denial and local service transition (`L`) | Local-admin unlock restores phone write (`P`) | pending |
| `LOCK-03` | Repeated/concurrent transitions are deterministic and audit response matches durable state. | Race/idempotent-state matrix (`A`) | SQLite/audit inspection (`L`) | Not required | pending |
| `DEVICE-01` | Device list is bounded, ordered, non-secret, and denied to unpaired/expired/revoked credentials. | Aggregate list matrix (`A`) | HTTPS body inspection (`L`) | Paired list may identify only bounded device metadata (`P`) | pending |
| `REVOKE-01` | Current-CSRF writer or local admin can revoke another, self, or final device through one accepted-to-terminal audit path. | Other/self/final matrix (`A`) | HTTPS and SQLite truth (`L`) | Final self-revoke (`P`) | pending |
| `REVOKE-02` | Fresh revoke synchronously invalidates active and opening request/SSE authority; other-device authority remains active. | HTTP/bootstrap/SSE concurrency matrix (`A`) | Real stream closure (`L`) | Authenticated phone SSE closes on revoke (`P`) | pending |
| `REVOKE-03` | Self-revoke returns once, emits only the exact deletion cookie, then read/bootstrap/write/SSE all fail. | Aggregate route sequence (`A`) | Set-Cookie and follow-up HTTPS (`L`) | Phone sequence after final self-revoke (`P`) | pending |
| `REVOKE-04` | Already-revoked/missing/racing targets are visible conflicts and never redispatch or contradict durable/audit truth. | Conflict/race matrix (`A`) | SQLite/audit inspection (`L`) | Not required | pending |
| `AUDIT-01` | Every accepted security mutation has exactly one matching succeeded, failed, or incomplete terminal record; pre-admission rejection has none. | Cross-route audit reconciliation (`A`) | Raw SQLite rows (`L`) | Physical operation ids reconciled (`P`) | pending |
| `AUDIT-02` | Audit actors, targets, intents, and outcomes agree with request authority and durable result without secret fields. | Schema and semantic assertions (`A`) | Raw-row/privacy inspection (`L`) | Physical operation subset (`P`) | pending |
| `SIDE-01` | Every rejected request leaves sentinel read confidentiality, write count, lock state, devices, pairing state, and audit state unchanged at the owning boundary. | Before/after snapshots (`A`) | Real-listener counters and database (`L`) | Required physical denials checked (`P`) | pending |
| `PRIV-01` | Protected sentinel, bearer, cookie, CSRF, pairing code, private key, and private causes are absent from rejected bodies, CORS exposure, logs, audits, raw database/WAL/SHM, and retained evidence. | Canary scan (`A`) | Response/log/file scan (`L`) | Browser console/storage/network redacted inspection (`P`) | pending |
| `CLEAN-01` | App close leaves zero active authority leases, SSE iterators/subscribers, request timers, listener sockets, and temporary app resources. | Runtime snapshots and active-handle ownership (`A`) | Post-close socket/process inventory (`L`) | Phone tab/profile and ADB cleanup (`P`) | pending |
| `CLEAN-02` | Temporary certificates/pages/profile data, transferred public files, Chrome tabs, service workers, caches, and ADB forwards are removed; durable test database is retained only long enough for redacted inspection. | Host cleanup assertions (`A`) | Files/process/port inventory (`L`) | Device cleanup inventory (`P`) | pending |
| `META-01` | Evidence records Android model, OS/API, Chrome version, host/phone private addresses, certificate fingerprint, commit, and cold-browser/cache policy without secrets. | Harness metadata schema (`A`) | Host metadata (`L`) | Device metadata (`P`) | pending |

## Closure Gates

- Every `A` and `L` row must pass in focused tests and the supported full workspace validation.
- Every required `P` row must come from the attached phone in the same aggregate run. Prior certificate evidence substitutes only for `TLS-03`.
- Failed or unavailable physical rows remain named gaps. They cannot be replaced by injection, disabled TLS verification, relaxed trust policy, screenshots alone, or a desktop browser.
- Retained evidence is redacted and includes no raw pairing code, bearer, cookie value, CSRF value, private key, protected sentinel, or private cause.
