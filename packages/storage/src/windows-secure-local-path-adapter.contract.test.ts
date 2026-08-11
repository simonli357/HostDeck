import { describe, expect, it } from "vitest";
import type {
  HostDeckLocalPathErrorCode,
  PrepareHostDeckLocalPathsInput
} from "./secure-local-path-contract.js";
import {
  hasWindowsCurrentUserOnlySecurity,
  type WindowsKnownFolderRoots,
  type WindowsNativeFileSecurityPort
} from "./windows-native-file-security.js";
import {
  createWindowsHostDeckLocalPathAdapter,
  resolveWindowsHostDeckDefaultPaths,
  resolveWindowsHostDeckLocalPathsForRoots
} from "./windows-secure-local-path-adapter.js";

const roots = Object.freeze({
  local_app_data: "C:\\Users\\selected\\AppData\\Local",
  roaming_app_data: "C:\\Users\\selected\\AppData\\Roaming"
}) satisfies WindowsKnownFolderRoots;

const defaults = resolveWindowsHostDeckDefaultPaths(roots);
const equalOrdinalIgnoreCase = (left: string, right: string): boolean =>
  left.toUpperCase() === right.toUpperCase();

describe("Windows secure local-path contract", () => {
  it("requires both current-user ownership and a current-user-only ACL", () => {
    expect(
      hasWindowsCurrentUserOnlySecurity({
        acl_current_user_only: true,
        owner_current_user: true
      })
    ).toBe(true);
    expect(
      hasWindowsCurrentUserOnlySecurity({
        acl_current_user_only: true,
        owner_current_user: false
      })
    ).toBe(false);
    expect(
      hasWindowsCurrentUserOnlySecurity({
        acl_current_user_only: false,
        owner_current_user: true
      })
    ).toBe(false);
  });

  it("derives exact per-user defaults without trusting environment variables", () => {
    expect(defaults).toEqual({
      config_dir: "C:\\Users\\selected\\AppData\\Roaming\\HostDeck",
      state_dir: "C:\\Users\\selected\\AppData\\Local\\HostDeck\\State",
      runtime_dir:
        "C:\\Users\\selected\\AppData\\Local\\HostDeck\\Runtime",
      database_path:
        "C:\\Users\\selected\\AppData\\Local\\HostDeck\\State\\hostdeck.sqlite"
    });
    expect(Object.isFrozen(defaults)).toBe(true);
  });

  it("normalizes bounded descendants and reserves Windows runtime metadata", () => {
    const resolved = resolveWindowsHostDeckLocalPathsForRoots(
      {
        config_dir: `${defaults.config_dir}\\Profiles\\..\\Selected`,
        state_dir: `${defaults.state_dir}\\Selected`,
        runtime_dir: `${defaults.runtime_dir}\\Selected`,
        database_path: `${defaults.state_dir}\\Selected\\hostdeck.sqlite`
      },
      roots,
      equalOrdinalIgnoreCase
    );
    expect(resolved).toEqual({
      config_dir: `${defaults.config_dir}\\Selected`,
      state_dir: `${defaults.state_dir}\\Selected`,
      runtime_dir: `${defaults.runtime_dir}\\Selected`,
      database_path: `${defaults.state_dir}\\Selected\\hostdeck.sqlite`,
      lease_path: `${defaults.state_dir}\\Selected\\hostdeck.lock`,
      app_server_socket_path: `${defaults.runtime_dir}\\Selected\\app-server.endpoint`
    });
    expect(Object.isFrozen(resolved)).toBe(true);
  });

  it("accepts ordinal case variants lexically so native directory enumeration can reject collisions", () => {
    expect(
      resolveWindowsHostDeckLocalPathsForRoots(
        {
          config_dir: defaults.config_dir.toLowerCase(),
          state_dir: defaults.state_dir.toLowerCase(),
          runtime_dir: defaults.runtime_dir.toLowerCase(),
          database_path: defaults.database_path.toLowerCase()
        },
        roots,
        equalOrdinalIgnoreCase
      ).state_dir
    ).toBe(defaults.state_dir.toLowerCase());
  });

  it("rejects overrides outside each owning known-folder root", () => {
    const invalid: PrepareHostDeckLocalPathsInput[] = [
      {
        ...defaults,
        config_dir: "C:\\Users\\selected\\AppData\\Local\\HostDeck\\Config"
      },
      {
        ...defaults,
        state_dir: "C:\\Users\\selected\\AppData\\Local\\HostDeck\\Other",
        database_path:
          "C:\\Users\\selected\\AppData\\Local\\HostDeck\\Other\\hostdeck.sqlite"
      },
      {
        ...defaults,
        runtime_dir:
          "C:\\Users\\selected\\AppData\\Local\\HostDeck\\OtherRuntime"
      },
      {
        ...defaults,
        state_dir: "D:\\HostDeck\\State",
        database_path: "D:\\HostDeck\\State\\hostdeck.sqlite"
      }
    ];
    for (const input of invalid) {
      expectPathError(
        () =>
          resolveWindowsHostDeckLocalPathsForRoots(
            input,
            roots,
            equalOrdinalIgnoreCase
          ),
        "invalid_path"
      );
    }
  });

  it("rejects namespaces, streams, invalid components, trailing aliases, and reserved device names", () => {
    const invalid = [
      { ...defaults, config_dir: "\\\\server\\share\\HostDeck" },
      { ...defaults, config_dir: "\\\\?\\C:\\Users\\selected\\HostDeck" },
      {
        ...defaults,
        database_path: `${defaults.database_path}:private`
      },
      { ...defaults, database_path: `${defaults.state_dir}\\bad?.sqlite` },
      { ...defaults, database_path: `${defaults.state_dir}\\trailing.` },
      { ...defaults, database_path: `${defaults.state_dir}\\trailing ` }
    ];
    for (const input of invalid) {
      expectPathError(
        () =>
          resolveWindowsHostDeckLocalPathsForRoots(
            input,
            roots,
            equalOrdinalIgnoreCase
          ),
        "invalid_path"
      );
    }

    for (const name of [
      "CON",
      "con.txt",
      "COM1.log",
      "LPT9",
      "AUX.data",
      "NUL",
      "CLOCK$",
      "CONIN$",
      "COM\u00b9.txt"
    ]) {
      expectPathError(
        () =>
          resolveWindowsHostDeckLocalPathsForRoots(
            { ...defaults, database_path: `${defaults.state_dir}\\${name}` },
            roots,
            equalOrdinalIgnoreCase
          ),
        "reserved_name_rejected"
      );
    }
  });

  it("rejects overlong components and case-insensitive reserved-path collisions", () => {
    expectPathError(
      () =>
        resolveWindowsHostDeckLocalPathsForRoots(
          {
            ...defaults,
            database_path: `${defaults.state_dir}\\${"a".repeat(256)}`
          },
          roots,
          equalOrdinalIgnoreCase
        ),
      "invalid_path"
    );
    expectPathError(
      () =>
        resolveWindowsHostDeckLocalPathsForRoots(
          {
            ...defaults,
            database_path: `${defaults.state_dir}\\HOSTDECK.LOCK`
          },
          roots,
          equalOrdinalIgnoreCase
        ),
      "invalid_path"
    );
  });

  it("defines a Windows ACL adapter while keeping Unix sockets fail-closed", () => {
    const nativeSecurity = {
      currentUserRoots: () => roots,
      equalOrdinalIgnoreCase,
      inspectDescriptor: () => {
        throw new Error("not used");
      },
      inspectPath: () => {
        throw new Error("not used");
      },
      secureCurrentUserOnly: () => {
        throw new Error("not used");
      }
    } satisfies WindowsNativeFileSecurityPort;
    const adapter = createWindowsHostDeckLocalPathAdapter(nativeSecurity);
    expect(adapter.target).toBe("windows-x64");
    expect(adapter.path_family).toBe("windows");
    expect(adapter.path_security).toBe("current_user_acl");
    expect(adapter.resolveLocalPaths(defaults).database_path).toBe(
      defaults.database_path
    );
    expectPathError(
      () =>
        adapter.secureSocket(
          `${defaults.runtime_dir}\\app-server.sock`,
          { label: "socket" }
        ),
      "unsupported_platform"
    );
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
