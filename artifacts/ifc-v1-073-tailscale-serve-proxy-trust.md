# IFC-V1-073 Tailscale Serve Proxy Trust Evidence

## Outcome

- Frozen criteria: `e58d921`; normalized combined-signal correction: `4279b95` (`BUG-009`); implementation: `9c501be`.
- Added one immutable policy with a private synchronous admission reader, one pure normalized evaluator, one thin Fastify `onRequest` gate, a private provenance accessor, and bounded reason-only snapshots.
- Direct local form remains exact IPv4 loopback HTTP and delegates the existing Host/Origin/method evaluator. It contains no reserved proxy signal and never calls the remote reader.
- Remote form requires the exact spike-proven Tailscale Serve shape on the plaintext loopback backend. It reconstructs one canonical external HTTPS origin while retaining physical loopback transport truth.

## Trust Boundary

- Policy construction accepts only one canonical `http://127.0.0.1:<port>` local origin, selected HTTP header-count/header-byte/URL limits, and a function reader. The policy and limits are deeply frozen; the reader is held only in a private `WeakMap` and is absent from keys and serialization.
- Raw probes require an exact plain shape, bounded method/address/target/header work, valid header-name syntax, even raw pairs, selected count/byte ceilings, and no impossible control values. Oversize work rejects before UTF-8 measurement can become unbounded.
- The backend peer must be canonical IPv4 loopback or mapped IPv4 loopback, the socket must be plaintext, and the target must be origin-form. IPv6 loopback, non-loopback, TLS backend, absolute/authority/asterisk, encoded slash/backslash/control, and fragment forms reject.
- Any standard forwarding or Tailscale identity signal selects remote classification. `Forwarded`, `Via`, generic/unknown `X-Forwarded-*`, `X-Original-*`, `X-Real-IP`, `Proxy-Connection`, unknown `Tailscale-*`, Funnel, and access-control preflight reject. Every `X-Tailscale-*` name is an untrusted lookalike and has highest header precedence.
- Forwarding requires one each of `X-Forwarded-For`, `X-Forwarded-Host`, and `X-Forwarded-Proto`. Proto is exactly `https`; forwarded host is one canonical no-port HTTPS authority; source is one canonical IPv4 address in `100.64.0.0/10`. Lists, ports, whitespace, alternate text, private/public/non-CGNAT IPv4, and IPv6 reject.
- Standard identity is all four exact 1.98.8 names absent or all present once. The headers-info marker is exact; remaining values are nonblank, control-free, and aggregate-bounded. Values are discarded after one presence boolean.
- External `Host` and forwarded host must equal the current external authority exactly. Safe `GET`/`HEAD` may omit Origin; unsafe methods require one exact external Origin. Duplicate, foreign, uppercase, trailing-dot, userinfo, explicit-default-port, comma-joined, and DNS-rebinding aliases reject.
- Every proxy-shaped evaluation reads admission before and after parsing. Both normalized snapshots must be open and equal in generation and canonical origin. Closed, malformed, throwing, or changed reads reject as stale after any higher-priority hostile reason.
- A valid source is reduced to `sha256(hostdeck:tailscale-serve-source:v1, ipv4, canonical-address)`. Admission returns only frozen local or remote provenance with `app_authorization: not_evaluated`; it creates no device, permission, local-admin, cookie, or CSRF authority.

## Fastify And CORS

- The gate uses raw Node socket/header/URL data before handlers. Rejection increments one fixed reason counter, closes the backend connection, and returns the existing generic `403 invalid_origin` body without reflecting request values.
- Admitted provenance is attached through one private symbol and accessor. Snapshots copy and freeze accepted counts, CORS violations, and the fixed rejection-reason record; they retain no Host, Origin, DNS, source address, profile, or identity value.
- The existing raw Fastify/Node CORS response guard was extracted without behavior change and is shared by local and Serve gates. Fastify headers, raw `setHeader`/`appendHeader`/`setHeaders`/`writeHead` paths, and late `onSend` headers still fail to one bounded internal error.
- The module never enables Fastify `trustProxy`, emits CORS policy, opens a listener, calls Tailscale, reads a node key, or performs application authorization. App/auth/lifecycle composition remains downstream.

## Automated Evidence

- Eighteen focused proxy tests cover immutable/private policy construction; selected resource minima/defaults/maxima; direct-local separation; exact remote admission with optional identity; domain-separated source hash; safe/unsafe Origin; Host/forwarded-host aliases; all forwarding cardinalities; CGNAT endpoints and hostile values; all-or-none identity; reserved namespaces; non-loopback/TLS/target forms; reader closed/throw/malformed/generation/origin races; local rebinding; zero-handler rejection; frozen privacy-safe diagnostics; raw response CORS suppression; and raw TCP direct/remote/duplicate/lookalike behavior.
- A deterministic 36-case product crosses exact/partial/absent forwarding, absent/present/invalid identity, lookalike presence, and unknown reserved context. Every case preserves truthful assessments and the frozen precedence; none needs invented lower-priority evidence.
- The unchanged local request-trust suite remains 13/13 after CORS extraction, including raw CORS interception and throwing/rejecting observer paths.

## Real Serve Evidence

- An opt-in real smoke started one ephemeral loopback Fastify listener from an empty dedicated-profile Serve baseline and enabled only the ownership-safe private root mapping.
- Direct loopback form remained local and issued no Secure test cookie. Private Serve HTTPS was trusted without custom CA enrollment and produced admitted remote provenance with matching generation/origin, a valid hashed CGNAT source, and application authorization still unevaluated.
- Browser-supplied forwarding and partial standard identity spoof values were overwritten/removed by Serve and the resulting canonical requests admitted. A spoofed Funnel marker was removed. A surviving `X-Tailscale-*` lookalike, foreign Origin, and preflight each returned generic 403 before the handler and issued no cookie.
- Remote response cookie inspection proved `Secure`, `HttpOnly`, host-only, `SameSite=Strict`, and no CORS header. The smoke closed admission first, removed only the exact owned root mapping, independently observed final absent state, closed the listener, and left no child process.
- No account, profile, node, DNS name, source address, identity value, credential, raw Tailscale output, or response payload from the real environment is retained in code, output, docs, or this artifact.

## Validation

- Focused: proxy trust 18 passed; unchanged local trust 13 passed; opt-in real private Serve smoke 1 passed.
- Contract: 229 passed. Unit: 1,144 passed and 33 explicit external/device skips; 0 failed. Integration: 16 passed. Web: 14 passed.
- Root and all-package typechecks passed. Lint/exports passed for 359 files and 9 packages. Scaffold passed for 9 packages and 18 root scripts. Planning passed at 212 tasks, 84 requirements, 649 dependencies, and 19 queued before closure.
- Manual policy/parser/gate/CORS/privacy/side-effect/API review, active-resource inspection, `git diff --check`, focused Biome, real cleanup, and commit/push checks passed.

## Remaining Gate

- `IFC-V1-074` must compose this provenance with application pairing, source/global rate limits, cookie authentication, permissions, CSRF, lock, and revoke without treating tailnet identity as authority.
- `IFC-V1-076` still owns durable remote enable/status/disable service, API, and local CLI composition. Pairing links, lifecycle/SSE invalidation, aggregate hostile acceptance, package/service setup, and the complete physical Android workflow remain `IFC-V1-077` to `IFC-V1-079` and release work.
- ADB still did not enumerate the connected phone during the unit gate. This leaf proves the real Serve proxy boundary from the laptop; it does not claim final phone deployment or acceptance.
