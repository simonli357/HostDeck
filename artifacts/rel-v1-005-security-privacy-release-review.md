# REL-V1-005 Security And Privacy Release Review

Date: 2026-07-29
Status: complete; `SPR-01` to `SPR-24` pass with zero unresolved security/privacy blocker

## Objective

Run one release-level security and privacy review over the selected HostDeck V1
path: exact Codex 0.144.0 on an Ubuntu current-user service, loopback-only
HostDeck, private Tailscale Serve HTTPS on one human-selected saved personal
profile, and a paired Android browser. The review consolidates current L1-L4
evidence, reruns security-sensitive behavior against the current commit/package,
inspects implementation and retained artifacts manually, and blocks release on
any unresolved security or privacy issue.

Requirement refs: `NFR-001`, `NFR-013`, and `SFR-001` to `SFR-018`.

## Frozen Boundary

- Only the selected app-server/Unix-socket/loopback/Tailscale-Serve/app-pairing
  path counts. Historical tmux production ownership, direct LAN, custom CA,
  Funnel, router exposure, public listeners, and synthetic proxy trust cannot
  satisfy a criterion.
- Accepted L4 clean-user and remote-phone evidence may remain an input only when
  its exact commit is an ancestor, its machine record validates, and current code
  reruns prove no affected boundary drift. It does not replace current static,
  contract, integration, package, dependency, or manual review.
- Tailnet membership and Tailscale identity are network context only. They never
  replace HostDeck pairing, permission, CSRF, lock, exact-target, or confirmation
  checks.
- Release remains no-go until downstream clean aggregate/device/block/go-no-go
  tasks complete. Passing this review means no unresolved security/privacy
  blocker in this task's scope, not that V1 is release-ready.

## Frozen Success Criteria

