import { describe, expect, it } from "vitest";
import {
  formatSelectedResumeLaunchCommand,
  selectedResumeLaunchSchema,
  selectedResumeMetadataResponseSchema,
  selectedResumeParamsSchema
} from "./selected-resume.js";

const sessionId = "sess_resume_contract_001";
const threadId = "thread-resume-contract-001";

describe("selected managed-thread resume contracts", () => {
  it("formats one canonical simple launch and available response", () => {
    const launch = selectedResumeLaunchSchema.parse({
      executable: "codex",
      args: [
        "resume",
        "--remote",
        "unix:///run/user/1000/hostdeck/app-server.sock",
        threadId
      ]
    });
    const command = formatSelectedResumeLaunchCommand(launch);
    expect(command).toBe(
      `codex resume --remote unix:///run/user/1000/hostdeck/app-server.sock ${threadId}`
    );
    expect(
      selectedResumeMetadataResponseSchema.parse({
        session_id: sessionId,
        local_only: true,
        available: true,
        command,
        launch,
        unavailable_reason: null
      })
    ).toEqual({
      session_id: sessionId,
      local_only: true,
      available: true,
      command,
      launch,
      unavailable_reason: null
    });
    expect(selectedResumeParamsSchema.parse({ session_id: sessionId })).toEqual({
      session_id: sessionId
    });
  });

  it("quotes every unsafe token without changing the structured argv", () => {
    const launch = selectedResumeLaunchSchema.parse({
      executable: "/opt/Codex Tools/cod'ex",
      args: [
        "resume",
        "--remote",
        "unix:///run/user/1000/host deck/app's.sock",
        "thread;echo-private"
      ]
    });
    expect(formatSelectedResumeLaunchCommand(launch)).toBe(
      `'/opt/Codex Tools/cod'"'"'ex' resume --remote 'unix:///run/user/1000/host deck/app'"'"'s.sock' 'thread;echo-private'`
    );
    expect(launch.args).toEqual([
      "resume",
      "--remote",
      "unix:///run/user/1000/host deck/app's.sock",
      "thread;echo-private"
    ]);

    const unicode = selectedResumeLaunchSchema.parse({
      executable: "/opt/\u5de5\u5177/codex",
      args: [
        "resume",
        "--remote",
        "unix:///tmp/\u5de5\u4f5c/app.sock",
        threadId
      ]
    });
    expect(formatSelectedResumeLaunchCommand(unicode)).toBe(
      "'/opt/\u5de5\u5177/codex' resume --remote 'unix:///tmp/\u5de5\u4f5c/app.sock' " +
        threadId
    );
  });

  it("accepts only explicit unavailable metadata", () => {
    expect(
      selectedResumeMetadataResponseSchema.parse({
        session_id: sessionId,
        local_only: true,
        available: false,
        command: null,
        launch: null,
        unavailable_reason: "The selected Codex runtime is not available."
      })
    ).toMatchObject({ available: false, launch: null });
  });

  it("rejects malformed targets, launch drift, shell controls, and extra metadata", () => {
    const launch = {
      executable: "codex",
      args: [
        "resume",
        "--remote",
        "unix:///run/user/1000/hostdeck/app-server.sock",
        threadId
      ]
    } as const;
    const invalidLaunches = [
      { ...launch, executable: "codex --danger" },
      { ...launch, executable: "./codex" },
      { ...launch, executable: "codex\nprivate" },
      { ...launch, executable: `/${"x".repeat(4_096)}` },
      { ...launch, args: ["exec", ...launch.args.slice(1)] },
      { ...launch, args: ["resume", "--remote", "https://example.test", threadId] },
      { ...launch, args: ["resume", "--remote", "unix:///tmp/a%2fb", threadId] },
      {
        ...launch,
        args: ["resume", "--remote", `unix:///${"x".repeat(513)}`, threadId]
      },
      {
        ...launch,
        args: ["resume", "--remote", "unix:///tmp/app\nsock", threadId]
      },
      { ...launch, args: ["resume", "--remote", launch.args[2], "thread with spaces"] },
      { ...launch, extra: "raw shell" }
    ];
    for (const candidate of invalidLaunches) {
      expect(() => selectedResumeLaunchSchema.parse(candidate)).toThrow();
    }

    const command = formatSelectedResumeLaunchCommand(launch);
    const invalidResponses = [
      {
        session_id: sessionId,
        local_only: true,
        available: true,
        command: `${command} --danger`,
        launch,
        unavailable_reason: null
      },
      {
        session_id: sessionId,
        local_only: true,
        available: true,
        command,
        launch: null,
        unavailable_reason: null
      },
      {
        session_id: sessionId,
        local_only: true,
        available: false,
        command,
        launch,
        unavailable_reason: "Unavailable."
      },
      {
        session_id: sessionId,
        local_only: false,
        available: false,
        command: null,
        launch: null,
        unavailable_reason: "Unavailable."
      },
      {
        session_id: sessionId,
        local_only: true,
        available: false,
        command: null,
        launch: null,
        unavailable_reason: "Unavailable.",
        codex_thread_id: threadId
      },
      {
        session_id: sessionId,
        local_only: true,
        available: true,
        command: "x".repeat(1_001),
        launch,
        unavailable_reason: null
      },
      {
        session_id: sessionId,
        local_only: true,
        available: false,
        command: null,
        launch: null,
        unavailable_reason: "x".repeat(241)
      }
    ];
    for (const candidate of invalidResponses) {
      expect(() => selectedResumeMetadataResponseSchema.parse(candidate)).toThrow();
    }

    for (const candidate of [
      null,
      {},
      { session_id: "bad target" },
      { session_id: sessionId, codex_thread_id: threadId }
    ]) {
      expect(() => selectedResumeParamsSchema.parse(candidate)).toThrow();
    }
  });
});
