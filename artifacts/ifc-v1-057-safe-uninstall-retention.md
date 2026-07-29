# IFC-V1-057 Safe Uninstall And Release Retention

## Purpose

`IFC-V1-057` is complete. The packaged CLI removes only a fully proven HostDeck service installation, preserves user state/config/Codex/Tailscale, resumes journaled partial removal forward, retains only active plus immediate-previous releases after successful upgrades, and refuses ambiguous ownership before destructive work. Clean-machine parity remains `IFC-V1-058`; remote Serve mutation remains the explicit `remote disable` command.

## Audited Baseline

- `IFC-V1-056` installs immutable verified releases under one owner-only data root, selects one release through an atomic `current` symlink, and binds the environment, command, unit, manifest, enablement, runtime, and package identities in a canonical schema-1 manifest.
- Install, upgrade, status, start, stop, restart, and uninstall share one nonblocking advisory lifecycle lock and bounded no-shell `systemctl --user` adapter.
- Successful version-changing upgrade retains only the active and immediate-previous verified releases. A failed attempt remains available for inspection until the next successful upgrade removes it with older releases.
- The configured HostDeck state directory/database, general HostDeck config, Codex home/thread data, Tailscale daemon/account/node/profile/Serve state, and source checkout/package are not installer-owned deletion targets.
- The lifecycle lock lives inside the installer-owned data root. Removing that inode while another process can open a replacement would split serialization, so successful uninstall retains only the exact `0700` lifecycle root and exact locked `0600` coordination file.

## Frozen Removal And Preservation Set

| Disposition | Exact scope |
| --- | --- |
| Remove | Exact HostDeck enablement symlink, two stable user-unit symlinks, installed command symlink, stable manifest symlink, active selector, installer-owned `service.env`, every verified release directory and package/unit/manifest content, transaction/staging residue proven by the lifecycle journal, and the empty `releases/` directory. |
| Retain for coordination | `$XDG_DATA_HOME/hostdeck/` at `0700` and `lifecycle.lock` at `0600`, with no other child after successful uninstall. |
| Preserve | Configured state directory, SQLite database and sidecars, all non-service HostDeck config, `CODEX_HOME`, Codex threads/account state, source/packed invocation package, unrelated user units/commands/files, parent directories shared with other applications, and all Tailscale state. |
| Never mutate implicitly | Tailscale installation/daemon/account/node/profile, any Serve mapping, router/firewall, certificates, company profile, login lingering, system units, root-owned paths, or public/LAN listeners. |

## Retention Policy

- A successful first install has exactly one release.
- A successful upgrade retains exactly the new active release and the immediately previous verified release used for rollback. Before committing the upgrade, all other published or failed-attempt release directories must be proven exact and eligible for removal.
- Retention never removes the selected release or that upgrade's previous release. If preflight cannot prove every candidate, the upgrade refuses before selector or manager mutation.
- A post-selection cleanup failure rolls the upgrade back through the existing transaction contract; deletion may reduce obsolete history but cannot remove either rollback participant.
- Uninstall removes every proven release, including active, previous, obsolete, and failed-attempt releases. Unknown, substituted, malformed, or modified entries refuse the operation instead of being skipped or recursively deleted.

## Frozen Success Criteria

