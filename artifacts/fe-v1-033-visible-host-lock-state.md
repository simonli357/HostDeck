# FE-V1-033 Visible Host-Lock State

Date: 2026-07-26

Status: criteria frozen; implementation in progress.

## Scope

Implement the selected paired-writer host-lock workflow and carry its exact admission truth through Mission Control, Session Detail, every current session mutation, and the persistent Host & access surface. A paired writer can explicitly confirm one remote-write lock. Current and retained reads remain available according to their existing authority and continuity rules. Unlock remains an explicit local-laptop CLI operation.

Excluded: remote unlock, automatic unlock, local CLI or server behavior changes, device-list or revoke policy changes, interruption or cancellation of already-dispatched requests or Codex work, Tailscale/profile/Serve mutation, compatibility diagnosis, polling, automatic mutation retry, browser persistence, a new route, a desktop-only control, complete-dashboard hardening, and physical-phone release acceptance owned by downstream leaves.

## Pre-Change Findings

- `IFC-V1-030` already owns strict `GET /api/v1/access`, paired-writer/local-admin `POST /api/v1/access/lock`, local-admin-only `POST /api/v1/access/unlock`, and the durable unlocked-host write gate. Lock accepts only `{operation_id, confirmed:true}` and returns the strict access-state shape. It does not return an actor, caller reason, lock timestamp, audit id, or operation id.
- A lock is an emergency security mutation. A current paired writer plus current CSRF may lock even when runtime health, selected-session state, or the session stream is unavailable. Access reads, session reads, SSE, pairing, CSRF bootstrap, device listing/revocation, lock itself, and local-admin unlock follow their own policies rather than the session unlocked-host gate.
- A successful lock proves only durable admission closure. It does not stop a request already admitted by the server, cancel an active Codex turn, close SSE, revoke this device, rotate CSRF, or make retained session data unreadable.
- Audit-unavailable emergency lock can commit while returning `503`; terminal-audit failure, response loss, timeout, caller abort, or malformed success can also leave durable lock truth different from the last access read. Any uncorrelated post-dispatch result therefore requires a new access-state proof and cannot restore browser write admission or be retried automatically.
- The generic browser protected-request path currently includes `host_lock` and requires the complete session `writeEligibility` predicate. That is too restrictive for an emergency lock because host health, selected target, and runtime readiness are not lock prerequisites.
- The generic CSRF client currently classifies a non-retryable `409 operation_conflict` as stale CSRF for every protected route except device revoke. The host-lock route also uses that code for durable lock-state conflict, so `host_lock` needs the same domain-conflict exclusion; a conflict is not proof that page CSRF became stale.
- The coordinator has no global pending/uncertain lock-admission latch. A component-local busy flag would leave prompt, model, goal, Plan, and approval controls apparently writable while a lock is being dispatched or its outcome is unknown.
- Mission Control already shows a current locked access fact and notice. Host & access already shows the lock boolean and generic laptop-only recovery. Session Detail has no route-level lock notice; only individual implemented controls expose their own disabled copy. There is no selected lock command or confirmation surface.
- `DEC-028` selects Focus Rail. The approved access-recovery asset shows a flat phone lock rail, readable sessions, one disabled write path, and local-laptop recovery. `confirm_lock` is explicitly typed but has no literal raster target, so the selected `ConfirmationSheet` mapping governs it without authorizing a new route, card grid, desktop inspector, or Signal Ledger borrowing.

## Frozen Design

### Exact Browser Boundary

- Add one narrow coordinator operation for `host_lock`; do not expose the HTTP client, CSRF credential, cookie, configured-origin header, server adapter, or `host_unlock` to React or the lock controller.
- Remove `host_lock` from the generic protected-route type and reject a forged generic call at runtime. The exact lock operation requires one current paired-writer access authority, `can_lock:true`, an observed unlocked state, current page CSRF, one fresh validated operation id, and literal confirmation.
- Lock admission is independent of host-status currency, local runtime readiness, selected route/session state, stream state, session write eligibility, and existing action-controller availability. A read-only, unpaired, invalid, expired, revoked, stale, local-admin browser, already-locked, CSRF-unready, changed-authority, or closed snapshot dispatches no lock request.
- Before invoking the CSRF client, the coordinator synchronously publishes a lock transition latch. The latch blocks every later session/runtime mutation through canonical write eligibility while preserving reads, stream ownership, access refresh, pairing recovery, device list/revoke, and the already-owned security exceptions.
- Add distinct canonical write causes for `host_lock_pending` and `host_lock_unconfirmed`; neither may be mislabeled as a proven durable lock. Cause ordering puts stale/lost authority first, then read-only, then the lock transition, proven host lock, host health, and page security.
- Treat host-lock `409 operation_conflict` as a route-domain result rather than implicit stale CSRF generation. Actual permission/authority rejection retains the existing authority invalidation policy. No error path fabricates a current locked or unlocked access response.

