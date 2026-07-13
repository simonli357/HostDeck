# IFC-V1-031 LAN Configuration Boundary

Date: 2026-07-12

Status: complete; hardened implementation and validation evidence pass.

## Purpose

Implement the selected network-state read, local-admin LAN configure/enable/disable boundary, durable pending configuration, production certificate ownership, and exact HTTPS lifecycle input over the completed trust, authentication, CSRF, settings, certificate-profile, route-manifest, and security-audit foundations.

This leaf owns LAN configuration and desired-mode chronology, certificate generation/inspection/public enrollment metadata, local-admin mutation orchestration, HTTPS listener admission, restart-required truth, and selected network contracts. It does not implement remote LAN mutation, device revocation, the common write gate, dashboard UI, selected production route composition, package/service commands, aggregate phone security acceptance, or release acceptance.

## Audit Findings And Resolutions

| Finding | Frozen resolution |
| --- | --- |
| Historical `setLanEnabled` rewrites the full settings row, defaults to `0.0.0.0`, enables plaintext LAN state, and can lose concurrent lock/retention changes. | Retain it only as deprecated evidence. Add immediate selected configure/enable/disable transactions with compare-and-set chronology. Selected code never calls the historical helper or accepts wildcard/plaintext LAN. |
| The current settings row cannot retain a validated LAN configuration while loopback remains enabled. | Add one singleton selected LAN-configuration record. Configure updates only that record while LAN is disabled; enable atomically applies its exact host/port to settings; disable atomically restores explicit loopback desired state. |
| The selected X.509 profile exists only inside the IFC-V1-015 probe. | Extract one production certificate owner using the already selected dependencies and secure-path primitives. It owns exact root/leaf generation, same-root leaf issue/renewal, inspection, TLS material, public-root enrollment, atomic no-follow file replacement, and cleanup. |
| The Fastify lifecycle admits only loopback HTTP and its public snapshot type cannot safely carry TLS secrets. | Extend the runtime-start contract with a private exact HTTPS material input and a separate non-secret bind descriptor. HTTPS requires one canonical assigned RFC1918 IPv4 or IPv6 ULA; loopback HTTP remains explicit. Snapshots and errors never retain PEM/key bytes. |
| Configure/enable/disable request and network response ids exist only as manifest strings. | Add strict selected contracts with one operation id, literal confirmation, canonical IP/port, explicit certificate action, public certificate metadata, desired versus active mode, and restart-required truth. |
| A single LAN-only listener cannot prove loopback source provenance for an HTTP disable request. | Route mutations are admitted only when current request provenance is local admin. The same headless mutation service remains callable by the future local CLI owner so disable/recovery does not depend on remote dashboard authority. Paired phone/browser clients can only read state. |
| Listener rebinding during an in-flight route would make response and cleanup truth ambiguous. | Configure and desired-mode mutation never rebind the current process. Success reports `restart_required`; startup revalidates durable configuration and certificate material before binding. No route claims the listener already changed. |

## Frozen Contracts

### Route Manifest

All registrations assert the exact immutable manifest entry before registration.

| Route | Exact policy |
| --- | --- |
| `network_state` | `GET /api/v1/network`; no body/query/params; `network_state_response_v1`; loopback-or-device-cookie read authority; no CSRF/lock/audit/credential effect. |
| `network_configure` | `POST /api/v1/network/configure`; `lan_configure_request_v1`; local-admin only; no CSRF; host target; accepted-to-terminal `lan_configure` audit. |
| `network_enable` | `POST /api/v1/network/enable`; `lan_enable_request_v1`; local-admin only; no CSRF; host target; accepted-to-terminal `lan_enable` audit. |
| `network_disable` | `POST /api/v1/network/disable`; `lan_disable_request_v1`; local-admin only; no CSRF; host target; accepted-to-terminal `lan_disable` audit. |

All routes are no-store, expose no CORS headers, validate before authentication side effects, and are single-owner/single-registration.

### Mutation Requests

