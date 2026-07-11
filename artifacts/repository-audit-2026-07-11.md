# Repository Audit - 2026-07-11

## Scope

Repository-wide read-only review followed by bounded entry-point and validation-integrity fixes. Reviewed:

- product goal, roadmap, PRD, 84 requirements, UX contract, technical plan, implementation blueprint, test plan, decisions, six capability blocks, delivery plan, 196-task dependency graph, current queue, and delivery guides;
- all package manifests, public package entry points, root scripts/configuration, source/test inventory, architecture-boundary import scans, current git state/history, and production dependency advisories;
- portable scaffold, planning, type, lint, export, and focused test paths on the available Windows host.

The audit did not read or use `human.md`.

## Harsh Success Criteria

- Root onboarding identifies HostDeck, its selected app-server architecture, its Ubuntu target, and the current release no-go without implying a runnable package or UI.
- Every validation command named as canonical in the test plan exists or fails loudly with its exact implementation owner.
- Scaffold validation fails if selected exact-Codex commands, the aggregate Codex alias, or future-command owners drift.
- Workspace convention coverage includes all nine packages.
- Delivery guides agree with package scripts and current code/package maturity.
- No blocked runtime, physical-device, UI-selection, packaging, or release gate is reclassified as complete.
- Changes pass portable checks; unsupported-host/native/external gaps remain explicit.

## Architecture Assessment

### Strong

- Planning is unusually complete and internally checked: requirements map to blocks and leaf tasks, dependency cycles/invalid readiness fail, and current work is explicit.
- Boundaries are well chosen: framework-free core, stable HostDeck contracts, generated Codex types isolated in one adapter, storage behind repositories, application services above ports, and UI designed to consume typed API state.
- Failure semantics are conservative: unknown outcomes, stale projections, compatibility drift, replay boundaries, audit phases, and resource limits are modeled instead of hidden.
- Security direction is appropriate for the product risk: loopback default, private app-server socket, HTTPS-only LAN opt-in, paired reads/writes, HttpOnly device token, CSRF rotation, exact-target mutations, and bounded audit.
- The selected path has substantial unit/contract/integration evidence, and production dependencies report no known advisories in the current registry audit.

### Material Risks And Gaps

| Severity | Finding | Disposition |
| --- | --- | --- |
| Release blocker | The assembled exact-Codex vertical is externally blocked by authenticated usage reset and the strict Bubblewrap AppArmor prerequisite. | Existing owner `INT-V1-027`; unchanged. |
| Release blocker | HTTPS trust has host-side evidence but still lacks real-phone enrollment/failure-recovery proof. | Active owner `IFC-V1-015`; unchanged. |
| Release blocker | No approved replacement mobile direction or implemented product UI exists. | `FE-V1-002` / human `FE-V1-003`; UI-fidelity workflow correctly prevents implementation. |
| High | Selected application composition, auth/security routes, package/bin, user services, E2E, clean install, and release smokes remain incomplete. | Existing `IFC-V1-026` onward and release tasks; no readiness claim made. |
| Medium | Root README and repository guide described template/package shells rather than current HostDeck architecture. | Fixed under `BUG-008`. |
| Medium | Test-plan command and placeholder ownership drifted from package scripts/backlog. | Fixed and made executable under `BUG-008`. |
| Low | Workspace convention unit coverage omitted `codex-adapter` even though other checks included it. | Fixed under `BUG-008`. |
| Medium | No hosted CI workflow is present, so validated commands depend on manual execution and historical artifacts. | Recommend a dedicated leaf task with exact Ubuntu/native cache, deterministic gates, opt-in authenticated smokes, and secret policy; not invented in this audit. |

## Implemented Improvements

- Replaced the generic planning-template README with current HostDeck product, architecture, state, and supported-development truth.
- Added `pnpm test:codex` as the canonical alias for the existing `INT-V1-027` structured vertical.
- Corrected the `pnpm build` loud placeholder to point to `IFC-V1-021`, and the E2E placeholder to its selected API/browser implementation owners `IFC-V1-046` and `FE-V1-040`.
- Extended loud placeholders to report multiple blocking task owners without pretending success.
- Expanded scaffold validation from 18 historical root commands to the complete 30-command contract and asserted exact owners for deferred commands.
- Added `codex-adapter` to workspace convention tests.
- Synchronized developer, repository, and command-reference docs.

## Validation Context And Results

Audit host: Windows, Node `22.22.3`, Corepack pnpm `10.29.2`. The repository supports Ubuntu/Linux and pins exact Node `22.22.2`; the version warning is therefore a validation limitation, not accepted release evidence.

| Check | Result |
| --- | --- |
| `pnpm check:scaffold` | Pass after changes; all 9 packages and 30 root scripts recognized. |
| `pnpm check:planning` | Pass; 196 tasks, 84 requirements, 631 dependencies, 2 queued. Required an unsandboxed worker spawn on this host. |
| `pnpm typecheck` | Pass with exact-Node warning. |
| `pnpm lint` | Pass; Biome and package-export checks clean. |
| Focused workspace convention test | Pass after adding the ninth package. |
| `pnpm build` | Expected nonzero placeholder naming `IFC-V1-021`; no fake build success. |
| `pnpm test:e2e` | Expected nonzero placeholder naming both `IFC-V1-046` and `FE-V1-040`; no fake browser-workflow success. |
| Production dependency audit | Pass; no known vulnerabilities reported. |
| Frozen native install | Not valid on this host: `fs-ext` requires the supported Linux contract (or a Windows C++ toolchain) and Node differs by one patch. An ignore-scripts install was used only for portable checks. |
| Full unit suite | Not accepted on this host: Linux filesystem/Unix-socket/native assumptions fail after the ignore-scripts install. |
| Contract/integration/web suites | Not accepted: their sandboxed launches could not spawn Vite helpers, and they were not promoted to evidence on an unsupported host with an unbuilt native lease. Historical Ubuntu evidence remains, but no new aggregate pass is claimed. |
| Codex/phone/build/E2E/local release | Not run; prerequisites or owning implementations are incomplete. |

## Recommended Order

1. Complete real-phone HTTPS enrollment evidence for `IFC-V1-015`.
2. Resume `INT-V1-027` only after the authenticated usage and strict command-sandbox prerequisites are restored.
3. Finish selected runtime supervision, restart reconciliation, auth/security, route composition, and legacy-path disposition before package/UI work.
4. Add a dependency-aware Ubuntu CI leaf that runs deterministic portable/native gates and keeps authenticated/device smokes explicit and opt-in.
5. Proceed through the replacement mobile visual gate, selected API composition, React implementation, screenshot/device evidence, then release hardening.

## Go/No-Go

**No-go for users or release.** The audit improves repository truth and validation integrity only. Existing external, physical-device, production-composition, UI, packaging, and release blockers remain visible and correctly owned.
