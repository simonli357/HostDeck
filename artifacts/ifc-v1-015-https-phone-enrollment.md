# IFC-V1-015 HTTPS Phone Enrollment

Date: 2026-07-11

Status: complete; host profile, physical Android enrollment, renewal, rejection, removal, recovery, and cleanup pass.

## Scope

Select and prove the local CA, leaf profile, explicit LAN identity, enrollment transfer, renewal, failure, and cleanup contract before any production LAN listener/auth route is implemented. This spike does not enable production LAN, create a plaintext bootstrap endpoint, or add pairing/auth behavior.

## Candidate Review

| Candidate | Result | Reason |
| --- | --- | --- |
| `@peculiar/x509` 2.0.0 plus `reflect-metadata` 0.2.2 | Selected | Current Node 20+ TypeScript/WebCrypto library, CA-signed generation and extension control, no subprocess/native binary, MIT direct library, Apache-2.0 reflection polyfill. Exact dependencies and lockfile are committed. |
| OpenSSL 3 CLI | Retained as independent validator only | Present on supported Ubuntu and authoritative for chain/purpose/IP checks, but runtime generation would add subprocess, version/config, temporary-file, and packaging failure surfaces. |
| `mkcert` 1.4.x | Rejected | Its own documentation says it is for development rather than end-user production machines; automatic desktop trust-store behavior does not solve controlled mobile enrollment. |
| Smallstep `step` / `step-ca` | Rejected for V1 | Strong certificate tooling, lint, renewal, and CA operations, but a separate binary or online CA service is disproportionate for one local HostDeck origin. |
| `selfsigned` / `node-forge` | Rejected | Less direct control over the selected CA/leaf profile or broader legacy/dual-license surface; neither improves the mobile enrollment gate over the selected structured library. |

Package review added 18 pure-JS packages to the frozen graph. `pnpm audit --prod` reports no known vulnerabilities. New X.509 dependencies are MIT/BSD-3-Clause; `reflect-metadata` is Apache-2.0. Frozen offline install passes.

## Selected Host Profile

- Identity is one canonical address currently assigned to the host: RFC1918 IPv4 or IPv6 ULA. Loopback, unspecified, link-local, multicast, globally routable, unassigned, malformed, and wildcard values reject before generation. The physical proof target was exact IP SAN `192.168.0.29`; DNS aliases remain outside the selected contract unless separately resolved and validated.
- Root and leaf use RSA 2048 with SHA-256. Serial numbers are random positive fixed-width 128-bit values.
- Root: `CN=HostDeck Local CA`, CA true, path length 0, critical `keyCertSign`/`cRLSign`, subject key identifier, exact 3,650-day validity.
- Leaf: `CN=HostDeck LAN`, CA false, critical `digitalSignature`/`keyEncipherment`, exact `serverAuth`, exact IP SAN, subject/authority key identifiers, exact 397-day validity.
- Both profiles allow five minutes of issuance clock skew. Leaf renewal becomes due at 30 days remaining. Renewal creates a new key/serial/leaf under the same root; root rotation is a separate explicit re-enrollment event.
- Root key, leaf key, root certificate, and leaf certificate are owner-only `0600` files under canonical `0700` ownership. The existing no-follow owner/mode/type/link validator remains mandatory. Unencrypted service keys are protected from other UIDs, not from a malicious process already running as the HostDeck user.
- Enrollment exports only the root DER certificate, exact host, media type, and normalized SHA-256 fingerprint. It never exports either private key. DEC-020 forbids a plaintext LAN download endpoint; the physical proof must use out-of-band file transfer or another fingerprint-verified path.

## Host Evidence

Implementation/probe commit: `794784a`.

`packages/server/src/lan-https-certificate.probe.test.ts` proves:

- canonical private IPv4 and ULA admission plus loopback/link-local/multicast/global/unassigned/malformed rejection;
- exact root/leaf extensions, signatures, issuer relationship, private-key matches, serial width, SAN, validity, renewal states, fingerprint, and bounded public DER export;
- fresh real TLS handshakes for trusted exact IP, wrong IP, absent trust, plaintext-to-TLS, expiry, not-yet-valid, wrong private key, same-root renewal, and root rotation;
- independent OpenSSL `verify -purpose sslserver` and exact/mismatched `-checkip` inspection;
- owner-only file modes plus over-permissive key and symlink rejection through the production secure-path validator;
- bounded requests, response bytes, OpenSSL process time, listener close, and temporary directory cleanup.

Validation after the spike:

- Focused certificate profile: 1 file, 6 tests passed.
- Unit: 85 files passed, 16 skipped; 762 tests passed, 29 explicit external tests skipped.
- Contract: 14 files/138 tests; integration: 2 files/16 tests; web: 2 files/14 tests.
- Root/server typechecks, lint/package exports (270 files, 9 packages), scaffold, planning, exact Codex binding, offline frozen install, production audit, license review, and diff checks pass.

## Physical Android Evidence

Device and network:

- Xiaomi model code `2410DPN6CC`, Android 16/API 36, build `OS3.0.304.0.WOBCNXM`.
- Chrome `150.0.7871.114`.
- Phone `192.168.0.59/24` and host `192.168.0.29/24`; phone-to-host ICMP passed before TLS testing.
- Public root transfer used authenticated USB-C/ADB, not LAN. The 779-byte DER file and phone copy both had SHA-256 `a9c61d35859ff962f6bc08f2ee75940183fd0883986477b47ef0a13ae8a46d9f`.
- Only `HostDeck-Local-CA.cer` reached the phone. Root and leaf private keys remained in owner-only host storage.

