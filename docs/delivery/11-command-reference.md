# Command Reference

Copy-paste commands only. Put explanation in `docs/delivery/09-developer-guide.md`.

## Setup

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm exec playwright install chromium firefox
```

## Run

```bash
pnpm --filter @hostdeck/web dev
pnpm --filter @hostdeck/web preview
pnpm check:scaffold
pnpm check:planning
pnpm check:runtime-boundary
pnpm check:codex-bindings
```

## Validate

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm test:unit
pnpm test:contract
pnpm exec vitest run --config vitest.contract.config.ts packages/cli/src/cli.contract.test.ts
pnpm test:integration
pnpm test:web
pnpm --filter @hostdeck/web test
pnpm --filter @hostdeck/web build
pnpm test:browser:shell
pnpm test:accessibility:zoom
pnpm test:accessibility:orca
pnpm build
dist/hostdeck/dist/shell.js --help
dist/hostdeck/dist/shell.js --version
pnpm test:package
node dist/hostdeck/verify.mjs dist/hostdeck
pnpm test:browser:package
pnpm test:browser:pairing
pnpm test:e2e
pnpm exec vitest run packages/cli/src/remote-control-client.test.ts packages/cli/src/remote-cli.test.ts
pnpm exec vitest run packages/cli/src/start-client.test.ts packages/cli/src/start-cli.test.ts packages/server/src/selected-write-audit-executor.test.ts packages/server/src/session-start-routes.test.ts packages/server/src/managed-thread-service.test.ts packages/storage/src/session-start-audit-catalog-migration.test.ts
pnpm exec vitest run packages/cli/src/config.test.ts packages/cli/src/host-lock-client.test.ts packages/cli/src/host-lock-cli.test.ts packages/cli/src/pairing-link-client.test.ts packages/cli/src/selected-api-route-inventory.test.ts packages/cli/src/legacy-session-admin.test.ts packages/storage/src/legacy-session-repository.test.ts
pnpm exec vitest run packages/cli/src/host-status-client.test.ts packages/cli/src/session-list-client.test.ts packages/cli/src/device-revoke-client.test.ts packages/cli/src/administrative-cli.test.ts packages/cli/src/selected-api-route-inventory.test.ts
pnpm exec vitest run packages/storage/src/read-only-database.test.ts packages/cli/src/local-device-list.test.ts
pnpm exec vitest run packages/cli/src/archive-client.test.ts packages/cli/src/archive-cli.test.ts packages/server/src/selected-write-audit-executor.test.ts packages/server/src/selected-write-gate.test.ts packages/server/src/session-archive-routes.test.ts packages/server/src/managed-thread-service.test.ts
pnpm exec vitest run --config vitest.integration.config.ts tests/archive-vertical.integration.test.ts
pnpm exec vitest run packages/cli/src/prompt-client.test.ts packages/cli/src/prompt-cli.test.ts packages/server/src/codex-prompt-control-service.test.ts packages/server/src/prompt-routes.test.ts packages/server/src/selected-write-audit-executor.test.ts packages/server/src/selected-write-gate.test.ts
pnpm exec vitest run --config vitest.integration.config.ts tests/prompt-vertical.integration.test.ts
pnpm exec vitest run packages/cli/src/model-client.test.ts packages/cli/src/model-cli.test.ts packages/server/src/codex-model-control-service.test.ts packages/server/src/model-routes.test.ts
pnpm exec vitest run --config vitest.integration.config.ts tests/model-vertical.integration.test.ts
pnpm exec vitest run packages/cli/src/goal-client.test.ts packages/cli/src/goal-cli.test.ts packages/codex-adapter/src/goal-client.test.ts packages/server/src/codex-goal-control-service.test.ts packages/server/src/goal-routes.test.ts
pnpm exec vitest run --config vitest.integration.config.ts tests/goal-vertical.integration.test.ts
pnpm exec vitest run packages/codex-adapter/src/plan-client.test.ts packages/server/src/codex-plan-control-service.test.ts packages/server/src/plan-routes.test.ts packages/cli/src/plan-client.test.ts packages/cli/src/plan-cli.test.ts
pnpm exec vitest run --config vitest.integration.config.ts tests/plan-vertical.integration.test.ts
pnpm exec vitest run packages/codex-adapter/src/compact-client.test.ts packages/server/src/codex-compact-control-service.test.ts packages/server/src/compact-routes.test.ts packages/cli/src/compact-client.test.ts packages/cli/src/compact-cli.test.ts
pnpm exec vitest run --config vitest.contract.config.ts packages/contracts/src/compact.contract.test.ts packages/server/src/selected-api-route-manifest.contract.test.ts
pnpm exec vitest run --config vitest.integration.config.ts tests/compact-vertical.integration.test.ts
pnpm exec vitest run packages/server/src/codex-approval-control-service.test.ts packages/server/src/approval-routes.test.ts packages/cli/src/approval-client.test.ts packages/cli/src/approval-cli.test.ts
pnpm exec vitest run --config vitest.contract.config.ts packages/contracts/src/approval.contract.test.ts
pnpm exec vitest run --config vitest.integration.config.ts tests/approval-vertical.integration.test.ts
pnpm exec vitest run packages/server/src/codex-interrupt-control-service.test.ts packages/server/src/interrupt-routes.test.ts packages/cli/src/interrupt-client.test.ts packages/cli/src/interrupt-cli.test.ts
pnpm exec vitest run --config vitest.contract.config.ts packages/contracts/src/interrupt.contract.test.ts
pnpm exec vitest run --config vitest.integration.config.ts tests/interrupt-vertical.integration.test.ts
pnpm exec vitest run packages/server/src/selected-write-admission-policy.test.ts packages/server/src/selected-write-gate.test.ts
pnpm exec vitest run --config vitest.integration.config.ts tests/selected-write-admission.integration.test.ts
pnpm exec vitest run packages/server/src/codex-runtime-supervisor.test.ts
pnpm exec vitest run --config vitest.integration.config.ts tests/codex-runtime-supervisor.integration.test.ts
pnpm smoke:remote-control
pnpm smoke:codex-compatibility
pnpm smoke:codex-ipc
pnpm smoke:codex-threads
```

