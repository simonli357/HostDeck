# REL-V1-005 Security And Privacy Release Review

Date: 2026-07-29
Status: strict criteria frozen before release review changes

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

## Documentation Impact

Tier 1 hardening criteria: this artifact and the owning `REL-V1-005` task/queue.
Planning, architecture, requirements, and delivery owners change only if the review
finds a contract or behavior mismatch.
