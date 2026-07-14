# FE-V1-004 Mobile State And Interaction Contract

Date: 2026-07-13

## Outcome

The phone-first design gate is now executable before visual exploration:

- 141 immutable state traces across 15 surfaces;
- 39 interactions with explicit UI owner, execution owner, route, authority, target, confirmation, operation-id, retry, and downstream-task policy;
- 29 exact exported schema references and 28 selected API route references;
- 46 parsed selected-mobile view models and 13 parsed structured-runtime fixtures;
- all `UX-001` to `UX-012` journeys, five reference viewports, and `FE-V1-002` plus `FE-V1-010` to `FE-V1-040` downstream owners covered;
- concrete maximum-bound fixtures for 64-character session name, 160-character project cue/model, 240-character branch, 512-character goal/summary, and 12,000-character event content.

The machine-readable owner is `packages/test-fixtures/src/mobile-design-contract.ts`. This artifact is the review map; it does not replace the executable inventory.

## Render Boundary

| Boundary | States | Allowed diagnosis | Disclosure | UI consequence |
| --- | --- | --- | --- | --- |
| Browser/Tailscale before document load | `preload_phone_network_unavailable`, `preload_remote_origin_unreachable` | Browser/network failure only | None | HostDeck renders nothing and cannot name laptop profile, Serve, runtime, or app-auth state. |
| Loaded HostDeck application | Every other trace | Current app authority, admitted remote/local observation, runtime projection, or user interaction | Explicitly `access_only`, `session_list`, or `session_detail` | UI may show only facts carried by the exact selected contracts. |
| Local laptop observation | Remote disabled, laptop Tailscale unavailable, profile mismatch, Serve absent/configuring/conflict, profile-switch boundary | Bounded local recovery fact | Access only until read authority exists | Recovery can name a required laptop action, but no phone control mutates Tailscale or Serve. |

An already loaded page may show a generic reconnecting state after losing the origin. A fresh phone navigation that cannot load the origin has no HostDeck state and is never relabeled as a precise laptop diagnosis.

## Information Architecture

