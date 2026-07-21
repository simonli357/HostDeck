import { Buffer } from "node:buffer";
import {
  defaultResourceBudget,
  encodeSelectedDeviceListCursor,
  encodeSelectedSessionListCursor,
  sessionIdSchema
} from "@hostdeck/contracts";
import { describe, expect, it } from "vitest";
import { CliFailure, internalFailure } from "./errors.js";
import { cliExitCodes } from "./exit-codes.js";
import type { LegacySessionAdmin } from "./legacy-session-admin.js";
import { parseCliArgs } from "./parser.js";
import {
  renderFailure,
  renderLegacySessionReset,
  renderLegacySessionStatus
} from "./render.js";
import { runCli } from "./shell.js";

const sessionListCursor = encodeSelectedSessionListCursor({
  order_snapshot: "a".repeat(64),
  after: {
    attention_rank: 20,
    last_activity_at: null,
    session_id: sessionIdSchema.parse("sess_cli_contract_01")
  }
});
const deviceListCursor = encodeSelectedDeviceListCursor("client_contract_01");

describe("selected CLI shell contract", () => {
  it("parses selected commands, legacy administration, and config flags", () => {
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
        label: "serve",
        args: ["serve"],
        expected: { command: { kind: "serve" }, configFlags: {} }
      },
      {
        label: "status",
        args: ["status", "--json"],
        expected: { command: { kind: "status", json: true }, configFlags: {} }
      },
      {
        label: "list",
        args: ["list", "--limit=25", "--cursor", sessionListCursor, "--json"],
        expected: {
          command: {
            kind: "list",
            limit: 25,
            cursor: sessionListCursor,
            json: true
          },
          configFlags: {}
        }
      },
      {
        label: "devices",
        args: ["devices", "--limit", "10", `--cursor=${deviceListCursor}`],
        expected: {
          command: {
            kind: "devices",
            limit: 10,
            cursor: deviceListCursor,
            json: false
          },
          configFlags: {}
        }
      },
      {
        label: "revoke",
        args: ["revoke", "client_contract_01", "--confirm", "--json"],
        expected: {
          command: {
            kind: "revoke",
            deviceId: "client_contract_01",
            confirm: true,
            json: true
          },
          configFlags: {}
        }
      },
      {
        label: "service",
        args: ["service", "upgrade", "--json"],
        expected: {
          command: { kind: "service", action: "upgrade", json: true },
          configFlags: {}
        }
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
        args: ["--port", "4888", "lock", "--json"],
        expected: {
          command: { kind: "lock", json: true },
          configFlags: { port: "4888" }
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

    for (const action of [
      "install",
      "upgrade",
      "status",
      "start",
      "stop",
      "restart",
      "uninstall"
    ] as const) {
      expect(parseCliArgs(["service", action])).toEqual({
        command: { kind: "service", action, json: false },
        configFlags: {}
      });
    }
  });

  it("rejects the retired host selector before configuration loading", async () => {
    for (const args of [
      ["--host", "127.0.0.1", "lock"],
      ["--host=127.0.0.1", "unlock"]
    ]) {
      const result = await runCli(args, {
        env: {},
        readFile: () => {
          throw new Error("retired host option must fail before config");
        }
      });
      expect(result.exitCode, args.join(" ")).toBe(cliExitCodes.usage);
      expect(result.stderr).toContain("Unknown option: --host");
    }
  });

  it("advertises required commands and rejects removed historical runtime commands", async () => {
    const help = await runCli(["help"], {
      env: {},
      readFile: () => {
        throw new Error("help must not load config");
      }
    });
    expect(help.exitCode).toBe(cliExitCodes.ok);
    expect(help.stdout).toContain("codexdeck resume SESSION_ID");
    expect(help.stdout).toContain("codexdeck legacy reset --confirm [--json]");
    expect(help.stdout).toContain("codexdeck serve");
    expect(help.stdout).toContain("codexdeck status [--json]");
    expect(help.stdout).toContain("codexdeck list [--limit N] [--cursor CURSOR] [--json]");
    expect(help.stdout).toContain("codexdeck devices [--limit N] [--cursor CURSOR] [--json]");
    expect(help.stdout).toContain("codexdeck revoke DEVICE_ID --confirm [--json]");
    expect(help.stdout).toContain(
      "codexdeck service install|upgrade|status|start|stop|restart|uninstall [--json]"
    );
    const helpCommands = help.stdout.split("\n").map((line) => line.trim());

    for (const command of ["attach", "stop", "lan"]) {
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

  it("rejects ambiguous and invalid command input before configuration or other side effects", async () => {
    const cases = [
      ["--port", "4888", "--port=4889", "status"],
      ["--database", "/tmp/a", "--database-path=/tmp/b", "devices"],
      ["status", "--port", "4888"],
      ["start", "--name=first", "--name=second", "--cwd=/tmp"],
      ["start", "--name=first", "--cwd=/tmp/a", "--cwd=/tmp/b"],
      ["list", "--limit=0"],
      ["list", "--limit=01"],
      ["list", "--limit=101"],
      ["list", "--limit=1", "--limit=2"],
      ["list", "--cursor=invalid"],
      ["devices", "--cursor=invalid"],
      ["devices", "unexpected"],
      ["revoke", "client_contract_01"],
      ["revoke", "invalid device", "--confirm"],
      ["revoke", "client_contract_01", "--confirm", "--confirm"],
      ["service"],
      ["service", "unknown"],
      ["service", "status", "extra"],
      ["serve", "extra"],
      ["serve", "--json"],
      ["--json", "--json", "status"],
      ["status", "--help"]
    ] as const;

    for (const args of cases) {
      let configReads = 0;
      const result = await runCli(args, {
        env: {},
        readFile: () => {
          configReads += 1;
          throw new Error("invalid input must fail before config");
        }
      });
      expect(result.exitCode, args.join(" ")).toBe(cliExitCodes.usage);
      expect(configReads, args.join(" ")).toBe(0);
    }
  });

  it("reports staged commands unavailable without config, filesystem, network, or process work", async () => {
    for (const args of [
      ["serve"],
      ["devices", "--limit=10", "--cursor", deviceListCursor],
      ["service", "install"],
      ["service", "upgrade"],
      ["service", "status"],
      ["service", "start"],
      ["service", "stop"],
      ["service", "restart"],
      ["service", "uninstall"]
    ] as const) {
      let configReads = 0;
      let fetchCalls = 0;
      const result = await runCli(args, {
        env: {},
        readFile: () => {
          configReads += 1;
          throw new Error("reserved command must not load config");
        },
        fetch: async () => {
          fetchCalls += 1;
          throw new Error("reserved command must not use the network");
        }
      });
      expect(result.exitCode, args.join(" ")).toBe(cliExitCodes.apiError);
      expect(result.stderr, args.join(" ")).toContain("capability_unavailable");
      expect(configReads, args.join(" ")).toBe(0);
      expect(fetchCalls, args.join(" ")).toBe(0);
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

  it("propagates a pre-aborted shell signal into the shared selected transport", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runCli(
      [
        "--api-url=http://127.0.0.1:3777",
        "remote",
        "status"
      ],
      { env: {}, signal: controller.signal }
    );

    expect(result).toMatchObject({
      exitCode: cliExitCodes.apiError,
      stdout: ""
    });
    expect(result.stderr).toContain("unknown_error");
    expect(result.stderr).toContain("request was cancelled");
    expect(result.stderr).not.toContain("daemon_unavailable");
  });

  it("accepts exact-limit stdout and converts one-byte overflow to a bounded internal failure", async () => {
    const framingBytes = Buffer.byteLength("codexdeck \n", "utf8");
    const exactVersion = "x".repeat(
      defaultResourceBudget.cli_response_max_bytes - framingBytes
    );
    const exact = await runCli(["version"], { version: exactVersion });
    expect(exact.exitCode).toBe(cliExitCodes.ok);
    expect(Buffer.byteLength(exact.stdout, "utf8")).toBe(
      defaultResourceBudget.cli_response_max_bytes
    );

    const overflow = await runCli(["version"], {
      version: `${exactVersion}x`
    });
    expect(overflow).toMatchObject({
      exitCode: cliExitCodes.internal,
      stdout: ""
    });
    expect(overflow.stderr).toContain("stdout exceeds its selected limit");
    expect(Buffer.byteLength(overflow.stderr, "utf8")).toBeLessThanOrEqual(
      defaultResourceBudget.cli_response_max_bytes
    );
  });

  it("escapes hostile failure text and replaces oversized stderr without partial output", async () => {
    const rendered = renderFailure(
      new CliFailure({
        code: "malformed_request",
        exitCode: cliExitCodes.usage,
        field: "args\n\u001b[31m",
        kind: "usage",
        message: "private\n\u001b[31m"
      })
    );
    expect(rendered).toContain("private\\n\\u001b[31m");
    expect(rendered).toContain("args\\n\\u001b[31m");
    expect(rendered).not.toContain("\u001b");

    const privateSentinel = "private-cli-overflow-sentinel";
    const rawFailure = await runCli(["remote", "status"], {
      env: {},
      remoteClient: {
        async disable(): Promise<never> {
          throw new Error(privateSentinel);
        },
        async enable(): Promise<never> {
          throw new Error(privateSentinel);
        },
        async status(): Promise<never> {
          throw new Error(`${privateSentinel}\n\u001b[31m`);
        }
      }
    });
    expect(rawFailure).toMatchObject({
      exitCode: cliExitCodes.internal,
      stdout: ""
    });
    expect(rawFailure.stderr).toContain("HostDeck CLI failed unexpectedly");
    expect(rawFailure.stderr).not.toContain(privateSentinel);
    expect(rawFailure.stderr).not.toContain("\u001b");

    const remoteClient = {
      async disable(): Promise<never> {
        throw internalFailure("unused");
      },
      async enable(): Promise<never> {
        throw internalFailure("unused");
      },
      async status(): Promise<never> {
        throw internalFailure(
          `${privateSentinel}${"x".repeat(
            defaultResourceBudget.cli_response_max_bytes
          )}`
        );
      }
    };
    const overflow = await runCli(["remote", "status"], {
      env: {},
      remoteClient
    });
    expect(overflow).toMatchObject({
      exitCode: cliExitCodes.internal,
      stdout: ""
    });
    expect(overflow.stderr).toContain(
      "failure output exceeded its selected limit"
    );
    expect(overflow.stderr).not.toContain(privateSentinel);
    expect(Buffer.byteLength(overflow.stderr, "utf8")).toBeLessThanOrEqual(
      defaultResourceBudget.cli_response_max_bytes
    );
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