## Physical Android Security Acceptance

```bash
pnpm smoke:pairing-android
pnpm smoke:prompt-android
HOSTDECK_REMOTE_CONTROL_DEDICATED_PROFILE_ID=DEDICATED_ID \
HOSTDECK_REMOTE_CONTROL_AWAY_PROFILE_ID=AWAY_ID \
pnpm smoke:recovery-android
HOSTDECK_REMOTE_CONTROL_DEDICATED_PROFILE_ID=DEDICATED_ID \
HOSTDECK_REMOTE_CONTROL_AWAY_PROFILE_ID=AWAY_ID \
pnpm smoke:remote-android
```

All four device harnesses capture the original mobile-data, Wi-Fi, and USB stay-awake settings; temporarily enable mobile data when needed; disable Wi-Fi; require separate validated cellular Internet and Tailscale VPN networks; and restore every captured setting on success or failure.

`smoke:pairing-android` is the `FE-V1-013` production-UI device run. It requires one clean commit, exact Tailscale 1.98.8, the active dedicated HostDeck profile with its Serve root absent, and one unlocked authorized Android device with Tailscale, Chrome, USB debugging, and available cellular service. The harness builds and serves the real React app through private Serve HTTPS, generates and validates the in-memory QR payload, then passes that same selected one-time link to Chrome through fixed stdin-only ADB without placing it in host-side ADB arguments or captured output. It verifies the paired confirmation, Mission Control, Host & access sheet, and fragment-free reload through bounded Android accessibility controls, then self-revokes the temporary device authority. Device screenshots and UI hierarchy remain temporary and are removed during cleanup because they can contain the private tailnet origin.

`smoke:prompt-android` is the `FE-V1-020` production prompt-composer device run over cellular plus private Tailscale HTTPS. It has the same clean-commit, Tailscale, Chrome, USB-debugging, and unlocked-phone prerequisites. The harness performs one automated stdin-only one-time-link handoff with no QR scan, opens the real Session Detail route, proves the visible software keyboard and exact two-line edit, sends one protected prompt, observes accepted then event-proven running and completed states, self-revokes browser authority, removes Serve, restores phone settings, deletes private screenshots and temporary state, and writes only sanitized evidence to `artifacts/fe-v1-020-selected-session-prompt-composer/physical-android.json`.

