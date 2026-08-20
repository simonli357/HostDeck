# FE-V1-108 Shared-Session Phone Acceptance

Status: passed on 2026-08-20

## Candidate

- HostDeck `0.0.20`; release `0.0.20-05817c7853eb79e2ddfeb8dadc555f241f7982125f6070a3c2717724962ff169`.
- Package SHA-256 `2bd48548a01688926a2e3ded95ca134e784b5471838b4dbfcec83c4a2c49521e`; web SHA-256 `090f267e9600beadc04dd825368445871ae7b6a8af29de11b77b1d59f73175c1`.
- Exact Codex `0.148.0`; implementation through `7406f7c` on `feat/shared-codex-runtime`.

## Environment

- Laptop: Ubuntu 24.04 x64.
- Phone: Xiaomi 15 Pro, Android 16, Chrome `151.0.7922.137`.
- Product transport: private Tailscale Serve HTTPS over cellular with phone Wi-Fi disabled. ADB/CDP was used only for deterministic inspection and input, never as product transport.
- Existing paired browser authority survived reloads, package upgrades, and service restart without another QR claim.

## Physical Result

| Flow | Result |
| --- | --- |
| Ordinary start | A fresh `codex --no-alt-screen` TUI auto-enrolled after its first turn and appeared in Mission Control without refresh. |
| Bidirectional work | Laptop turn `V020_START_OK` streamed to Session Detail. A phone prompt reached that same ordinary TUI and `V020_PHONE_OK` streamed back live. |
| Native resume | Stock `codex --no-alt-screen resume <native-uuid>` restored the exact laptop and phone transcript. |
| HostDeck restart | HostDeck PID changed while shared broker PID `1470166` and the resumed TUI remained alive. The phone stayed rendered, showed the restart boundary, recovered its composer, and completed `V020_RESTART_OK` in the same TUI. |
| Live catalog | The final archive was accepted once; Mission Control removed the exact row without refresh 60 ms after CLI completion, below the two-second criterion. |
| Failure handling | No blank root, terminal stream error, duplicate prompt, retry of a mutation, stale selected detail, or unrelated session removal occurred. |

Focused regressions passed for delayed enrollment, transient Serve errors, repeated replay boundaries, event/interrupt consumers, and exact-session catalog removal. The deterministic production package built and installed before the immutable run.

## Cleanup

- The acceptance TUI exited, its native thread was archived once, and it is absent from the active catalog.
- The temporary root was removed; phone Wi-Fi was restored; the temporary ADB CDP forward was removed.
- HostDeck remains `ready` on `0.0.20`; shared broker PID `1470166` is unchanged. No unrelated session was archived or modified.

## Remaining Gate

`REL-V1-110` owns the clean Ubuntu aggregate, install-to-uninstall release acceptance, and candidate freeze.