### Correlation And Transition Truth

- A successful response is accepted only when it is a strict `host_lock_state_response_v1`, reports `locked:true`, and preserves the exact current paired device, write permission, expiry, configured origin, network mode, transport, read capability, lock capability, and browser-only no-unlock authority. A cross-authority, unlocked, malformed, or late response is unconfirmed.
- Correlated success replaces the coordinator's access resource with the returned current locked state before resolving the request. Future session mutations are blocked by `host_locked`; current session reads and SSE remain owned and usable. CSRF remains ready because lock does not revoke authority.
- Invalid operation-id creation, invalid local confirmation state, stale selection before dispatch, or coordinator admission rejection sends zero requests and leaves prior proven access truth intact. There is no local optimistic claim that the laptop is locked.
- Once the exact HTTP mutation is invoked, any result other than correlated success is conservative. Permission loss follows authority-loss policy; every same-authority conflict, `5xx`, audit failure, timeout, abort, response loss, invalid response, or unknown error enters `host_lock_unconfirmed`, blocks later session mutations, retains readable data only under existing stale/current rules, and requires a later current access read.
- A load started before or during the mutation cannot clear a later uncertainty latch. Only an exact current access response from a load whose proof window begins after the uncertain transition, or a correlated lock response, may clear it. The new proof may show locked or unlocked; the browser presents exactly that result and never retries the old operation id.
- Route navigation, sheet close/open, rerender, stream reconnect, host-status recovery, or an unrelated control result cannot clear lock pending/uncertain state. Authority replacement or coordinator close suppresses late publication and preserves the stronger authority-loss/closed result.
- Starting a lock blocks new browser-side session mutation admission but does not abort any already-dispatched prompt/control/approval request, disconnect the session stream, clear the timeline, or claim that active Codex work stopped. Late results from pre-lock requests remain governed by their existing exact outcome rules.

### Persistent Headless Owner

- One headless lock controller above route and Host & access sheet lifetimes owns availability, confirmation, one operation id, one request, result, and close/late-settlement suppression. It consumes only exact coordinator snapshot/lock ports plus an injected operation-id function.
- Confirmation snapshots one exact host authority epoch and origin. Authority, lock state, CSRF posture, or controller ownership changing before dispatch invalidates the confirmation. Duplicate tap, touch, Enter, rerender, StrictMode replay, route change, or sheet reopen cannot create a second request.
- The controller distinguishes unavailable, unlocked, confirmation, dispatching, locked, local failure, and unconfirmed outcome without retaining an operation id, device id, private origin, raw error, API envelope, or CSRF material in its public view.
- Operation-id generation occurs only after explicit confirmation. Once dispatch begins, confirmation close, Escape, outside interaction, Cancel, and repeat Lock controls remain disabled until settlement or owner suppression.
- Lock confirmation states: new remote session writes will be blocked; session reads and live updates remain available; requests already sent and Codex work already running are not stopped; unlock must run locally on the laptop. Copy does not claim logout, device revoke, Tailscale change, stream cancellation, thread interruption, or data deletion.

### Shared Lock Projection

- One pure shared projection derives the visible lock phase, reason, and source from current access plus the coordinator transition cause. It has only `none`, `pending`, `locked`, and `unconfirmed` states and rejects contradictory combinations.
- `locked` source is the current HostDeck access state from the laptop; its reason is that the laptop safety lock blocks new remote session writes. `pending` source is this phone's explicit lock request. `unconfirmed` source is the last lock attempt, with current laptop lock truth unresolved until refresh. Stale historical `locked:true` is labeled last known, never current.
- Mission Control renders the shared rail immediately after its compact host/access strip and before the queue. Session Detail renders the same state family after session context and before activity. Both keep session rows/timeline readable, retain existing stale/boundary truth, and expose one coherent explanation rather than relying on a disabled composer below the fold.
- Prompt, model, goal, Plan, and approval controllers map `host_lock_pending`, `host_lock_unconfirmed`, and `host_locked` to the same canonical short explanations. They do not each invent recovery, issue a request, or treat stream reconnection as unlock proof. Future session actions consume the same causes through the coordinator contract.
- Host & access adds one flat `Remote write lock` section before paired devices. A current unlocked paired writer with ready CSRF receives one `Lock writes` command. Runtime-offline, degraded-host, stale-target, and disconnected-stream cases still allow that emergency action when access and CSRF are current. Reader or unavailable authority gets no lock command.
- A proven locked state has no dashboard unlock button, link, hidden command handler, generic protected request, or automatic recovery. It shows one bounded local instruction: run `codexdeck unlock` on the laptop, then refresh HostDeck. The dashboard never invokes or links `host_unlock`.
- If current access later proves unlocked, all lock notices and local recovery copy disappear and normal write eligibility resumes only when every independent host, target, and CSRF gate is also current.

