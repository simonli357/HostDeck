# REL-V1-102 Supply-Chain Metadata

Status: done.

Implementation: `8669347`, `5a2df7c`, `15cae7b`; portable-path correction:
`0dd98f3`. Accepted native run: `31513897607`.

## Frozen Contract

- Input is one verified schema-5 native package tree, its exact `hostdeck-package.json`,
  the repository `pnpm-lock.yaml`, and passed REL-V1-101 native-CI evidence for the
  same source commit, target, Node ABI, package manager, and native dependencies.
- Output is one detached directory containing canonical UTF-8/LF `SHA256SUMS`,
  `licenses.json`, CycloneDX 1.7 JSON, SLSA provenance v1 in an in-toto Statement
  v1 envelope, and a self-bound `metadata.json` index.
- CycloneDX uses the pinned OWASP JavaScript model/serializer and its strict AJV-backed
  1.7 validator; HostDeck owns the narrower graph, license, privacy, and identity checks.
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

## Evidence

- Six metadata tests pass with strict CycloneDX validation, target/runtime/license
  closure, two deterministic generations, and schema, graph, target, checksum,
  package/evidence tamper, missing/extra file, path/link, privacy, and publication
  failure mutations. Package acceptance passes 43 tests and two 6,293-entry builds.
- Run `31513897607` binds commit `0dd98f3c43a03efe352293c300e42f91f4210a16`
  and lockfile `18ff003698c457578ba3e041074e522cd4fcfdf73e1e7d60ece7354cb43b7458`.
  Linux passes 17 checks; Windows passes 16, both including `supply_chain` with no skip.
- Independently downloaded evidence verifies at SHA-256
  `60073f20775764816e240e8b4507d5f8b080b98aca5a5d36d194d5079500eab2`
  for Linux and `bfc777cd92ac264894fbdf33259d1c47fe1bfd41609ccd32852ebc5a48990b7f`
  for Windows.
- The real accepted Linux input emits byte-identical five-record sets over 4,983 files,
  181 licensed third-party packages, 188 CycloneDX components, and 189 dependency
  records. Metadata identity is
  `08e904236ba12bbf65dc12436ca87cf041d750c562baa360b9e62a4801c741e2`.
- Failed run `31513526951` exposed host-dialect normalization in the existing package
  verifier; `0dd98f3` moved both affected checks to explicit portable POSIX semantics.
  No generated metadata, native evidence, private path, account, token, or host residue
  is retained.