| Surface | State trace IDs | Exact contracts | Phone first viewport | Primary owner tasks |
| --- | --- | --- | --- | --- |
| Browser preload | `preload_phone_network_unavailable`, `preload_remote_origin_unreachable` | None by design | Browser error only | `FE-V1-013`, `FE-V1-019`, `FE-V1-025`, `FE-V1-034`, `FE-V1-040` |
| Mission Control | `mission_loading`, `mission_empty`, `mission_mixed_attention`, `mission_all_quiet`, `mission_read_only`, `mission_locked`, `mission_runtime_offline`, `mission_runtime_incompatible`, `mission_runtime_degraded`, `mission_fatal`, `mission_unpaired`, `mission_expired`, `mission_revoked`, `mission_remote_disabled`, `mission_tailscale_unavailable`, `mission_profile_mismatch`, `mission_serve_conflict`, `mission_long_content`, `mission_desktop_expansion` | `selectedMissionControlViewModelSchema`, `selectedHostAccessSchema` | Host/access strip, page title, at least two rows when data exists | `FE-V1-010`, `FE-V1-011`, `FE-V1-013`, `FE-V1-015`, `FE-V1-016`, `FE-V1-025`, `FE-V1-034`, `FE-V1-035`, `FE-V1-039` |
| Session Detail | `detail_loading`, `detail_active_writable`, `detail_needs_input`, `detail_approval`, `detail_completed`, `detail_interrupted`, `detail_failed`, `detail_unknown`, `detail_stale`, `detail_stream_reconnecting`, `detail_replay_boundary`, `detail_compacting`, `detail_rate_limit`, `detail_read_only`, `detail_locked`, `detail_not_found`, `detail_runtime_incompatible`, `detail_long_content`, `detail_desktop_expansion` | `selectedSessionDetailViewModelSchema`, `selectedSessionEventStreamSchema`, `selectedPromptControlSchema`, `selectedControlStateSchema`, `managedSessionProjectionSchema` | Session identity/status, structured feed, sticky composer, `/model`, `/goal`, `/plan` | `FE-V1-010`, `FE-V1-012`, `FE-V1-014` to `FE-V1-016`, `FE-V1-020` to `FE-V1-023`, `FE-V1-025` to `FE-V1-030`, `FE-V1-033`, `FE-V1-035`, `FE-V1-036`, `FE-V1-039` |
| Composer | `composer_empty`, `composer_composing`, `composer_keyboard_open`, `composer_submitting`, `composer_accepted`, `composer_running`, `composer_completed`, `composer_failed_retryable`, `composer_failed_nonretryable`, `composer_disabled_unpaired`, `composer_disabled_read_only`, `composer_disabled_locked`, `composer_disabled_runtime`, `composer_disabled_session`, `composer_disabled_stream` | `selectedPromptControlSchema`, operation dispatch/progress, bounded error | Exact session, composer state, primary controls; keyboard state preserves safe-area access | `FE-V1-016`, `FE-V1-020`, `FE-V1-039` |
| Host And Access | `access_remote_ready`, `access_loopback_ready`, `access_unpaired`, `access_expired`, `access_revoked`, `access_read_only`, `access_locked`, `access_remote_disabled`, `access_tailscale_absent`, `access_tailscale_stopped`, `access_tailscale_signed_out`, `access_profile_mismatch`, `access_serve_absent`, `access_serve_configuring`, `access_serve_conflict`, `access_profile_switch_boundary`, `access_csrf_bootstrap`, `access_csrf_failure`, `access_stream_unavailable`, `access_runtime_incompatible`, `access_device_list` | Host/access, access-state, ingress public/provenance, CSRF, device list, lock-state contracts | Permission/lock, remote/runtime/stream health, one bounded recovery action | `FE-V1-013`, `FE-V1-023` to `FE-V1-025`, `FE-V1-031` to `FE-V1-035` |
| Pairing | `pair_fragment_ready`, `pair_claiming`, `pair_paired`, `pair_invalid`, `pair_expired`, `pair_used`, `pair_rate_limited`, `pair_remote_unreachable` | Pair request/claim response, fragment-link intent, bounded error | Pair status, requested permission, recovery; no session data | `FE-V1-013`, `FE-V1-031` |
| Model | `model_current`, `model_loading`, `model_unsupported`, `model_conflict`, `model_accepted`, `model_success`, `model_failure` | Model snapshot, control state, operation dispatch/progress | Session target, current model/effort, capability and action state | `FE-V1-021` |
| Goal | `goal_current`, `goal_loading`, `goal_unsupported`, `goal_conflict`, `goal_accepted`, `goal_success`, `goal_failure` | Goal snapshot, control state, operation dispatch/progress | Session target, objective/state, explicit set/pause/resume/complete/clear action | `FE-V1-026` |
| Plan | `plan_current`, `plan_loading`, `plan_unsupported`, `plan_conflict`, `plan_accepted`, `plan_success`, `plan_failure` | Plan snapshot, control state, operation dispatch/progress | Session target, current mode, capability and action state | `FE-V1-027` |
| Usage | `usage_loading`, `usage_content`, `usage_empty`, `usage_stale`, `usage_unsupported`, `usage_failure` | Usage snapshot and control state | Session target, capture freshness, bounded account/thread/rate observations | `FE-V1-028` |
| Compact | `compact_confirmation`, `compact_accepted`, `compact_running`, `compact_completed`, `compact_conflict`, `compact_unsupported`, `compact_failure` | Control state and operation dispatch/progress | Exact session, consequence, accepted-versus-proven-complete status | `FE-V1-029` |
| Skills | `skills_loading`, `skills_content`, `skills_empty`, `skills_partial`, `skills_unsupported`, `skills_failure` | Skills snapshot and control state | Session target, bounded skill rows, partial/error status | `FE-V1-030` |
| Inline approval | `approval_pending`, `approval_elevated_confirmation`, `approval_responding`, `approval_approved`, `approval_denied`, `approval_expired`, `approval_superseded`, `approval_reconnecting` | Pending approval, operation dispatch/terminal outcome | Exact action, scope, reason, grant scope, risk, decision state | `FE-V1-022` |
| Event details | `event_complete`, `event_truncated`, `event_boundary`, `event_redacted`, `event_unknown` | Event stream and read-only diagnostics | Event identity plus explicit redaction/truncation/boundary limit | `FE-V1-014` |
| Confirmation | `confirm_interrupt`, `confirm_archive`, `confirm_lock`, `confirm_revoke` | Operation dispatch/terminal outcome and bounded error | Exact target, consequence, destructive/security separation | `FE-V1-032`, `FE-V1-033`, `FE-V1-036`, `FE-V1-037` |

