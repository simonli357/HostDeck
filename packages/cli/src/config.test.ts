import { describe, expect, it } from "vitest";
import { loadCliConfig } from "./config.js";
import { CliFailure } from "./errors.js";
import { cliExitCodes } from "./exit-codes.js";

describe("CLI config loading", () => {
  it("uses safe localhost defaults", () => {
    expect(loadCliConfig({ env: {} }).baseUrl.toString()).toBe("http://127.0.0.1:3777/");
  });

  it("uses XDG or home state defaults and lets flags override storage paths", () => {
    const defaultConfig = loadCliConfig({
      env: {
        HOME: "/home/simonli",
        XDG_CONFIG_HOME: "/tmp/config",
        XDG_RUNTIME_DIR: "/tmp/runtime",
        XDG_STATE_HOME: "/tmp/state"
      }
    });

    expect(defaultConfig.stateDir).toBe("/tmp/state/hostdeck");
    expect(defaultConfig.configDir).toBe("/tmp/config/hostdeck");
    expect(defaultConfig.runtimeDir).toBe("/tmp/runtime/hostdeck");
    expect(defaultConfig.databasePath).toBe("/tmp/state/hostdeck/hostdeck.sqlite");

    const flagConfig = loadCliConfig({
      cwd: "/tmp/project",
      env: {
        HOME: "/home/simonli"
      },
      flags: {
        stateDir: "state",
        databasePath: "state/hostdeck.db"
      }
    });

    expect(flagConfig.stateDir).toBe("/tmp/project/state");
    expect(flagConfig.databasePath).toBe("/tmp/project/state/hostdeck.db");
  });

  it("loads an explicit config file and lets flags override it", () => {
    const config = loadCliConfig({
      cwd: "/tmp",
      env: {},
      flags: {
        configPath: "hostdeck.json",
        port: "4888"
      },
      readFile: (path) => {
        expect(path).toBe("/tmp/hostdeck.json");
        return JSON.stringify({ host: "localhost", port: 4555, state_dir: "state", database_path: "state/db.sqlite" });
      }
    });

    expect(config.baseUrl.toString()).toBe("http://localhost:4888/");
    expect(config.stateDir).toBe("/tmp/state");
    expect(config.databasePath).toBe("/tmp/state/db.sqlite");
    expect(config.runtimeDir).toBeNull();
  });

  it("rejects invalid config with the stable config exit family", () => {
    expect(() =>
      loadCliConfig({
        env: {
          HOSTDECK_API_BASE_URL: "file:///tmp/hostdeck.sock"
        }
      })
    ).toThrow(CliFailure);

    try {
      loadCliConfig({
        env: {
          HOSTDECK_API_BASE_URL: "file:///tmp/hostdeck.sock"
        }
      });
    } catch (error) {
      expect(error).toBeInstanceOf(CliFailure);
      expect((error as CliFailure).exitCode).toBe(cliExitCodes.config);
    }
  });

  it("rejects API URLs with path components before they can be ignored", () => {
    expect(() =>
      loadCliConfig({
        env: {
          HOSTDECK_API_BASE_URL: "http://127.0.0.1:3777/nested"
        }
      })
    ).toThrow(CliFailure);
  });

  it("rejects relative XDG bases and database paths outside state", () => {
    expect(() => loadCliConfig({ env: { XDG_RUNTIME_DIR: "runtime" } })).toThrow(CliFailure);
    expect(() =>
      loadCliConfig({
        cwd: "/tmp/project",
        env: { HOME: "/home/simonli" },
        flags: { stateDir: "state", databasePath: "outside.sqlite" }
      })
    ).toThrow(CliFailure);
  });
});
