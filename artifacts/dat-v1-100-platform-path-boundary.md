# DAT-V1-100 Platform Path Boundary

Status: done.

## Result

- Platform-neutral validation owns bounded absolute paths, lexical normalization, root rejection, non-overlapping config/state/runtime roots, and a strict database descendant rule for POSIX and Windows dialects.
- The Linux adapter retains the existing UID, mode, no-follow, owner, link, canonical-parent, runtime-parent, repair, and path-substitution checks. Existing imports continue through a thin facade.
- Adapter identities admit only `linux-x64`/`posix`/`uid_mode` or `windows-x64`/`windows`/`current_user_acl`. Native Windows filesystem work fails closed until `DAT-V1-101` supplies the ACL adapter.
- Windows fixtures use distinct `State` and `Runtime` roots with the database below `State`.

## Evidence

- Implementation: `6ad86b4`.
- Native matrix: [31461977290](https://github.com/simonli357/HostDeck/actions/runs/31461977290); independently verified Linux and Windows artifacts bind commit `6ad86b4`, one lockfile digest, Node 22.22.2/ABI 127, and passed 11 Linux and nine Windows checks.
- Local: eight Linux secure-path tests, 263 contract tests, typecheck, lint/exports, scaffold, and the 623-module/22-external runtime boundary passed.
- Package: deterministic 623-source/1,253-output/6,239-entry acceptance and the 76-case Chromium/Firefox phone/desktop matrix passed against package digest `f3886ef14769952a4c71689333bcc29ddaaf0483d81063dda81edef0f36206bf`.

Windows ACL, reparse-point, alternate-stream, reserved-name, case-collision, and raw path-identity enforcement remains owned by `DAT-V1-101`.