- Every mutation carries one bounded selected `operation_id` and literal `confirmed: true`.
- Configure additionally carries one canonical `bind_host`, integer `bind_port`, and `certificate_action: "reuse" | "issue_leaf"`.
- Selected V1 admits only a currently assigned RFC1918 IPv4 or IPv6 ULA. Loopback, wildcard, unspecified, link-local, multicast, global, DNS, zone-id, mapped, malformed, duplicate, and unassigned identities reject before certificate/storage/audit mutation.
- `reuse` requires an existing exact valid certificate/key/root set for the requested host.
- `issue_leaf` explicitly permits first root creation when no certificate set exists, or a new leaf/key under the existing valid root. It never rotates or silently replaces an existing root.
- No request carries PEM, DER, private-key path, origin, fingerprint, validity, actor, audit summary, current mode, restart flag, or caller-selected TLS policy.

### Network State

The strict response exposes only:

- active request `network_mode`, `transport`, and `active_origin`;
- durable `desired_mode`, `lan_enabled`, selected `bind_host`/`bind_port`, and derived `configured_origin`;
- `configured` and `restart_required`;
- public `certificate_state`: `not_configured`, `valid`, `renewal_due`, `not_yet_valid`, `expired`, `identity_mismatch`, or `unavailable`;
- normalized lowercase SHA-256 root and leaf fingerprints, leaf validity, and whether public-root enrollment is available;
- `can_manage_lan`, true only for exact local-admin authority.

Configured host/origin and public certificate metadata are bounded operational state, not credentials. Responses never expose PEM/DER bytes, private paths, serials, keys, cookies, CSRF state, device identity not already proven by authentication, audit ids, SQL/native errors, or file causes.

Mutation responses use the same selected state plus `configuration_changed`, `desired_mode_changed`, and `restart_required`. They never claim a live rebind.

## Durable Network State

- Migration creates one singleton selected LAN-configuration table with schema version, canonical host/family/port/origin, normalized root/leaf fingerprints, leaf validity, and monotonic `updated_at`.
- Configure is allowed only while durable LAN desired mode is disabled. It descriptor-validates the complete settings and configuration rows inside one immediate transaction.
- Equal configure input is a no-op with no timestamp rewrite. Changed configure input requires non-regressing time and updates only the selected LAN record.
- Enable requires one complete configuration and an exact freshly inspected certificate descriptor. Its immediate transaction compares the descriptor and chronology, then updates only settings `bind_mode`, `bind_host`, `bind_port`, `lan_enabled`, and `updated_at`.
- Repeated enable of the same applied configuration is an auditable no-op. Conflicting configuration/certificate/time state fails without mutation.
- Disable updates only settings network fields and chronology to `localhost`, `127.0.0.1`, the existing selected port, and `lan_enabled: false`; it preserves the reusable LAN configuration and all lock/retention/state fields.
- Repeated disable is an auditable no-op. Opposing operations serialize through SQLite immediate transactions.
- Exact deeply frozen receipts prove before/after/changed state. There is no whole-row save, wildcard fallback, process-only truth, automatic enable, automatic root rotation, or hidden retry.

## Certificate Ownership

- Certificate directory and exact filenames are resolved beneath an owner-controlled canonical config root before mutation.
- Root private key, root certificate, leaf private key, and leaf certificate are owner-only regular files with mode `0600`; the directory is `0700`. Link, hard-link, owner, type, mode, descriptor/path substitution, duplicate-process, partial-set, and mismatched-key conditions fail closed.
- Generation preserves the IFC-V1-015 RSA-2048/SHA-256 root and exact-IP server leaf profiles, random positive 128-bit serials, five-minute skew, 3,650/397-day validity, and 30-day renewal threshold.
- First issue creates a new root and leaf only when no managed set exists. Later issue preserves the exact root and creates a new leaf/key. Root rotation requires a separately explicit future action and phone re-enrollment.
- Material is generated before publication, independently parsed and key/issuer/SAN/usage/validity checked, then atomically published with owner-only modes. A failed publication cleans temporary files and leaves either the prior complete set or an explicit partial-state failure; it never reports success.
- Public enrollment returns only bounded root DER, exact host, media type, and normalized root fingerprint to an explicit local caller. No LAN download route is added.
- Runtime TLS loading rereads and validates the complete selected set for the durable applied host. Returned TLS material is private to lifecycle construction and never enters snapshots, observers, logs, responses, or artifacts.

