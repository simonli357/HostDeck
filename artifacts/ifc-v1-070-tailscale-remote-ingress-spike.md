# IFC-V1-070 Tailscale Remote Ingress Spike

Date: 2026-07-13

Status: complete; exact profile, Serve, proxy, SSE, permission, lifecycle, cellular-phone, coexistence, and cleanup rows pass for the pinned versions below.

## Scope

Freeze the real Tailscale boundary that HostDeck V1 may observe and control before implementing remote-ingress contracts or product commands. The spike used one human-authorized saved HostDeck profile, one pre-existing saved other profile, a physical Android phone, an ephemeral loopback HTTP probe, and an isolated in-memory daemon for destructive login/logout evidence.

This spike does not implement the observer, Serve manager, proxy trust gate, app pairing, production UI, service packaging, or release acceptance.

## Verdict

- The selected direction works when the laptop and phone are on different networks. A physical Android browser reached private Serve HTTPS over cellular while laptop LAN routing was absent.
- No custom CA, public listener, Funnel, router change, HostDeck relay, or laptop LAN bind is required.
- Saved HostDeck and other profiles coexist with exactly one selected at a time. HostDeck Serve state is profile-scoped and survives profile switching plus `tailscale down`/`tailscale up`.
- The local backend sees Serve through loopback HTTP. Tailscale terminates trusted HTTPS and supplies exact external Host, forwarding, and identity metadata.
- Serve strips and replaces the documented `Tailscale-User-*` headers and the tested `X-Forwarded-*` headers. Browser-supplied `X-Tailscale-*` lookalikes survive unchanged and are untrusted input.
- Tailnet membership and identity remain connectivity/source context only. HostDeck pairing, device permission, CSRF, lock, and audit remain mandatory.
- V1 needs HTTP request/response plus SSE. No WebSocket transport is required.
- The supported release tuple is exact Tailscale 1.98.8 on the tested Ubuntu and Android clients. Version or required JSON/header-shape drift makes remote access unavailable until compatibility evidence is rerun; it never selects LAN, public, custom-CA, or blind-command fallback.

## Harsh Success Criteria

All rows passed:

- exact laptop, daemon, phone, browser, and platform versions recorded;
- absent, stopped, signed-out, dedicated-selected, and other-selected states observed with exit behavior;
- non-root operator can configure, inspect, selectively remove, and restore Serve;
- non-operator mutation is denied and leaves config unchanged;
- HTTPS consent, Funnel opt-out, trusted certificate, canonical origin, proxy source, and header behavior observed;
- normal, spoofed, long-lived, heartbeat, reconnect, and `Last-Event-ID` SSE behavior observed;
- phone path proved with Wi-Fi off, cellular plus VPN routes present, and no laptop-LAN route;
- manual profile switch made the phone path fail while loopback stayed healthy, then recovered without Serve reconfiguration;
- absent, exact, foreign/colliding, drifted, stopped, restarted, and logged-out states observed;
- exact path-scoped removal preserved a foreign mount;
- original profile metadata and Serve state remained semantically unchanged;
- Serve, Funnel, listener, radio, temporary node, UI dump, and filesystem cleanup passed.

## Pinned Environment

| Component | Exact evidence |
| --- | --- |
| Laptop | Ubuntu 24.04.4 LTS, kernel `6.17.0-35-generic`, amd64 |
| Tailscale package | Debian package `1.98.8`; `/usr/bin/tailscale` |
| Tailscale client/daemon build | `1.98.8`, long version `1.98.8-t1241b225b-g0520dfda5`, Tailscale commit `1241b225bc798707d02db3570992625d3a16594f`, Go `1.26.3` Tailscale build |
| `tailscaled` service | systemd active and enabled |
| Probe runtime | Node `v22.22.2` |
| Phone | Xiaomi 15 Pro, model `2410DPN6CC`, Android 16/API 36, security patch `2026-06-01` |
| Android Tailscale | package `com.tailscale.ipn`, `1.98.8-t1241b225b-gbcbaf1889`, version code `626` |
| Android browser | Chrome `150.0.7871.114`, version code `787111433` |

