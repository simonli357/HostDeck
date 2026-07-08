# Backlog Index

Execution map for the release. Detailed task cards live in the group files. Capability blocks live in `docs/planning/05-blocks/`.

## Program Area Profiles

Choose or adapt one profile after planning. Profiles are starting points, not mandatory modules. Do not seed auth, lobby, currency, hardware, or UI/interface-fidelity work unless the active version requires it.

### Web App

| Program area | Typical epics | Prefix |
| --- | --- | --- |
| Frontend | Pages, components, state, accessibility, visual fidelity | `FE-V1-*` |
| Backend | API, auth if needed, services, background jobs | `BE-V1-*` |
| Data | Schema, migrations, import/export, redaction | `DAT-V1-*` |
| Infrastructure | Hosting, CI/CD, env, observability | `OPS-V1-*` |

### Mobile App

| Program area | Typical epics | Prefix |
| --- | --- | --- |
| Mobile UI | Screens, navigation, device states, accessibility | `MOB-V1-*` |
| Native Capabilities | Camera, location, notifications, storage, permissions | `NAT-V1-*` |
| Data / Sync | Local data, API sync, offline behavior, migrations | `DAT-V1-*` |
| Store Release | Device QA, signing, privacy labels, release metadata | `REL-V1-*` |

### Desktop App

| Program area | Typical epics | Prefix |
| --- | --- | --- |
| Shell / UI | Windows, menus, shortcuts, accessibility, visual fidelity | `UI-V1-*` |
| Local System | Files, OS integration, permissions, background processes | `SYS-V1-*` |
| Persistence | Local storage, migrations, import/export, redaction | `DAT-V1-*` |
| Packaging | Installers, signing, updates, smoke tests | `REL-V1-*` |

### General Program / CLI

| Program area | Typical epics | Prefix |
| --- | --- | --- |
| Core Logic | Algorithms, validation, transformations, workflows | `CORE-V1-*` |
| Interface | CLI/API/config/files/jobs/notebooks | `IFC-V1-*` |
| Integrations | External services, adapters, import/export | `INT-V1-*` |
| Release | Packaging, docs, examples, reproducibility | `REL-V1-*` |

### Robotics / Hardware

| Program area | Typical epics | Prefix |
| --- | --- | --- |
| Simulation | Sim environment, fixtures, virtual sensors | `SIM-V1-*` |
| Perception | Sensor parsing, filtering, world model | `PER-V1-*` |
| Planning / Control | Path planning, control loops, fail-safes | `CTL-V1-*` |
| Hardware Interface | Motors, sensors, drivers, HIL | `HW-V1-*` |
| Safety | Timeout, e-stop, degraded mode | `SAFE-V1-*` |

### Game

| Program area | Typical epics | Prefix |
| --- | --- | --- |
| Core Loop | Player, rules, win/loss, progression | `GAME-V1-*` |
| Systems | Physics, AI, inventory, combat, save/load | `SYS-V1-*` |
| Content | Levels, assets, audio, animation | `CNT-V1-*` |
| Performance | FPS, memory, loading, platform checks | `PERF-V1-*` |

## Selected Program Areas

Replace these rows after planning with the chosen profile or blend.

| Program area | Block refs | Group file | Typical epics | Leaf task prefix |
| --- | --- | --- | --- | --- |
| Foundation / Contracts | `BLK-V1-01` | `foundation.md` | Active-version contracts, fixtures, first runnable path | `FND-V1-*` |

## Backlog Quality Gates

Before implementation starts, the backlog must satisfy these checks:

- Every active-version requirement maps to at least one leaf task, explicit spike, or explicit release deferral.
- Every required V1 block in `docs/planning/05-blocks/00-index.md` maps to backlog epics, leaf tasks, validation evidence, and a completion-matrix row.
- Every selected program area has a group file with epics, leaf tasks, dependencies, success criteria, and validation/evidence.
- Every user-facing screen group has state coverage, accessibility/fidelity validation, and asset tasks when UI exists.
- Every native capability, service, data store, account, certificate, or permission has setup, denial/failure-state, and validation tasks.
- Every module or workflow has a module-hardening task with strict success criteria and simulator/device inspection where applicable.
- Release readiness is represented with build/package, device QA, signing, privacy labels, docs/support, and human acceptance gates.
- No `TBD` placeholder remains outside intentionally blocked human decisions, spikes, or explicit deferrals.

## Dependency Graph

Track only meaningful ordering dependencies here. Do not duplicate every task row.

| Block/task | Enables | Notes |
| --- | --- | --- |
| TBD | TBD | Replace with block and task IDs after planning. |

## Ordering Rules

Prefer this order unless the product needs a different dependency chain:

1. Contracts and data models.
2. Fixtures, mocks, and sample data.
3. Core/headless logic.
4. Native adapters and permission flows.
5. UI consuming existing contracts.
6. Error, empty, loading, and failure states.
7. Persistence, sync, import/export, and redaction.
8. Performance, accessibility, privacy, and security hardening.
9. Device QA, signing, and store release gates.
10. Human acceptance.