## Exact Operation Order

### Read

1. Apply no-store policy and validate exact route shape.
2. Resolve loopback-or-device-cookie authentication once.
3. Read and validate durable settings plus optional selected configuration.
4. Inspect only public certificate state when configured.
5. Compare active trust context against durable desired state and derive the strict response.

### Configure

1. Validate exact body before authentication side effects.
2. Require exact local-admin provenance with no cookie/browser fallback.
3. Canonicalize and prove the assigned private address and exact HTTPS origin.
4. Execute accepted audit with bounded address family/port/change intent.
5. Issue or reuse and validate the certificate set exactly once.
6. Atomically configure durable selected LAN state exactly once while remaining disabled.
7. Return success only after terminal audit proof; report no live listener change.

### Enable Or Disable

1. Validate exact body before authentication side effects and require local-admin provenance.
2. For enable, require complete configuration and fresh exact certificate/TLS inspection before accepted audit; disable performs no certificate fallback.
3. Execute accepted audit with only requested desired mode.
4. Invoke one atomic desired-mode transition.
5. Prepare a strict state showing the current active listener separately from desired mode.
6. Return only after terminal audit proof. The caller restarts through the later service owner.

## Failure Contract

| Boundary | Public result | Side-effect truth |
| --- | --- | --- |
| Invalid body/host/port/action | `400 validation_error` | No auth-side write where schema can reject, certificate, audit, or storage mutation. |
| Nonlocal/browser/cookie mutation | `403 permission_denied` | No certificate, audit, or storage work. |
| Wildcard/unassigned/unsupported identity | `400 validation_error` | No certificate or durable mutation. |
| Missing/partial/corrupt/mismatched/unsafe certificate | `409 invalid_config` | No enable; configure fails or records failed/incomplete audit according to side-effect certainty. |
| Configure while LAN desired mode is enabled | `409 operation_conflict` | Existing configuration/settings remain unchanged. |
| Missing/corrupt/read-only/busy storage | `500 storage_error` | No fabricated state; accepted audit receives failed/incomplete terminal truth where applicable. |
| Regressing/concurrent state | `409 operation_conflict` | One transaction wins; no whole-row overwrite. |
| Audit unavailable before mutation | Executor result | No certificate/storage change. No emergency LAN bypass exists. |
| Terminal audit failure after certificate/storage mutation | Fixed non-success, non-retryable | Durable files/settings remain authoritative and are not rolled back deceptively. |
| Response preparation/send failure | Fixed non-success or transport failure | No transition retry; audit/state remain authoritative. |
| Startup certificate/configuration mismatch | Startup fails before listen | No plaintext or wildcard fallback and no stale listener. |

## Hard Success Criteria

| Criterion | Required evidence |
| --- | --- |
| Shared contracts | Exact/extra/missing/accessor/inherited/boundary tests for configure/enable/disable/state/mutation schemas and every cross-field invariant. |
| Address/origin policy | Assigned RFC1918 IPv4 and ULA pass; all unsupported identity classes and canonicalization ambiguities reject before side effects. |
| Certificate owner | Fresh issue, exact reuse, same-root renewal, secure modes, restart, public enrollment, TLS handshake, wrong SAN/key/root/date/usage, partial/corrupt/link/substitution, publish failure, and cleanup pass. |
| Atomic storage | Configure/change/no-op, enable/disable/no-op, unrelated-field preservation, regressing time, corruption, read-only/closed, two-connection contention, restart, and frozen receipt tests pass. |
| Construction/manifest | Branded exact detached ports, mutable/duplicate registration, all four exact manifest entries, and count-only non-secret diagnostics fail closed before listen. |
| Authority/order | Reads cover every auth state. Every paired/browser/cookie mutation fails before certificate/audit/storage; schema validation precedes auth side effects. |
| Audit truth | Configure/enable/disable success/no-op, certificate failure/partial publication, transition failed/incomplete, duplicate operation id, terminal failure, and response failure preserve actor/target/summary continuity. No emergency bypass. |
| HTTPS lifecycle | Loopback HTTP and exact private-IP HTTPS start, request, snapshot, close, failure cleanup, and same-port restart pass. LAN HTTP/wildcard/mismatched certificate/configuration refuse before listen. TLS material is absent from public state/errors. |
| Restart truth | Configure leaves loopback active and desired; enable/disable report restart required until a lifecycle starts from matching durable state. Restart then reports active equals desired. |
| Privacy/runtime | Real SQLite main/WAL/SHM, certificate directory, HTTP/TLS frames, observers, errors, snapshots, logs, and active handles contain only expected public metadata and owner-only key material. |
| Ownership | No remote LAN mutation, device revoke, common write dispatch, UI, package/service command, aggregate phone acceptance, or release acceptance is claimed. |