| ID | Required assertion |
| --- | --- |
| `SPR-01` | One immutable executable ledger covers exactly these 24 criteria, all 20 requirement refs, selected trust boundaries, threat classes, evidence owners, and final dispositions. Missing, duplicate, reordered, stale, historical-only, or private evidence fails. |
| `SPR-02` | Current source commit, lockfile/toolchain, exact Codex/Tailscale/browser constraints, 35-route/22-registration API identity, deterministic package/web hashes, and accepted L4 ancestor commits are bound before review results can pass. |
| `SPR-03` | Threat review enumerates protected assets, actors, entry points, trust transitions, host-local assumptions, and abuse cases for laptop processes, Tailscale ingress, pairing, browser authority, writes, SSE, storage, service lifecycle, evidence, and support material. No tailnet, proxy, or host identity becomes implicit authorization. |
| `SPR-04` | Listener/process/package inspection proves no HostDeck cloud dependency, telemetry, public/Funnel/LAN listener, HostDeck TLS/certificate owner, router requirement, direct Codex app-server exposure, direct-LAN/custom-CA fallback, or second production ingress. HostDeck binds exact IPv4 loopback only. |
| `SPR-05` | Raw HTTP tests reject non-loopback direct access, remote HTTP, wrong Host/Origin/target/TLS/source, DNS rebinding, missing/partial/duplicate/comma-joined/unknown forwarding identity, Funnel, lookalikes, wildcard credentialed CORS, and admission-generation races before protected disclosure or mutation. |
| `SPR-06` | Trusted Serve HTTPS accepts only the exact configured external origin and all-or-none normalized proxy context. Secure, HttpOnly, host-only, SameSite=Strict cookies are issued only after valid HTTPS claim; no bearer or CSRF secret enters URLs, JavaScript-readable durable storage, response detail, referrer, or cross-origin transport. |
| `SPR-07` | Pairing codes are high-entropy, one-time, short-lived, bounded, source-rate/concurrency-limited, fragment-only, scrubbed before referrer/history/application work, and invalidated on claim. Invalid, reused, expired, revoked, malformed, or uncertain claims disclose no protected data and never retry automatically. |
| `SPR-08` | Every protected read and mutation composes current admitted ingress with valid paired authority. Unpaired, invalid, expired, revoked, read-only, CSRF-invalid, locked, stale-generation, wrong-profile, and untrusted clients have the exact denied read/write behavior with no unauthorized metadata, event, cookie, audit-success, or side effect. |
| `SPR-09` | CSRF bootstrap/rotation, reload, multi-tab authority, self-revoke, other-device revoke, cookie deletion, synchronous UI purge, and in-flight request/SSE closure remain race-safe. Device list/revoke exposes only bounded necessary identity and cannot create authority. |
| `SPR-10` | Host lock is immediate across all paired writers, accepted/in-flight boundaries, routes, and restarts; no queued mutation crosses it. Remote unlock is impossible, local unlock is exact and audited, and monitoring authority remains distinct from write authority. |
| `SPR-11` | Approval, compact, interrupt, archive, revoke, lock, remote enable/disable, and other risky operations require explicit immutable target and risk-appropriate confirmation. Repeated, concurrent, stale, conflicting, or post-dispatch-unknown use cannot duplicate or silently retarget work. |
| `SPR-12` | Prompt/control/approval/interrupt/archive/remote operations reject missing, archived, stale, incompatible, unresolved, or non-writable targets instead of buffering or replaying. Accepted, terminal succeeded/failed/incomplete audit truth cannot contradict response or durable operation state. |
| `SPR-13` | Remote status is bounded and read-only. Enable/disable is explicit, audited, generation-safe, and limited to the active selected personal profile plus exact HostDeck Serve ownership; it never switches profiles, logs in/out, starts/stops Tailscale, mutates company/foreign Serve, repairs automatically, resets globally, enables Funnel, or hides incomplete cleanup. |
| `SPR-14` | Tailscale/profile/Serve absence, stop, sign-out, mismatch, drift, conflict, timeout, oversize, malformed output, command failure, profile race, and process restart fail closed with truthful local recovery. Local HostDeck/Codex stays independent and returning to the selected profile recovers by observation only when exact proof remains. |
| `SPR-15` | Phone/API/UI/CLI route and dependency inspection finds no arbitrary raw shell, terminal input, file browser/editor, direct app-server client, hidden legacy production path, unsafe debug route, test-only bypass, secret default, broad fallback, or environment flag that can weaken production admission. |
| `SPR-16` | State, config, database/WAL/SHM, service environment, lifecycle lock, runtime directory, Unix socket, release files, units, and manifests have exact current-user ownership and restrictive modes or fail/repair observably. No Tailscale node key, reusable credential, or auth store is read or copied; raw profile/account/company identity is never retained or used as application authority. |
| `SPR-17` | Raw database bytes, audit rows, logs, errors/causes, CLI output, process arguments/environment, browser history/storage/referrer, package files, screenshots, JSON/Markdown evidence, temp roots, and support docs retain no pairing link/code, cookie, CSRF, prompt/transcript, raw output, private origin/IP/profile/account/device/runtime id, node key, credential, or unbounded path. Explicit bounded public projections remain the only exceptions. |
| `SPR-18` | Pair, source/device/global mutation, request-body/header, HTTP deadline, SSE subscriber/queue/backpressure/heartbeat, output, storage retention, process shutdown, and evidence bounds reject minima/maxima/overflow/slow/concurrent/abort cases without unbounded queue, leak, starvation, retry loop, or retained resource. |
| `SPR-19` | Service units and lifecycle preserve least privilege, private runtime ownership, exact executable/package identity, one daemon lease, independent Codex/HostDeck process ownership, rollback, stop/uninstall order, and zero unauthorized persistence. No root service, capability, login-shell edit, lingering change, firewall, certificate, Tailscale, or unrelated failed-unit mutation occurs. |
| `SPR-20` | Current production dependency audit has zero known vulnerabilities at the enforced level; production licenses are inventoried and policy-compatible; lockfile/install is frozen; package verification rejects missing/extra/modified/escaping/runtime/native/web content and contains no source map, `.env`, credential, dev server, or undeclared executable. |
| `SPR-21` | Exact runtime/config/schema/platform/version drift and missing/malformed secrets or paths fail loudly before unsafe operation. Compatibility diagnostics are mutation-closed, disclose no private runtime data, and cannot be activated by an untrusted browser or validation-only environment fallback. |
| `SPR-22` | Accepted clean-user and real-phone evidence proves ordinary-user install, cellular/unrelated-network private HTTPS, no CA/LAN/USB app transport, app pairing, write/read/SSE/lock/revoke, saved-profile noninterference, and complete cleanup. Current review records its exact unchanged limits and does not upgrade it into `FE-V1-090` or release-smoke evidence. |
| `SPR-23` | User/developer/command/support material describes only verified selected-path commands, separates Tailscale reachability from app authorization, protects pairing/diagnostic material, gives safe profile/Serve/conflict/lost-phone/shutdown recovery, and never instructs CA enrollment, certificate bypass, LAN/public fallback, global Serve reset, company-profile mutation, or remote unlock. |
| `SPR-24` | Closure records every criterion disposition, threat and issue/fix inventory, exact commands/counts/versions/hashes, dependency/license/package results, manual code/runtime/artifact/doc inspection, accepted evidence, privacy/residue inventory, remaining release blockers, and push state. Any unresolved security/privacy finding leaves `REL-V1-005` open and the release no-go. |

