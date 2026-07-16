import { describe, expect, it } from "vitest";
import { cliExitCodes } from "./exit-codes.js";
import type { LegacySessionAdmin } from "./local-admin.js";
import { parseCliArgs } from "./parser.js";
import { renderLegacySessionReset, renderLegacySessionStatus } from "./render.js";
import { runCli } from "./shell.js";

describe("selected CLI shell contract", () => {
  it("parses selected commands, local administration, and config flags", () => {
    const cases = [
      {
        label: "help",
        args: ["help"],
        expected: { command: { kind: "help" }, configFlags: {} }
      },
      {
        label: "version",
        args: ["version"],
        expected: { command: { kind: "version" }, configFlags: {} }
      },
      {
        label: "start",
        args: ["--api-url=http://127.0.0.1:4888", "start", "--name=contract-demo", "--cwd", "/tmp/hostdeck-demo", "--json"],
        expected: {
          command: { kind: "start", name: "contract-demo", cwd: "/tmp/hostdeck-demo", json: true },
          configFlags: { apiUrl: "http://127.0.0.1:4888" }
        }
      },
      {
        label: "send",
        args: ["send", "sess_cli_contract_01", "Continue", "carefully"],
        expected: {
          command: {
            kind: "send",
            session: "sess_cli_contract_01",
            text: "Continue carefully",
            json: false
          },
          configFlags: {}
        }
      },
      {
        label: "resume",
        args: ["resume", "sess_cli_contract_01"],
        expected: { command: { kind: "resume", session: "sess_cli_contract_01" }, configFlags: {} }
      },
      {
        label: "usage",
        args: ["usage", "sess_cli_contract_01", "--json"],
        expected: { command: { kind: "usage", session: "sess_cli_contract_01", json: true }, configFlags: {} }
      },
      {
        label: "skills",
        args: ["skills", "sess_cli_contract_01", "--json"],
        expected: { command: { kind: "skills", session: "sess_cli_contract_01", json: true }, configFlags: {} }
      },
      {
        label: "pair",
        args: ["pair", "--label=phone", "--read-only"],
        expected: { command: { kind: "pair", label: "phone", permission: "read" }, configFlags: {} }
      },
      {
        label: "lock",
        args: ["--state-dir", "state", "--database-path=db.sqlite", "lock", "--reason=maintenance", "--json"],
        expected: {
          command: { kind: "lock", reason: "maintenance", json: true },
          configFlags: { stateDir: "state", databasePath: "db.sqlite" }
        }
      },
      {
        label: "legacy status",
        args: ["legacy", "status", "--json"],
        expected: {
          command: { kind: "legacy", action: "status", confirmed: false, json: true },
          configFlags: {}
        }
      },
      {
        label: "legacy reset",
        args: ["legacy", "reset", "--confirm", "--json"],
        expected: {
          command: { kind: "legacy", action: "reset", confirmed: true, json: true },
          configFlags: {}
        }
      },
      {
        label: "remote status",
        args: ["remote", "status", "--json"],
        expected: {
          command: { kind: "remote", action: "status", json: true },
          configFlags: {}
        }
      }
    ] as const;

    for (const scenario of cases) {
      expect(parseCliArgs(scenario.args), scenario.label).toEqual(scenario.expected);
    }
  });

  it("omits and rejects every removed historical runtime command", async () => {
    const help = await runCli(["help"], {
      env: {},
      readFile: () => {
        throw new Error("help must not load config");
      }
    });
    expect(help.exitCode).toBe(cliExitCodes.ok);
    expect(help.stdout).toContain("codexdeck resume SESSION_ID");
    expect(help.stdout).toContain("codexdeck legacy reset --confirm [--json]");
    const helpCommands = help.stdout.split("\n").map((line) => line.trim());

    for (const command of ["serve", "status", "list", "attach", "stop"]) {
      expect(helpCommands.some((line) => line === `codexdeck ${command}` || line.startsWith(`codexdeck ${command} `))).toBe(false);
      let configReads = 0;
      const result = await runCli([command], {
        env: {},
        readFile: () => {
          configReads += 1;
          throw new Error("removed command must fail before config");
        }
      });
      expect(result.exitCode, command).toBe(cliExitCodes.usage);
      expect(result.stderr, command).toContain(`Unknown command: ${command}`);
      expect(configReads, command).toBe(0);
    }
  });

  it("reports and resets legacy rows through bounded local-only output", async () => {
    const admin = fakeLegacyAdmin();
    const status = await runCli(["legacy", "status"], { env: {}, legacyAdmin: admin });
    const reset = await runCli(["legacy", "reset", "--confirm", "--json"], {
      env: {},
      legacyAdmin: admin
    });

    expect(status).toEqual({
      exitCode: cliExitCodes.ok,
      stdout: "Legacy sessions: 2\nDisposition: legacy_unmigrated\n",
      stderr: ""
    });
    expect(JSON.parse(reset.stdout)).toEqual({
      disposition: "legacy_unmigrated",
      removed_session_count: 2,
      remaining_session_count: 0
    });
    expect(`${status.stdout}${reset.stdout}`).not.toMatch(/\/tmp\/private|secret-session|pane|command/iu);
  });

  it("requires explicit reset confirmation and rejects malformed legacy forms", async () => {
    for (const args of [
      ["legacy"],
      ["legacy", "unknown"],
      ["legacy", "status", "extra"],
      ["legacy", "reset"],
      ["legacy", "reset", "--confirm", "extra"]
    ]) {
      const result = await runCli(args, { env: {}, legacyAdmin: fakeLegacyAdmin() });
      expect(result.exitCode, args.join(" ")).toBe(cliExitCodes.usage);
    }
  });

  it("rejects malformed or privacy-expanding legacy render input", () => {
    expect(() =>
      renderLegacySessionStatus(
        {
          disposition: "legacy_unmigrated",
          legacy_session_count: 1,
          cwd: "/tmp/private-sentinel"
        },
        true
      )
    ).toThrow("Legacy session status rendering input is invalid");
    expect(() =>
      renderLegacySessionReset(
        {
          disposition: "legacy_unmigrated",
          removed_session_count: -1,
          remaining_session_count: 0
        },
        true
      )
    ).toThrow("Legacy session reset rendering input is invalid");
  });

  it("renders version without loading daemon or local configuration", async () => {
    const result = await runCli(["version"], {
      env: {},
      version: "1.2.3-contract",
      readFile: () => {
        throw new Error("version must not load config");
      }
    });
    expect(result).toEqual({
      exitCode: cliExitCodes.ok,
      stdout: "codexdeck 1.2.3-contract\n",
      stderr: ""
    });
  });
});

function fakeLegacyAdmin(): LegacySessionAdmin {
  return {
    getLegacySessions() {
      return { disposition: "legacy_unmigrated", legacy_session_count: 2 };
    },
    resetLegacySessions() {
      return {
        disposition: "legacy_unmigrated",
        removed_session_count: 2,
        remaining_session_count: 0
      };
    }
  };
}