## Validation Plan

- Direct contracts, certificate owner, selected network repository/service/routes, audit-executor regression, and HTTPS lifecycle suites.
- Real migrated SQLite with two connections, forced failures, restart, audit pending truth, and raw main/WAL/SHM inspection.
- Real owner-only certificate directory, exact TLS handshake, raw plaintext refusal, no-store/no-CORS framing, and listener cleanup/restart.
- Focused server/storage/contracts regressions, then root/all-package typecheck, lint/exports, scaffold, unit, contract, integration, web, planning, exact Codex binding, frozen offline install, production audit/license inventory, and `git diff --check`.
- Manual descriptor/authority/order/audit/restart/privacy/ownership review. Physical Android aggregate acceptance remains `IFC-V1-033`; UI certificate state remains `FE-V1-034`.

## Implementation Result

- Strict selected network contracts distinguish active listener state from durable desired state and reject extra, inherited, accessor-backed, malformed, unsupported, or contradictory values.
- Migration 012 and the selected LAN repository own one durable pending configuration plus atomic configure/enable/disable chronology without rewriting unrelated settings. No-op, contention, restart, corruption, read-only, and regressing-time behavior fail closed.
- The production certificate owner issues or reuses an exact RSA-2048/SHA-256 root and private-IP server leaf, preserves the root across renewal, validates the complete profile before use, publishes only owner-readable files, and exposes only bounded public enrollment material.
- The lifecycle admits explicit loopback HTTP or branded assigned-private-IP HTTPS. It rejects plaintext LAN, wildcard, mismatched TLS/configuration, secret-bearing snapshots, and stale listener claims; close and same-port restart are proven on real sockets.
- The four exact routes enforce validation, authority, accepted-to-terminal audit, certificate, storage, and response order. Paired/browser callers can read but cannot mutate; local-admin disable remains available through the headless service after LAN startup.
- Hardened race coverage re-inspects assigned-address and certificate state immediately before durable mutation, including certificate replacement after accepted audit. Real SQLite main/WAL/SHM and certificate files were inspected for expected public metadata and private-key containment.

## Validation Evidence

- Direct selected network routes (10), certificate policy (7), and HTTPS lifecycle (1) pass with real SQLite, generated certificates, TLS handshakes, plaintext refusal, listener cleanup, and restart.
- Full unit: 105 files passed, 16 skipped; 958 tests passed, 29 skipped. Contract: 22 files and 176 tests. Integration: 16 tests. Web: 14 tests.
- Root and all-package typechecks, lint/exports, scaffold, planning integrity, exact Codex 0.144.0 binding, frozen offline install, zero-vulnerability production audit, permissive-license inventory, and manual authority/order/restart/privacy/ownership review pass.
- Implementation commits: contracts `3c6df02`, storage `bc25473`, certificate owner `7103508`, lifecycle `cb790e6`, routes `f8d9aa8`, and transition hardening `9e6c0b7`. Frozen criteria: `47cafb7`.

## Downstream Ownership

- `IFC-V1-033`: aggregate browser trust/security matrix and physical Android HTTPS acceptance.
- `IFC-V1-021`, `IFC-V1-053` to `IFC-V1-058`: production composition, package, CLI/service restart, and install lifecycle.
- `FE-V1-013`, `FE-V1-034`: host/access and read-only LAN/certificate/recovery UI.
- `IFC-V1-059`, `IFC-V1-066`: device revocation and common exact-target write admission.
- `REL-V1-005`, `REL-V1-006`: release security and clean phone/package acceptance.
