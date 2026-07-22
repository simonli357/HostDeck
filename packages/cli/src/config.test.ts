import { describe, expect, it } from "vitest";
import { loadCliConfig } from "./config.js";
import { CliFailure } from "./errors.js";
import { cliExitCodes } from "./exit-codes.js";

describe("CLI config loading", () => {
  it("uses the fixed loopback origin and safe storage defaults", () => {
    const config = loadCliConfig({
      env: {
        HOME: "/home/simonli",
        XDG_CONFIG_HOME: "/tmp/config",
        XDG_RUNTIME_DIR: "/tmp/runtime",
        XDG_STATE_HOME: "/tmp/state"
      }
    });
    expect(config.baseUrl.toString()).toBe("http://127.0.0.1:3777/");
    expect(config.stateDir).toBe("/tmp/state/hostdeck");
    expect(config.configDir).toBe("/tmp/config/hostdeck");
    expect(config.runtimeDir).toBe("/tmp/runtime/hostdeck");
    expect(config.databasePath).toBe(
      "/tmp/state/hostdeck/hostdeck.sqlite"
    );
  });

  it("accepts exact loopback origins from flag, environment, or config", () => {
    const scenarios = [
      loadCliConfig({
        env: { HOME: "/home/simonli" },
        flags: { apiUrl: "http://127.0.0.1:4101" }
      }),
      loadCliConfig({
        env: {
          HOME: "/home/simonli",
          HOSTDECK_API_BASE_URL: "http://127.0.0.1:4102"
        }
      }),
      loadCliConfig({
        cwd: "/tmp",
        env: { HOME: "/home/simonli" },
        flags: { configPath: "hostdeck.json" },
        readFile: () => JSON.stringify({ api_url: "http://127.0.0.1:4103" })
      })
    ];
    expect(scenarios.map((config) => config.baseUrl.toString())).toEqual([
      "http://127.0.0.1:4101/",
      "http://127.0.0.1:4102/",
      "http://127.0.0.1:4103/"
    ]);
  });

  it("loads an exact config file and lets flags override port and storage paths", () => {
    const config = loadCliConfig({
      cwd: "/tmp",
      env: { HOME: "/home/simonli" },
      flags: {
        configPath: "hostdeck.json",
        port: "4888",
        stateDir: "selected-state",
        databasePath: "selected-state/selected.sqlite"
      },
      readFile: (path) => {
        expect(path).toBe("/tmp/hostdeck.json");
        return JSON.stringify({
          port: 4555,
          state_dir: "ignored-state",
          database_path: "ignored-state/ignored.sqlite"
        });
      }
    });
    expect(config.baseUrl.toString()).toBe("http://127.0.0.1:4888/");
    expect(config.stateDir).toBe("/tmp/selected-state");
    expect(config.databasePath).toBe(
      "/tmp/selected-state/selected.sqlite"
    );
  });

  it("rejects every retired host selector even when another origin wins", () => {
    expectConfigFailure(() =>
      loadCliConfig({
        env: { HOME: "/home/simonli" },
        flags: {
          apiUrl: "http://127.0.0.1:4101",
          host: "127.0.0.1"
        } as never
      })
    );
    expectConfigFailure(() =>
      loadCliConfig({
        env: {
          HOME: "/home/simonli",
          HOSTDECK_API_BASE_URL: "http://127.0.0.1:4101",
          HOSTDECK_HOST: "127.0.0.1"
        }
      })
    );
    expectConfigFailure(() =>
      loadCliConfig({
        cwd: "/tmp",
        env: { HOME: "/home/simonli" },
        flags: { configPath: "hostdeck.json" },
        readFile: () =>
          JSON.stringify({
            api_url: "http://127.0.0.1:4101",
            host: "127.0.0.1"
          })
      })
    );
  });

  it("rejects noncanonical, secure, non-loopback, or decorated API origins", () => {
    for (const apiUrl of [
      "https://127.0.0.1:4101",
      "http://localhost:4101",
      "http://127.0.0.2:4101",
      "http://127.1:4101",
      "http://[::1]:4101",
      "http://0.0.0.0:4101",
      "http://127.0.0.1",
      "http://127.0.0.1:80",
      "http://127.0.0.1:1023",
      "http://user:pass@127.0.0.1:4101",
      "http://127.0.0.1:4101/",
      "http://127.0.0.1:4101/nested",
      "http://127.0.0.1:4101?query=1",
      "http://127.0.0.1:4101#fragment"
    ]) {
      expectConfigFailure(() =>
        loadCliConfig({
          env: { HOME: "/home/simonli" },
          flags: { apiUrl }
        })
      );
    }
  });

  it("enforces the nonprivileged loopback port range", () => {
    for (const port of ["", "1", "1023", "65536", "4101.5", "not-a-port"]) {
      expectConfigFailure(() =>
        loadCliConfig({
          env: { HOME: "/home/simonli" },
          flags: { port }
        })
      );
    }
    expect(
      loadCliConfig({
        env: { HOME: "/home/simonli" },
        flags: { port: "1024" }
      }).baseUrl.origin
    ).toBe("http://127.0.0.1:1024");
  });

  it("rejects unknown or conflicting config fields", () => {
    for (const value of [
      { unknown: true },
      { host: "127.0.0.1" },
      {
        api_url: "http://127.0.0.1:4101",
        apiUrl: "http://127.0.0.1:4102"
      }
    ]) {
      expectConfigFailure(() =>
        loadCliConfig({
          cwd: "/tmp",
          env: { HOME: "/home/simonli" },
          flags: { configPath: "hostdeck.json" },
          readFile: () => JSON.stringify(value)
        })
      );
    }
  });

  it("does not disclose a failed config path", () => {
    const privatePath = "/tmp/private-hostdeck-config/selected.json";
    let failure: unknown;
    try {
      loadCliConfig({
        env: { HOME: "/home/simonli" },
        flags: { configPath: privatePath },
        readFile: () => {
          throw new Error(privatePath);
        }
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(CliFailure);
    expect((failure as Error).message).not.toContain(privatePath);
  });

  it("rejects relative XDG bases and database paths outside state", () => {
    expectConfigFailure(() =>
      loadCliConfig({ env: { XDG_RUNTIME_DIR: "runtime" } })
    );
    expectConfigFailure(() =>
      loadCliConfig({
        cwd: "/tmp/project",
        env: { HOME: "/home/simonli" },
        flags: { stateDir: "state", databasePath: "outside.sqlite" }
      })
    );
  });
});

function expectConfigFailure(action: () => unknown): void {
  let failure: unknown;
  try {
    action();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(CliFailure);
  expect(failure).toMatchObject({ exitCode: cliExitCodes.config });
}
