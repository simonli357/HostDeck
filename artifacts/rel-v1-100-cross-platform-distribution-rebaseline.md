# REL-V1-100 Cross-Platform Distribution Rebaseline

- Date: 2026-08-10
- Decision: `DEC-029`
- Target: Ubuntu 24.04 x64 and Windows 11 x64 native per-user host packages.
- Remote path: unchanged loopback HostDeck plus private Tailscale Serve HTTPS and HostDeck pairing.
- Linux: private Unix Codex socket, XDG roots, systemd user units.
- Windows: authenticated loopback Codex WebSocket, current-user ACL roots, interactive-user startup agent, signed MSIX.
- Packaging: bundled pinned Node and native modules; native CI only; public checksums, SBOM, provenance, and signatures.
- Release: tested install, start, login recovery, upgrade, rollback, repeated uninstall, reinstall, data preservation, remote phone, privacy, and cleanup on both hosts.
- Deferred: macOS, ARM hosts, app stores, HostDeck relay, native phone apps.
- Status: planning complete; implementation and native Windows evidence remain release blockers.