Account, tailnet, profile, node, DNS, Tailscale IP, public key, login URL, and identity-header values were inspected only in memory and are intentionally absent here.

## Frozen Read Contract

### Commands

The observer implementation may wrap only bounded, absolute-path equivalents of these reads:

```text
/usr/bin/tailscale version
/usr/bin/tailscale status --json
/usr/bin/tailscale switch --list --json
/usr/bin/tailscale serve status --json
/usr/bin/tailscale funnel status --json
```

`tailscale status --json` on 1.98.8 exposed these root keys:

```json
[
  "AuthURL",
  "BackendState",
  "CertDomains",
  "ClientVersion",
  "CurrentTailnet",
  "HaveNodeKey",
  "Health",
  "MagicDNSSuffix",
  "Peer",
  "Self",
  "TUN",
  "TailscaleIPs",
  "User",
  "Version"
]
```

`tailscale switch --list --json` returned an array whose exact item keys were:

```json
["account", "id", "nickname", "selected", "tailnet"]
```

The raw status/profile payload contains private identity, DNS, address, key, and account material. Product logs, errors, audits, API output, and durable fixtures must never retain it. The parser must project only the strict normalized fields owned by `FND-V1-018` and reject unknown required shapes or contradictory selections.

Post-implementation live validation found that exact 1.98.8 routes both `serve status --json` and `funnel status --json` through the same ServeConfig status implementation. Private Serve therefore makes both JSON reads nonempty and semantically identical; `AllowFunnel` is the public-exposure field. The observer retains both commands as bounded consistency reads, requires their parsed snapshots to agree, and fails closed on disagreement. This correction is tracked as `BUG-008`.

### State And Exit Matrix

| State | Command evidence | Frozen interpretation |
| --- | --- | --- |
| CLI absent | `command -v tailscale` under an empty `PATH` exited `1`; direct invocation exited `127`. | `not_installed`; do not invoke another command or choose a fallback. |
| Signed out | Isolated 1.98.8 daemon `status --json` exited `0` with `BackendState: "NeedsLogin"`; `Self` remained present, `CertDomains` was empty, and Serve status was `{}`. | Key on `BackendState`, not exit code or `Self` presence. |
| Logged out transition | A temporary in-memory node reached `Running`; `tailscale logout` exited `0`; subsequent status exited `0` with `NeedsLogin`, omitted `HaveNodeKey`, and had empty Serve state. | HostDeck observes this state but never invokes login/logout. |
| Stopped | Real dedicated profile `status --json` exited `0` with `BackendState: "Stopped"`, retained profile/peer/certificate metadata, and reported one health entry. Serve status still returned the persisted config. | Key on `BackendState`; retained metadata does not mean remote ready. |
| Dedicated selected | Two saved profiles, exactly one selected; `BackendState: "Running"`; health empty. | Continue exact profile and Serve comparison. |
| Other selected and stopped | Manual non-root switch selected the saved other profile but the switch command exited `1` with `Tailscale is stopped.` | Selection changed despite nonzero exit. Product never switches; any operator tooling must read back state after a manual command. |
| Unknown/version drift | Not synthesized as success. | Strict parse/version failure maps to bounded unsupported remote state while local HostDeck remains healthy. |

`Self`, `Peer`, `CurrentTailnet`, `User`, `AuthURL`, `CertDomains`, profile ids, account, and tailnet values are sensitive inputs. Their presence is not an authorization signal.

## Saved-Profile Coexistence

- The laptop ended with two saved profiles and exactly one selected: the dedicated `HostDeck` profile.
- Before and after snapshots proved the other profile's account, tailnet, nickname, and empty Serve state semantically unchanged.
- The other profile was already saved in stopped state. Selecting it manually did not start it or alter Serve.
- While the other profile was selected, the HostDeck URL produced a physical phone browser network error after timeout, the probe received no request, and direct loopback HTTP continued to return `200`.
- Switching back manually selected HostDeck, restored `BackendState: "Running"`, restored the exact persisted Serve descriptor without another Serve command, and made the phone probe pass again.
- `tailscale down` made remote HTTPS unavailable while the loopback probe stayed healthy. `tailscale up` restored the exact descriptor and HTTPS with no health entries.
- HostDeck product code must never run `login`, `logout`, `switch`, `up`, `down`, systemd control, or nickname/account mutation.

