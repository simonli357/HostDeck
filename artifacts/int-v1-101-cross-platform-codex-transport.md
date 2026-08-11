# INT-V1-101 Cross-Platform Codex Transport

Date: 2026-08-11

## Result

Passed. `@hostdeck/codex-adapter` now exposes one fail-closed schema-1 local endpoint contract and one transport for Linux x64 private Unix sockets or Windows x64 authenticated IPv4 loopback WebSockets. The legacy Unix factory remains compatible.

## Contract

- Linux accepts only normalized absolute POSIX socket paths up to 107 UTF-8 bytes and never accepts a credential source.
- Windows accepts only `ws://127.0.0.1:<nonprivileged-port>` with `ephemeral_random` allocation and a base64url bearer read once from `HOSTDECK_CODEX_REMOTE_AUTH` through the protected-environment port.
- Endpoint kind, target, URI, option fields, native host, resource bounds, and credential bounds are exact. Aliases, mixed targets, fixed/privileged ports, unknown fields, accessors, and fallback transports fail before connection.
- Endpoint display, typed errors, rejected upgrades, and both close directions omit credential material. Raw WebSocket causes are not propagated.
- Existing text-frame, heartbeat, generation, abort, close, payload, and backpressure behavior is shared unchanged by both endpoint families.

## Evidence

| Gate | Result |
| --- | --- |
| Focused | 73 endpoint/transport tests pass, including deterministic port/token properties, hostile config, legacy Unix lifecycle, bounds, heartbeat, and backpressure. |
| Workspace | Typecheck, lint/exports, planning, and selected-runtime boundary pass; unit 3,088 with 29 intentional environment/device skips; contract 272; integration 36. |
| Package | 43 direct checks and two deterministic 627-source builds pass with 6,280 entries and unchanged three-file web identity. |
| Native | Run `31481942844`, source `11971101fca3a6f33b2530def18ba58dc5ee5a0a`: Windows 12/12 and Linux 13/13 checks pass. Downloaded SHA-256 sidecars and both native records verify. |
| Windows branch | Native contract rejects the opposite target and invalid bearer, accepts exact auth, exchanges text across two generations, reads authority once, and redacts remote/client close reasons. |
| Linux branch | Native contract rejects the opposite target, exchanges text on a private Unix socket, and observes no authorization header. |

Implementation: `cd2cf7c`; package identity correction: `1197110`. Endpoint-secret generation/rotation and platform TUI execution remain `INT-V1-102` and `INT-V1-103`; no phone evidence is required or claimed.
