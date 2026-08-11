import {
  closeSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { win32 } from "node:path";
import { describe, expect, it } from "vitest";
import type { HostDeckLocalPathErrorCode } from "./secure-local-path-contract.js";
import {
  nativeWindowsFileSecurityPort,
  type WindowsNativeFileSecurityPort
} from "./windows-native-file-security.js";
import {
  createWindowsHostDeckLocalPathAdapter,
  resolveWindowsHostDeckDefaultPaths
} from "./windows-secure-local-path-adapter.js";

describe("Windows-native secure local paths", () => {
  it("enforces the native ACL, path, stream, link, reparse, case, and descriptor matrix", () => {
    if (process.platform !== "win32") {
      expect(() => nativeWindowsFileSecurityPort.currentUserRoots()).toThrowError(
        expect.objectContaining({
          name: "WindowsNativeFileSecurityError",
          code: "unsupported_platform"
        })
      );
      return;
    }

    expect(process.arch).toBe("x64");
    const userRoots = nativeWindowsFileSecurityPort.currentUserRoots();
    for (const path of [userRoots.local_app_data, userRoots.roaming_app_data]) {
      expect(path).toMatch(/^[A-Z]:\\/u);
      const inspection = nativeWindowsFileSecurityPort.inspectPath(path);
      expect(inspection.file_system).toBe("NTFS");
      expect(inspection.is_directory).toBe(true);
      expect(inspection.is_reparse_point).toBe(false);
      expect(inspection.owner_current_user).toBe(true);
      expect(
        nativeWindowsFileSecurityPort.equalOrdinalIgnoreCase(
          inspection.canonical_path,
          path
        )
      ).toBe(true);
    }

    const root = mkdtempSync(win32.join(tmpdir(), "hostdeck-windows-paths-"));
    const localRoot = win32.join(root, "Local");
    const roamingRoot = win32.join(root, "Roaming");
    mkdirSync(localRoot);
    mkdirSync(roamingRoot);
    const isolatedSecurity = Object.freeze({
      ...nativeWindowsFileSecurityPort,
      currentUserRoots: () =>
        Object.freeze({
          local_app_data: localRoot,
          roaming_app_data: roamingRoot
        })
    }) satisfies WindowsNativeFileSecurityPort;
    const adapter = createWindowsHostDeckLocalPathAdapter(isolatedSecurity);
    const defaults = resolveWindowsHostDeckDefaultPaths(
      isolatedSecurity.currentUserRoots()
    );
    const insecureSource = win32.join(localRoot, "inherited-source.sqlite");
    writeFileSync(insecureSource, "inherited");

    try {
      const prepared = adapter.prepareLocalPaths(defaults);
      expect(prepared.repairs.length).toBeGreaterThan(0);
      expect(
        prepared.repairs.every(
          (repair) =>
            "from_acl" in repair &&
            repair.from_acl === "not_current_user_only" &&
            repair.to_acl === "current_user_only"
        )
      ).toBe(true);
      for (const path of [
        prepared.config_dir,
        prepared.state_dir,
        prepared.runtime_dir,
        prepared.lease_path
      ]) {
        const inspection = isolatedSecurity.inspectPath(path);
        expect(inspection.acl_current_user_only).toBe(true);
        expect(inspection.owner_current_user).toBe(true);
        expect(inspection.has_named_streams).toBe(false);
        expect(inspection.is_reparse_point).toBe(false);
      }

      const preparedState = adapter.prepareStatePaths({
        database_path: defaults.database_path,
        state_dir: defaults.state_dir
      });
      expect(preparedState.database_path).toBe(defaults.database_path);
      expect(
        isolatedSecurity.inspectPath(defaults.database_path)
          .acl_current_user_only
      ).toBe(true);

      const inheritedPath = win32.join(defaults.state_dir, "inherited.sqlite");
      renameSync(insecureSource, inheritedPath);
      expect(
        isolatedSecurity.inspectPath(inheritedPath).acl_current_user_only
      ).toBe(false);
      const inheritedRepair = adapter.secureRegularFile(inheritedPath, {
        label: "inherited file",
        repair_mode: true
      });
      expect(inheritedRepair).toMatchObject({
        from_acl: "not_current_user_only",
        kind: "file",
        to_acl: "current_user_only"
      });
      expect(
        isolatedSecurity.inspectPath(inheritedPath).acl_current_user_only
      ).toBe(true);

      const streamPath = win32.join(defaults.state_dir, "stream.sqlite");
      adapter.secureRegularFile(streamPath, {
        create: true,
        label: "stream file",
        repair_mode: true
      });
      writeFileSync(`${streamPath}:hidden`, "hidden");
      expectPathError(
        () =>
          adapter.secureRegularFile(streamPath, {
            label: "stream file",
            repair_mode: true
          }),
        "alternate_stream_rejected"
      );

      const linkedPath = win32.join(defaults.state_dir, "linked.sqlite");
      const secondLinkPath = win32.join(
        defaults.state_dir,
        "linked-copy.sqlite"
      );
      adapter.secureRegularFile(linkedPath, {
        create: true,
        label: "linked file",
        repair_mode: true
      });
      linkSync(linkedPath, secondLinkPath);
      expectPathError(
        () =>
          adapter.secureRegularFile(linkedPath, {
            label: "linked file",
            repair_mode: true
          }),
        "hard_link_rejected"
      );

      const caseCollision = win32.join(defaults.state_dir, "selected");
      mkdirSync(caseCollision);
      expectPathError(
        () =>
          adapter.prepareStatePaths({
            database_path: win32.join(
              defaults.state_dir,
              "Selected",
              "hostdeck.sqlite"
            ),
            state_dir: win32.join(defaults.state_dir, "Selected")
          }),
        "case_collision"
      );

      const junctionTarget = win32.join(defaults.state_dir, "junction-target");
      adapter.prepareStatePaths({
        database_path: win32.join(junctionTarget, "hostdeck.sqlite"),
        state_dir: junctionTarget
      });
      const junctionPath = win32.join(defaults.state_dir, "junction");
      symlinkSync(junctionTarget, junctionPath, "junction");
      expectPathError(
        () =>
          adapter.prepareStatePaths({
            database_path: win32.join(junctionPath, "hostdeck.sqlite"),
            state_dir: junctionPath
          }),
        "symlink_rejected"
      );

      const wrongTypePath = win32.join(defaults.state_dir, "wrong-type.sqlite");
      mkdirSync(wrongTypePath);
      expectPathError(
        () =>
          adapter.openSecureRegularFile(wrongTypePath, {
            label: "wrong type",
            repair_mode: true
          }),
        "path_type_mismatch"
      );

      const substitutionPath = win32.join(
        defaults.state_dir,
        "substitution.sqlite"
      );
      const movedPath = win32.join(defaults.state_dir, "substitution-moved.sqlite");
      const opened = adapter.openSecureRegularFile(substitutionPath, {
        create: true,
        label: "substitution file",
        repair_mode: true,
        writable: true
      });
      try {
        const descriptorInspection = isolatedSecurity.inspectDescriptor(
          opened.descriptor
        );
        const pathInspection = isolatedSecurity.inspectPath(substitutionPath);
        expect(descriptorInspection.identity).toEqual(pathInspection.identity);
        renameSync(substitutionPath, movedPath);
        const replacement = adapter.openSecureRegularFile(substitutionPath, {
          create: true,
          label: "replacement file",
          repair_mode: true
        });
        closeSync(replacement.descriptor);
        expectPathError(opened.verifyPath, "path_substitution");
      } finally {
        closeSync(opened.descriptor);
      }
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});

function expectPathError(
  work: () => unknown,
  code: HostDeckLocalPathErrorCode
): void {
  expect(work).toThrowError(
    expect.objectContaining({ name: "HostDeckLocalPathError", code })
  );
}
