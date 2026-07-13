# REL-V1-012 Remote Access Rebaseline

Date: 2026-07-13

## Trigger And Finding

- Product intent requires the phone to control the laptop while the two devices are on different networks.
- The prior V1 direct-LAN/custom-CA path could not meet that intent without router/VPN infrastructure and imposed manual certificate enrollment.
- The laptop already uses Tailscale for a company tailnet at times. The user confirmed HostDeck and company access are needed one at a time, not simultaneously.
- Tailscale fast user switching supports saved accounts with only one active account/tailnet at a time. This makes a dedicated saved HostDeck profile compatible with a separately saved company profile, subject to an exact local spike.

## Selected V1 Direction

```text
Android browser
  -> active dedicated HostDeck Tailscale profile
  -> private Tailscale Serve HTTPS origin
  -> HostDeck HTTP on explicit loopback
  -> HostDeck normalized services
  -> private Unix socket
  -> Codex app-server
```

- Tailscale owns tailnet membership, NAT traversal/direct or relayed connectivity, `.ts.net` DNS, external TLS, and Serve ingress.
- HostDeck owns only its loopback HTTP listener, exact external-origin/proxy admission, one HostDeck-owned Serve mapping, app pairing/device authorization, CSRF, lock, rate limits, and audit.
- HostDeck pairing remains mandatory for remote clients. Serve-provided Tailscale identity is bounded source context inside the explicit single-user host-local-process boundary and never an app authorization shortcut.
- Pairing uses a local CLI-created one-time code in a QR/link URL fragment. The browser removes the fragment before any claim request or retained history.
- The local operator surface is only `remote enable`, read-only `remote status`, and `remote disable`. Enable derives the active dedicated profile/origin; status creates no mutation audit; disable closes HostDeck remote admission before ownership-safe Serve cleanup and remains disabled on cleanup conflict.
- No HostDeck public/LAN listener, router change, manual CA, HostDeck cloud relay, Tailscale node-key access, or automatic Tailscale profile switch is selected for V1.
- When Tailscale is stopped, signed out, on the company/wrong profile, or has drifted Serve state, remote access is unavailable while local HostDeck/Codex work remains healthy.
- HostDeck may mutate Serve only under explicit local `remote enable`/`remote disable`, on the exact selected dedicated profile, and only when the target state is absent or provably HostDeck-owned. Ambiguous or foreign state fails untouched; startup and profile return never auto-repair it.
- Direct-LAN/custom-CA work remains historical diagnostic evidence. It is not a V1 transport, UI, security, phone, or release gate.
- A HostDeck-operated outbound relay remains V2 because it can remove the phone VPN/profile prerequisite but adds cloud service, account, operations, and threat-model scope.

Decision: `DEC-027`.

## Profile Policy

- The laptop keeps a saved dedicated personal HostDeck profile and a saved company profile.
- The human chooses the active profile. HostDeck never invokes account login/logout/switch or changes a nickname.
- The phone must also have the HostDeck tailnet active while connecting. Its Tailscale profile is managed only in the Tailscale app; HostDeck cannot switch it or diagnose an unreachable phone before a request arrives.
- Company-profile active: company Tailscale works; HostDeck remote is unavailable; local HostDeck remains available.
- HostDeck-profile active: HostDeck observes its exact Serve mapping; only explicit local enable/disable may apply or remove it, and unrelated Serve configuration is preserved.
- A profile switch during an HTTP/SSE/mutation invalidates stale remote provenance and cannot be reported as successful recovery or mutation completion without authoritative evidence.

## Evidence Behind The Direction

- Tailscale fast user switching states that one client account is active at a time, the device cannot transmit on multiple tailnets simultaneously, saved accounts can be switched without reauthentication while their node keys remain valid, and Linux exposes `tailscale switch`/`tailscale switch --list`: `https://tailscale.com/docs/features/client/fast-user-switching`.
- Tailscale Serve privately proxies tailnet traffic to a local service, provisions external HTTPS, supports `http://127.0.0.1` proxy targets, exposes status/config commands, and can run persistently: `https://tailscale.com/docs/features/tailscale-serve` and `https://tailscale.com/docs/reference/tailscale-cli/serve`.
- Serve strips spoofed incoming Tailscale identity headers before adding its own and recommends a localhost-only backend. Tagged-device and shared-user cases mean identity headers cannot be assumed universally present or sufficient for HostDeck authorization: `https://tailscale.com/docs/features/tailscale-serve`.
- Any process able to access the host loopback namespace can imitate headers. V1 therefore states the single-user host-local-process boundary explicitly: imitated identity cannot manufacture paired-device authority, while existing local-admin request forms remain a separate trusted-host policy. V1 does not claim local header provenance is cryptographically distinguishable.
- Tailscale normally establishes a direct encrypted device path and can fall back to peer relay/DERP when direct connectivity is unavailable: `https://tailscale.com/docs/reference/connection-types` and `https://tailscale.com/docs/reference/derp-servers`.

These sources support the architecture choice, not the exact implementation contract. CLI JSON shape, permissions, profile-scoped Serve persistence, header/origin behavior, SSE behavior, consent, ownership-safe mutation, and target-device switching remain deliberately blocked on `IFC-V1-070`.

## Planning And Backlog Changes

- Updated product owners: end goal, roadmap, PRD, requirements, UX, architecture, implementation blueprint, test plan, and decision log.
- Reopened only changed capability outcomes: contracts/fixtures, durable remote state/audit, host interface/security, mobile remote states, and release proof.
- Added foundation leaves `FND-V1-018` and `FND-V1-092`.
- Added storage leaves `DAT-V1-031`, `DAT-V1-032`, and `DAT-V1-092`.
- Added remote interface spike/implementation/acceptance leaves `IFC-V1-070` to `IFC-V1-079`.
- Rebased unfinished frontend and release leaves around remote/profile/Serve state, QR pairing, no custom CA, and no-LAN-route phone proof.
- Deferred `IFC-V1-033`; preserved prior direct-LAN evidence without treating it as selected-path proof.
- Made `IFC-V1-070` the first ready task. Implementation cannot start by guessing Tailscale behavior.

## Validation

- `pnpm check:planning`: pass; checker tests pass and the graph reports 212 tasks, 84 requirements, 649 dependencies, and 17 queued leaves.
- `pnpm check:scaffold`: pass; 9 packages and 18 root scripts.
- `pnpm lint`: pass; Biome checked 336 files and all 9 package export checks pass.
- `pnpm typecheck`: pass.
- `git diff --check`: pass.
- Selected-path stale-reference scan: no remaining `remote configure`, stale custom-CA readiness, impossible local-header provenance, or phone-profile diagnosis claims.
- Manual dependency/architecture review: no cycle; `IFC-V1-070` remains the first ready remote leaf; remote contracts, storage, adapter, trust, pairing, lifecycle, mobile visual gate, module hardening, and release proof remain dependency ordered. The review explicitly corrected the host-local loopback trust boundary, pre-app phone network failures, read-only status audit ownership, no-auto-repair policy, and fail-closed disable behavior.

No product code, dependency, setup guide, or command reference changed in this rebaseline. Those owners change only after the spike and implementation prove real behavior.
