# INT-V1-003 Codex Binding And Compatibility Gate

Date: 2026-07-09

## Outcome

- Added the private `@hostdeck/codex-adapter` package and kept raw generated app-server types behind its package entry.
- Pinned V1 compatibility to exact `codex-cli 0.144.0`; version ranges and same-name unreviewed bindings are not accepted.
- Generated the experimental app-server TypeScript surface because the default 0.144.0 output omits collaboration-mode input required by primary `/plan` control.
- Committed 671 generated files under one canonical tree identity: `e1a1a5cff3ab91862f9215dd06538eae1ea0b00bae48cbb7d87061faaee27e24`.
- Added deterministic generate/check commands. Generation occurs in a temporary directory, applies only NodeNext import-extension normalization, hashes sorted path/content frames, and fails on version, manifest, generated-tree, or generated-manifest drift.
- Added a normalized compatibility evaluator that blocks mutation for unsupported/malformed versions, unreviewed identity, missing required method/event/field/approval evidence, incomplete handshake, mismatched app-server user-agent version, unsupported platform, or missing `Plan`/`Default` catalog modes.

## Architecture Corrections

- `initialize` does not negotiate HostDeck product capabilities. Its client capabilities opt into protocol features such as `experimentalApi`; method support comes from the reviewed generated binding and exact-version policy.
- The initialize response corroborates the separately probed binary through `hostdeck/<version>` user-agent prefix and Linux/Unix platform fields.
- `/plan` readiness requires generated `collaborationMode/list`, `TurnStartParams.collaborationMode`, plan notifications, experimental opt-in, and a live catalog containing both `Plan` and `Default`.
- Approval readiness requires generated command/file server requests and both generated response-decision types. Actual approve/deny/expiry behavior remains `INT-V1-006` evidence.
- Multi-client is a pinned policy capability only at this stage. Simultaneous HostDeck/TUI correctness remains `INT-V1-007`; this task does not claim that behavioral proof.

Official behavior was checked against the current [Codex app-server documentation](https://learn.chatgpt.com/docs/app-server) and local CLI help.

## Hardening Matrix

| Area | Proven | Remaining owner |
| --- | --- | --- |
| Version and schema | Exact CLI output parsing, whole-tree checksum, manifest/module agreement, repeat regeneration, unreviewed identity rejection. | Upgrade policy is explicit review plus regenerated artifact. |
| Required capabilities | Every required capability loses mutation readiness when one selected method/event/field/policy marker is removed. | Real operation behavior: `INT-V1-005` to `INT-V1-007`. |
| Optional capabilities | A known missing optional usage surface remains explicit without blocking proven required mutations. | Runtime operation errors: `INT-V1-006`. |
| Handshake | Not-attempted/failed states block; Linux/Unix, exact server version, and Plan/Default modes are required. | Unix transport/broker: `INT-V1-004`. |
| Boundary | Package root exports only HostDeck binding/compatibility descriptors; generated unions remain adapter-private. | Decoder/adapter implementation: `INT-V1-004` onward. |
| Repeated use | 32 repeated evaluations are deterministic and leave frozen manifest/surface arrays unchanged. | Multi-process/reconnect: `INT-V1-007`. |

## Real Installed Smoke

- Environment: Ubuntu 24.04.4 LTS, Node.js 22.22.2, `codex-cli 0.144.0`.
- Spawned `codex app-server --stdio` without a model call.
- Sent one experimental `initialize`, confirmed app-server user-agent version and Linux/Unix platform, sent `initialized`, and called `collaborationMode/list`.
- The live catalog returned `Plan` and `Default`; normalized compatibility was `ready` with mutation policy `allowed`.
- Child shutdown is bounded with SIGTERM then SIGKILL enforcement.

## Validation

- `pnpm install --frozen-lockfile --offline`: passed for all 10 workspace projects.
- `pnpm check:codex-bindings`: passed; 671 files and reviewed SHA-256 identity match a fresh temporary regeneration.
- `pnpm smoke:codex-compatibility`: passed, 1 real installed-runtime test without a model call.
- Adapter suite: 27 tests passed and the opt-in installed smoke was skipped by default.
- `pnpm check:scaffold`: passed, 9 packages and 16 root scripts.
- `pnpm typecheck` and all 9 package typechecks: passed.
- Full unit suite: 37 files passed and 2 skipped; 260 tests passed and 2 skipped.
- Contract: 9 files and 104 tests passed.
- Integration: 15 tests passed.
- Web: 14 tests passed.
- Lint/package exports and diff checks passed before docs advancement.

## Explicit Remaining Gaps

- `INT-V1-004`: production Unix-socket WebSocket transport, initialize state machine, broker bounds/deadlines, message decoding, and reconnect skeleton.
- `INT-V1-005`: managed thread lifecycle, persistence saga, and exact laptop TUI resume.
- `INT-V1-006`: real prompt/events/model/goal/plan/usage/compact/skills/approval/interrupt semantics.
- `INT-V1-007`: supervision, simultaneous TUI client, crash/restart, and multi-client correctness.