### Focus Rail And Accessibility

- Preserve the selected dark Focus Rail canvas, semantic danger/attention rails, flat section hierarchy, 6 px maximum radius, Lucide icons, 44 px controls, fixed type scale, and existing bounded Host & access sheet. Do not add cards inside the sheet, a new route/tab, a desktop-only command, a terminal motif, or decorative lock artwork.
- The lock confirmation is a named nested Radix dialog with title, description, host target, consequence, explicit Cancel and `Lock writes` actions, deterministic initial focus, focus trap/restore, busy dismissal lock, visible focus, and non-color state meaning.
- Mission and detail lock rails use status semantics for stable/pending state and alert semantics only for unconfirmed outcomes. Status announcements are atomic and bounded; the same state is not redundantly announced from every disabled control.
- At 320, 360, 390, 412, 768, and 1280 widths, 390 x 420 short height, long route/session content, and actual 200 percent reflow, the route lock rail, readable content, Host & access lock section, local recovery command, confirmation actions, and sheet close remain reachable without overlap, clipping, horizontal overflow, or competing scroll owners.

## Harsh Success Criteria

| ID | Requirement |
| --- | --- |
| `HLS-01` | One strict persistent headless owner consumes only exact snapshot/lock/operation-id ports; malformed ports/state, close, authority replacement, and late foreign settlement fail or suppress without direct HTTP, React, credential, storage, timer, diagnostic, or unlock ownership. |
| `HLS-02` | The coordinator exposes one exact paired-writer `requestHostLock`; generic protected requests exclude and runtime-reject `host_lock`, while no browser coordinator method exposes `host_unlock`. |
| `HLS-03` | Current paired writer, `can_lock:true`, observed unlocked state, and ready CSRF are the complete browser lock prerequisites. Host/runtime/target/stream readiness and session `writeEligibility` are not prerequisites; denied states send zero requests. |
| `HLS-04` | One explicit confirmation creates one fresh valid operation id and one exact `{operation_id, confirmed:true}` request. Duplicate activation, rerender, route/sheet lifecycle, and StrictMode cannot duplicate, retarget, or reuse it. |
| `HLS-05` | A synchronous coordinator latch precedes HTTP dispatch and blocks every later session/runtime mutation with canonical `host_lock_pending`; reads, SSE, access recovery, and lock-independent device list/revoke remain admitted by their own policies. |
| `HLS-06` | Lock start/success/failure never aborts or relabels an already-dispatched prompt/control/approval request, closes the stream, clears readable projection state, interrupts a turn, or claims Codex work stopped. |
| `HLS-07` | Success requires strict locked response plus exact authority/origin/permission/expiry/transport/capability continuity. Correlated success adopts current `locked:true` access before promise resolution and preserves ready CSRF. |
| `HLS-08` | Invalid operation-id/local state/admission before HTTP sends zero requests and preserves prior proof. No optimistic durable-lock claim is exposed before a correlated response. |
| `HLS-09` | Every uncorrelated post-dispatch same-authority result becomes `host_lock_unconfirmed`, blocks later session mutations, performs no retry, reuses no operation id, and claims neither locked nor unlocked. Authority rejection retains stronger authority-loss behavior. |
| `HLS-10` | Host-lock `409 operation_conflict` remains a domain conflict and does not masquerade as stale CSRF. It still requires a fresh access-state proof because durable outcome cannot be inferred by the browser. |
| `HLS-11` | A pre/during-dispatch access read cannot clear later uncertainty. Only a causally later strict current access read or correlated lock response resolves pending/unconfirmed truth to the exact observed locked or unlocked state. |
| `HLS-12` | Route changes, sheet close/open, host recovery, stream reconnect, unrelated operation settlement, authority replacement, and coordinator/controller close preserve or suppress lock state according to ownership without duplicate requests, stale publication, or unhandled rejection. |
| `HLS-13` | One pure shared projector emits only none/pending/locked/unconfirmed with exact reason and source. Current versus last-known access is explicit; contradictions fail closed and no actor, timestamp, audit id, operation id, or private value is invented. |
| `HLS-14` | Mission Control shows lock phase/reason/source before its readable queue; pending, current locked, stale locked, unconfirmed, and later unlocked proof remain distinct without hiding authorized rows. |
| `HLS-15` | Session Detail shows the same lock phase/reason/source before its readable timeline; current events, boundary/reconnect/stale labels, and read-only utilities remain truthful and visible. |
| `HLS-16` | Prompt, model, goal, Plan, and approval actions all disable from the same canonical pending/unconfirmed/locked causes and short explanations. No control retries, bootstraps, refreshes, or locally clears lock truth. |
| `HLS-17` | Host & access contains one flat `Remote write lock` rail. Current unlocked writers can lock even with runtime/host/target/stream degradation; readers and unavailable authorities see state but no lock command. |
| `HLS-18` | Confirmation names the host-wide remote-write scope and states read/SSE continuity, non-cancellation of sent/running work, and laptop-only unlock. Busy dismissal and double submit are impossible. |
| `HLS-19` | Proven locked and unconfirmed states expose only bounded local recovery. `codexdeck unlock` is presented as a laptop command followed by refresh; no dashboard unlock button/link/route/fetch, automatic unlock, fake logout, or remote-admin shortcut exists. |
| `HLS-20` | Production composition mounts one lock controller above route and sheet lifetimes, one shared route projection, one flat sheet rail, and one nested Focus Rail confirmation with no new route/tab/card/desktop inspector/second scroll owner or cross-option drift. |
| `HLS-21` | Region/status/alert/dialog/button/code semantics, accessible names/descriptions, keyboard activation/order, focus trap/restore, busy lock, visible focus, non-color meaning, reduced motion, and 44 px targets pass without redundant live-region noise. |
| `HLS-22` | 320/360/390/412/768/1280, 390 x 420, long content, Mission Control/Session Detail, and actual 200 percent reflow have no overlap, clipping, horizontal overflow, hidden lock/recovery/confirmation/close control, or competing scroll owner. |
| `HLS-23` | Focused controller/coordinator/CSRF/component/API/concurrency/browser suites prove exact request count/body/headers, emergency admission, global write closure, no cancellation, proof-order races, no unlock request, no retry, privacy, and adjacent read/device/control continuity. |
| `HLS-24` | Deterministic screenshots/layout evidence, full web/unit/contract/integration/type/lint/scaffold/planning/runtime-boundary/build/package/install/audit/privacy checks, source and visual inspection, task-residue cleanup, owner-doc evidence, and clean commit/push state pass before closure. |

