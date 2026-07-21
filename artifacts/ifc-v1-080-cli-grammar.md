# IFC-V1-080 Required CLI Grammar

## Scope

- Freeze the complete `FR-011` source grammar before API, local-device, foreground, service, or package wiring.
- Preserve first-class `model`, `goal`, and `plan` commands and every accepted operation command.
- Keep all newly staged behavior explicit; this leaf does not claim runnable status/list/device/revoke, foreground serve, service lifecycle, or a packaged `codexdeck` binary.

## Implementation

- Added exact parser variants and help forms for `serve`, `status`, paginated `list`, paginated `devices`, confirmed `revoke`, and `service install|upgrade|status|start|stop|restart|uninstall`.
- Session and device cursors parse through their selected contracts. Page limits accept only canonical decimal integers from 1 through 100, and revoke accepts one selected device id plus exactly one `--confirm`.
- Global connection/state flags are accepted only before the command. Duplicate global aliases, duplicate `--json`, duplicate start/list/device/revoke options, conflicting help/version forms, option injection, invalid terminators, unknown actions, and extra arguments fail with usage exit before configuration or client work.
- Help and version remain configuration-free. Newly parsed commands return bounded `capability_unavailable` without config, filesystem, network, or process work until their owning implementation leaves replace the staged branch.
- No `lan`, historical serve, source runner, tmux, direct-LAN, certificate, or profile-switch path was added.

## Validation

| Gate | Result |
| --- | --- |
| Focused CLI contract | 12 tests pass, including all required forms, all seven service actions, hostile/duplicate input, removed commands, and zero-side-effect staged behavior. |
| Unit | 181 files / 1,773 tests pass; 25 files / 26 external tests skip explicitly. |
| Contract | 32 files / 240 tests pass. |
| Static | Root and CLI typecheck, Biome/package exports over 511 files and 8 packages, scaffold, planning, runtime-boundary, and `git diff --check` pass. |
| Planning | 218 tasks, 84 requirements, 670 dependencies, and the corrected queue pass. |

Implementation: `f13e53e`.

## Downstream

- `IFC-V1-084` replaces staged status/list/revoke behavior with bounded selected-route clients, renderers, and source dispatch.
- `IFC-V1-085` replaces staged devices behavior with the secure read-only local application path required by `DEC-024`.
- `IFC-V1-081` to `IFC-V1-083` own foreground resources, application composition, and serve lifecycle; `IFC-V1-054` owns final compiled process/bin integration.
- `IFC-V1-056` and `IFC-V1-057` own service lifecycle and uninstall implementation. No phone evidence is required for this grammar leaf.