## Initial Gap Audit

| Gap | Required action |
| --- | --- |
| Existing module-hardening evidence covers most release threats but no release-owned executable ledger maps all `NFR-001`, `NFR-013`, and `SFR-001` to `SFR-018`. | Add one immutable task ledger and validator over current code/package plus accepted L4 inputs. |
| Dependency, license, package-content, and retained-artifact truth can drift after module closure. | Rerun current production audit/license/package/privacy gates and bind exact hashes/results. |
| Prior physical evidence is narrow and aggregate dashboard acceptance is still open. | Accept only the unchanged security boundary proved by `IFC-V1-079`; keep `FE-V1-090` and release-device work explicitly open. |
| Release docs include a newly completed user guide, while repo/status/delivery truth still has downstream owners. | Inspect all security-sensitive guidance now; route non-security release-doc drift to its owning later task without hiding it. |

## Threat And Boundary Review

Protected assets are the paired-device authority, CSRF state, exact operation
target, audit truth, Codex socket/runtime, HostDeck database and service state,
selected saved-profile/Serve ownership, release package, and sanitized support
evidence. Actors are the current laptop user, an unpaired or paired remote
browser, a stale/revoked browser, another same-tailnet device, a local process,
an untrusted network peer, and a release-package consumer. Entry points are the
35 selected HTTP routes, pairing fragment and claim, SSE stream, local CLI,
service lifecycle, Codex socket, Tailscale CLI observation/control adapter,
package/install boundary, and retained evidence.

