# Developer Guide

Owns setup context, environment policy, services, and operational notes.

## Setup

- Runtime: Node.js `22.22.2` pinned in `.nvmrc`.
- Package manager: `pnpm 10.29.2` pinned in `package.json`.
- Install: `corepack enable`, then `pnpm install --frozen-lockfile`.
- Env file: none required for the scaffold.
- Local services: none required for the scaffold.

## Development

| Purpose | Command | Notes |
| --- | --- | --- |
| Install | `pnpm install --frozen-lockfile` | Uses the committed `pnpm-lock.yaml`. |
| Scaffold check | `pnpm check:scaffold` | Verifies root files, package directories, and root script names. |
| Typecheck | `pnpm typecheck` | Runs a strict TypeScript no-emit check across package source files. |
| Lint | `pnpm lint` | Runs Biome plus package export convention checks. |
| Unit tests | `pnpm test` or `pnpm test:unit` | Runs Vitest unit tests. |
| Contract tests | `pnpm test:contract` | Runs Vitest contract tests for shared schemas. |
| Later tests | `pnpm test:integration`, `pnpm test:tmux`, `pnpm test:web`, `pnpm test:e2e` | Placeholders; fail loudly until their owning tasks implement them. |
| Build/package | `pnpm build` | Placeholder; fails loudly until release/build tasks implement it. |
| Local smoke | `pnpm smoke:local` | Placeholder; fails loudly until release smoke exists. |

## Operations

- Secrets: none created by the scaffold.
- Data/reset: remove `node_modules/` and rerun `pnpm install --frozen-lockfile`.
- Logs/artifacts: task evidence lives under `artifacts/`.
- Common failures: placeholder scripts exiting nonzero are expected until the referenced owning task replaces them.
