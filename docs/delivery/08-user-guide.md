# User Guide

This guide covers the selected HostDeck V1 workflow: an Ubuntu laptop runs Codex
and HostDeck, while an Android phone reaches the phone-first browser dashboard
through private Tailscale Serve HTTPS. V1 is a responsive web app, not a native
Android application.

Exact copy-paste commands live in
`docs/delivery/11-command-reference.md#installed-user-workflow`.
For the shortest phone setup, use `docs/delivery/12-quick-connect.md`.

## Supported Setup

| Part | V1 requirement |
| --- | --- |
| Laptop | Ubuntu 24.04/Linux x86-64, online and awake, with the current-user HostDeck services running. |
| Codex | Exact reviewed `codex-cli 0.144.0`. A different version leaves HostDeck in read-only compatibility diagnostics. |
| Private network | Tailscale 1.98.8 on the laptop and phone. Both must be signed into the same saved personal HostDeck profile while remote access is in use. |
| Company Tailscale use | A company profile may remain saved on the laptop, but only one profile is active at a time. HostDeck never switches profiles or changes company Serve state. |
| Phone | Android Chrome with Internet access through cellular or unrelated Wi-Fi and an active Tailscale VPN. USB is not needed for ordinary use. |
| Ingress | Private Tailscale Serve HTTPS only. Do not expose a router port, enable Funnel, install a custom CA, or use a laptop LAN address. |

The laptop may stay at home or at work while the phone is elsewhere. It must stay
powered, connected to the Internet, signed into the saved HostDeck Tailscale
profile, and running both HostDeck user services.

## First Setup

1. Install Tailscale separately on the laptop and phone. Save the personal
   HostDeck profile on the laptop and select it on both devices. Keep any company
   profile saved but inactive during HostDeck use.
2. From a verified HostDeck package, run `service install` with the absolute path
   to exact Codex 0.144.0. Installation verifies and publishes the package,
   installs `~/.local/bin/codexdeck`, and enables the HostDeck user unit without
   starting either service.
3. Run `service start`, then `status`. The Codex user service owns its private
   Unix socket, and HostDeck owns only its loopback listener. Startup does not
   expose remote access.
4. While the saved HostDeck Tailscale profile is active, run `remote enable`, then
   `remote status`. Continue only when it reports `Remote access: ready` and
   `Laptop action required: no`.
5. Run `pair --label "Android phone" --write`. Scan the local terminal QR once or
   privately open the exact `Open instead` link on the phone. The link is a
   short-lived, one-time credential; do not send it through chat, email, logs, or
   screenshots.
6. Chrome removes the link fragment before claiming it. Wait for the paired
   result, choose **Open Mission Control**, then reload once. A successful reload
   must remain paired without reusing the link.

Use `--read-only` instead of `--write` when a phone should monitor sessions but
never send commands. Paired devices expire after a bounded lifetime; the default
is 90 days. Create a new link when an authority expires or is revoked.

## Core Use

| Task | Phone workflow | Expected result |
| --- | --- | --- |
| Scan sessions | Open **Mission Control**. Review `ACT NOW`, `IN PROGRESS`, then `QUIET`; tap the full session row. | Attention work appears first and opens one immutable Session Detail target. |
| Send a prompt | In **Session Detail**, focus the prompt editor, enter the instruction, and choose **Send** once. | The editor stays above the keyboard and the turn moves through submitting, accepted, running, and terminal truth without automatic resend. |
| Change model | Open `/model`, select the model and effort, then confirm. | HostDeck distinguishes accepted selection from the model confirmed for the next turn. It does not send a prompt. |
| Manage the goal | Open `/goal`, review the objective and state, then choose the applicable set, pause, resume, complete, or clear action and confirm. | The exact selected-session goal changes only after accepted and terminal runtime evidence. |
| Change Plan mode | Open `/plan`, select the available mode, and confirm. | Plan state changes without starting a turn. Unsupported runtime choices remain disabled. |
| Inspect usage | Open session utilities, then **Usage**. | Bounded account, context, and rate information is read-only. |
| Compact context | Open session utilities, choose **Compact**, review the consequence, and confirm once. | Accepted, running, completed, interrupted, failed, and unknown outcomes stay distinct. |
| Inspect skills | Open session utilities, then **Skills**; use the local search when needed. | Complete, partial, empty, stale, and unavailable results remain labelled and bounded. |
| Respond to approval | Review the inline action, scope, reason, risk, and expiry; choose deny or the offered approval action. Confirm elevated consequences when asked. | One exact request is decided once. Expired, superseded, or unsupported requests become read-only. |
| Inspect event details | Open an eligible event's details. | HostDeck shows a bounded normalized projection and labels redacted, truncated, unknown, or replay-boundary limits. |
| Interrupt a turn | Open **Session actions**, choose **Interrupt**, review the exact turn and consequence, then confirm once. | The active turn is interrupted; the session and its files are not deleted. |
| Archive a session | Open **Session actions**, choose **Archive**, review the target, then confirm once. | The managed session leaves the active list. Archive does not delete project files or conversation history. |
| Resume on laptop | Open **Session actions**, choose **Resume on laptop**, and copy the exact command. Run it in a laptop terminal. | The normal Codex TUI resumes the same thread through the private Codex Unix socket that HostDeck observes. No terminal runs on the phone. |
| Review access | Open **Host and access**. | Connection, permission, expiry, page security, host compatibility, remote state, stream state, and paired devices remain separate. |
| Revoke a device | In **Host and access**, choose the revoke icon for the exact device and confirm. | That browser loses protected reads and writes immediately. Revoking this phone closes its current dashboard authority. |
| Lock remote writes | In **Host and access**, choose the host lock action and confirm. | Every paired phone becomes read-only. Monitoring remains available; unlock is laptop-only. |

