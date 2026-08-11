# DAT-V1-101 Windows Secure Paths

Status: done.

## Result

- Windows defaults resolve through native current-user known folders to `%APPDATA%\HostDeck` and `%LOCALAPPDATA%\HostDeck\{State,Runtime}`.
- HostDeck-owned directories and files use a protected current-user owner/DACL. Insecure inherited ownership or ACLs are repaired only in explicit repair mode and revalidated on the same native file identity.
- NTFS/local-fixed-volume, canonical case, root containment, reserved names, reparse points, alternate streams, hard links, file type, and path substitution fail closed before protected files are consumed.
- Open-file validation binds Node's descriptor identity to the path through Node-exported `uv_get_osfhandle`, then compares raw Windows volume serial/file index identities. No external CRT descriptor table is trusted.

## Acceptance

| Criterion | Evidence |
| --- | --- |
| Known-folder defaults and root confinement | Contract fixtures plus the native known-folder/path matrix |
| Current-user owner and protected DACL | Native create, inherited-ACL repair, and post-repair inspection |
| Reparse, ADS, hard-link, case, reserved-name, type, and escape rejection | Contract mutation cases and `windows_paths` native check |
| Descriptor/path substitution detection | Open descriptor, rename, replacement, and `verifyPath()` rejection on Windows |
| Unsupported platform/filesystem handling | Fail-closed contract cases; only local fixed NTFS is admitted |

## Evidence

- Implementation: `2610ea6` through `9195017`; accepted source and browser pin: `9663834`.
- Native matrix: [31468773680](https://github.com/simonli357/HostDeck/actions/runs/31468773680), jobs `93707237075` and `93707237234`. Independently downloaded JSON and SHA-256 sidecars verify commit `9663834`, lockfile `526de9bacb84e4b3b9ce8b8f3af1a1677c27ac8923939e38bc04b60ef58679be`, Node 22.22.2/ABI 127, pnpm 10.29.2, Koffi 3.1.4, and all 10 Windows/12 Linux checks.
- Local: 265 files/3,004 unit tests passed with 27 files/29 intentional environment skips; 38 files/270 contract tests passed; focused typecheck and lint passed.
- Package/browser: two deterministic 625-source/1,257-output/6,276-entry builds passed relocation, read-only, and tamper checks at content SHA-256 `1ea72f96dadb9bc9652657155c15c51a228128242c37dd85b492045cf297bcf9`; all 76 Chromium/Firefox phone/desktop cases passed with 316 bounded requests, 52 exact mutations, and zero unexpected diagnostics.

Clean Windows 11 package, lifecycle, upgrade, and installer acceptance remain owned by downstream native-distribution tasks. Same-user malicious code is outside the filesystem-isolation boundary.