| ID | Required behavior |
| --- | --- |
| `UNS-01` | Expose exactly `codexdeck service uninstall [--json]` through the existing strict parser and packaged CLI. Invalid, duplicate, reordered, injected, or extra input rejects before config, filesystem, network, package, process, or manager side effects; no sudo/root/system-unit/alternate-init/force form exists. |
| `UNS-02` | Resolve only the current user's canonical bounded HOME/XDG layout and existing lifecycle root. A genuinely absent install returns a truthful unchanged `not_installed` result without creating lifecycle files or invoking manager mutation; a present root uses the existing nonblocking advisory lock. |
| `UNS-03` | Before mutation, inspect every existing ownership ancestor, stable anchor, selector, environment file, enablement link, transaction, release root, release manifest, generated unit, and package with no-follow semantics. Require current uid, exact type/mode/link count/target/hash/layout, secure ancestors, canonical containment, bounded UTF-8, and no traversal or overlapping delete/preserve roots. |
| `UNS-04` | Build one complete immutable uninstall plan before the first manager or filesystem mutation. Every present path must be either an exact manifest-derived removal, the retained lifecycle root/lock, or an explicit preserved path; unknown data-root entries, ambiguous manifests, mismatched environment identities, foreign hard links, and nested preserve/delete collisions refuse with zero destructive work. |
| `UNS-05` | Preserve configured state, database and sidecars, general config, audit/device/session data, Codex home/thread/account data, source invocation package, unrelated commands/units/files, and shared parent directories byte-for-byte. Only exact `service.env` is removed from the HostDeck config directory. |
| `UNS-06` | Never invoke Tailscale, mutate backend/profile/Serve/account/node state, remove Tailscale, or imply remote disable. Uninstall leaves an existing exact or foreign Serve mapping untouched and reports no remote-cleanup success; `remote disable` remains the sole explicit mapping mutation owner. |
| `UNS-07` | Before stop/disable, require each loaded HostDeck manager unit to reference the exact owned stable unit path and reject foreign fragment identity, unexpected enablement, reload-required state, or contradictory PID/active state. Missing units are acceptable only when the corresponding owned anchor is already absent in a recoverable partial uninstall. |
| `UNS-08` | For active, failed, activating, or deactivating owned units, stop HostDeck before Codex and require bounded consecutive inactive/zero-PID observations. Already stopped units cause no unnecessary stop. A stop failure removes no enablement, anchor, environment, selector, or release and leaves a retryable journaled state. |
| `UNS-09` | Disable only `hostdeck.service` through the bounded user manager, accept an already absent exact enablement as idempotent partial progress, verify the exact enablement link is absent, and never disable or edit another unit or target. Manager stderr-on-success, timeout, abort, malformed output, or failure stays actionable and bounded. |
| `UNS-10` | After stopped/disabled proof, remove exact stable anchors and selector, remove the exact environment file, delete only prevalidated release trees, remove the empty releases directory, reload the user manager, and prove both exact units are inactive, zero-PID, `not-found`, fragment-free, and not enabled. No recursive deletion begins from an unverified path. |
| `UNS-11` | Complete uninstall leaves only the exact lifecycle root and lock in installer data, with no command, unit, enablement, manifest, selector, environment, release, transaction, staging, process, socket, listener, or temporary residue. Repeated uninstall is successful, unchanged, and mutation-free; reinstall through the retained lock remains supported. |
| `UNS-12` | Missing/partial uninstall is forward-recoverable only when every remaining object proves exact ownership. Any changed symlink target, package byte, generated unit, manifest, environment file, release entry, ownership/mode/link count, or manager fragment refuses destructive removal with bounded recovery guidance and no claim of success. |
| `UNS-13` | Extend the bounded canonical lifecycle journal with explicit uninstall phases. Before filesystem deletion, failures can be retried from the stopped/disabled installation; after destructive progress begins, only forward uninstall recovery is allowed. Malformed, contradictory, missing-required, or path-unsafe journal state yields `recovery_required` and never guesses or rolls back deleted bytes. |
| `UNS-14` | Serialize uninstall, install, upgrade, start, stop, and restart through one lock. Concurrent attempts fail with `operation_conflict`; signal/abort and lock-release failures do not open a second owner or leave hidden manager/process work. Retaining the root/lock is the documented split-lock prevention boundary. |
| `UNS-15` | After every successful version-changing upgrade, retain exactly the active verified release and its immediately previous verified rollback release; remove all older and failed-attempt releases. Same-identity no-op upgrade performs no retention mutation because it has no new rollback boundary. |
| `UNS-16` | Retention preflights the complete releases directory before selector/manager mutation, rejects unknown names/types/content and tampered candidates, never follows links, and removes no current/previous release. A cleanup failure cannot strand a mixed active selector/unit identity and is surfaced through the existing rollback result. |
| `UNS-17` | Failure injection covers every manager boundary and destructive phase. Before the forward-only boundary, exact installation artifacts remain available for retry even if services were stopped; after it, the journal preserves explicit recovery. No catch-all cleanup, ignored filesystem error, fake completion, or fallback-to-force deletion is allowed. |
| `UNS-18` | Extend the strict lifecycle result/assertion/rendering contract with `action: "uninstall"`. Success reports `install_state: "not_installed"`, null release/package, disabled, non-ready API, exact inactive/not-found unit states, `changed` truth, no private paths, and stable human/JSON output; typed ownership, manager, recovery, and lock failures map to bounded existing CLI exit families. |
| `UNS-19` | Uninstall does not require a healthy HostDeck API, active Tailscale, network access, a model call, or the installed Codex runtime to start. It may require the current packaged Node process and exact owner/package evidence needed for safe deletion; unavailable runtime state is not misreported as uninstall success or used to relax ownership. |
| `UNS-20` | Update production package identity/deferral metadata and package acceptance so `service uninstall` executes from relocated read-only, package-manager, packed, global-style, and installed-command layouts. The package must retain one executable, no source/runtime-loader dependency, no uninstall helper shell, and only clean-machine parity as the remaining service-package deferral. |
| `UNS-21` | Direct tests cover active/inactive/failed units, zero/one/many releases, successful and failed upgrades, retention ordering, absent/repeated/partial uninstall, lock contention, abort, every journal phase, manager failures, tampered/foreign/missing paths, hostile names/types/modes/hard links/symlinks, preserved nested sentinels, reinstall, private output, and complete residue inventory. |
| `UNS-22` | Real current-user systemd evidence runs from a relocated verified package with exact Codex: install/start/uninstall, inactive upgraded uninstall, active upgraded uninstall, repeated uninstall, reinstall, injected recoverable failure, exact process/socket/listener/unit/file inventory, and preservation of pre-existing failed units, state/config/database/Codex sentinels, and Tailscale profile/Serve identity. |
| `UNS-23` | Focused lifecycle/CLI/manager tests, complete unit/contract/integration/web suites, exact runtime binding, scaffold/planning/runtime-boundary/typecheck/lint, deterministic build/package/browser acceptance, frozen offline install, production audit/licenses, privacy/fallback scans, and residue checks pass after implementation. |
| `UNS-24` | Closure records criteria/implementation/evidence/closure commits, exact command counts, retention and failure-phase inventories, manifest/package hashes, real-manager observations, removed and preserved paths, Tailscale noninterference, remaining clean-machine limitation, and no claim beyond this uninstall/retention leaf. |