## Journey Trace

| Journey | Surfaces and state anchors | Interaction ownership | Downstream leaves |
| --- | --- | --- | --- |
| `UX-001` pair phone | Browser preload, pairing states, unpaired/expired/revoked access, CSRF bootstrap | Pair creation is local CLI; fragment sanitation is browser-local; one claim and CSRF bootstrap use exact API routes | `FE-V1-013`, `FE-V1-024`, `FE-V1-031` |
| `UX-002` scan sessions | Mission loading/empty/mixed/all-quiet/long/degraded | Access and session reads use selected routes; row navigation is browser-local | `FE-V1-010`, `FE-V1-011`, `FE-V1-025` |
| `UX-003` read and prompt | Detail plus all composer lifecycle/disabled states | Exact session detail/stream reads and one operation-id prompt mutation; no automatic write retry | `FE-V1-012`, `FE-V1-020`, `FE-V1-023` |
| `UX-004` model | Model seven-state family | Read and select routes target one session; accepted is not loaded-state confirmation | `FE-V1-021` |
| `UX-005` goal/plan | Goal and Plan seven-state families | Exact read/mutation routes; goal risk confirmation remains action-specific | `FE-V1-026`, `FE-V1-027` |
| `UX-006` utilities | Usage, Compact, Skills families | Usage/skills are reads; Compact is confirmed, one-attempt mutation; none sends slash text | `FE-V1-028` to `FE-V1-030` |
| `UX-007` approval | Eight approval states plus inline detail anchor | Read list, then one exact request-id response; duplicate disabled; confirmation follows risk | `FE-V1-022` |
| `UX-008` interrupt/archive | Confirmation and event-detail surfaces | Both mutations require exact target, confirmation, operation id, no retry | `FE-V1-014`, `FE-V1-036`, `FE-V1-037` |
| `UX-009` reconnect | Preload generic failure, loaded stale/reconnecting/boundary, profile-switch boundary | Event reads may reconnect; mutations never retry; retained failures/boundaries stay visible | `FE-V1-015`, `FE-V1-019`, `FE-V1-023`, `FE-V1-025` |
| `UX-010` laptop resume | Active detail and resume metadata | API reads exact local-only metadata; browser may copy but never execute a phone shell | `FE-V1-038` |
| `UX-011` lock/revoke | Access lock/read-only/expired/revoked/device-list and confirmations | Paired writer may lock/revoke; unlock remains local CLI; every target is exact | `FE-V1-032`, `FE-V1-033` |
| `UX-012` profile safety | Remote ready/disabled/client/profile/Serve/profile-switch-boundary states | Status is read-only; HostDeck remote enable/disable is local CLI; profile change is an external laptop-user action | `FE-V1-034` |

## Action Ownership

| Owner | Interactions | Policy |
| --- | --- | --- |
| Browser local | `bootstrap_shell`, `consume_pairing_fragment`, `open_session`, `navigate_back`, `reconnect_stream`, `copy_resume_command` | Navigation/transient state only; no authority minting and no mutation retry. |
| Selected API reads | `read_host_access`, `read_host_status`, `read_remote_status`, `read_sessions`, `read_session_detail`, `stream_events`, model/goal/plan/usage/compact/skills reads, approval/device/event/resume reads | Exact selected route and target; authority is optional-device or paired read as declared. |
| Selected API mutations | `claim_pairing`, `bootstrap_csrf`, `send_prompt`, model/goal/plan/compact mutations, `respond_approval`, `interrupt_turn`, `archive_session`, `revoke_device`, `lock_host` | One operation id, exact host/session/turn/approval/device target, no automatic retry, explicit confirmation policy. |
| Local CLI only | `create_pairing_link`, `enable_remote_local`, `disable_remote_local`, `unlock_host_local` | Never rendered as a remote phone control. |
| Laptop user outside HostDeck | `switch_tailscale_profile_local` | No HostDeck route or automatic mutation; company/other profile state is not modified by HostDeck. |

