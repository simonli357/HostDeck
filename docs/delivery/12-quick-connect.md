# Connect Your Phone

HostDeck is a browser app. The laptop runs HostDeck and Codex; Android Chrome
connects through private Tailscale HTTPS. USB is needed only for debug automation.

## Connect

1. Select the saved personal HostDeck Tailscale profile on both devices. Leave
   any company profile saved but inactive.
2. On the laptop, start HostDeck and enable its private Serve route:

```bash
~/.local/bin/codexdeck broker start
~/.local/bin/codexdeck service start
~/.local/bin/codexdeck remote enable
~/.local/bin/codexdeck remote status
```

Continue only when `remote status` reports `Remote access: ready` and
`Laptop action required: no`.

3. Create one phone authority:

```bash
~/.local/bin/codexdeck pair --label "Android phone" --write
```

Open the private one-time link in Android Chrome. Do not send or save that link.
After **Paired** appears, open Mission Control and reload once. Future use opens
the clean `https://...ts.net` address; no new pairing link or USB connection is
needed until the device expires or is revoked.

The laptop must remain awake, online, on the HostDeck Tailscale profile, and
running both the broker and HostDeck services. Never enable Funnel, expose a
router port, install a custom CA, or use the laptop's LAN address.

## Use HostDeck

Start Codex normally in a project, or resume an existing native session:

```bash
cd /absolute/path/to/project
codex
# Later, from any laptop terminal:
codex resume NATIVE_CODEX_UUID
```

The same session appears in Mission Control automatically. Open the saved
HostDeck address on the phone, tap the session, write a prompt, and tap Send.
Phone and laptop activity stay on the same Codex thread. Use `/model`, `/goal`,
and `/plan` for the main controls; the overflow menu contains the remaining
session tools.

USB is not needed for normal use. If switching to the company Tailscale
profile, first run `codexdeck remote disable`. When returning, select the saved
HostDeck profile on both devices and run `codexdeck remote enable`.
