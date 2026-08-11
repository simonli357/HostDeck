# REL-V1-102 Supply-Chain Metadata

Status: in progress.

## Frozen Contract

- Input is one verified schema-5 native package tree, its exact `hostdeck-package.json`,
  the repository `pnpm-lock.yaml`, and passed REL-V1-101 native-CI evidence for the
  same source commit, target, Node ABI, package manager, and native dependencies.
- Output is one detached directory containing canonical UTF-8/LF `SHA256SUMS`,
  `licenses.json`, CycloneDX 1.7 JSON, SLSA provenance v1 in an in-toto Statement
  v1 envelope, and a self-bound `metadata.json` index.
- `SHA256SUMS` covers every regular package file exactly once, in lexical portable-
  path order. The package-tree subject also binds directories and safe contained
  symlinks; hard links, special files, unsafe links/paths, and changed trees fail closed.
- The license inventory and SBOM describe the production workspace dependency graph,
  including native modules. Optional packages are resolved for the selected target;
  dev-only packages and host paths are excluded. External packages require an
  approved SPDX expression. A bundled Node runtime must carry an explicit reviewed
  license descriptor before metadata can be emitted.
- Provenance subjects bind every shipped package file and the package-tree identity.
  Materials bind the source commit, lockfile, package manifest, and native-CI evidence.
  Byproducts bind checksums, licenses, and SBOM. This task emits no signature and
  claims no SLSA level; REL-V1-103 owns signing and publication.
- Generation is deterministic, bounded, staged, exclusive, and cleanup-safe.
  Verification independently rehashes all files and records, checks graph/license
  closure and package/evidence agreement, rejects missing or extra components, and
  rejects private paths, accounts, credentials, tokens, Tailscale identities, or
  non-public URLs.

## Acceptance

- Same inputs produce byte-identical outputs on Ubuntu and Windows.
- Schema, target, runtime, native-dependency, missing-file, extra-file, tamper,
  traversal, link, privacy, and interrupted-publication mutations fail.
- Native CI runs the metadata contract on both targets without skips.
- The completed artifact records exact commands, counts, hashes, commits, and the
  accepted native run; no generated release metadata is retained from a private host.
