# FND-V1-101 Platform Fixtures

- Result: pass.
- Inventory: two immutable synthetic host profiles and 60 deterministic cases covering Linux/Windows across configuration, paths, Codex endpoint, lifecycle, package, and Tailscale surfaces.
- Cases: every surface has valid, invalid, boundary, mixed-platform, and secret-bearing input with explicit accept/reject truth and bounded non-secret reasons.
- Boundary: direct host APIs are frozen to 41 reviewed adapter/build/edge owners; any new owner or stale registry entry fails the selected-runtime check.
- Validation: contract 257; unit 2,992 passed with 29 intentional skips; typecheck, lint/exports, scaffold, planning, and runtime boundary pass.
