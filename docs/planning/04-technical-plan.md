# Technical Plan

Owns active-version high-level architecture, dependencies, services, environment, security, and setup policy. Detailed module design and sequencing belong in `docs/planning/04a-implementation-blueprint.md`.

## Architecture

| Layer | Responsibility | Notes |
| --- | --- | --- |
| Domain/core | Product rules and state |  |
| Adapters | Storage, network, OS, services |  |
| UI | Presentation and interaction |  |

## Cross-Block Interfaces

Blocks own local design; this table owns the system-level contracts between blocks.

| From block | To block | Contract / dependency | Failure behavior |
| --- | --- | --- | --- |
| BLK-V1-01 |  |  |  |

## Environment

| Item | Decision |
| --- | --- |
| Runtime |  |
| Package manager |  |
| Local services |  |
| Docker/devcontainer policy |  |
| Secret handling |  |

## Dependencies

| Dependency | Version/source | License | Why | Risk |
| --- | --- | --- | --- | --- |
|  |  |  |  |  |

## Reuse Checks

| Capability | Candidates checked | Decision |
| --- | --- | --- |
|  |  |  |

## Data, Privacy, Security

- Data stored:
- Sensitive data:
- Auth/secrets:
- Failure policy:
- Observability:

## Architecture Decisions To Resolve

| Question | Options | Recommended default | Owner |
| --- | --- | --- | --- |
|  |  |  |  |
