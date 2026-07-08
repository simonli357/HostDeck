# Command Reference

Copy-paste commands only. Put explanation in `docs/delivery/09-developer-guide.md`.

## Setup

```bash
corepack enable
pnpm install --frozen-lockfile
```

## Run

```bash
pnpm check:scaffold
```

## Test

```bash
pnpm typecheck
pnpm test
pnpm test:unit
pnpm lint
pnpm test:contract
pnpm test:integration
pnpm test:tmux
pnpm test:web
pnpm test:e2e
```

## Build / Package

```bash
pnpm build
```

## Release / Handoff

```bash
pnpm smoke:local
```