Start a new managed session from the laptop with `codexdeck start`. To use an
existing eligible Codex CLI session, close its standalone client, run
`codexdeck discover`, then run `codexdeck adopt THREAD_ID --name NAME
--confirm-handoff`. Refresh Mission Control and use the adopted session normally.
Its Codex thread id and history remain unchanged; HostDeck stores only bounded
projection state. Use `codexdeck resume NAME` for the laptop TUI while managed, or
quiet the session and run `codexdeck unmanage NAME --confirm` to remove only its
HostDeck membership. The phone does not expose discovery, arbitrary path entry, or
a shell. Closing Chrome, losing phone network, or switching the laptop away from
the HostDeck profile does not cancel Codex work.

## Profile Switching

### Use the company profile

1. Finish or observe any pending phone action before switching. Do not resend an
   action whose result is still unknown.
2. Switch the laptop to the already-saved company Tailscale profile using the
   Tailscale UI or `tailscale switch`.
3. HostDeck and Codex remain locally available, but the phone's private HostDeck
   address becomes unreachable. This is expected. HostDeck does not inspect,
   modify, or add Serve configuration on the company profile.

### Return to HostDeck

1. Switch the laptop back to the saved personal HostDeck profile. Make sure the
   phone is using that same profile and Tailscale shows connected.
2. Run `remote status` locally. If the exact previously enabled mapping is still
   verified, HostDeck returns to `ready` by observation only.
3. If status remains unavailable because the mapping is absent or changed, run
   `remote enable` explicitly while the HostDeck profile is active.
4. Reopen or refresh the existing fragment-free dashboard. A non-expired,
   non-revoked phone remains paired; no new QR scan is required.

## Safe Shutdown And Removal

To stop remote use while preserving the installation, switch to the HostDeck
profile, run `remote disable`, verify remote status is disabled, then run
`service stop`. `remote disable` removes only the exact HostDeck-owned Serve
mapping.

Before uninstalling, disable remote access while HostDeck is still running, then
stop and uninstall the service. Uninstall removes HostDeck-owned releases, units,
and command anchors but deliberately does not alter Tailscale, saved profiles,
Serve configuration it cannot prove it owns, Codex authentication, or preserved
HostDeck user data.

## Troubleshooting

