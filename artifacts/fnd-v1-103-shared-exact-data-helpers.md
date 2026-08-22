# FND-V1-103 Shared Exact-Data Deep Freeze

Replaces 92 local `deepFreeze` definitions with one shared implementation, and fixes a latent
stack overflow that 80 of them carried.

## Problem

`deepFreeze` was defined 92 times across seven packages: server 45, cli 19, web 15,
codex-adapter 5, test-fixtures 4, storage 3, contracts 1. Normalising whitespace produced **26
textually distinct bodies**, which fell into five behaviour classes:

| class | files | behaviour |
| --- | --- | --- |
| post-order | 79 | recurse into children, then freeze the parent |
| pre-order | 8 | freeze the parent, then recurse |
| explicit `Set` cycle guard | 3 | all in `packages/web` |
| throws on a primitive | 1 | `<T extends object>`, no null guard |
| no `isFrozen` short circuit | 1 | re-walks already-frozen subtrees |

The variation was accidental rather than intended — the same idea retyped 92 times.

## The bug this was hiding

The 79-file post-order majority **recurses forever on a cyclic graph**. The cycle re-enters a
parent that has not been frozen yet, so the `isFrozen` short circuit never fires. Measured:

```
post-order (the 79-file majority)    -> RangeError: Maximum call stack size exceeded
pre-order (consolidated)             -> terminated, frozen: true
```

## Change

One `deepFreezeExactData` added to the existing `packages/contracts/src/exact-data-object.ts`,
which the review of this task identified as the repo's established shared exact-data module —
so no new module was created and the production source closure stays at 638.

**Pre-order was chosen deliberately.** For acyclic data the result is byte-identical to every
prior variant, so no call site changes meaning. For cyclic data it converts a hang into
termination. It therefore never makes any call site worse, which post-order or a `Set` guard
could not both claim.

`Map` and `Set` contents remain unfrozen, matching every prior variant: `Object.values`
reports own enumerable properties, and `Object.freeze` does not stop `set`, `add`, `delete` or
`clear` on those containers anyway.

The one exported copy (`security-mutation-audit-validation.ts`) and its cross-module consumer
(`security-mutation-audit-executor.ts`) were migrated too. `deepFreezeInspection` in
`windows-native-file-security.ts` is a different function and was left alone.

## Architecture

`exact-data-object.ts` was package-private, reached only by relative sibling imports. Serving
seven packages from one copy required exporting it from the contracts index, so
`./exact-data-object.js` was added to the pinned specifier list in
`scripts/check-selected-runtime-boundary.mjs`. That list is a gate on accidental surface
growth, not a prohibition; this is a deliberate, recorded addition. `exactDataObject`,
`exactDataArray` and `exactDataTree` become public alongside it.

Contracts is the only viable home: `packages/storage` does not depend on `packages/core`, so
core could not serve every consumer.

## Evidence

- Net **940 deletions against 429 insertions** across 95 files.
- Two local definitions remain by design: the new shared one, and the unrelated
  `deepFreezeInspection`.
- Seven direct tests in `exact-data-object.contract.test.ts` cover nested freezing and
  reference identity, primitive and null pass-through, **cycle termination on both an object
  graph and a self-referencing array**, the already-frozen short circuit, `Map`/`Set`
  behaviour, and that frozen data actually rejects mutation.
- Gates: unit 3,237 passed with 32 skipped, contract 297, integration 36, typecheck, lint over
  901 files, `check:runtime-boundary` at 638 modules unchanged, `check:planning` with 23
  technical-plan facts.

## Limits

- The `Set`-guarded web variants skipped cycles without freezing them; the shared version
  freezes them. No test depended on the old behaviour.
- The one variant that threw on a primitive now returns it. Its call sites pass objects, so no
  behaviour reachable from them changed.
- `settleOwnedProcessGroup` is still duplicated between two CLI modules — a separate
  duplication noted while closing `FND-V1-107`, not in this task's scope.