## Serve Contract

### Exact Owned Descriptor

With the probe active, the redacted 1.98.8 Serve status was structurally:

```json
{
  "TCP": {
    "443": {
      "HTTPS": true
    }
  },
  "Web": {
    "<redacted-node>.<redacted-tailnet>.ts.net:443": {
      "Handlers": {
        "/": {
          "Proxy": "http://127.0.0.1:43170"
        }
      }
    }
  }
}
```

The production port is not frozen by this probe. The ownership tuple is exact active dedicated profile comparison, canonical external DNS authority, HTTPS port 443, root path `/`, and the current HostDeck loopback target selected by production startup.

### Allowed Mutations

These 1.98.8 forms passed as the configured non-root operator:

```text
tailscale serve --bg http://127.0.0.1:<port>
tailscale serve status --json
tailscale serve --https=443 --set-path=/ off
```

- `--bg` persisted across profile switch and `down`/`up`.
- Path-scoped root removal deleted `/` while preserving a separately configured `/foreign` handler byte-for-byte at the semantic JSON level.
- A second path was then removed with `tailscale serve --https=443 --set-path=/foreign off`, leaving `{}`.
- `tailscale serve reset` also produced `{}` during the controlled spike, but production HostDeck must not use broad reset because it can delete foreign state.
- Product mutation is allowed only after a plan proves absent state for enable or an exact HostDeck-owned root mapping for disable. Every apply/remove requires strict read-back.

### Absent, Foreign, Collision, And Drift

| State | Probe | Required product result |
| --- | --- | --- |
| Absent | Serve status `{}`. | Explicit local enable may add the exact root descriptor. |
| Exact | One HTTPS 443 listener and one root proxy to the expected loopback target. | Ready only when durable intent/profile generation also match. |
| Collision | Root plus `/foreign` produced two handlers. | Refuse enable/repair; preserve foreign state. Exact owned root disable may remove only `/`. |
| Drift | Root target changed to unused loopback port `43171`; remote request returned `502` while the real loopback probe stayed healthy. | Unavailable/ownership conflict; no automatic overwrite or removal. |
| Public/Funnel | `AllowFunnel` is absent for private Serve and present for Funnel. Both exact 1.98.8 JSON status commands return the same full ServeConfig rather than separate Serve/Funnel projections. | Any `AllowFunnel` field is a hard conflict; disagreement between the duplicate reads fails closed; HostDeck never invokes a Funnel mutation. |

### HTTPS Consent

- The first Serve command did not apply until tailnet HTTPS consent completed.
- The web consent UI selected HTTPS and Funnel by default. Funnel was explicitly unchecked before consent.
- After consent, exactly one certificate domain existed, Serve was private, and `AllowFunnel` was absent. Later implementation validation established that the `funnel status --json` alias returns that same private ServeConfig rather than an empty Funnel-only projection.
- Product automation must not click or script consent, enable HTTPS policy, or accept Funnel. It reports a bounded local consent-required state, requires human action, and requires a fresh explicit enable/read-back afterward.

## Proxy And Header Evidence

The backend listener was exactly `127.0.0.1:43170`; `ss -ltnp` found no wildcard or LAN probe listener. Serve connected to it from loopback.