Each negative browser case used a newly generated leaf key, a fresh port, a cold Chrome process, a cache-busting query, and a DevTools title check. This prevents a restored tab or prior certificate exception from producing false evidence.

| Case | Origin/profile | Physical result |
| --- | --- | --- |
| Initial enrollment | `https://192.168.0.29:8443/`, leaf `8e8cb85bd4146f4a7c58d13f2a70d2610ea1f2c58c736ff69dae1bd30df1dfe8` | Chrome exposed `Connection is secure`; bounded page showed `Profile: initial`. |
| Same-root renewal | Same origin, leaf `a8de15e3aa9900c09cecf6b6be95e9fb4ebff30afe26ff2528086a0fccca5321` | Cold reconnect succeeded without reinstalling the unchanged root; page showed `Profile: renewed`. |
| Wrong IP SAN | `:18450`, fresh leaf `87c1b37e51cd3ceb0711c3f5176d2feb16b2b5c310dc3c3b63997474143e904b` | `Privacy error`; `NET::ERR_CERT_COMMON_NAME_INVALID`; no probe page loaded. |
| Expired leaf | `:18451`, fresh leaf `953894ed172c6dd3984218fcb42781975c8d64e86eef47cf1b36c041b715a3e9` | `Privacy error`; `NET::ERR_CERT_DATE_INVALID`; no probe page loaded. |
| Not-yet-valid leaf | `:18452`, fresh leaf `9a1f3d12c1e18f2d96b0c8064ea1dcd537f92cb5d7f7f7ab0e8860a164e5886f` | `Privacy error`; `NET::ERR_CERT_DATE_INVALID`; no probe page loaded. |
| Rotated/untrusted root | `:18453`, root `2b60723486f468bfe2bf4cec9f65fe8d3c1654c149b3ac7b4f12536c0d152abe` | `Privacy error`; `NET::ERR_CERT_AUTHORITY_INVALID`; no probe page loaded. |
| Restored selected root | `:18454`, leaf `a0ac3dc4d71483467210d6b3cd56aff18d136d2bd42f4bb8b0f4e3e3547e2c35` | `Connection is secure`; page showed `Profile: restored`. |
| Plaintext to TLS listener | `http://192.168.0.29:18454/` | `ERR_EMPTY_RESPONSE`; HostDeck content was not exposed. |
| Root removed | `https://192.168.0.29:18455/`, same valid leaf | `Privacy error`; `NET::ERR_CERT_AUTHORITY_INVALID`. |
| Root reinstalled | `https://192.168.0.29:18456/`, same valid leaf | `Connection is secure`; bounded restored page loaded again. |
| Wrong private key | Host listener construction/startup | Node rejects the key/certificate mismatch before bind, so no phone endpoint can exist; the focused host probe owns this non-network failure evidence. |

Reviewed screenshots retained in `artifacts/`:

- Trust lifecycle: `ifc-v1-015-android-user-ca.png`, `ifc-v1-015-android-user-ca-removed.png`, `ifc-v1-015-android-user-ca-reinstalled.png`.
- Accepted paths: `ifc-v1-015-android-initial-valid.png`, `ifc-v1-015-android-renewed-valid.png`, `ifc-v1-015-android-restored-valid.png`, `ifc-v1-015-android-reenrolled-recovery.png`.
- Refused paths: `ifc-v1-015-android-wrong-ip-rejected.png`, `ifc-v1-015-android-expired-rejected.png`, `ifc-v1-015-android-not-yet-valid-rejected.png`, `ifc-v1-015-android-rotated-root-rejected.png`, `ifc-v1-015-android-trust-removed-rejected.png`, `ifc-v1-015-android-plaintext-refused.png`.

The device credential was entered directly by the human and never passed through ADB, process arguments, repository files, logs, or artifacts. No trust-bypass action was used in retained evidence.

## Cleanup

- The temporary HTTPS listener stopped and no probe port remained bound.
- The phone's HostDeck user CA was removed after the final recovery proof.
- The transferred root, device screenshots, UI hierarchy, all 11 probe tabs, ADB forwarding, and temporary stay-awake setting were removed.
- Host probe key/certificate state and the temporary physical-test harness were deleted; no private key or certificate state remains under `/tmp/hostdeck-ifc-v1-015-phone`.
- Only reviewed product-specific screenshots remain in the repository. A full contact-sheet inspection found no credential or unrelated sensitive page content.

The second mobile OS/browser family remains part of later browser/release matrices unless the V1 support policy is expanded.

## Primary References

- Apple manual root trust: <https://support.apple.com/en-ie/102390>
- Apple certificate profile installation: <https://support.apple.com/en-gb/102400>
- Apple TLS certificate requirements: <https://support.apple.com/en-lamr/103769>
- Android/Pixel certificate install and removal: <https://support.google.com/pixelphone/answer/2844832?hl=en>
- `@peculiar/x509`: <https://github.com/PeculiarVentures/x509>
- Node TLS: <https://nodejs.org/api/tls.html>
- OpenSSL verification: <https://docs.openssl.org/3.0/man1/openssl-verify/>
