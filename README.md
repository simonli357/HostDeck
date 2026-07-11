# HostDeck

HostDeck is a local-first, phone-first control plane for one Ubuntu user supervising multiple Codex threads. A private host service integrates with a version-gated Codex app-server, while a responsive dashboard presents structured session state, approvals, prompts, and primary model/goal/plan controls without exposing a shell to the phone.

## Current State

HostDeck is under active V1 development and is **not release ready**. The normalized contracts, selected Codex adapter, durable state foundations, and several Fastify/SSE boundaries are implemented, but the assembled runtime, HTTPS phone enrollment, production package/service path, approved mobile design, and release evidence are still incomplete.

- Start with [current status](docs/status.md) for the active task, blockers, and validation truth.
- Use the [execution queue](docs/tracking/06-tasks.md) for the current dependency-aware next work.
- Read the [end goal](docs/planning/00-end-goal.md) and [roadmap](docs/planning/00-roadmap.md) for product scope.
- Do not treat package-level tests or the legacy tmux path as proof of a production-ready V1.

## Architecture

| Layer | Responsibility |
| --- | --- |
| `packages/core` | Framework-free domain state, deadlines, eligibility, attention, and errors. |
| `packages/contracts` | Stable HostDeck API, runtime, storage, resource, and mobile schemas. |
| `packages/codex-adapter` | Private generated Codex bindings, compatibility checks, Unix-socket transport, and structured operations. |
| `packages/storage` | SQLite migrations, mappings, projections, retention, auth, audit, secure paths, and daemon lease. |
| `packages/server` | Application services plus the selected Fastify API, SSE, static, and lifecycle boundaries. |
| `packages/cli` | CLI parsing, local administration, API client, rendering, and exit contracts. |
| `packages/web` | Pre-implementation mobile view-model foundations; React screens remain gated on visual selection. |
| `packages/tmux-adapter` | Legacy evidence pending selected-runtime disposition; not the V1 production runtime. |

The phone communicates only with HostDeck. Codex app-server remains on a user-private local transport and is never exposed directly to LAN. See the [technical plan](docs/planning/04-technical-plan.md) for the complete architecture and trust model.

## Development

The supported target is Ubuntu/Linux with exact Node.js `22.22.2`, pnpm `10.29.2`, and Codex CLI `0.144.0` where selected-adapter validation is required.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm check:scaffold
pnpm check:planning
pnpm typecheck
pnpm lint
pnpm test:unit
pnpm test:contract
pnpm test:integration
```

Native dependencies and real Codex smokes require the Linux prerequisites documented in the [developer guide](docs/delivery/09-developer-guide.md). Build, E2E, packaged CLI, service, and local release commands intentionally fail loudly until their owning tasks are implemented.

## Repository Workflow

Planning and implementation are dependency-driven. Work from ready leaf tasks, preserve the release no-go until production evidence exists, and keep documentation changes scoped to the owning files.

- Workflow and document ownership: [docs map](docs/README.md)
- Engineering standards: [engineering style](docs/engineering-style.md)
- Validation strategy: [test plan](docs/planning/04b-test-plan.md)
- Repository map: [repo guide](docs/delivery/10-repo-guide.md)
- Copy-paste commands: [command reference](docs/delivery/11-command-reference.md)
