import {
  type SkillsSnapshot,
  skillsSnapshotSchema
} from "@hostdeck/contracts";
import { describe, expect, it } from "vitest";
import type { HttpResponse } from "./api-client.js";
import { clientOperationFailure } from "./errors.js";
import { cliExitCodes } from "./exit-codes.js";
import { parseCliArgs } from "./parser.js";
import { type CliRunOptions, runCli } from "./shell.js";
import type { HostDeckSkillsClient } from "./skills-client.js";

const sessionId = "sess_skills_cli_001";
const otherSessionId = "sess_skills_cli_002";
const threadId = "thread-skills-cli-001";

describe("managed-session skills CLI command", () => {
  it("parses one session id with optional JSON and no runtime override", () => {
    expect(parseCliArgs(["skills", sessionId])).toEqual({
      command: { kind: "skills", session: sessionId, json: false },
      configFlags: {}
    });
    expect(parseCliArgs(["skills", sessionId, "--json"])).toEqual({
      command: { kind: "skills", session: sessionId, json: true },
      configFlags: {}
    });
    expect(
      parseCliArgs([
        "--api-url=http://127.0.0.1:4888",
        "--json",
        "skills",
        sessionId
      ])
    ).toEqual({
      command: { kind: "skills", session: sessionId, json: true },
      configFlags: { apiUrl: "http://127.0.0.1:4888" }
    });

    for (const args of [
      ["skills"],
      ["skills", sessionId, "extra"],
      ["skills", sessionId, "--cwd", "/private"],
      ["skills", sessionId, "--thread-id", threadId],
      ["skills", sessionId, "--scope", "repo"],
      ["skills", sessionId, "--force-reload=false"],
      ["skills", sessionId, "--command", "/skills"],
      ["/skills", sessionId],
      ["skill", sessionId]
    ]) {
      expect(() => parseCliArgs(args), args.join(" ")).toThrowError(
        expect.objectContaining({
          code: "malformed_request",
          exitCode: cliExitCodes.usage
        })
      );
    }
  });

  it("includes only the selected skills surface in help", async () => {
    const help = await runCli(["help"]);
    expect(help).toMatchObject({ exitCode: cliExitCodes.ok, stderr: "" });
    expect(help.stdout).toContain("codexdeck skills SESSION_ID [--json]");
    expect(help.stdout).not.toContain("codexdeck skill ");
    expect(help.stdout).not.toContain("codexdeck /skills");
    expect(help.stdout).not.toMatch(
      /^\s*codexdeck skills .*--(?:cwd|thread-id|force-reload|command)/imu
    );
  });

  it("passes one validated snapshot receiverlessly without constructing legacy or filesystem ports", async () => {
    const clientCalls: string[] = [];
    let clientThis: unknown = "not-called";
    let unrelatedAccesses = 0;
    const skillsClient: HostDeckSkillsClient = {
      list: async function listSkills(this: void, target) {
        clientThis = this;
        clientCalls.push(target);
        return skillsSnapshot();
      }
    };
    const options = Object.defineProperties(
      { env: {}, skillsClient },
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
        },
        resumeLauncher: {
          enumerable: true,
          get() {
            unrelatedAccesses += 1;
            throw new Error("launcher-private-sentinel");
          }
        },
        usageClient: {
          enumerable: true,
          get() {
            unrelatedAccesses += 1;
            throw new Error("usage-client-private-sentinel");
          }
        }
      }
    ) as CliRunOptions;

    const result = await runCli(["skills", sessionId], options);
    expect(result).toMatchObject({ exitCode: cliExitCodes.ok, stderr: "" });
    expect(result.stdout).toContain(`Skills: ${sessionId}`);
    expect(result.stdout).toContain("State: content");
    expect(result.stdout).toContain("[enabled] alpha (repo)");
    expect(result.stdout).toContain("[disabled] beta (system)");
    expect(result.stdout).toContain("Description: not provided");
    expect(result.stdout).not.toMatch(
      /private-sentinel|skill-path|default-prompt|dependency-command/iu
    );
    expect(clientCalls).toEqual([sessionId]);
    expect(clientThis).toBeUndefined();
    expect(unrelatedAccesses).toBe(0);
  });

  it("performs one exact loopback request and renders contract-exact JSON without mutation", async () => {
    const requests: unknown[] = [];
    const expected = skillsSnapshot();
    const result = await runCli(["skills", sessionId, "--json"], {
      env: {},
      fetch: async (url, init) => {
        requests.push({ url, init });
        return jsonResponse(200, expected);
      }
    });

    expect(result).toMatchObject({ exitCode: cliExitCodes.ok, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual(expected);
    expect(requests).toEqual([
      {
        url: `http://127.0.0.1:3777/api/v1/sessions/${sessionId}/skills`,
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

  it("renders all four states, nullable descriptions, and terminal controls truthfully", async () => {
    const empty = await runCli(["skills", sessionId], {
      env: {},
      skillsClient: {
        list: async () =>
          skillsSnapshot({ state: "empty", skills: [], error_count: 0 })
      }
    });
    expect(empty.stdout).toContain("State: empty");
    expect(empty.stdout).toContain("Skill count: 0");
    expect(empty.stdout).toContain("Skill errors: 0");
    expect(empty.stdout).toContain("No skills reported.");

    const partial = await runCli(["skills", sessionId], {
      env: {},
      skillsClient: {
        list: async () => skillsSnapshot({ state: "partial", error_count: 2 })
      }
    });
    expect(partial.stdout).toContain("State: partial");
    expect(partial.stdout).toContain("Skill errors: 2 (details redacted)");
    expect(partial.stdout).not.toMatch(/error message|error path/iu);

    const failed = await runCli(["skills", sessionId], {
      env: {},
      skillsClient: {
        list: async () =>
          skillsSnapshot({ state: "error", skills: [], error_count: 2 })
      }
    });
    expect(failed.stdout).toContain("State: error");
    expect(failed.stdout).toContain("No skills reported.");

    const controlled = await runCli(["skills", sessionId], {
      env: {},
      skillsClient: {
        list: async () =>
          skillsSnapshot({
            skills: [
              {
                name: "alpha\nspoof",
                description: "red\u001b[31m\nline\u202eright-to-left",
                scope: "repo",
                enabled: true
              }
            ]
          })
      }
    });
    expect(controlled).toMatchObject({ exitCode: cliExitCodes.ok, stderr: "" });
    expect(controlled.stdout).toContain("alpha\\nspoof");
    expect(controlled.stdout).toContain(
      "red\\u001b[31m\\nline\\u202eright-to-left"
    );
    expect(controlled.stdout).not.toContain("\u001b");
    expect(controlled.stdout).not.toContain("\u202e");
    expect(controlled.stdout.split("\n")).not.toContain("spoof (repo)");
  });

  it("rejects invalid, cross-session, path-bearing, hostile, and oversized client data before output", async () => {
    let clientAccesses = 0;
    let fetchCalls = 0;
    const invalidOptions = Object.defineProperty(
      {
        env: {},
        fetch: async () => {
          fetchCalls += 1;
          return jsonResponse(200, skillsSnapshot());
        }
      },
      "skillsClient",
      {
        enumerable: true,
        get() {
          clientAccesses += 1;
          throw new Error("skills-client-private-sentinel");
        }
      }
    ) as CliRunOptions;
    for (const target of ["skills-cli", threadId, "/tmp/private", "sess with spaces"]) {
      const result = await runCli(["skills", target], invalidOptions);
      expect(result).toMatchObject({
        exitCode: cliExitCodes.usage,
        stdout: ""
      });
      expect(result.stderr).toContain("valid managed session id");
      expect(result.stderr).not.toContain("private-sentinel");
    }
    expect(clientAccesses).toBe(0);
    expect(fetchCalls).toBe(0);

    const hostile = Object.defineProperty({}, "target", {
      enumerable: true,
      get() {
        throw new Error("hostile-output-private-sentinel");
      }
    });
    const candidates = [
      {
        ...skillsSnapshot(),
        target: { ...skillsSnapshot().target, session_id: otherSessionId }
      },
      { ...skillsSnapshot(), cwd: "/private/cwd" },
      {
        ...skillsSnapshot(),
        skills: [
          {
            ...skillsSnapshot().skills[0],
            path: "/private/skill-path"
          }
        ]
      },
      hostile
    ];
    for (const candidate of candidates) {
      const result = await runCli(["skills", sessionId], {
        env: {},
        skillsClient: { list: async () => candidate as never }
      });
      expect(result).toMatchObject({
        exitCode: cliExitCodes.internal,
        stdout: ""
      });
      expect(result.stderr).toContain("invalid managed-session data");
      expect(result.stderr).not.toMatch(/private|skill-path|hostile-output/iu);
    }

    const oversized = skillsSnapshot({
      skills: Array.from({ length: 300 }, (_, index) => ({
        name: `skill-${String(index).padStart(4, "0")}`,
        description: "x".repeat(4_096),
        scope: "repo",
        enabled: true
      }))
    });
    const result = await runCli(["skills", sessionId], {
      env: {},
      skillsClient: { list: async () => oversized }
    });
    expect(result).toMatchObject({
      exitCode: cliExitCodes.internal,
      stdout: ""
    });
    expect(result.stderr).toContain("output exceeds its selected limit");
  });

  it("preserves bounded failures without retry and rejects non-loopback APIs", async () => {
    let clientCalls = 0;
    const failed = await runCli(["skills", sessionId], {
      env: {},
      skillsClient: {
        async list() {
          clientCalls += 1;
          throw clientOperationFailure(
            "runtime_unavailable",
            "Codex skills are unavailable."
          );
        }
      }
    });
    expect(failed).toMatchObject({
      exitCode: cliExitCodes.apiError,
      stdout: ""
    });
    expect(failed.stderr).toContain("Codex skills are unavailable");
    expect(clientCalls).toBe(1);

    let fetchCalls = 0;
    const remote = await runCli(
      [
        "--api-url",
        "https://private-skills.example.test",
        "skills",
        sessionId
      ],
      {
        env: {},
        fetch: async () => {
          fetchCalls += 1;
          return jsonResponse(200, skillsSnapshot());
        }
      }
    );
    expect(remote).toMatchObject({
      exitCode: cliExitCodes.config,
      stdout: ""
    });
    expect(remote.stderr).toContain("direct loopback");
    expect(remote.stderr).not.toContain("private-skills.example.test");
    expect(fetchCalls).toBe(0);
  });
});

function skillsSnapshot(overrides: Partial<SkillsSnapshot> = {}): SkillsSnapshot {
  return skillsSnapshotSchema.parse({
    target: {
      type: "managed_session",
      session_id: sessionId,
      codex_thread_id: threadId
    },
    runtime_version: "0.144.0",
    connection_generation: 3,
    observed_at: "2026-07-15T14:05:00.000Z",
    state: "content",
    skills: [
      {
        name: "alpha",
        description: "Alpha skill.",
        scope: "repo",
        enabled: true
      },
      {
        name: "beta",
        description: null,
        scope: "system",
        enabled: false
      }
    ],
    error_count: 0,
    ...overrides
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
