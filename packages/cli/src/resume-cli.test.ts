import { selectedResumeMetadataResponseSchema } from "@hostdeck/contracts";
import { describe, expect, it } from "vitest";
import type { HttpResponse } from "./api-client.js";
import { clientOperationFailure } from "./errors.js";
import { cliExitCodes } from "./exit-codes.js";
import { parseCliArgs } from "./parser.js";
import type { HostDeckResumeClient } from "./resume-client.js";
import type { HostDeckResumeLauncher } from "./resume-launcher.js";
import { type CliRunOptions, runCli } from "./shell.js";

const sessionId = "sess_resume_cli_001";
const threadId = "thread-resume-cli-001";
const socketPath = "/run/user/1000/hostdeck/app-server.sock";

describe("managed-thread resume CLI command", () => {
  it("parses only one session id argument with no alias or command options", () => {
    expect(parseCliArgs(["resume", sessionId])).toEqual({
      command: { kind: "resume", session: sessionId },
      configFlags: {}
    });
    expect(
      parseCliArgs([
        "--api-url=http://127.0.0.1:4888",
        "resume",
        sessionId
      ])
    ).toEqual({
      command: { kind: "resume", session: sessionId },
      configFlags: { apiUrl: "http://127.0.0.1:4888" }
    });

    for (const args of [
      ["resume"],
      ["resume", sessionId, "extra"],
      ["resume", sessionId, "--json"],
      ["--json", "resume", sessionId],
      ["resume", sessionId, "--thread-id", threadId],
      ["resume", sessionId, "--remote", "https://example.test"],
      ["resume", sessionId, "--command", "codex resume"],
      ["reconnect", sessionId],
      ["import", threadId]
    ]) {
      expect(() => parseCliArgs(args), args.join(" ")).toThrowError(
        expect.objectContaining({
          code: "malformed_request",
          exitCode: cliExitCodes.usage
        })
      );
    }
  });

  it("includes only the selected resume surface in help", async () => {
    const help = await runCli(["help"]);
    expect(help).toMatchObject({ exitCode: cliExitCodes.ok, stderr: "" });
    expect(help.stdout).toContain("codexdeck resume SESSION_ID");
    expect(help.stdout).not.toMatch(
      /codexdeck (?:reconnect|import)|resume .*thread-id|resume .*command/iu
    );
  });

  it("passes only validated structured launch metadata to the laptop launcher", async () => {
    const clientCalls: string[] = [];
    const launchCalls: unknown[] = [];
    let clientThis: unknown = "not-called";
    let launcherThis: unknown = "not-called";
    let unrelatedAccesses = 0;
    const resumeClient: HostDeckResumeClient = {
      read: async function readResume(this: void, target) {
        clientThis = this;
        clientCalls.push(target);
        return availableResponse();
      }
    };
    const resumeLauncher: HostDeckResumeLauncher = {
      launch: async function launchResume(this: void, descriptor) {
        launcherThis = this;
        launchCalls.push(descriptor);
      }
    };
    const options = Object.defineProperties(
      { env: {}, resumeClient, resumeLauncher },
      {
        client: {
          enumerable: true,
          get() {
            unrelatedAccesses += 1;
            throw new Error("legacy-client-private-sentinel");
          }
        },
        hostLockClient: {
          enumerable: true,
          get() {
            unrelatedAccesses += 1;
            throw new Error("local-admin-private-sentinel");
          }
        }
      }
    ) as CliRunOptions;

    const result = await runCli(["resume", sessionId], options);
    expect(result).toEqual({ exitCode: cliExitCodes.ok, stdout: "", stderr: "" });
    expect(clientCalls).toEqual([sessionId]);
    expect(clientThis).toBeUndefined();
    expect(launcherThis).toBeUndefined();
    expect(launchCalls).toEqual([availableResponse().launch]);
    expect(launchCalls[0]).not.toBe(availableResponse().command);
    expect(unrelatedAccesses).toBe(0);
  });

  it("performs one loopback client request before one launch", async () => {
    const sequence: string[] = [];
    const requests: unknown[] = [];
    const result = await runCli(["resume", sessionId], {
      env: {},
      fetch: async (url, init) => {
        sequence.push("fetch");
        requests.push({ url, init });
        return jsonResponse(200, availableResponse());
      },
      resumeLauncher: {
        async launch(descriptor) {
          sequence.push("launch");
          expect(descriptor).toEqual(availableResponse().launch);
        }
      }
    });

    expect(result).toEqual({ exitCode: cliExitCodes.ok, stdout: "", stderr: "" });
    expect(sequence).toEqual(["fetch", "launch"]);
    expect(requests).toEqual([
      {
        url: `http://127.0.0.1:3777/api/v1/sessions/${sessionId}/resume`,
        init: {
          method: "GET",
          headers: {
            accept: "application/json",
            "cache-control": "no-store"
          }
        }
      }
    ]);
  });

  it("does not construct or call a launcher for unavailable metadata", async () => {
    let launches = 0;
    let launcherAccesses = 0;
    const options = Object.defineProperty(
      {
        env: {},
        resumeClient: {
          read: async () => ({
            ...unavailableResponse(),
            unavailable_reason:
              "private cwd, thread, binding, cookie, and shell output"
          })
        }
      },
      "resumeLauncher",
      {
        enumerable: true,
        get() {
          launcherAccesses += 1;
          return {
            async launch() {
              launches += 1;
            }
          };
        }
      }
    ) as CliRunOptions;
    const result = await runCli(["resume", sessionId], options);

    expect(result).toMatchObject({
      exitCode: cliExitCodes.apiError,
      stdout: ""
    });
    expect(result.stderr).toContain(
      "Managed session is not available for laptop resume."
    );
    expect(result.stderr).not.toMatch(/private|cwd|thread|binding|cookie|shell/iu);
    expect(launcherAccesses).toBe(0);
    expect(launches).toBe(0);
  });

  it("rejects invalid targets before client construction or request", async () => {
    let clientAccesses = 0;
    let fetchCalls = 0;
    const options = Object.defineProperty(
      {
        env: {},
        fetch: async () => {
          fetchCalls += 1;
          return jsonResponse(200, availableResponse());
        }
      },
      "resumeClient",
      {
        enumerable: true,
        get() {
          clientAccesses += 1;
          throw new Error("resume-client-private-sentinel");
        }
      }
    ) as CliRunOptions;

    for (const target of ["resume-cli", threadId, "sess with spaces"]) {
      const result = await runCli(["resume", target], options);
      expect(result).toMatchObject({
        exitCode: cliExitCodes.usage,
        stdout: ""
      });
      expect(result.stderr).toContain("valid managed session id");
      expect(result.stderr).not.toContain("private-sentinel");
    }
    expect(clientAccesses).toBe(0);
    expect(fetchCalls).toBe(0);
  });

  it("fails closed on malformed or cross-target client metadata before launcher access", async () => {
    const candidates = [
      { ...availableResponse(), session_id: "sess_resume_cli_other" },
      { ...availableResponse(), command: "codex resume arbitrary" },
      { ...availableResponse(), launch: null },
      { ...availableResponse(), codex_thread_id: threadId }
    ];
    let launcherAccesses = 0;
    for (const candidate of candidates) {
      const options = Object.defineProperty(
        {
          env: {},
          resumeClient: { read: async () => candidate }
        },
        "resumeLauncher",
        {
          enumerable: true,
          get() {
            launcherAccesses += 1;
            throw new Error("launcher-private-sentinel");
          }
        }
      ) as CliRunOptions;
      const result = await runCli(["resume", sessionId], options);
      expect(result).toMatchObject({
        exitCode: cliExitCodes.internal,
        stdout: ""
      });
      expect(result.stderr).toContain("invalid managed-thread metadata");
      expect(result.stderr).not.toMatch(/arbitrary|thread-resume|private-sentinel/iu);
    }
    expect(launcherAccesses).toBe(0);
  });

  it("preserves bounded client and launcher failures without fallback or retry", async () => {
    let clientCalls = 0;
    let launcherCalls = 0;
    const clientFailure = await runCli(["resume", sessionId], {
      env: {},
      resumeClient: {
        async read() {
          clientCalls += 1;
          throw clientOperationFailure(
            "runtime_unavailable",
            "Laptop resume metadata is unavailable."
          );
        }
      },
      resumeLauncher: {
        async launch() {
          launcherCalls += 1;
        }
      }
    });
    expect(clientFailure).toMatchObject({
      exitCode: cliExitCodes.apiError,
      stdout: ""
    });
    expect(clientFailure.stderr).toContain("metadata is unavailable");
    expect(clientCalls).toBe(1);
    expect(launcherCalls).toBe(0);

    const launchFailure = await runCli(["resume", sessionId], {
      env: {},
      resumeClient: { read: async () => availableResponse() },
      resumeLauncher: {
        async launch() {
          launcherCalls += 1;
          throw clientOperationFailure(
            "runtime_unavailable",
            "Codex TUI resume could not be started."
          );
        }
      }
    });
    expect(launchFailure).toMatchObject({
      exitCode: cliExitCodes.apiError,
      stdout: ""
    });
    expect(launchFailure.stderr).toContain("could not be started");
    expect(launcherCalls).toBe(1);
  });

  it("rejects a non-loopback API URL before fetch or launch", async () => {
    let fetchCalls = 0;
    let launchCalls = 0;
    const result = await runCli(
      [
        "--api-url",
        "https://private-resume.example.test",
        "resume",
        sessionId
      ],
      {
        env: {},
        fetch: async () => {
          fetchCalls += 1;
          return jsonResponse(200, availableResponse());
        },
        resumeLauncher: {
          async launch() {
            launchCalls += 1;
          }
        }
      }
    );
    expect(result).toMatchObject({
      exitCode: cliExitCodes.config,
      stdout: ""
    });
    expect(result.stderr).toContain("direct loopback");
    expect(result.stderr).not.toContain("private-resume.example.test");
    expect(fetchCalls).toBe(0);
    expect(launchCalls).toBe(0);
  });
});

function availableResponse() {
  return selectedResumeMetadataResponseSchema.parse({
    session_id: sessionId,
    local_only: true,
    available: true,
    command: `codex resume --remote unix://${socketPath} ${threadId}`,
    launch: {
      executable: "codex",
      args: ["resume", "--remote", `unix://${socketPath}`, threadId]
    },
    unavailable_reason: null
  });
}

function unavailableResponse() {
  return selectedResumeMetadataResponseSchema.parse({
    session_id: sessionId,
    local_only: true,
    available: false,
    command: null,
    launch: null,
    unavailable_reason: "The selected Codex runtime is not available."
  });
}

function jsonResponse(status: number, body: unknown): HttpResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}