## Implementation And Inspection

- One discriminated schema-1 lifecycle journal owns install/upgrade and the six monotonic uninstall phases `prepared`, `stopped`, `disabled`, `anchors_removed`, `releases_removed`, and `manager_reloaded` under the existing lifecycle lock.
- Fresh and resumed uninstall prove exact release/package/unit/environment/link ownership, manager fragment and enablement identity, coherent PID/state truth, preservation-path separation, and the complete data-root inventory before deletion.
- Uninstall stops HostDeck before Codex, requires two consecutive inactive/zero-PID observations, disables only `hostdeck.service`, removes exact anchors/releases, reloads the user manager, and returns strict `not_installed`/`not-found` public truth. The retained empty `0700` data root plus `0600` lock prevents split-lock races and supports reinstall.
- Successful version-changing upgrade retains the active release and immediate previous release. Same-identity upgrade is mutation-free; a failed attempt remains inspectable until the next successful upgrade removes it with older releases.
- Manual code/output review found no force-delete fallback, broad catch-and-ignore cleanup, API/Tailscale/Codex dependency, private path in lifecycle output, source-loader/helper-shell dependency, or mutation outside the exact HostDeck ownership set.

## Validation Evidence

| Layer | Result |
| --- | --- |
| Direct lifecycle | 27 tests pass, including active/inactive/failed state, absence/repetition/reinstall, lock contention, all six journal phases, manager/read-back failures, malformed journal, path/link/mode/hard-link/content/fragment drift, retention ordering/no-op/failure, missing Codex, and API independence. |
| Workspace | Unit 2,875 passed/28 intentional external-device skips; contract 245; integration 36; web 920; focused CLI contract 12; root typecheck and Biome/package exports over 803 files pass. |
| Package | Two deterministic builds and package acceptance pass across relocated read-only, package-manager, packed, global-style, and installed-command invocation. Build identity is 619 sources, 1,245 outputs, 6,466 entries, content SHA-256 `7d7566dc2bbae73acdee8f30f8eb7264a2306f15fd4df55aefb3e51a1fba92bf`, manifest SHA-256 `555c00d3d317d3db851d5e033ac9aab357d3a5d3a5e1ca8d468d08cc3317eb83`, unchanged web SHA-256 `09c04fc54c8d88ded7dff55f54e8228fc65e6eb01e851a65674bf920a3461752`, and only `IFC-V1-058` deferred. |
| Browsers | Repinned exact package passes 76/76 Chromium 149 and Firefox 151 phone/desktop cases; four sanitized reports record 316 bounded requests and 52 exact mutations. |
| Real user manager | One final no-retry 22-operation lifecycle run covers four installs, four starts, two statuses, one restart, two stops, three upgrades including injected rollback, and six uninstalls including active/inactive/repeated/injected recovery. Exact 0.144.0 Codex PID/socket continuity, active and inactive upgraded uninstall, reinstall, state/config/Codex sentinels, pre-existing failed units, Tailscale profile/Serve identity, not-found units, absent runtime/install residue, and cleanup pass. |
| Static/supply chain | Planning 220 tasks/84 requirements/683 dependencies/two queued, scaffold eight packages/21 scripts, runtime boundary 619 modules/22 externals, exact Codex binding 671 files, frozen offline install, zero known production vulnerabilities, 172 production license entries across eight groups, privacy scan, diff check, and 18 protected PNG byte comparisons pass. |

The first aggregate suite attempt duplicated React tests concurrently and produced timeout-only failures; the four affected files passed 82/82 immediately and clean sequential unit/web reruns passed. Early smoke iterations exposed one stale release-count assertion and the test harness exceeding the unit start-limit with a sixth synthetic start; the final harness checks retention truth and resets only already-uninstalled HostDeck unit counters between accelerated reinstall rounds. Three final cleanups left both units `not-found`, no runtime root, and no lifecycle temp root.

## Remaining Boundary

- `IFC-V1-058` owns clean-checkout/package/foreground/service parity on a clean supported Ubuntu environment. This task does not claim that release gate or phone acceptance.

## Manual Inspection

- Review deletion and preservation sets against a real installed manifest and filesystem tree.
- Inspect manager call order and post-uninstall unit/process/socket/listener state.
- Compare state, database, config, Codex, failed-unit, and Tailscale snapshots before and after each real run.
- Inspect human and JSON success/failure output for private paths, secrets, false cleanup claims, and actionable recovery ownership.
- Confirm no source checkout, phone, ADB, browser pairing, Tailscale profile switch, or Serve mutation is needed for this leaf.

## Commit Record

- Criteria: `aef65e4`.
- Implementation/evidence: `af45ec4`.
- Closure: `7b7dcc1`.
