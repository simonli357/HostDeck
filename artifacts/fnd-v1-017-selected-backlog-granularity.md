# FND-V1-017 Selected Backlog Granularity Audit

## Scope

- Trigger: `BUG-001` showed that the selected-path graph could pass mechanically while unfinished rows still bundled independent implementation outcomes.
- Audited: every unfinished selected data, runtime, interface, frontend, hardening, release, spike, and human-gate row.
- Rule: an implementation leaf must be assignable without choosing product scope, architecture, security policy, dependency strategy, or validation design while coding.
- No product scope or product code changed in this task.

## Inventory

| Checkpoint | Tasks | `Blocked by` edges | Notes |
| --- | ---: | ---: | --- |
| Pushed baseline `0064c31` | 104 | 262 | Before the Fastify boundary split and cross-block audit. |
| Immediate pre-audit working graph | 108 | 277 | Four Fastify foundation leaves had exposed the broader granularity defect. |
| Final decomposed graph | 196 | 622 | 84 requirements; every added id is dependency-checked and traced through owning docs. |

Relative to `0064c31`, the final graph adds 92 task cards: 1 foundation audit, 9 data, 16 runtime, 48 interface, and 18 frontend cards. The requirement count remains 84; decomposition did not expand V1 scope.

## Audit Method

Each unfinished row was read against its requirements, block outcome, prerequisites, success criteria, and evidence route. A row failed when it:

- contained independently shippable outcomes or unrelated failure modes;
- mixed architecture/contract selection with production implementation;
- grouped commands or controls that had separate runtime, API, and UI owners;
- depended on a policy that was scheduled after its implementation;
- combined acceptance evidence with destructive legacy cleanup;
- could not be handed to another engineer with a single observable result.

Broad rows remain only when explicitly classified as an external/architecture/design spike, human gate, aggregate acceptance matrix, module-hardening pass, release review, or final handoff gate.

## Corrections

### Data

- Split production append, retention/boundaries, audit state, startup retention, orphan accepted-operation reconciliation, CSRF rotation, device listing, authentication last-used updates, revoke, pairing rate/claim, and security audit catalog.
- Kept commit-before-publish and accepted-to-terminal audit truth as separate owning boundaries.
- Separated device listing, last-used mutation, and revoke because their authorization, concurrency, and recovery evidence differ.

### Runtime

- Kept `INT-V1-006` as a bounded real-Codex semantic spike, then split event normalization, prompt, model, goal, plan, usage, compact, skills, approval, and interrupt ports.
- Split process supervision, reconnect, app-server crash reconciliation, HostDeck-only restart, TUI coexistence, aggregate lifecycle acceptance, and legacy tmux disposition.
- Real aggregate tasks cannot be satisfied by fake Codex or historical tmux evidence.

### Interface

- Moved the resource-budget/deadline contract before Fastify, SSE, lifecycle, and browser client implementation.
- Split stack selection, typed app, SSE transport, static boundary, listener lifecycle, trust gate, cookie auth, CSRF, pair, device list, revoke, lock, LAN, security audit executor, and security acceptance.
- Split route-manifest selection from the reusable exact-target write gate.
- Split host status, session list/detail, event diagnostics, start, resume, archive, prompt, model, goal, plan, usage, compact, skills, approval, and interrupt routes.
- Split selected API/CLI acceptance from legacy custom-listener/raw/tmux route disposition.
- Split HTTP, SSE, idempotency/concurrency, end-to-end deadline, CLI bounds, resource acceptance, build outputs, web assets, binary, user units, service lifecycle, uninstall, and clean parity.

### Frontend

- Kept mobile state/interaction design, two visual options, and human selection ahead of React screen implementation.
- Split HTTP, SSE, CSRF, and shell state clients from Mission Control and Session Detail.
- Split prompt, model, goal, plan, usage, compact, skills, approval, access, CSRF recovery, devices/revoke, lock, LAN/certificate, compatibility, diagnostics, interrupt, archive, and TUI-resume surfaces.
- Classified cross-screen state, responsive, accessibility, browser, fidelity, copy, and real-device tasks as explicit acceptance/hardening gates.

## Deliberate Aggregate Rows

- External/architecture/design: `INT-V1-006`, `IFC-V1-015`, `IFC-V1-016`, `FE-V1-004`, `FE-V1-002`, human `FE-V1-003`.
- Real/integration acceptance: `INT-V1-027`, `INT-V1-030` to `INT-V1-032`, `IFC-V1-033`, `IFC-V1-038`, `IFC-V1-046`, `IFC-V1-052`, `IFC-V1-058`, `FE-V1-015`, `FE-V1-040`.
- Module/fidelity hardening: `DAT-V1-091`, `INT-V1-091`, `IFC-V1-091`, `FE-V1-016`, `FE-V1-039`, `FE-V1-017`, `FE-V1-018`, `FE-V1-090`.
- Release/docs/handoff: `REL-V1-004` to `REL-V1-010`, `REL-V1-999`.
- Legacy cleanup remains bounded and separate: `INT-V1-008`, `IFC-V1-067`.

These rows verify or close a defined body of leaf work. They are not valid substitutes for unfinished implementation leaves.

## Dependency Rules Confirmed

- `Blocked by` is the authoritative complete execution graph; `Blocks` is a concise downstream-impact index.
- Real Codex semantics precede operation implementation and the mobile state/mockup gate.
- Resource units, limits, deadlines, and cancellation ownership precede transport/client implementation.
- Route manifest precedes routes; trust/CSRF/lock/audit plus the real runtime precede the write gate; the write gate precedes selected mutations.
- Selected API acceptance precedes legacy listener removal; selected-only composition and resource acceptance precede packaging.
- UI implementation remains blocked by real structured state, two replacement mobile directions, and human selection.

## Validation

- `pnpm check:planning`: 5 checker tests pass; repository reports 196 tasks, 84 requirements, 622 dependency edges, and 2 current queue rows while this audit is active.
- The checker proves unique/known ids, requirement coverage, range expansion, acyclic dependencies, status/readiness rules, and queue agreement.
- Manual junior-handoff review covered every unfinished row and every deliberate aggregate exception above.
- Requirement traces, block task maps/completion matrix, blueprint stages/races, test ownership, delivery maturity, queue, status, and critical graph were synchronized.
- `git diff --check` passes.

## Result

`BUG-001` is resolved when this artifact and synchronized owner docs are committed. The next independent ready work is the exact Fastify stack spike, real Codex semantic spike, production append transaction, audit state machine, and physical HTTPS phone proof; only one becomes active at a time.
