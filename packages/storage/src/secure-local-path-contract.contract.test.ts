import { posix, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import {
  defineHostDeckLocalPathAdapter,
  type HostDeckLocalPathAdapter,
  type HostDeckLocalPathErrorCode,
  type HostDeckPathDialect,
  resolveHostDeckAbsolutePath,
  resolveHostDeckPathRoots,
  resolveHostDeckStatePathRoots
} from "./secure-local-path-contract.js";
import { nativeHostDeckLocalPathAdapter } from "./secure-local-paths.js";

const posixDialect = pathDialect("posix");
const windowsDialect = pathDialect("windows");

describe("shared secure local-path contract", () => {
  it("normalizes valid POSIX and Windows roots without host inspection", () => {
    const posixInput = {
      config_dir: "/home/user/.config/hostdeck/./",
      state_dir: "/home/user/.local/state/hostdeck",
      runtime_dir: "/run/user/1000/hostdeck",
      database_path: "/home/user/.local/state/hostdeck/cache/../hostdeck.sqlite"
    };
    const windowsInput = {
      config_dir: "C:\\Users\\user\\AppData\\Roaming\\HostDeck\\.",
      state_dir: "C:\\Users\\user\\AppData\\Local\\HostDeck\\State",
      runtime_dir: "C:\\Users\\user\\AppData\\Local\\HostDeck\\Runtime",
      database_path:
        "C:\\Users\\user\\AppData\\Local\\HostDeck\\State\\cache\\..\\hostdeck.sqlite"
    };

    expect(resolveHostDeckPathRoots(posixInput, posixDialect)).toEqual({
      config_dir: "/home/user/.config/hostdeck",
      state_dir: "/home/user/.local/state/hostdeck",
      runtime_dir: "/run/user/1000/hostdeck",
      database_path: "/home/user/.local/state/hostdeck/hostdeck.sqlite"
    });
    expect(resolveHostDeckPathRoots(windowsInput, windowsDialect)).toEqual({
      config_dir: "C:\\Users\\user\\AppData\\Roaming\\HostDeck",
      state_dir: "C:\\Users\\user\\AppData\\Local\\HostDeck\\State",
      runtime_dir: "C:\\Users\\user\\AppData\\Local\\HostDeck\\Runtime",
      database_path:
        "C:\\Users\\user\\AppData\\Local\\HostDeck\\State\\hostdeck.sqlite"
    });
    expect(Object.isFrozen(resolveHostDeckPathRoots(posixInput, posixDialect))).toBe(
      true
    );
    expect(posixInput.config_dir).toBe("/home/user/.config/hostdeck/./");
    expect(windowsInput.config_dir).toBe(
      "C:\\Users\\user\\AppData\\Roaming\\HostDeck\\."
    );
  });

  it("rejects relative, root, overlap, same-root, and escaped paths for both dialects", () => {
    const cases = [
      {
        dialect: posixDialect,
        input: {
          config_dir: "/home/user/.config/hostdeck",
          state_dir: "relative/state",
          runtime_dir: "/run/user/1000/hostdeck",
          database_path: "/home/user/.local/state/hostdeck/hostdeck.sqlite"
        }
      },
      {
        dialect: posixDialect,
        input: {
          config_dir: "/home/user/state/config",
          state_dir: "/home/user/state",
          runtime_dir: "/run/user/1000/hostdeck",
          database_path: "/home/user/state/hostdeck.sqlite"
        }
      },
      {
        dialect: windowsDialect,
        input: {
          config_dir: "C:\\Users\\user\\Config",
          state_dir: "C:\\Users\\user\\State",
          runtime_dir: "c:\\users\\USER\\state\\Runtime",
          database_path: "C:\\Users\\user\\State\\hostdeck.sqlite"
        }
      },
      {
        dialect: windowsDialect,
        input: {
          config_dir: "C:\\Users\\user\\Config",
          state_dir: "C:\\Users\\user\\State",
          runtime_dir: "C:\\Users\\user\\Runtime",
          database_path: "D:\\HostDeck\\hostdeck.sqlite"
        }
      }
    ] as const;

    for (const { dialect, input } of cases) {
      expectPathError(
        () => resolveHostDeckPathRoots(input, dialect),
        "invalid_path"
      );
    }

    for (const [candidate, dialect] of [
      ["/", posixDialect],
      ["C:\\", windowsDialect],
      ["relative", posixDialect],
      ["C:\\HostDeck\u0000State", windowsDialect]
    ] as const) {
      expectPathError(
        () => resolveHostDeckAbsolutePath(candidate, "state_dir", dialect),
        "invalid_path"
      );
    }
  });

  it("requires the database to be a strict descendant under either path family", () => {
    for (const [input, dialect] of [
      [
        { state_dir: "/home/user/state", database_path: "/home/user/state" },
        posixDialect
      ],
      [
        {
          state_dir: "C:\\Users\\user\\State",
          database_path: "c:\\users\\USER\\state"
        },
        windowsDialect
      ]
    ] as const) {
      expectPathError(
        () => resolveHostDeckStatePathRoots(input, dialect),
        "invalid_path"
      );
    }
  });

  it("rejects paths parsed with the wrong platform dialect", () => {
    expectPathError(
      () =>
        resolveHostDeckAbsolutePath(
          "C:\\Users\\user\\HostDeck",
          "state_dir",
          posixDialect
        ),
      "invalid_path"
    );
    expectPathError(
      () =>
        resolveHostDeckAbsolutePath(
          "/home/user/hostdeck",
          "state_dir",
          windowsDialect
        ),
      "invalid_path"
    );
  });

  it("rejects a mixed target, path-family, and security adapter identity", () => {
    const mixed = {
      target: "linux-x64",
      path_family: "windows",
      path_security: "current_user_acl"
    } as unknown as HostDeckLocalPathAdapter;
    expect(() => defineHostDeckLocalPathAdapter(mixed)).toThrowError(
      "HostDeck local-path adapter identity is inconsistent."
    );

    const unknown = {
      ...mixed,
      target: "darwin-arm64"
    } as unknown as HostDeckLocalPathAdapter;
    expect(() => defineHostDeckLocalPathAdapter(unknown)).toThrowError(
      "HostDeck local-path adapter identity is inconsistent."
    );
  });

  it("selects only the exact native filesystem adapter", () => {
    if (process.platform === "win32") {
      expect(process.arch).toBe("x64");
      expect(nativeHostDeckLocalPathAdapter.target).toBe("windows-x64");
      expect(nativeHostDeckLocalPathAdapter.path_family).toBe("windows");
      expect(nativeHostDeckLocalPathAdapter.path_security).toBe(
        "current_user_acl"
      );
      return;
    }
    expect(process.platform).toBe("linux");
    expect(process.arch).toBe("x64");
    expect(nativeHostDeckLocalPathAdapter.target).toBe("linux-x64");
    expect(nativeHostDeckLocalPathAdapter.path_family).toBe("posix");
    expect(nativeHostDeckLocalPathAdapter.path_security).toBe("uid_mode");
  });
});

function pathDialect(family: HostDeckPathDialect["family"]): HostDeckPathDialect {
  const implementation = family === "posix" ? posix : win32;
  return Object.freeze({
    family,
    separator: implementation.sep,
    dirname: implementation.dirname,
    isAbsolute: implementation.isAbsolute,
    relative: implementation.relative,
    resolve: implementation.resolve,
    root: (path: string) => implementation.parse(path).root
  }) as HostDeckPathDialect;
}

function expectPathError(
  work: () => unknown,
  code: HostDeckLocalPathErrorCode
): void {
  expect(work).toThrowError(
    expect.objectContaining({
      name: "HostDeckLocalPathError",
      code
    })
  );
}
