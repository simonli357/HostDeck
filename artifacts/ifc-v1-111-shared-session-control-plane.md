# IFC-V1-111 Shared Session Control Plane

Status: passed

## Result

- `codexdeck broker start|status|stop` owns the standard Codex broker lifecycle without exposing its socket path.
- Selected read, event, stream, write, control, archive, and resume routes accept a native Codex UUID or internal `sess_` compatibility id and verify the response mapping against both identities.
- Human CLI help, start output, and list output present the native Codex UUID; plain `codex resume <uuid>` replaces private `--remote` resume arguments.
- Discover/adopt/unmanage grammar, clients, routes, services, registrations, tests, and package reachability are removed. Historical storage/audit contracts remain readable.
- Production foreground and service composition attach to automatic enrollment on the shared broker. Closing HostDeck leaves that broker and ordinary Codex clients running.
- The selected surface is 35 routes through 22 API/SSE registrations; production adds one static registration. The deterministic package closure is 658 sources and excludes manual-adoption and private-supervisor modules.

## Validation

| Gate | Result |
| --- | --- |
| Workspace | Typecheck and lint/package exports passed. Unit: 285 files, 3,225 passed and 31 intentional skips. Contract: 44 files, 308 passed. Integration: 21 files, 36 passed. |
| Control plane | Parser, help/rendering, clients, dual-id route resolution, conflict rejection, manifest/composition, resume, prompt loopback, stream target view, and production foreground/resource tests passed. |
| Runtime | Exact Codex 0.147.0 shared-broker, automatic-enrollment, production-composition, and foreground-restart smokes passed with isolated standard sockets and complete cleanup. HostDeck detach preserved the broker. |
| Package | `pnpm test:package` passed from source commit `83a47c0`: 43 package contracts, two deterministic builds, 6,343 entries, 658 sources, and read-only relocated CLI/import/Fastify/config/static/integrity smoke. The host's foreign active installation produced only the exact safe uninstall ownership refusal, so destructive uninstall variants remained inapplicable. |
| Static/manual | The 658-module/24-external runtime boundary, planning checker, diff checks, built `--help`/`--version`, and built `broker status --json` passed. The socket-permission fixture also passed four concurrent stress runs after atomic `0600` creation. |

## Remaining Boundary

- `IFC-V1-112` and `FE-V1-107` own live Mission Control catalog updates without polling or manual refresh.
- `INT-V1-114` owns aggregate runtime race/failure/resource hardening.
- `IFC-V1-113` owns Ubuntu systemd/package migration from the historical private runtime unit to the standard shared broker. Release remains no-go until those tasks, physical Android acceptance, and `REL-V1-110` pass.
