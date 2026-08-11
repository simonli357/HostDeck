# REL-V1-101 Native CI

Status: done.

## Accepted Run

- Source: `1ca32c4a9fd6a515d2ede391eda43276d6767a09`.
- GitHub Actions run: [31459318098](https://github.com/simonli357/HostDeck/actions/runs/31459318098), attempt 1.
- Toolchain: Node `22.22.2`, ABI `127`, N-API `10`, pnpm `10.29.2`.
- Both targets bind lockfile SHA-256 `35306403905e8af36e714c7ce4b00199ea5cc771b31ae2e5ade1bfe348c4391e`.

| Target | Native runner | Checks | Evidence SHA-256 |
| --- | --- | ---: | --- |
| `linux-x64` | `ubuntu-24.04` | 11 | `c7c5920f5f1c7e5e699d444507b5ce17cb49f231553ac66f3343987f86805d72` |
| `windows-x64` | `windows-2022` | 9 | `31aca785a3fabae01131db1f48efa25c6bd72f02e6830785a0723181d2e13ea4` |

Linux passed scaffold, planning, runtime-boundary, typecheck, lint, contract, native-lock, integration, web-build, native-module, and deterministic-package checks. Windows passed every applicable check, including contracts, native locking, web build, and native-module loading.

The workflow uses read-only repository permissions, SHA-pinned actions, frozen installs, bounded concurrency/timeouts, no cache or release secrets, fail-closed structured reports, sanitized digest-bound evidence, and no accepted test skip.

Independent local verification accepted both downloaded JSON artifacts and their SHA-256 sidecars.