All 39 interaction records set `automaticRetry: false`. Tailscale identity remains transport context, never app read/write authority.

## Mockup Input Set

`FE-V1-002` must use the traces marked `mockupRequired` and map each visible element to a component/token:

- Mission Control: mixed attention, read-only, locked, unpaired, remote disabled, laptop Tailscale unavailable, laptop profile mismatch, Serve conflict, desktop expansion.
- Session Detail: active writable, inline approval, replay boundary, read-only, locked, desktop expansion.
- Host/access: remote ready, unpaired, locked, remote disabled, profile mismatch, Serve conflict.
- Pairing: fragment ready, claim in flight, paired result.
- Approval: normal pending and elevated confirmation.

Every marked state except the two explicit desktop-expansion traces covers 360 x 800, 390 x 844, 412 x 915, 768 x 1024, and 1280 x 800. Desktop expansion remains a 1280 x 800 target while preserving the same route hierarchy.

## Rejected Contradictions

- No HostDeck-rendered laptop diagnosis before the document loads.
- No session disclosure for preload, unpaired, expired, revoked, or non-ready ingress states.
- No Tailscale identity to app-authority shortcut.
- No remote unlock, profile switch, Serve mutation, remote enable/disable, LAN fallback, custom-CA, certificate enrollment, terminal, raw input, blind slash dispatch, editor, file tree, or desktop-only required flow.
- No accepted prompt/model/goal/plan/compact response mislabeled as a completed runtime result.
- No compact success without authoritative completion.
- No approval decision without the exact pending request target; no duplicate submission while responding.
- No stale, unknown, disconnected, incompatible, or boundary state presented as healthy/current/writable.
- No desktop expansion with a different information architecture or a workflow unavailable on phone.
- Historical `FE-V1-001` desktop/tmux/LAN fixtures remain migration evidence only and are not referenced by this selected matrix.

## Manual UX Review

- Mission Control is the only default route and keeps host state plus useful session content in the first phone viewport.
- Session Detail remains conversation-first; primary controls are `/model`, `/goal`, `/plan`; utilities remain secondary.
- Risky actions stay outside the composer and primary control strip.
- Access recovery copy identifies whether the action belongs on the laptop without presenting a remote mutation control.
- Pairing retains no raw code in the view-model matrix; the fragment contract requires removal before request/history/referrer exposure.
- Long labels/content have explicit stress fixtures and viewport owners rather than relying on mockup placeholder text.
- The matrix is visual-direction neutral: it fixes hierarchy, state truth, and action ownership without choosing color, density, or component styling.

## Validation

Focused validation passed before aggregate closure:

- `pnpm --filter @hostdeck/test-fixtures typecheck`.
- `pnpm test:web`: 2 files, 16 tests.
- focused selected mobile/remote/design contract run: 3 files, 37 tests.
- `packages/test-fixtures/src/mobile-design-contract.contract.test.ts`: 14 tests.

Aggregate closure passed:

- `pnpm typecheck`.
- `pnpm lint`: 377 files and all 9 package exports.
- `pnpm test:unit`: 127 files/1,213 tests passed; 21 files/35 tests skipped by existing environment gates.
- `pnpm test:contract`: 27 files/245 tests.
- `pnpm test:integration`: 2 files/16 tests.
- `pnpm test:web`: 2 files/16 tests.
- `pnpm check:planning`: 212 tasks, 84 requirements, 649 dependencies, 18 queued.
- `pnpm check:scaffold`: 9 packages and 18 root scripts.
- `git diff --check`.

No React screen, visual direction, screenshot, or physical-phone completion is claimed by `FE-V1-004`.