| Threat class | Disposition and proof |
| --- | --- |
| `public_network_exposure` | Pass: the app owns exact IPv4 loopback only; Tailscale Serve is the sole selected remote ingress; no Funnel, LAN listener, router rule, HostDeck TLS owner, telemetry, or cloud dependency exists. |
| `proxy_header_spoofing` | Pass: direct, partial, duplicate, malformed, stale-generation, wrong-source, and non-Serve proxy contexts fail before disclosure or mutation. |
| `origin_dns_cors_confusion` | Pass: exact configured HTTPS origin, Host, proxy target, TLS, source, credentialed CORS, and DNS-rebinding cases are mutation-closed. |
| `application_authorization_bypass` | Pass: admitted ingress, paired cookie authority, permissions, current generation, CSRF, lock, and exact target compose on every protected route. |
| `pairing_theft_replay` | Pass: 128-bit fragment-only one-time codes have bounded lifetime, source/global limits, timing-safe hash comparison, immediate invalidation, and no automatic retry. |
| `csrf_cookie_browser_storage` | Pass: host-only Secure/HttpOnly/SameSite=Strict cookies and page-memory CSRF state survive only the intended authority lifecycle; no durable browser secret store is used. |
| `permission_lock_revocation_race` | Pass: lock/revoke/profile/ingress generations synchronously purge clients, close streams, and prevent accepted or queued writes from crossing the boundary. |
| `target_replay_audit_contradiction` | Pass: risky writes bind immutable targets, confirmations, operation ids, dispatch state, and durable audit terminal truth under replay/concurrency/failure cases. |
| `tailscale_profile_serve_mutation` | Pass: the bounded adapter observes exact read-only state and can mutate only HostDeck's exact Serve path on the already selected profile; it cannot switch, log in/out, reset, repair globally, or enable Funnel. |
| `arbitrary_execution_legacy_bypass` | Pass: the exact 35-route manifest exposes no shell, terminal, file/editor, app-server, LAN, debug, or validation-bypass product surface. Child processes use exact executables/arguments without a shell. |
| `local_permission_secret_retention` | Pass: canonical current-user paths and restrictive modes cover state, database sidecars, runtime, socket, environment, lock, units, and release files; Tailscale credentials and raw account/profile identity are not retained. |
| `resource_exhaustion_slow_client` | Pass: request, pairing, source/device/global mutation, SSE subscriber/queue, output, retention, process, and evidence bounds reject overflow, slow, abort, and shutdown cases with deterministic accounting. |
| `process_service_persistence` | Pass: ordinary-user units have no root/capability/firewall/certificate/login-shell authority; one lease, exact package executables, ordered cleanup, rollback, retention, and uninstall are independently proven. |
| `supply_chain_package_tampering` | Pass after `SPR-FINDING-01`: frozen install, zero known production vulnerabilities, reviewed permissive licenses, deterministic package identity, independent mutation closure, no source maps/secrets, and declared executable modes. |
| `evidence_support_disclosure` | Pass: package, reports, JSON/Markdown, screenshots, support guidance, temp/residue, and current runtime inventories were scanned and manually inspected without retained credentials, prompts, transcripts, or private network/account identity. |
| `compatibility_config_downgrade` | Pass: schema/platform/runtime/config/path drift fails loudly; the supported Codex binding passes and the newer default binary is rejected with a bounded diagnostic rather than silently accepted. |

| Trust boundary | Result |
| --- | --- |
| `release_input_to_verified_package` | Deterministic two-build identity and independent package mutation verifier pass. |
| `verified_package_to_current_user_install` | Read-only relocation, installed/global-style execution, modes, lifecycle, rollback, retention, and uninstall contracts pass. |
| `local_user_cli_to_loopback_admin` | Fixed loopback target, bounded transport, exact route set, no retrying writes, and privacy-safe output pass. |
| `hostdeck_to_codex_unix_socket` | Exact Codex 0.144.0 generated binding, canonical private socket, child lifecycle, reconciliation, and incompatibility closure pass. |
| `tailscale_serve_to_loopback_proxy` | Exact profile/Serve ownership, normalized proxy admission, selected HTTPS origin, failure/race closure, and independent local health pass. |
| `unpaired_browser_to_pair_claim` | Fragment scrub, one-time claim, rate/concurrency/expiry/reuse/revoke limits, and no pre-auth disclosure pass. |
| `paired_browser_to_protected_api` | Cookie/CSRF/permission/lock/target/generation admission plus 76-case two-engine package evidence pass. |
| `application_to_local_state_audit` | Guarded SQLite ownership, schema checks, durable operation/audit consistency, retention, and restart reconciliation pass. |
| `runtime_output_to_ui_evidence_support` | Bounded projections, errors, diagnostics, browser state, reports, screenshots, and support-doc privacy scans pass. |