`smoke:recovery-android` is the `FE-V1-034` production recovery-UI device run over cellular plus private Tailscale HTTPS. It requires the same clean committed worktree and unlocked authorized phone plus two distinct saved-profile ids. The harness opens the committed React build through one automated no-QR pairing link, performs two exact read-only dashboard checks, switches the laptop profile away and back, proves generic loaded-browser failure and observation-only recovery without re-pairing or browser profile/Serve mutation, self-revokes the temporary device, restores the HostDeck profile and phone settings, removes Serve, and publishes privacy-checked screenshots plus JSON under `artifacts/fe-v1-034-remote-connection-recovery/physical-android/`.

`smoke:remote-android` is the strict `IFC-V1-079` no-retry device run. It requires one clean commit, exact Tailscale 1.98.8, two distinct authorized saved-profile ids, one unlocked authorized Android device, Android Tailscale and Chrome, and a cellular connection. The harness disables and restores phone Wi-Fi, uses USB only for guarded camera/Chrome inspection, requires the human to scan and open the in-memory QR, restores the dedicated profile, removes its exact Serve path, and publishes only sanitized evidence under `artifacts/ifc-v1-079-device/` after complete cleanup.

## Codex Runtime Probes

```bash
HOSTDECK_CODEX_BIN="$(readlink -f /absolute/path/to/codex-0.144.0)" pnpm test:codex
HOSTDECK_CODEX_BIN=/absolute/path/to/codex-0.144.0 pnpm smoke:codex-semantics
HOSTDECK_CODEX_BIN=/absolute/path/to/codex-0.144.0 pnpm smoke:codex-model
HOSTDECK_CODEX_BIN=/absolute/path/to/codex-0.144.0 pnpm smoke:codex-goal
HOSTDECK_CODEX_BIN=/absolute/path/to/codex-0.144.0 pnpm smoke:codex-plan
HOSTDECK_CODEX_BIN=/absolute/path/to/codex-0.144.0 pnpm smoke:codex-usage
HOSTDECK_CODEX_BIN=/absolute/path/to/codex-0.144.0 pnpm smoke:codex-compact
HOSTDECK_CODEX_BIN=/absolute/path/to/codex-0.144.0 pnpm smoke:codex-skills
HOSTDECK_CODEX_BIN=/absolute/path/to/codex-0.144.0 pnpm smoke:codex-prompt
HOSTDECK_CODEX_BIN=/absolute/path/to/codex-0.144.0 pnpm smoke:codex-approval
HOSTDECK_CODEX_BIN=/absolute/path/to/codex-0.144.0 pnpm smoke:codex-interrupt
HOSTDECK_CODEX_BIN=/absolute/path/to/codex-0.144.0 pnpm smoke:codex-vertical
HOSTDECK_CODEX_BIN=/absolute/path/to/codex-0.144.0 pnpm smoke:codex-supervisor
HOSTDECK_CODEX_BIN=/absolute/path/to/codex-0.144.0 pnpm smoke:codex-restart
HOSTDECK_CODEX_BIN=/absolute/path/to/codex-0.144.0 pnpm smoke:codex-tui-coexistence
HOSTDECK_CODEX_BIN="$(readlink -f /absolute/path/to/codex-0.144.0)" pnpm smoke:codex-lifecycle
HOSTDECK_CODEX_BIN="$(readlink -f /absolute/path/to/codex-0.144.0)" pnpm smoke:executable-serve
HOSTDECK_CODEX_BIN="$(readlink -f /absolute/path/to/unsupported-codex)" HOSTDECK_EXPECT_DIAGNOSTIC=1 pnpm smoke:executable-serve
HOSTDECK_CODEX_BIN="$(readlink -f /absolute/path/to/codex-0.144.0)" pnpm smoke:service-host
HOSTDECK_CODEX_BIN="$(readlink -f /absolute/path/to/codex-0.144.0)" pnpm smoke:systemd-user-units
```

`HOSTDECK_EXPECT_DIAGNOSTIC=1` is validation-only. It requires a valid Codex semver different from the reviewed version and proves the packaged listener remains read-only and reachable without app-server admission; ordinary HostDeck startup never reads this variable.

## Regenerate Reviewed Codex Binding

```bash
pnpm generate:codex-bindings
```

## Explicit Gaps

- CLI install/service lifecycle: `pnpm build` emits one verified `dist/hostdeck/dist/shell.js` `codexdeck` entry, the non-executable service host, exact pure user-unit generator, and manifest-verified dashboard assets. Service actions and persistent installation remain explicit non-success until `IFC-V1-056` to `IFC-V1-058`.
- Local release smoke: `pnpm smoke:local` intentionally exits nonzero until `REL-V1-006` implements it.
