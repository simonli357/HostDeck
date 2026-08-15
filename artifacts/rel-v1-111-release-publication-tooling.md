# REL-V1-111 Release Publication Tooling

Status: passed

## Result

- `bedebcf` adds the Ubuntu tag workflow, deterministic release bundle, exact package/native/source/tag binding, and static workflow verifier; `9950ab7` preserves package-relative symlink targets in the archive.
- The workflow uses Ubuntu 24.04, Node `22.22.2`, pnpm `10.29.2`, and SHA-pinned checkout, setup-node, and `actions/attest` actions.
- A tag runs native checks, builds and verifies the package and supply-chain records, generates and re-verifies 11 release assets, attests them with GitHub OIDC, then creates a draft release. Any earlier failure prevents publication.
- The bundle contains the archive/checksum, package checksums, SBOM, licenses, provenance, metadata index, native evidence/checksum, release notes, and release index. Generation is staged, bounded, normalized, and fails on source/tag/evidence drift, extra or missing assets, unsafe paths, tampering, or unsupported platforms.

## Validation

| Gate | Result |
| --- | --- |
| Workflow policy | Two mutation tests and the static verifier passed: 3 pinned actions, 14 exact ordered steps, least-privilege job permissions, no secrets, attestation before draft creation. |
| Archive | Two focused tests passed byte determinism, normalized root/metadata, relative-symlink preservation, changed-input detection, and invalid-output rejection. |
| Real package | Eight supply-chain tests passed. Two generated archives were byte-identical, contained 6,363 tar entries under one `hostdeck/` root, extracted cleanly, and replayed the independent 6,361-entry package verifier. |
| Workspace | Unit 3,279; contract 309; integration 36; web 960; package 44; packaged Chromium `1/1`; typecheck, lint/exports, scaffold, planning, native-workflow, and release-workflow checks passed. |
| Inspection | All 11 local bundle files were regular mode `0644`; checksums and inventory agreed. No home path, local account, credential, token, Tailscale identity, private URL, or private network address was present. |

The local `v0.0.3` bundle used sanitized synthetic release-run evidence only to exercise the complete generator/verifier. It was not uploaded, tagged, attested, or treated as release evidence. Live publication remains `REL-V1-110` after `FE-V1-108` physical-phone acceptance.

The delivery plan and block matrix are unchanged because this task did not change the release milestone or no-go status.
