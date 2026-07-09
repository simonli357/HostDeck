# REL-V1-001 Validation Wiring

Date: 2026-07-08

## Scope

- Verified root validation command names from `docs/planning/04b-test-plan.md` and `docs/delivery/11-command-reference.md`.
- Corrected placeholder ownership so unavailable commands point at future owner tasks instead of completed or current wiring tasks.
- Confirmed `artifacts/` is documented as the location for detailed future evidence in `docs/delivery/09-developer-guide.md` and `docs/delivery/10-repo-guide.md`.

## Command Wiring

| Command | Current behavior | Owner / blocker |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | Implemented install check. | Current workspace |
| `pnpm check:scaffold` | Implemented scaffold validation. | Current workspace |
| `pnpm typecheck` | Implemented root TypeScript check. | Current workspace |
| `pnpm lint` | Implemented Biome and package-export checks. | Current workspace |
| `pnpm test`, `pnpm test:unit` | Implemented Vitest unit suite. | Current workspace |
| `pnpm test:contract` | Implemented Vitest contract suite. | Current workspace |
| `pnpm test:integration` | Fails loudly through `scripts/not-implemented.mjs`. | `IFC-V1-014` |
| `pnpm test:tmux` | Fails loudly through `scripts/not-implemented.mjs`. | `INT-V1-016` |
| `pnpm test:web` | Fails loudly through `scripts/not-implemented.mjs`. | `FE-V1-001` |
| `pnpm test:e2e` | Fails loudly through `scripts/not-implemented.mjs`. | `REL-V1-007` |
| `pnpm build` | Fails loudly through `scripts/not-implemented.mjs`. | `REL-V1-007` |
| `pnpm smoke:local` | Fails loudly through `scripts/not-implemented.mjs`. | `REL-V1-006` |

## Validation

- `pnpm check:scaffold` passed.
- `pnpm install --frozen-lockfile` passed.
- `pnpm typecheck` passed.
- `pnpm lint` passed.
- `pnpm test` passed with 102 tests across 17 files.
- `pnpm test:contract` passed with 37 tests across 4 files.
- `pnpm test:integration` failed as expected with blocking task `IFC-V1-014`.
- `pnpm test:tmux` failed as expected with blocking task `INT-V1-016`.
- `pnpm test:web` failed as expected with blocking task `FE-V1-001`.
- `pnpm test:e2e` failed as expected with blocking task `REL-V1-007`.
- `pnpm build` failed as expected with blocking task `REL-V1-007`.
- `pnpm smoke:local` failed as expected with blocking task `REL-V1-006`.
- `git diff --check` passed.

## Remaining Gaps

- This task does not implement integration, tmux, web, E2E, build, or local smoke commands.
- `REL-V1-007` must later run the aggregate validation path or record validated gaps.
- `REL-V1-006` must later provide clean local install/run smoke evidence when runtime behavior exists.
