# INT-V1-103 Platform TUI Resume

Status: passed

## Result

- One immutable platform command targets the exact Codex executable, cwd, endpoint, and thread with `shell: false`.
- Linux retains `unix://`; Windows uses authenticated `ws://127.0.0.1:<ephemeral>` plus `--remote-auth-token-env HOSTDECK_CODEX_REMOTE_AUTH`.
- Windows authority is resolved once from the current generation, injected only into the child environment, removed from the parent copy immediately after spawn, and absent from argv, commands, errors, and evidence.
- Invalid/mixed paths, Windows aliases, malformed environments, stale credentials, unsupported hosts, start failures, signals, nonzero exits, abort races, and invalid child contracts fail closed without retries or captured output.
- The legacy Linux real-resume smoke now consumes the platform builder; `INT-V1-104` owns composition into the complete Windows runtime vertical.

## Validation

| Layer | Result |
| --- | --- |
| Focused | 21 unit plus 3 native process-contract tests pass; exact Linux Codex 0.144.0 no-model TUI render/resume/archive passes with both private-login and explicit CI-fixture auth paths. |
| Workspace | Unit 3,120 passed/29 intentional skips; contract 278; integration 36; typecheck, 866-file lint/export, scaffold, and planning pass. |
| Runtime/package | Boundary passes at 630 production sources/23 externals; two deterministic package builds pass at 6,287 entries with relocation and tamper rejection. |
| Supply chain | Frozen offline install passes; production audit reports no known vulnerabilities. |
| Native | Run `31494425909`, exact source `040c133dec9306a821b7ec2f5154d879ed674e5b`: Linux 15/15 and Windows 14/14 ordered checks pass with no skips. |

Downloaded Linux/Windows evidence and digests independently verify. Linux includes the exact real TUI smoke and product process contract. Windows combines the exact Codex 0.144.0 authenticated real-resume spike with the product process contract, supervisor, native path/lock, type/lint/contract, and native-module checks.

## Inspection

- Command and error serialization contain no endpoint credential.
- Stale ambient auth variants are removed on both targets; malformed environment input is rejected before protected authority is read.
- Abort waits for native process termination; output remains inherited by the local terminal and is never retained in adapter diagnostics.
- User-modified UI artifacts and `packages/web/src/mobile-copy-contract.test.ts` remained unstaged and unchanged by this task.

Implementation: `040c133`.
