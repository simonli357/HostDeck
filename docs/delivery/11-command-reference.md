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

## CLI Surface

```bash
# Packaged codexdeck binary is pending REL-V1-003; these command forms are implemented in the CLI shell.
codexdeck serve --state-dir ~/.local/state/hostdeck --port 3777
codexdeck status
codexdeck start --name demo --cwd /path/to/worktree
codexdeck list
codexdeck send demo "Continue"
codexdeck attach demo
codexdeck stop demo
codexdeck pair --label phone --ttl-minutes 10
codexdeck lock --reason "maintenance"
codexdeck unlock
codexdeck lan enable --bind-host 0.0.0.0
codexdeck lan disable
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