## Planned Evidence

- Headless tests own strict construction, availability, confirmation snapshots, operation-id timing, one request, result mapping, close/authority/route races, and immutable private-free views.
- Coordinator tests own emergency lock admission, generic-path exclusion, synchronous global write latch, exact response adoption, domain conflict handling, causal refresh proof, authority loss, read/SSE/device continuity, and non-cancellation of already-dispatched requests.
- CSRF tests own host-lock conflict classification while preserving the existing legacy protected-route stale-generation behavior and device-revoke domain behavior.
- Mission Control, Session Detail, Host & access, prompt, model, goal, Plan, and approval tests own shared projection/copy, current-versus-stale source, action visibility, local-only recovery, and no unlock surface.
- Production-shell browser tests own exact lock request headers/body/count, pending/success/uncertain/current-refresh paths, no request replay, no unlock request, route transition, lock-independent device administration, DOM/storage/history/privacy, responsive containment, and effective 200 percent reflow.
- Deterministic captures and layout measurements own Focus Rail fidelity across current, pending, locked, stale, uncertain, recovery, degraded-but-lockable, confirmation, busy, route, and viewport states. Full repository/package/supply-chain/privacy/no-retry/residue gates close `HLS-01` to `HLS-24`.

## Reuse And Ownership

Reuse the selected access/lock contracts, bounded HTTP and in-memory CSRF clients, persistent browser coordinator, existing control admission views, Host & access sheet, Focus Rail notice/confirmation patterns, Radix dialog primitives, Lucide icons, operation-id helper, and deterministic browser fixtures. Add no dependency.

`FE-V1-033` owns browser lock invocation, transition truth, shared route visibility, consistent current control blocking, and local-only unlock recovery copy. It does not absorb `FE-V1-034` remote recovery, `FE-V1-035` compatibility state, `FE-V1-036`/`037` session actions, `FE-V1-039` complete-dashboard hardening, `FE-V1-016` device acceptance, or release readiness.