## Findings And Fixes

| ID | Severity | Finding | Resolution |
| --- | --- | --- | --- |
| `SPR-FINDING-01` | Medium | The production dependency closure retained 235 third-party source-map files, violating `SPR-20` and increasing disclosure/package surface. | Fixed in `fcfc957`: production publication deterministically prunes source maps; the independent verifier now rejects any reintroduced `.map`, `.env*`, `.npmrc`, `.netrc`, or credential-suffix file. Direct and relocated mutation tests pass. |
| `SPR-FINDING-02` | Low | One subscriber-isolation regression used a fixed 50 ms wall-clock oracle that failed under aggregate scheduler load without a product failure. | Fixed in `d3d9e0d`: exact event queue/accounting assertions now prove slow-subscriber isolation deterministically; focused stream and production resource-stress suites pass. |

No finding was waived, deferred, or accepted as release risk. The installed
default Codex 0.146.0 failing the exact 0.144.0 gate is an expected compatibility
diagnostic, not a hidden fallback or supported-runtime claim.

## Criterion Disposition

| Criteria | Status | Release-owned evidence |
| --- | --- | --- |
| `SPR-01` to `SPR-03` | Pass | Immutable 24-criterion ledger; exact 20 requirements, 16 threats, nine boundaries, selected evidence owners, current source and accepted L4 ancestry. |
| `SPR-04` to `SPR-07` | Pass | Listener/process/route inspection; ingress/proxy/origin hostile matrices; exact cookie/CSRF and bounded one-time pairing contracts. |
| `SPR-08` to `SPR-12` | Pass | Protected read/write admission, lock/revoke races, immutable target/confirmation, operation/audit consistency, SSE closure, and stale/conflict matrices. |
| `SPR-13` to `SPR-15` | Pass | Observation-first saved-profile/Serve adapter and lifecycle matrices; no profile switching/global repair; exact API/CLI/product-route and child-process review. |
| `SPR-16` to `SPR-19` | Pass | Path/mode/state/database/service inspection, privacy scan, cross-owner resource stress, exact user-unit security and lifecycle/uninstall evidence. |
| `SPR-20` to `SPR-21` | Pass | Fixed supply-chain/package finding; frozen install, audit/license inventory, deterministic verifier, runtime/config/schema/version drift closure. |
| `SPR-22` to `SPR-23` | Pass | Exact unchanged clean-user and Android security-boundary inputs plus selected-path user, command, recovery, privacy, and support guidance review. |
| Final closure (`SPR-24`) | Pass | This artifact and strict private-free `evidence.json` record all dispositions, findings, identities, validation, accepted limits, blockers, and push state. |

The machine record lists every `SPR-01` to `SPR-24` disposition individually;
all are `pass`, and `unresolved_security_blockers` is zero.

## Current Validation

