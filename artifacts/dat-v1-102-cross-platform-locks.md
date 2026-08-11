# DAT-V1-102 Cross-Platform Locks

Status: done.

## Result

- One `HostDeckFileLockPort` owns daemon and service-lifecycle advisory locking.
- Pinned `fs-native-extensions` `1.3.4` supplies native Linux and Windows descriptor locks; it is Apache-2.0 licensed and the production audit reports no known vulnerability.
- Acquisition is exclusive and nonblocking. Release is idempotent; failed release becomes terminal and explicit.
- Contention, same-process duplicate acquisition, child-process crash recovery, invalid descriptors, binding failures, and consumer release failures are covered without PID-only authority or reflected private diagnostics.

## Evidence

- Implementation: `54acf05`.
- Native matrix: [31459318098](https://github.com/simonli357/HostDeck/actions/runs/31459318098) at `1ca32c4`; `native_lock` and native-module probes passed on `ubuntu-24.04` and `windows-2022`.
- Local aggregate: 3,000 unit tests passed with 29 intentional environment/device skips; 257 contract and 36 integration tests passed.
- Deterministic package acceptance, systemd smoke, typecheck, lint, runtime-boundary, browser matrix, and zero-vulnerability audit passed.

Detailed native CI evidence is owned by `artifacts/rel-v1-101-native-ci.md`.
