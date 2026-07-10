# Bug Log

Owns accepted bugs, triage, routing, fix evidence, and closure.

Humans can report bugs in any format. The agent should extract the useful details, choose a route, and ask only for blocking reproduction, environment, or priority details.

| ID | Symptom | Severity | Route | Status | Owning task | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| BUG-001 | Selected-path backlog rows pass graph checks while still bundling independent implementation outcomes. | High | Spike / planning bug | Closed | `FND-V1-017` | `artifacts/fnd-v1-017-selected-backlog-granularity.md`; planning commit `481cb44`. |

## Routing

| Route | Use when | Backlog interaction |
| --- | --- | --- |
| Small | Local root cause, clear expected behavior, no planning change | Fix directly; link existing task if relevant |
| Backlog | Multi-step fix or affects planned/completed work | Create or update leaf task(s), add `BUG-*` refs, update blockers if needed |
| Spike | Root cause or expected behavior is unclear | Create triage/spike task before implementation |
| Release blocker | Blocks acceptance, data integrity, security/privacy, install/run, deployment, or critical flow | Mark blocker in status/release tracking and prioritize blocking task(s) |

## Bug Template

```md
### BUG-000 Name

- Symptom:
- Impact:
- Route:
- Related requirements:
- Affected / owning task:
- Blocks:
- Root cause:
- Fix:
- Validation:
- Closed by:
```

### BUG-001 Selected Backlog Granularity

- Symptom: unfinished selected-path rows such as `DAT-V1-020`, `INT-V1-006`, and `IFC-V1-017` to `IFC-V1-021` contain independent outcomes that cannot be handed off without architecture decisions during implementation.
- Impact: dependency readiness and V1 completion can look stronger than the executable leaf backlog really is.
- Route: planning bug; implementation leaves are gated while the remaining selected backlog is audited and decomposed.
- Related requirements: all active V1 requirements through their existing owners; no product scope change.
- Affected / owning task: `FND-V1-017`.
- Blocks: resolved; affected execution now uses handoff-sized leaves, with deliberate spikes/acceptance/hardening gates classified explicitly.
- Root cause: `check:planning` validates graph/trace/status integrity but cannot determine semantic task breadth.
- Fix: classify every unfinished row, split independent outcomes, update dependencies/traces/block maps/queue, and record intentional module-hardening/release/human-gate rollups explicitly.
- Validation: planning check, manual junior-handoff audit, before/after inventory artifact, clean diff/commit/push.
- Closed by: `FND-V1-017`; planning commit `481cb44` pushed to `origin/main`.