| Gate | Result |
| --- | --- |
| Ledger/final evidence | Six focused tests pass with the strict final-evidence gate enabled; exact 24/20/16/9 inventories and accepted L4 ancestors validate. |
| Unit | 2,909 passed across 262 files; 29 intentional environment/device-gated skips were enumerated, including this review's normally disabled final-evidence gate. |
| Contract / integration / web | 245 / 36 / 932 passed. |
| Static | Typecheck passes; lint checks 828 files and eight package export surfaces. |
| Runtime boundary | Seven hostile mutations, 619-source/22-registration boundary, and exact isolated Codex 0.144.0 binding over 671 generated files pass; default 0.146.0 fails the exact gate as required. |
| Package | 42 direct cases plus acceptance pass over two deterministic builds, immutable relocation, installed/global-style execution, full tamper matrix, and independent verification. |
| Browser package | 76/76 no-retry cases pass in pinned Chromium 149 and Firefox 151 at phone and desktop regimes; 316 requests, 52 mutations, zero unexpected diagnostics, four reports, and aggregate privacy/cleanup checks pass. |
| Supply chain | Frozen offline install covers nine workspaces; 184 production dependencies have zero known vulnerabilities; 172 records resolve to eight reviewed permissive license expressions. |
| Package identity | 619 sources, 1,245 owned outputs, 6,231 entries, 35,830,356 bytes; content `903df036e5f71db5406f591fabbe1e838125fa43317715331d8251e5e35f9a21`; manifest `60933a5050c1be5cda6dc29382687b78ec346602219aaa63dc93fc5a3a1ff0ad`. |
| Web identity | Three files, 1,210,747 bytes; content `5e96b3c87b6e5c942426bbd0748c1f7b36325a4c597199545871a08a55024ae5`; manifest `4d6b1bb607ce4b9e80239f2115cb452b998e46a9c5fa25de8a962b5d78df2017`. |
| Host inspection | No HostDeck process, listener, owned Serve path, installed user unit, or owned runtime residue remained; Tailscale stayed independent with exactly one selected saved profile and one preserved alternate profile. |
| Protected artifacts | The 18 pre-existing modified PNGs remain unstaged and outside every task commit. |

## Manual Inspection

- Environment flow is bounded to required current-user/runtime/package values.
  The service environment allowlist excludes network and browser authority; the
  Codex child inherits the intentional same-user developer boundary and uses an
  exact executable with `shell: false`.
- The Tailscale adapter invokes only the exact local binary with a minimal
  environment, timeout, and output cap. Reads are status/version/profile/Serve
  observations. Mutations are only exact HostDeck Serve-path enable/disable.
- Generated systemd units run as the ordinary user with no capabilities, root
  service, login-shell edit, firewall/certificate ownership, Tailscale lifecycle
  mutation, or unrelated-unit repair. The remaining systemd-analyze exposure is
  the intentional same-user Codex development authority.
- Duplicate cookies, invalid authority, stale admission generations, and active
  lease races fail closed. Pairing and high-entropy session secrets are hashed
  and timing-safe compared; browser credentials are not placed in URLs or
  durable JavaScript-readable storage.
- Source and package searches found no shell execution flag, dynamic code
  evaluation, dangerous HTML sink, telemetry, external cloud fetch, hidden
  product route, environment weakening switch, or raw shell/file/editor surface.
- Privacy inspection covered package paths/content, database/audit/error
  projections, process arguments/environment contracts, browser storage/history,
  support docs, reports, screenshots, and temp/residue cleanup. Three lexical
  hostname-model matches were bounded semantic/device-model text, not retained
  network, account, credential, or authorization data.

## Accepted L4 Limits And Remaining Gates

- `IFC-V1-058` at `eb77647e8b1e77e42b16fef21b65da0d1b65ea8e`
  remains accepted only for unchanged ordinary-user clean-install/security
  boundaries.
- `IFC-V1-079` at `b4078b6d411267dec9701ed5ae67037567a9dee9`
  remains accepted only for unchanged remote Android HTTPS/app-auth/profile
  noninterference security boundaries.
- Neither input is upgraded into current aggregate phone evidence. The target
  phone was offline during closure, so `FE-V1-090` remains blocked and
  `REL-V1-006` through `REL-V1-010` remain downstream release gates.
- Security/privacy blockers: zero. Overall V1 release state: no-go pending those
  non-security release gates and human acceptance.

Implementation and validation through `d3d9e0d`; package hardening `fcfc957`;
browser evidence refresh `ee31ea7`. Closure commit and push state are recorded
in the owning backlog/status after publication.

## Documentation Impact

Tier 3 release-gate update: this artifact, machine evidence, owning task/queue,
status, release block, and delivery gate change from open to complete. No product,
UX, requirements, architecture, setup, or command behavior changed.
