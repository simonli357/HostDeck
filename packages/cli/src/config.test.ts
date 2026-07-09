import { describe, expect, it } from "vitest";
import { loadCliConfig } from "./config.js";
import { CliFailure } from "./errors.js";
import { cliExitCodes } from "./exit-codes.js";

describe("CLI config loading", () => {
  it("uses safe localhost defaults", () => {
    expect(loadCliConfig({ env: {} }).baseUrl.toString()).toBe("http://127.0.0.1:3777/");
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
        return JSON.stringify({ host: "localhost", port: 4555 });
      }
    });

    expect(config.baseUrl.toString()).toBe("http://localhost:4888/");
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
});
