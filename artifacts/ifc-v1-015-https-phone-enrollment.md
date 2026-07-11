# IFC-V1-015 HTTPS Phone Enrollment

Date: 2026-07-11

Status: host-side profile and dependency proof pass; physical-phone enrollment is pending.

## Scope

Select and prove the local CA, leaf profile, explicit LAN identity, enrollment transfer, renewal, failure, and cleanup contract before any production LAN listener/auth route is implemented. This spike does not enable LAN, create a plaintext bootstrap endpoint, add pairing/auth behavior, or claim mobile trust without a physical browser run.

## Candidate Review

| Candidate | Result | Reason |
| --- | --- | --- |
| `@peculiar/x509` 2.0.0 plus `reflect-metadata` 0.2.2 | Selected host-side candidate | Current Node 20+ TypeScript/WebCrypto library, CA-signed generation and extension control, no subprocess/native binary, MIT direct library, Apache-2.0 reflection polyfill. Exact dependencies and lockfile are committed. |
| OpenSSL 3 CLI | Retained as independent validator only | Present on supported Ubuntu and authoritative for chain/purpose/IP checks, but runtime generation would add subprocess, version/config, temporary-file, and packaging failure surfaces. |
| `mkcert` 1.4.x | Rejected | Its own documentation says it is for development rather than end-user production machines; automatic desktop trust-store behavior does not solve controlled mobile enrollment. |
| Smallstep `step` / `step-ca` | Rejected for V1 | Strong certificate tooling, lint, renewal, and CA operations, but a separate binary or online CA service is disproportionate for one local HostDeck origin. |
| `selfsigned` / `node-forge` | Rejected | Less direct control over the selected CA/leaf profile or broader legacy/dual-license surface; neither improves the mobile enrollment gate over the selected structured library. |

Package review added 18 pure-JS packages to the frozen graph. `pnpm audit --prod` reports no known vulnerabilities. New X.509 dependencies are MIT/BSD-3-Clause; `reflect-metadata` is Apache-2.0. Frozen offline install passes.

## Selected Host Profile

- Identity is one canonical address currently assigned to the host: RFC1918 IPv4 or IPv6 ULA. Loopback, unspecified, link-local, multicast, globally routable, unassigned, malformed, and wildcard values reject before generation. The current physical proof target is exact IP SAN `192.168.0.29`; DNS aliases remain outside the proof unless separately resolved and validated.
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

## Physical Gate

Pending evidence must record the phone model, OS version, browser/version, same-network origin, and redacted screenshots or transcript for:

1. Transfer only the root `.cer` and independently compare the SHA-256 fingerprint.
2. Install the root; on Apple devices, explicitly enable full TLS trust.
3. Open the exact IP-SAN HTTPS origin with no warning and confirm the expected bounded probe response.
4. Replace the leaf under the same root and reconnect without installing a new root.
5. Prove wrong-IP, expired/not-yet-valid, untrusted/root-rotated, and plaintext origins do not expose HostDeck content.
6. Remove the root and confirm trust fails; reinstall and recover deterministically.
7. Stop the listener and remove all temporary phone-probe files. Confirm no key, credential, or sensitive page content entered logs, screenshots, history, QR, or artifacts.

IFC-V1-015 remains incomplete until this gate passes. The second mobile OS/browser family remains part of later browser/release matrices unless the V1 support policy is expanded.

## Primary References

- Apple manual root trust: <https://support.apple.com/en-ie/102390>
- Apple certificate profile installation: <https://support.apple.com/en-gb/102400>
- Apple TLS certificate requirements: <https://support.apple.com/en-lamr/103769>
- Android/Pixel certificate install and removal: <https://support.google.com/pixelphone/answer/2844832?hl=en>
- `@peculiar/x509`: <https://github.com/PeculiarVentures/x509>
- Node TLS: <https://nodejs.org/api/tls.html>
- OpenSSL verification: <https://docs.openssl.org/3.0/man1/openssl-verify/>
