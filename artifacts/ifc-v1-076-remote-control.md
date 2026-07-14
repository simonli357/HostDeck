# IFC-V1-076 Remote Control Evidence

## Outcome

- Added one application service over the remote-state repository, admission-proof repository, bounded observer, ownership-safe Serve manager, and selected security-audit executor.
- Status performs fresh configured observation for a persisted selection and opens admission only when durable ready state, terminal enable audit, durable proof, and a fresh matching process lease agree.
- Enable persists intent before one manager call, requires authoritative exact read-back, records terminal audit, then establishes proof and admission. Unknown storage, audit, response, manager, or proof outcomes never retry or admit.
- Disable closes the lease first, atomically invalidates proof with accepted audit, durably latches cleanup incomplete before one manager call, and clears selection only after verified absent read-back. Restart, status, or profile return cannot reopen failed cleanup.
- One operation runs at a time without a wait queue. Equivalent concurrent status reads coalesce; mutation overlap rejects before another manager call.

## API And CLI

- Registered exact no-store `GET /api/v1/remote/status`, `POST /api/v1/remote/enable`, and `POST /api/v1/remote/disable` routes from the selected manifest.
- Status accepts a current paired device or exact direct-loopback `X-HostDeck-Local-Admin: cli-v1`; mutations remain loopback local-admin only. Currentness is checked around dispatch and successful publication.
- Corrected selected Serve ingress translation so an already validated local-admin GET retains `local_non_browser` authority. Remote use, duplicate/wrong markers, browser headers, cookies, Origin, and proxy context remain rejected.
- Added `codexdeck remote status|enable|disable [--json]`. Mutations create one fresh operation id, send literal confirmation once, use only the selected loopback API, and never call Tailscale or retry.
- CLI transport accepts only direct loopback HTTP, uses raw bounded Node HTTP without browser/cookie/origin authority, applies selected timeout/body/response/concurrency limits, and sanitizes typed and uncertain errors.
- Human and JSON output omit external origin, profile/account/node identity, proof/audit identifiers, credentials, and raw command data.

## Deterministic Evidence

- Service and SQLite coverage proves first/repeated enable, status lease renewal/expiry, restart without lease, proof carry-forward/invalidation/corruption, profile and Serve drift/recovery, terminal-audit/response/proof/storage uncertainty, fail-closed cleanup, generation/race handling, and no-queue concurrency.
- Route coverage proves exact methods/schemas/cache policy, local and paired status, remote mutation denial, malformed-input short circuit, stable public errors, revocation/currentness suppression, and selected Serve-boundary behavior.
- CLI coverage proves parsing, exact request shapes, one-attempt mutations, operation-id validation, loopback-only configuration, bounded raw transport, oversize/truncated/concurrent failures, rendering privacy, and no retry.
- Aggregate gates pass: unit 1,211 passed with 35 explicit external/device skips; contract 231 passed; integration 16 passed; root typecheck passed; lint/exports passed for 375 files and 9 packages; scaffold and planning passed at 212 tasks, 84 requirements, 649 dependencies, and 18 queued before closure.

## Real Dedicated-Profile Evidence

- The opt-in `pnpm smoke:remote-control` run composes a temporary migrated SQLite database, real observer and manager, selected Tailscale Serve Fastify boundary, selected remote routes, and the CLI's real loopback transport.
- From an absent root Serve baseline it proves disabled status, audited enable, exact read-back, durable proof and open admission, fresh status, certificate-verified private HTTPS with unpaired denial, audited disable, closed admission, cleared selection/proof, and final absent Serve.
- The final smoke passed three consecutive clean-baseline runs after hardening. Each run closed the listener/database, removed temporary state, and retained no child process.
- The laptop's ordinary resolver is currently displaced by another local resolver even though Tailscale split DNS is enabled. The smoke therefore queries Tailscale's internal resolver directly, accepts only a tailnet IPv4 result, and still validates canonical Host, SNI, and the trusted HTTPS certificate. No product fallback was added; physical-phone DNS remains an `IFC-V1-079` acceptance item.
- No account, saved-profile name, node, private DNS name, address, source identity, credential, consent URL, or raw Tailscale output is retained in this artifact or smoke output.

## Commits

- Frozen contract: `9073733`.
- Durable admission proof: `d87dd86`.
- Application service: `88b9811`.
- Selected API routes: `d3675c8`.
- Local CLI: `e6f86c9`.
- Real vertical smoke and local-admin provenance correction: `5258c8c`.

## Remaining Gates

- `IFC-V1-077` owns fragment-safe pairing URL/QR and browser claim startup.
- `IFC-V1-078` owns startup, polling, health, SSE currentness, and shutdown composition.
- `IFC-V1-079` owns aggregate hostile cases and physical Android acceptance from another network.
- The phone still does not enumerate on the laptop USB bus, so no ADB or deploy result is claimed here.
