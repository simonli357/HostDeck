import { describe, expect, it } from "vitest";
import {
  formatSelectedResumeLaunchCommand,
  selectedResumeLaunchSchema,
  selectedResumeMetadataResponseSchema,
  selectedResumeParamsSchema
} from "./selected-resume.js";

const sessionId = "sess_resume_contract_001";
const threadId = "019f489a-1f9d-7402-ae00-eac6ea322f64";

describe("selected shared-thread resume contracts", () => {
  it("formats one plain Codex resume and accepts either public target id", () => {
    const launch = selectedResumeLaunchSchema.parse({
      executable: "codex",
      args: ["resume", threadId]
    });
    const command = formatSelectedResumeLaunchCommand(launch);
    expect(command).toBe(`codex resume ${threadId}`);
    expect(
      selectedResumeMetadataResponseSchema.parse({
        session_id: sessionId,
        codex_thread_id: threadId,
        local_only: true,
        available: true,
        command,
        launch,
        unavailable_reason: null
      })
    ).toEqual({
      session_id: sessionId,
      codex_thread_id: threadId,
      local_only: true,
      available: true,
      command,
      launch,
      unavailable_reason: null
    });
    expect(selectedResumeParamsSchema.parse({ session_id: sessionId })).toEqual({
      session_id: sessionId
    });
    expect(selectedResumeParamsSchema.parse({ session_id: threadId })).toEqual({
      session_id: threadId
    });
  });

  it("quotes an unsafe executable without changing the structured argv", () => {
    const launch = selectedResumeLaunchSchema.parse({
      executable: "/opt/Codex Tools/cod'ex",
      args: ["resume", threadId]
    });
    expect(formatSelectedResumeLaunchCommand(launch)).toBe(
      `'/opt/Codex Tools/cod'"'"'ex' resume ${threadId}`
    );
    expect(launch.args).toEqual(["resume", threadId]);
  });

  it("accepts only explicit unavailable metadata with stable identity", () => {
    expect(
      selectedResumeMetadataResponseSchema.parse({
        session_id: sessionId,
        codex_thread_id: threadId,
        local_only: true,
        available: false,
        command: null,
        launch: null,
        unavailable_reason: "The selected Codex runtime is not available."
      })
    ).toMatchObject({
      session_id: sessionId,
      codex_thread_id: threadId,
      available: false,
      launch: null
    });
  });

  it("rejects private-remote argv, launch drift, controls, and malformed targets", () => {
    const launch = {
      executable: "codex",
      args: ["resume", threadId]
    } as const;
    for (const candidate of [
      { ...launch, executable: "codex --danger" },
      { ...launch, executable: "./codex" },
      { ...launch, executable: "codex\nprivate" },
      { ...launch, executable: `/${"x".repeat(4_096)}` },
      { ...launch, args: ["exec", threadId] },
      { ...launch, args: ["resume", "--remote", threadId] },
      { ...launch, args: ["resume", "not-a-native-uuid"] },
      { ...launch, extra: "raw shell" }
    ]) {
      expect(() => selectedResumeLaunchSchema.parse(candidate)).toThrow();
    }

    const command = formatSelectedResumeLaunchCommand(launch);
    for (const candidate of [
      {
        session_id: sessionId,
        codex_thread_id: threadId,
        local_only: true,
        available: true,
        command: `${command} --danger`,
        launch,
        unavailable_reason: null
      },
      {
        session_id: sessionId,
        codex_thread_id: threadId,
        local_only: true,
        available: true,
        command,
        launch: null,
        unavailable_reason: null
      },
      {
        session_id: sessionId,
        codex_thread_id: threadId,
        local_only: true,
        available: false,
        command,
        launch,
        unavailable_reason: "Unavailable."
      },
      {
        session_id: sessionId,
        codex_thread_id: threadId,
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
        unavailable_reason: "Unavailable."
      },
      {
        session_id: sessionId,
        codex_thread_id: threadId,
        local_only: true,
        available: false,
        command: null,
        launch: null,
        unavailable_reason: "Unavailable.",
        private_socket: "/private/app-server.sock"
      }
    ]) {
      expect(() => selectedResumeMetadataResponseSchema.parse(candidate)).toThrow();
    }

    for (const candidate of [
      null,
      {},
      { session_id: "bad target" },
      { session_id: sessionId, codex_thread_id: threadId },
      { session_id: "00000000-0000-0000-0000-000000000000" }
    ]) {
      expect(() => selectedResumeParamsSchema.parse(candidate)).toThrow();
    }
  });
});
