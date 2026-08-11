# Tasks

Current execution queue only. Detailed cards and historical evidence live in `docs/tracking/backlog/`.

## Rules

- Execute leaf tasks from this queue unless the user changes priority.
- `ready` requires every task dependency done and validation known.
- Keep completed history out of this file; completion remains in the owning backlog/artifact.
- React screen implementation must use the selected Focus Rail assets and design system under `DEC-028`; unapproved cross-option drift is not allowed.
- Do not use tmux/fake-Codex evidence to complete the selected app-server runtime.
- Do not use direct-LAN/custom-CA evidence to complete the selected remote path, and do not implement Tailscale behavior before `IFC-V1-070` freezes it.
- Update status only for handoff truth and run `pnpm check:planning` before completion/commit.

## Current Next Queue

| Order | Task | Status | Blocked by | Why next |
| --- | --- | --- | --- | --- |
| 1 | `FE-V1-090` Mobile dashboard physical hardening | in_progress | none | Run one distinct immutable candidate immediately after the phone is proven awake/unlocked; retain and deploy only a complete no-retry pass. |
| 2 | `REL-V1-101` Native CI matrix | ready | none | Establish required Ubuntu/Windows checks early so every native implementation leaf is exercised on its owning OS. |
| 3 | `DAT-V1-100` Platform path boundary | ready | none | Preserve the proven Linux path behavior behind the shared adapter contract before adding Windows ACL semantics. |
| 4 | `DAT-V1-102` Cross-platform locks | ready | none | Remove the Linux-only native lock dependency from the future Windows package path. |
| 5 | `IFC-V1-101` Native package identity | ready | none | Bind every future native artifact and bundled runtime to an exact fail-closed manifest before building packages. |
| 6 | `IFC-V1-100` Platform Tailscale adapter | ready | none | Generalize command discovery and execution while preserving the selected profile/Serve contract. |
| 7 | `INT-V1-100` Windows Codex transport spike | ready | none | Run on the native Windows CI path once the runner workflow can retain redacted evidence. |

`BUG-078` / `FE-V1-106` is closed, and later candidates crossed the corrected stream-recovery boundary. Candidate `61485d2` passed immutable package and 83/1 driver gates but found the phone asleep/locked before app interaction; exact cleanup passed, no evidence was published, and it will not be retried. The next candidate must start immediately after the device wake/unlock gate.

## Intentional Blockers

| Gate | Owner | Blocker | Unblocks |
| --- | --- | --- | --- |
| Release | `REL-V1-010` | All module hardening, clean package/service/remote-phone/profile/security evidence, human acceptance | V1 release and V2 planning. |
| Native distribution | `REL-V1-108` | Native Ubuntu/Windows packages, lifecycle, signing, clean-host acceptance, docs, and aggregate Android evidence | First distributable V1 release candidate. |

## Status Vocabulary

- `ready`: all task dependencies are done and scope/evidence are executable.
- `todo`: defined and ordered behind unfinished task dependencies.
- `blocked`: requires human choice, physical device/account/consent, or external state beyond task dependencies.
- `in_progress`: active work.
- `done`: current wording and evidence are complete.
- `deferred`: explicitly outside V1.
