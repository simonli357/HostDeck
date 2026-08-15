# IFC-V1-113 Ubuntu Shared-Runtime Package

Status: passed

## Candidate

- Ubuntu 24.04 x64 package schema 6; version `0.0.7`.
- Exact Codex `0.147.0`; binding tree `673c02b5a758e082cb02c15f36bf4f37e88501470fd430ad232bebd754e8689c`.
- Source closure commit `89d9ecad7d82f29841db81569999b7eac0e7d337`; 664 sources, 1,335 owned outputs, 6,361 entries.
- Package SHA-256 `edfde8bb4d51983e2e8cc4d3794477b594a03c477d143bdfd1905c85d6dcab62`; web SHA-256 `5b4bdf79107a040da87895b934e478a16ee617570a9e619800f240ed64e80890`.
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
| Runtime compatibility | Exact model, command, token-usage, rate-limit, ordinary-TUI coexistence, shared turn, two teardown orders, privacy, and cleanup passed. A real historical top-level thread resumed in ordinary Codex, refreshed its retained mapping, projected laptop activity, and accepted a HostDeck prompt in the same TUI without broker replacement. |
| Workspace | Typecheck passed; lint checked 933 files; unit passed 294 files and 3,282 tests with 30 files/32 tests intentionally device-gated. |
| Package | `pnpm test:package` passed 44 checks plus two deterministic builds, read-only relocation, rollback, and runtime/config/static/web/native/tamper rejection. Independent verifier passed the candidate identity above. |
| Browser | Relocated read-only packaged Chromium passed `1/1` with strict API/static/browser policy. |
| Lifecycle | Packaged executable, service-host, and systemd user-unit smokes passed exact 0.147.0. Preserved-state upgrade from `0.0.5` to `0.0.7` kept the broker PID and native thread identity, refreshed the retained mapping, and left the API ready. |
| Supply chain | Eight supply-chain/release-bundle tests passed deterministic archive, checksum/license/CycloneDX/provenance generation, independent real-package verification, and graph/license/target/checksum/privacy/tamper failures. |

## Manual Inspection

- Manifest target/runtime/Codex/native-module/launcher/service identities and package/web hashes agree.
- Evidence contains no PID, path, socket identity, thread/turn id, prompt, model output, TUI output, or authentication material.
- No test-owned process, socket, user unit, or temporary manager state remained.

## Remaining Release Gates

- `FE-V1-108`: one immutable installed candidate on unrelated-network Android/Tailscale with bidirectional ordinary-TUI/phone activity and HostDeck restart continuity.
- `REL-V1-110`: clean Ubuntu install-to-uninstall aggregate, tagged archive, live `DEC-033` attestation, release metadata, and candidate freeze.
