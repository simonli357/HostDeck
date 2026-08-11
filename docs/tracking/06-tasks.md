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
| 1 | `FE-V1-090` Mobile dashboard physical hardening | blocked | phone unavailable | Diagnose physical touch delivery and run one distinct immutable candidate when the phone returns; retain only a complete no-retry pass. |
| 2 | `IFC-V1-100` Platform Tailscale adapter | ready | none | Generalize command discovery and execution while preserving the selected profile/Serve contract. |
| 3 | `INT-V1-100` Windows Codex transport spike | ready | none | Use the accepted native Windows CI path for a redacted exact-runtime capture. |
| 4 | `DAT-V1-103` Native storage parity | ready | none | Prove target-built SQLite migration, recovery, backup, and rollback parity now that native paths and locks are complete. |
| 5 | `REL-V1-102` Native supply-chain metadata | ready | none | Build checksums, SBOM, license, and provenance contracts now that package identity and native CI are complete. |

`IFC-V1-101` is complete at `c0f3f4d` through native run `31471194169`; `DAT-V1-101` remains complete at `9663834` through run `31468773680`. The latest `FE-V1-090` branch candidate `6829bd2` reached a stable first continuation target but delivered no request after the tap; no acceptance evidence was retained. The next phone run must use a distinct commit after touch-delivery diagnosis.

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