| Observation | Physical/browser result | Frozen handling |
| --- | --- | --- |
| Browser origin | `https://<redacted>.ts.net/`, no explicit port; trusted by Chrome with no interstitial. | One canonical external HTTPS origin. |
| Backend socket | Loopback remote address. | Necessary Serve shape but not cryptographic proof against another local process. |
| `Host` | One external Tailscale DNS authority. | Must match configured authority exactly. |
| `X-Forwarded-Proto` | One value, `https`; spoofed incoming `http` was replaced. | Require exactly one `https`. |
| `X-Forwarded-Host` | One external Tailscale DNS authority; spoofed host was replaced. | Require exact configured authority. |
| `X-Forwarded-For` | One Tailscale CGNAT-class address; spoofed documentation address was replaced. | Parse only after admitted Serve shape; project a privacy-safe source key, never raw public output. |
| Identity names | `Tailscale-Headers-Info`, `Tailscale-User-Login`, `Tailscale-User-Name`, and `Tailscale-User-Profile-Pic`. | Exact standard names are optional bounded context, sensitive, and never app authorization. |
| Standard identity spoof | Browser-supplied `Tailscale-User-Login` and `Tailscale-User-Name` sentinels did not survive; Serve supplied one real value for each. | Matches official stripping behavior for the standard names. |
| Lookalike spoof | Browser-supplied `X-Tailscale-User-Login` and `X-Tailscale-User-Name` survived alongside the real standard headers. | Reject or ignore as reserved untrusted lookalikes; never merge by substring/prefix. |
| Same-origin POST | One exact HTTPS `Origin` and external HTTPS `Referer`. | Mutations still require exact Origin, paired cookie, CSRF, permission, and lock checks. |
| Direct loopback request | No forwarding or Tailscale headers. | Preserve separate explicit local-admin request forms. |

Official documentation guarantees stripping for the exact standard `Tailscale-User-*` names, not arbitrary `X-Tailscale-*` variants. The implementation must use exact case-insensitive names and cardinality, not suffix, prefix, substring, or generic proxy trust.

Another process running as the HostDeck OS user can call loopback and imitate headers. V1's documented single-user host-local-process boundary therefore remains necessary: proxy metadata cannot manufacture a paired device, permission, CSRF generation, or local-admin authority.

## Physical Android And Stream Matrix

USB-C/ADB was used only to control and inspect the physical test device. Browser traffic used the phone network stack.

| Row | Evidence | Result |
| --- | --- | --- |
| Cellular-only path | Phone Wi-Fi setting `0`; no Wi-Fi route; active cellular and VPN routes; telephony data connected; laptop saw Android peer online. | Pass; no laptop-LAN route. |
| TLS | Chrome loaded private HTTPS without a custom CA or certificate warning; laptop curl reported HTTP `200` and TLS verify result `0`. | Pass. |
| Normal SSE | EventSource opened and received three events. | Pass. |
| Heartbeat soak | One cellular EventSource stayed open for 65 seconds, receiving 65 heartbeat events and 16 data events with no error. | Pass across the one-minute boundary. |
| Reconnect | Server closed after event id `1`; browser emitted the expected intermediate error, reopened, sent exactly one `Last-Event-ID`, and received id `2`; open count was two. | Pass. |
| Profile away | Other laptop profile selected; phone reached browser network error; backend saw no request. | Pass. |
| Profile return | Dedicated profile reselected; same cellular phone completed HTTPS, spoof, heartbeat, and reconnect probes. | Pass without Serve reapply. |
| Cellular connection type | Three Tailscale pings used DERP; HTTPS/SSE still passed. | Pass; relay affects performance, not selected security semantics. |
| Restored Wi-Fi connection type | After restoring original radios, Tailscale ping established a direct path. | Pass; both direct and DERP observed. |

No WebSocket endpoint or dependency is required for V1. Request/response plus EventSource covered the selected browser behavior, heartbeat, and reconnection contract.

## Permissions And Failure Behavior

- `sudo tailscale set --operator=<current-user>` established the supported non-root operator. The operator could inspect, configure, selectively remove, reset during controlled cleanup, switch manually during the spike, and run `down`/`up`.
- Adding the new saved profile required privileged/human-authorized setup. Product runtime does not own profile creation or authentication.
- A different non-operator OS user could read Serve status but an idempotent Serve mutation exited `1` with daemon permission denial. Before/after Serve JSON was unchanged.
- Raw read output is therefore locally accessible beyond the operator and must still be treated as sensitive input.
- Signed-out Serve configuration exited nonzero. Missing login, stopped state, permission denial, consent requirement, timeout, nonzero command with changed selection, malformed/oversized output, and post-command profile change all need distinct bounded results.
- Command exit alone is insufficient. Every operation plans from a strict snapshot and verifies authoritative state after execution.

## Cleanup And Noninterference

Final inspection passed:

