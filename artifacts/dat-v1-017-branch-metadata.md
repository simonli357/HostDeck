# DAT-V1-017 Optional Git Branch Metadata

Date: 2026-07-08

## Scope

- Added `captureGitBranchMetadata` in `@hostdeck/storage`.
- Captures the current branch with `git -C <cwd> symbolic-ref --quiet --short HEAD`.
- Persists captured branch values through the existing session metadata repository.
- Keeps git optional: non-git directories, missing git, detached `HEAD`, empty output, multiline output, and oversized branch names return `null`.
- Invalid cwd values still fail loudly before git is invoked.

## Behavior Proven

- A temporary git worktree on branch `feature/branch-metadata` captures and stores that branch in `session_metadata.branch`.
- A non-git cwd stores `branch: null` without failing session metadata persistence.
- Missing git binary returns `null` rather than blocking optional metadata capture.
- Detached, empty, multiline, and over-240-character branch output is rejected as `null`.
- Relative cwd input throws `HostDeckGitBranchMetadataError` with `invalid_cwd`.

## Validation

- `command -v git && git --version` found `/usr/bin/git`, version `2.43.0`.
- `pnpm install --frozen-lockfile` passed.
- `pnpm --filter @hostdeck/storage typecheck` passed.
- `pnpm check:scaffold` passed.
- `pnpm typecheck` passed.
- `pnpm -r --if-present typecheck` passed.
- `pnpm lint` passed.
- `pnpm test` passed with 85 tests across 13 files.
- `pnpm test:unit -- packages/storage/src/branch-metadata.test.ts packages/storage/src/session-repository.test.ts packages/contracts/src/storage.contract.test.ts` passed with 85 tests across 13 files.
- `pnpm test:contract` passed with 37 tests across 4 files.
- `git diff --check` passed.

## Remaining Gaps

- API/session-list wiring for branch metadata remains planned in `IFC-V1-002`.
- Mission Control rendering for branch metadata remains planned in `FE-V1-011`.
