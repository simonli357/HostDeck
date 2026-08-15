# IFC-V1-113 Ubuntu Shared-Runtime Package

Status: passed

## Candidate

- Ubuntu 24.04 x64 package schema 6; version `0.0.3`.
- Exact Codex `0.147.0`; binding tree `673c02b5a758e082cb02c15f36bf4f37e88501470fd430ad232bebd754e8689c`.
- Source closure commit `0ea369b820b90bf7e2d821202a214980e4bd3759`; 664 sources, 1,335 owned outputs, 6,361 entries.
- Package SHA-256 `eaca440f4029f6131bf118b1f333a9ebea07e410acb9eba8a18e62d1f27ba9db`; web SHA-256 `184ff62f0c197d20dab8d2c9c6aee458089cded017a5b0631f30e764c857c556`.
- Bundled Node `22.22.2`/ABI `127`, native modules, verified Vite assets, launcher, broker host, service host, and separate systemd user units.

## Result

- Broker and HostDeck use independent lifecycle owners over `$CODEX_HOME/app-server-control/app-server-control.sock`.
- HostDeck stop/restart preserves the broker and ordinary Codex clients; explicit broker stop is owner-checked.
- Foreground, packaged service-host, and real user-manager unit flows recover from broker or HostDeck replacement without alternate sockets or fallback runtimes.
- Installer/upgrade/rollback/uninstall contracts preserve state and foreign files, retain only verified releases, and remove only owned lifecycle/program paths.
- `DEC-033` selects keyless GitHub Artifact Attestations for public Ubuntu archives. The first live tagged attestation and release promotion remain `REL-V1-110` evidence.
- Quick-connect and operator docs now use broker start plus ordinary `codex`/`codex resume NATIVE_UUID`; discover/adopt/unmanage is removed.

## Validation

| Gate | Result |
| --- | --- |
| Runtime compatibility | Exact model, command, token-usage, rate-limit, ordinary-TUI coexistence, shared turn, two teardown orders, privacy, and cleanup passed; evidence is bound to `31adce4` in `artifacts/int-v1-031-hostdeck-tui-coexistence-evidence.json`. |
| Workspace | Typecheck passed; lint checked 929 files; unit passed 294 files and 3,279 tests with 30 files/32 tests intentionally device-gated. |
| Package | `pnpm test:package` passed 43 checks plus two deterministic builds, read-only relocation, rollback, and runtime/config/static/web/native/tamper rejection. Independent verifier passed the candidate identity above. |
| Browser | Relocated read-only packaged Chromium passed `1/1` with strict API/static/browser policy. |
| Lifecycle | Packaged executable, service-host, and systemd user-unit smokes passed exact 0.147.0. The user-manager run covered independent restart/stop recovery, explicit owner-safe broker stop, lease exclusion, security score `9.7/9.7`, Tailscale noninterference, and zero persistent manager state. |
| Supply chain | Six supply-chain tests passed real-package deterministic checksum/license/CycloneDX/provenance generation and independent verification plus graph, license, target, checksum, privacy, and tamper failures. |

## Manual Inspection

- Manifest target/runtime/Codex/native-module/launcher/service identities and package/web hashes agree.
- Evidence contains no PID, path, socket identity, thread/turn id, prompt, model output, TUI output, or authentication material.
- No test-owned process, socket, user unit, or temporary manager state remained.

## Remaining Release Gates

- `FE-V1-108`: one immutable installed candidate on unrelated-network Android/Tailscale with bidirectional ordinary-TUI/phone activity and HostDeck restart continuity.
- `REL-V1-110`: clean Ubuntu install-to-uninstall aggregate, tagged archive, live `DEC-033` attestation, release metadata, and candidate freeze.
