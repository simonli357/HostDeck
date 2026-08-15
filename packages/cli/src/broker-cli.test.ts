import {
  sharedCodexEndpointSchema,
  sharedCodexRuntimeVersion
} from "@hostdeck/contracts";
import { describe, expect, it } from "vitest";
import { cliExitCodes } from "./exit-codes.js";
import { parseCliArgs } from "./parser.js";
import { renderHelp } from "./render.js";
import { runCli } from "./shell.js";

const readyEndpoint = sharedCodexEndpointSchema.parse({
  kind: "standard_unix",
  state: "ready",
  ownership: "owned",
  generation: 17,
  observed_version: sharedCodexRuntimeVersion,
  reason: null
});

describe("shared Codex broker CLI", () => {
  it("parses only the exact lifecycle grammar", () => {
    for (const action of ["start", "status", "stop"] as const) {
      expect(parseCliArgs(["broker", action])).toEqual({
        command: { kind: "broker", action, json: false },
        configFlags: {}
      });
      expect(parseCliArgs(["broker", action, "--json"]).command).toEqual({
        kind: "broker",
        action,
        json: true
      });
    }

    for (const args of [
      ["broker"],
      ["broker", "restart"],
      ["broker", "start", "extra"],
      ["broker", "status", "--json", "--json"]
    ]) {
      expect(() => parseCliArgs(args), args.join(" ")).toThrowError(
        expect.objectContaining({
          code: "malformed_request",
          exitCode: cliExitCodes.usage
        })
      );
    }
  });

  it("removes the superseded manual-session commands from grammar and help", () => {
    for (const command of ["discover", "adopt", "unmanage"]) {
      expect(() => parseCliArgs([command])).toThrowError(
        expect.objectContaining({ code: "malformed_request" })
      );
    }
    const help = renderHelp();
    expect(help).toContain("codexdeck broker start|status|stop [--json]");
    expect(help).not.toMatch(/codexdeck (?:discover|adopt|unmanage)\b/u);
  });

  it("dispatches one receiverless action and renders no endpoint path", async () => {
    const calls: string[] = [];
    const receivers: unknown[] = [];
    const result = await runCli(["broker", "start"], {
      env: {},
      brokerControl: {
        execute: async function execute(this: void, action) {
          receivers.push(this);
          calls.push(action);
          return { action, endpoint: readyEndpoint };
        }
      }
    });

    expect(result).toEqual({
      exitCode: cliExitCodes.ok,
      stderr: "",
      stdout: [
        "Broker: ready",
        "Ownership: owned",
        "Generation: 17",
        `Codex: ${sharedCodexRuntimeVersion}`,
        ""
      ].join("\n")
    });
    expect(calls).toEqual(["start"]);
    expect(receivers).toEqual([undefined]);
    expect(result.stdout).not.toMatch(/(?:\/|\\|socket|CODEX_HOME)/u);
  });

  it("renders the bounded public result as JSON", async () => {
    const result = await runCli(["broker", "status", "--json"], {
      env: {},
      brokerControl: {
        async execute(action) {
          return { action, endpoint: readyEndpoint };
        }
      }
    });

    expect(JSON.parse(result.stdout)).toEqual({
      action: "status",
      endpoint: readyEndpoint
    });
  });
});