- dedicated HostDeck profile selected; two saved profiles; exactly one selected;
- real daemon `Running`, health empty;
- other profile account/tailnet/nickname snapshot unchanged and its Serve state remained empty;
- HostDeck Serve status `{}` and Funnel status `{}`;
- no listener on probe port `43170`;
- temporary HTTP script/process, isolated daemon state, ephemeral logged-out node, auth/UI dumps, screenshots, and phone-side probe files removed;
- phone Wi-Fi restored on, mobile data restored off, Tailscale online, and phone returned to the home screen;
- no custom HostDeck CA was installed or required for this path;
- repository worktree was clean before evidence documentation began.

No screenshot is retained because the browser and consent surfaces contained private tailnet-derived identity. UI hierarchy was reduced to pass/fail booleans and deleted immediately.

## Downstream Contract

1. `FND-V1-018` owns strict normalized states and redacted fixtures for absent, stopped, signed-out, dedicated, other, unknown, exact, absent, collision, drift, consent-required, permission-denied, and public/Funnel conflict.
2. `IFC-V1-071` is read-only. It uses absolute executable resolution, exact 1.98.8 shape/version policy, bounded output/time/environment, strict schema parsing, and no raw-output exposure.
3. `IFC-V1-072` may run only the frozen Serve configure/status/path-scoped-off forms after explicit local CLI intent. It never calls broad reset in production and never invokes Funnel, profile, daemon, service, or login commands.
4. Enable accepts only absent state on the exact selected dedicated profile. Disable removes only an exact owned root descriptor. Collision, drift, ambiguity, profile change, partial result, or public state fail visibly without repair.
5. Consent is human-owned. HostDeck reports it, never automates it, and requires explicit retry plus read-back.
6. `IFC-V1-073` admits only exact external authority, scheme, forwarding cardinality, and frozen standard header names. `X-Tailscale-*` lookalikes are untrusted. No global `trustProxy` is permitted.
7. Tailscale identity remains optional source context. Pairing/device auth, CSRF, permission, lock, rate limits, target validation, and audit remain HostDeck-owned.
8. Remote health is independent of local runtime health. Stop, logout, other profile, consent, missing/drifted Serve, command failure, and client network loss cannot stop local Codex work.
9. Startup and profile return observe only. They never switch, enable, repair, or remove Serve automatically.
10. Any Tailscale version or required shape drift fails remote closed and reopens compatibility evidence. It does not activate a LAN/public/custom-CA fallback.

## Validation Summary

| Inspection | Result |
| --- | --- |
| Version/platform/package inventory | Pass; exact tuple above. |
| Absent/stopped/signed-out/logout/dedicated/other states | Pass; exact exit and read-back semantics recorded. |
| Non-root operator and non-operator denial | Pass. |
| Serve configure/status/persistence/path-scoped removal | Pass. |
| Absent/exact/collision/drift/Funnel states | Pass. |
| HTTPS consent and public Funnel opt-out | Pass. |
| Header/cardinality/spoof/source probe | Pass; `X-Tailscale-*` finding frozen. |
| Physical cellular Chrome TLS/request/SSE | Pass. |
| 65-second heartbeat and EventSource reconnect | Pass. |
| Physical profile away/error/return | Pass. |
| `down`/`up` and isolated live logout | Pass. |
| Direct and DERP observation | Pass. |
| Radio/profile/Serve/Funnel/listener/temp cleanup | Pass. |

Repository planning, formatting, type, and diff validation is recorded in the closure commit.

## Primary References

- Tailscale Serve and identity-header behavior: <https://tailscale.com/docs/features/tailscale-serve>
- `tailscale serve` command, JSON status, path-scoped `off`, and restart persistence: <https://tailscale.com/docs/reference/tailscale-cli/serve>
- Fast user switching and one active account: <https://tailscale.com/docs/features/client/fast-user-switching>
- Linux operator permission: <https://tailscale.com/docs/reference/troubleshooting/linux/linux-operator-permission>
- Serve versus public Funnel: <https://tailscale.com/docs/features/tailscale-funnel>
- Direct and DERP connection semantics: <https://tailscale.com/docs/reference/connection-types>

These official references support the feature contract. The exact 1.98.8 JSON, exit, consent, spoof, SSE, Android, profile, and cleanup behavior above comes from this target-device spike.
