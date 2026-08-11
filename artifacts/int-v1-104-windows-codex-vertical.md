# INT-V1-104 Windows Codex Vertical

Status: blocked on an authenticated native Windows Codex host

## Frozen Acceptance

- Run once, without retry, on native Windows x64 from one clean commit with exact Codex `0.144.0` and real authenticated model turns; skips, fake model responses, alternate runtimes, and partial aggregates fail.
- Use the production endpoint transport, Windows supervisor, structured clients, controls, event pipeline, persistence, reconnect controller, reconciliation lifecycle, and platform TUI command rather than a second protocol implementation.
- Create and isolate two durable managed threads; prove prompt streaming, pending model and Plan application, passive goal state, usage/skills/compact utilities, one approved side effect, interruption, archive, and authoritative read-back.
- Kill the owned app-server while admitted. Revoke the old token/port, rotate both on restart, expose one monotonic transport generation, reject stale callbacks, reconcile and resubscribe exactly once, and admit writes only after durable continuity is restored.
- Keep a Windows TUI attached to the exact current thread while HostDeck remains usable, with authority present only in the child environment and absent from argv, output, errors, reports, and serialized state.
- Close every connection, TUI, owned process tree, listener, database, lock, credential file, and temporary root. Cleanup failure fails the aggregate and retains bounded secret-free diagnostics.

## Required Evidence

| Layer | Required result |
| --- | --- |
| Deterministic | Rotating transport normal, invalid, abort, replacement, stale-event, concurrency, generation, privacy, and cleanup tests pass. |
| Native no-model | Exact Windows supervisor plus production transport prove authenticated connect, forced crash, token/port rotation, reconnect, stale-authority rejection, and cleanup. |
| Native aggregate | One no-retry model-backed report records all frozen acceptance claims, exact source/runtime identity, bounded counts, and zero leaked authority. |
| Workspace | Focused, unit, contract, integration, typecheck, lint/export, package/runtime-boundary, frozen-install, and vulnerability gates pass. |

The native aggregate remains the completion authority; deterministic or no-model evidence cannot substitute for it.
