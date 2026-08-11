# IFC-V1-101 Native Package Contract

## Result

- Status: passed.
- Implementation: `e63db60`; browser/service evidence: `c0f3f4d`.
- Native acceptance: run `31471194169`; Windows job `93714669664`, Linux job `93714669724`.
- Scope: contract and current Linux baseline only. Bundled native trees remain `IFC-V1-102`; no phone evidence is claimed.

## Contract

- Package manifest schema 5 binds artifact kind, target OS/architecture/lifecycle/public kind, Node 22.22.2 ABI 127, pnpm 10.29.2, runtime delivery/bundle, package version, clean source commit, Codex binding, launcher, service lifecycle, native modules, web, source, output, and content.
- Current `runtime_tree` declares Linux x64 with host-provided Node and `bundle: null`; bundled Linux/Windows profiles require the exact contained runtime path, hash, size, and executable inventory entry.
- Native descriptors bind `better-sqlite3` 12.11.1, `fs-native-extensions` 1.3.4, and `koffi` 3.1.4 to target and ABI.
- Linux service/lifecycle consumers reject non-Linux, non-systemd, bundled, or mixed identities before importing the service host.
- Packaging rejects dirty selected inputs and rechecks source bytes and commit immediately before manifest emission.

## Evidence

| Gate | Result |
| --- | --- |
| Identity/property and hostile mutation tests | 43 package/clean-contract tests pass, including 19 target/runtime/artifact/source mutations plus resigned full-package mutations. |
| Static/shared regressions | Typecheck and lint pass; contract 270; unit 3,004 with 29 intentional environment/device skips; runtime boundary 625 modules. |
| Deterministic package | Two builds pass: 625 sources, 1,257 owned outputs, 6,276 entries; source commit `e63db60807bfb94ac516e89c094f735fa03a623f`; content `19789d83fcb1def869199a1e8c271f0eec55fd1f4fb4a87df78517e195aa5ef1`; manifest `5651c480ddf16c852d2f65316918cbe5faf6b3ae7e9f143da3ae250c070062a2`. |
| Runtime/browser | Read-only relocation and tamper acceptance pass; service-host, executable, systemd-user-unit, and persistent lifecycle smokes pass with exact Codex 0.144.0; 76 browser scenarios pass with 316 requests, 52 mutations, and zero unexpected diagnostics. |
| Native CI | Windows 10/10 and Linux 12/12 checks pass at `c0f3f4dabca6b0f72191b42b2197450a95747149`; both downloaded JSON records and SHA-256 sidecars verify. |

No private path, account, token, pairing material, or phone claim is present in retained evidence.
