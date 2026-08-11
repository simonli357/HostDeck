# INT-V1-100 Windows Codex Transport Spike

Date: 2026-08-11

## Result

Exact Codex 0.144.0 supports the selected Windows architecture. `INT-V1-101` can implement the authenticated loopback transport without returning to planning.

## Native Evidence

- Accepted workflow: `native-ci` run `31478791010`, attempt 1, source `37b2a6b6ffb3232823269931df76e87044ee024d`.
- Runner: `windows-2022`, Windows `10.0.20348`, x64, image `20260802.262.1`, Node `22.22.2`.
- Runtime: npm Codex `0.144.0`, target `x86_64-pc-windows-msvc`, native binary SHA-256 `2b3c18d9393ed794531ae3da13f43a6de3bcd91dc577222bd31a17c59f7de0aa`.
- Binding: `codex-app-server-0.144.0-experimental:sha256:e1a1a5cff3ab91862f9215dd06538eae1ea0b00bae48cbb7d87061faaee27e24`.
- Durable redacted capture: `artifacts/int-v1-100-windows-codex-transport-spike/evidence.json`, SHA-256 `408b66780bda914ffe4f8ea61711bbc61463e267b20c9df7b88e855b50d5f90d`.

## Acceptance

| Boundary | Observed result |
| --- | --- |
| Listener | One nonprivileged `127.0.0.1` WebSocket listener owned by the exact process. |
| Authentication | Missing and invalid bearer credentials returned `401`; an origin-bearing upgrade returned `403`; valid auth connected. |
| Protocol | Two clients initialized as Windows, exposed Default and Plan, and one survived peer closure. |
| TUI resume | A paused-goal materialized thread resumed in the real Windows TUI; the token value stayed out of argv and the thread retained zero turns. |
| Credential boundary | Random token file was current-user-only; argv/captures contained no token value. |
| Shutdown | TUI/app-server process trees exited, the listener closed, and the temporary credential/root were removed. |

The no-model materialization uses Codex's supported paused-goal set/clear path; it does not start a turn or contact a model. Supervisor ownership, token rotation, and production TUI command construction remain owned by `INT-V1-102` and `INT-V1-103`.

## Verification

- `sha256sum -c int-v1-100-windows-codex-transport-spike.json.sha256`
- `node scripts/windows-codex-spike-evidence.mjs verify <capture>`
- `node scripts/native-ci-evidence.mjs verify <windows-native-evidence>`: 12/12 checks passed.
- Companion Linux native job, local typecheck, lint, native-CI contract tests, full unit suite, package tests, and deterministic build passed for the implementation series.
