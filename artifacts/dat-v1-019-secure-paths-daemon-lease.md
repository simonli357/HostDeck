# DAT-V1-019 Secure Paths And Daemon Lease

Date: 2026-07-09

## Scope

Enforce canonical owner-only local paths, stable Linux daemon ownership, and reverse-order startup/service cleanup before selected runtime supervision and packaging consume these boundaries.

## Harsh Success Criteria

- Purely resolve bounded absolute, non-overlapping config/state/runtime paths and an in-state database path before filesystem mutation.
- Bootstrap only the mode-`0700` state directory and mode-`0600` stable lease file before lock acquisition.
- Reject symlinks, non-canonical ancestors, wrong owner/type, hard-linked sensitive files, invalid modes, and descriptor/path substitution.
- Repair only current-user mode drift and return exact path/kind/from/to evidence.
- Acquire a nonblocking kernel lock before config/runtime/database/network/socket/app-server mutation.
- Make a second daemon fail before those mutations; release after every later failure and idempotent shutdown.
- Reacquire an unlocked stale lease or a lease whose owner died without PID polling or stale-time heuristics.
- Validate database, socket, private-key, and certificate ownership/type/mode without reading or logging secret contents.

## Audit Findings And Fixes

1. The initial implementation prepared config/runtime paths before checking daemon ownership. It was split into pure resolution, minimal state/lease bootstrap, lock acquisition, and post-lock owner mutation. A second-owner test uses alternate nonexistent config/runtime paths and proves they remain absent.
2. The initial lease validator closed and reopened the path before `flock`, leaving a substitution interval. Secure regular-file open now retains a validated descriptor, compares device/inode to the canonical path, opens a validated writable copy when required, and rechecks before/after lock metadata writes.
3. SQLite cannot consume the validator's descriptor directly. Startup and local-admin therefore hold a separate identity guard across SQLite open/migration and reject if the path changes before releasing that guard.
4. Existing non-regular files are rejected by `lstat` before open; `O_NONBLOCK|O_NOFOLLOW` remains on descriptor opens to prevent a raced FIFO/device path from hanging startup.
5. Programmatic startup previously resolved relative inputs silently. It now rejects them; CLI-relative overrides are normalized to absolute paths before crossing the startup boundary.
6. Runtime-parent validation now requires exact owner/mode `0700`, including special bits. Config/state/runtime directories cannot overlap, and database overrides cannot leave state or collide with reserved lease/socket paths.
7. The startup result initially exposed the live lease object. That capability was removed so consumers cannot release exclusivity while storage/listeners remain active.
8. Startup, local-admin, route construction, listener bind, service close, and lease metadata failures now attempt all reverse-order cleanup and preserve multiple failures with `AggregateError`.

## Dependency And Reuse Decision

- Pinned `fs-ext` 2.1.1 provides synchronous Linux `flock(2)` against the validated open descriptor. Node 22.22.2 has no first-party flock API.
- A directory/mtime lockfile library was rejected because its stale-owner timeout/heartbeat model does not provide the selected kernel-held lock or immediate process-death release.
- `pnpm view fs-ext` confirmed 2.1.1 is current; publication metadata is dated 2024-11-04. The addon compiled/loaded on pinned Node 22.22.2.
- `pnpm licenses list --prod` classified `fs-ext` and its `nan` dependency as MIT. `pnpm audit --prod` reported no known production vulnerabilities.
- `pnpm-workspace.yaml` explicitly allows the native build. Clean Ubuntu compiler/toolchain coverage remains a release gate even though forced frozen offline install and `pnpm rebuild fs-ext` pass here.

## Hostile Matrix Covered

- Relative/root/control/overlapping/escaping/reserved paths and malformed derived-path objects.
- Final and ancestor symlinks without target mutation; wrong owner; wrong directory/file/socket type; hard-linked database/lease; over-permissive and zero-permission files; special runtime-parent bits.
- Strict key/certificate modes, real Unix-socket mode repair, invalid socket mode, and socket-as-file rejection.
- Validated descriptor rename/replacement and database substitution during SQLite open.
- Single owner, same-process second owner, second service owner before DB/bind/runtime mutation, stale metadata replacement, idempotent release, later tmux failure, final HTTP bind failure, and restart.
- Separate child process holds the real native lock; parent rejects; child receives `SIGKILL`; parent immediately reacquires.
- Real migrated database/lease/config/state/runtime mode inspection and returned repair records.

## Validation

- `pnpm install --frozen-lockfile --offline --force`
- `pnpm rebuild fs-ext`
- `pnpm check:scaffold`
- `pnpm check:planning`
- `pnpm check:codex-bindings`
- `pnpm typecheck`
- `pnpm -r typecheck`
- `pnpm lint`
- `pnpm test:unit`: 386 passed, 4 opt-in smokes skipped
- `pnpm test:contract`: 105 passed
- `pnpm test:integration`: 16 passed, including process crash/reacquire
- `pnpm test:web`: 14 passed
- `pnpm exec vitest run packages/storage/src`: 83 passed
- `pnpm exec vitest run tests/service-mode-smoke.test.ts`: 2 passed
- `pnpm licenses list --prod --json`
- `pnpm audit --prod`: no known vulnerabilities
- `git diff --check`

## Remaining Boundaries

- Linux DAC protects against other users, and `flock` coordinates cooperating HostDeck daemons. Neither mechanism is a sandbox against a malicious process already running as the same uid and able to rename/unlink user-owned paths.
- App-server socket and LAN certificate creation consume these validators in `INT-V1-007` and `IFC-V1-015`; this task proves the filesystem primitives, not those later runtime/enrollment workflows.
- A clean normal-user Ubuntu install/service run still owns compiler availability, packaging, systemd integration, and crash/reboot evidence under release tasks.
- Production Fastify/SSE shutdown and bounded deadlines remain `IFC-V1-016`/later interface hardening.
- This completes `DAT-V1-019`, not `BLK-V1-02` or V1 release readiness.
