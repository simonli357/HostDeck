# IFC-V1-100 Platform Tailscale Adapter

## Result

- Status: passed.
- Implementation: `9f38632`; Windows canonical-path fix: `1893162`; accepted evidence: `0a34008`.
- Native acceptance: run `31474471365`; Windows job `93724885950`, Linux job `93724885955`.
- Scope: platform discovery/execution and existing normalized observer/Serve contracts. Real Windows Tailscale profile/Serve/phone acceptance remains `IFC-V1-109`.

## Contract

- One shared adapter selects only `/usr/bin/tailscale` for Linux x64 or `C:\Program Files\Tailscale\tailscale.exe` for Windows x64 from the exact host-platform capability.
- Discovery is read-only. It requires one stable canonical regular file with one link, rejects aliases and symlinks, and validates root-owned non-writable executable x64 ELF on Linux or x64 PE on Windows. Windows accepts only the native `\\?\` form of the same reviewed drive path; UNC and other device namespaces fail.
- The adapter alone constructs the five read argv shapes and two Serve mutation argv shapes. It uses absolute execution without a shell, target-specific cwd/environment, combined stdout/stderr byte limits, fatal UTF-8 reads, timeout and abort termination, and bounded consent/permission marker detection without returning raw mutation output.
- Production observation and Serve mutation share one adapter instance. Exact Tailscale 1.98.8 CLI/daemon checks, profile comparison hashing, Serve ownership, authoritative pre/post reads, failure mapping, and no automatic profile switching remain unchanged.

## Evidence

| Gate | Result |
| --- | --- |
| Adapter/discovery/process | 33 focused tests pass for Linux and Windows fixed paths/argv, ELF/PE and alias/script/arch rejection, missing/race/link/mode cases, native path forms, no discovery execution, output/UTF-8/timeout/abort bounds, marker privacy, and real cross-platform Node process/file edges. |
| Affected behavior | 204 observer, manager, remote-ingress, authorization, lifecycle, and production-composition tests pass; the real laptop read-only Tailscale observation smoke passes at exact 1.98.8 without profile or Serve mutation. |
| Workspace/static | Typecheck and lint pass; contract 270, integration 36, unit 3,036 with 29 intentional environment/device skips; runtime boundary accepts one Tailscale host-API owner across 626 production modules. |
| Package | Package acceptance passes 43 checks and two deterministic builds. Final build: 626 sources, 1,259 outputs, 6,278 entries; source commit `18931624d3c1b92c79a860b0de957f8dbfb0221f`; source SHA-256 `4c6781d0d87da545defdb1c1c1e479854a9f0bad4bee5557d169eb092b68765a`; content SHA-256 `48228424d45662f3e2ed19a749f2c51893ec87b5ada7859aadcfbe2b5fb2d4d5`; manifest SHA-256 `0de881abbb600b0cc1f42e203feb5ba20d946d5794ef6d431de3a05fb96b0e62`. |
| Native CI | Linux 13/13 and Windows 11/11 checks pass at `0a3400822f478477c33d44851aae9145b3823b28`, including the zero-skip `tailscale_adapter` check. Both downloaded JSON records and SHA-256 sidecars verify. |

No private account, profile identity, raw command output, token, pairing material, phone claim, or discovery mutation is retained.