| Problem | What to do | Boundary |
| --- | --- | --- |
| Chrome says the site cannot be reached | Confirm the laptop is awake and online, then check `service status`, laptop `tailscale status`, and `remote status`. Confirm the phone is connected to Tailscale under the same HostDeck profile. | A fresh unreachable page cannot diagnose HostDeck; it is a browser/Tailscale network failure until the private origin responds. |
| `remote status` reports `profile_other` | Switch the laptop locally to the saved HostDeck profile, then check status again. | HostDeck never switches profiles automatically and never names or mutates the active company profile. |
| Tailscale is stopped, signed out, absent, or unsupported | Start Tailscale or sign in locally on the affected device. | HostDeck does not own Tailscale installation, login, daemon state, or phone VPN state. |
| Remote access is disabled or Serve is absent | With the dedicated profile active and HostDeck running, run `remote enable`, then confirm `remote status` is ready. | There is no automatic Serve repair. |
| Status reports Serve drift, collision, public exposure, foreign ownership, or incomplete cleanup | Inspect `tailscale serve status --json` locally. Change only a mapping whose ownership you know, then run `remote enable` again. Escalate rather than resetting unrelated Serve state. | Do not use `tailscale serve reset`, Funnel, a router port, LAN fallback, or a certificate workaround. |
| Chrome shows a certificate warning | Stop. Verify that the address came from the current HostDeck pairing output and is the private `https://...ts.net` Serve origin. | HostDeck V1 requires browser-trusted Serve HTTPS. Never install a HostDeck CA or bypass the warning. |
| QR scanning is inconvenient or fails | Use the exact `Open instead` link shown by the same local `pair` command and open it privately on the phone. | The link is equivalent to the QR and must not be retained or shared. |
| Pairing link is expired, invalid, or already used | Run `pair` again locally and open the new link once. | A one-time claim is never retried in place and protected data stays hidden before success. |
| Pairing succeeded but the page later became unreachable | Restore the laptop and phone to the HostDeck Tailscale profile and check remote status. Refresh the existing clean URL after reachability returns. | Do not create a new link unless authority actually expired or was revoked. |
| Phone is read-only | Check whether the phone was paired with `--read-only` or the host is locked. Pair with explicit write permission when intended, or unlock locally if locked. | Read-only, locked, expired, and revoked are separate states. |
| Page security setup failed | Reload the clean dashboard URL once so the existing device cookie can bootstrap fresh page protection. | Do not reopen or replay the consumed pairing fragment. If the device is revoked or expired, create a new link. |
| Host is locked | On the laptop, run `codexdeck unlock`, then let the phone refresh current state. | Remote unlock is intentionally unavailable. No queued phone mutation crosses the lock transition. |
| Session state is stale or the activity stream is reconnecting | Wait for `Current` truth or use the offered safe refresh. Observe the result before sending another mutation. | HostDeck does not auto-resend prompts, controls, approvals, interrupts, archives, or device actions. |
| A mutation result is unknown | Reopen or refresh the relevant state and determine whether the requested change occurred. | Unknown post-dispatch outcomes are not retry permission. |
| Host compatibility says update required or incompatible | Verify the installed service uses exact Codex 0.144.0. Install or select the reviewed binary, then restart the HostDeck service and recheck status. | HostDeck does not emulate unsupported commands or dispatch through a different Codex version. |
| No sessions appear | Start a managed session with `codexdeck start --name ... --cwd ...`, or close an eligible standalone Codex CLI session and adopt its exact id with `codexdeck discover` followed by confirmed `codexdeck adopt`. Then refresh Mission Control. | Discovery and adoption are laptop-only. V1 has no phone file picker, shell, arbitrary working-directory input, transcript copy, or concurrent standalone-client takeover. |
| Resume command cannot be copied | Confirm the page is on trusted HTTPS and allow the browser's clipboard action, then reopen **Resume on laptop**. | The command is a laptop-only handoff and may contain a private socket/thread target; do not retain it in screenshots or support logs. |
| Phone is lost or no longer trusted | On the laptop, list devices, identify the exact bounded device id, and run confirmed revoke. Lock remote writes first when immediate global containment is needed. | Tailscale membership alone is not HostDeck authorization. |
| Laptop sleeps, shuts down, or loses Internet | Wake and reconnect the laptop, start the user service if needed, restore the HostDeck profile, and check remote status. | V1 has no hosted relay; Codex work cannot be reached while the laptop is offline. |

## Privacy And Safety

- Tailscale grants private network reachability, not HostDeck application access.
  Every browser still requires a bounded read-only or read/write pairing authority.
- Pairing links, cookies, and page-protection values are credentials. HostDeck stores
  server-side pairing and device secrets only as hashes, but users must still avoid
  sharing links, browser profiles, or screenshots containing session content.
- The pairing fragment is removed before the browser claim. Normal reloads use the
  clean origin and paired cookie; bookmarks must never contain a fragment.
- The dashboard exposes structured session projections and bounded diagnostics. It
  is not an SSH terminal, raw Codex app-server client, file browser, editor, Git
  review tool, or Tailscale administration console.
- HostDeck binds only to `127.0.0.1`. Tailscale Serve supplies private HTTPS. V1 has
  no Funnel, public listener, direct-LAN/custom-CA mode, router configuration, or
  cloud relay.
- Device revoke removes one phone's authority. Host lock closes all remote writes.
  Neither action stops Codex work; unlock remains a deliberate laptop action.

## V1 Limitations

- Android Chrome is the physically qualified phone client. The responsive browser
  UI is not an installable native Android or iOS app.
- The phone must run Tailscale and use the same saved HostDeck profile as the
  laptop. Simultaneous HostDeck and company profiles are not supported.
- The laptop must remain awake, online, and running HostDeck. V1 has no relay,
  push notifications, background phone service, or offline command queue.
- HostDeck V1 supports exact Codex 0.144.0 only. Version drift is diagnostic and
  read-only until a reviewed compatibility update is shipped.
- V1 does not provide remote unlock, automatic profile switching, automatic Serve
  repair, voice, bulk operations, a mobile terminal, file editing, or Git diff UI.

## Evidence

- Package and current-user lifecycle:
  `artifacts/ifc-v1-058-clean-environment-parity.md`.
- Private Serve, profile switching, pairing, lock, recovery, and cleanup:
  `artifacts/ifc-v1-079-remote-ingress-acceptance.md`.
- Production phone pairing and host/access UI:
  `artifacts/fe-v1-013-pairing-host-access.md`.
- Phone profile-away and observation-only return:
  `artifacts/fe-v1-034-remote-connection-recovery.md`.
- Complete screen/control/copy contract:
  `artifacts/fe-v1-018-copy-workflow-review.md`.
