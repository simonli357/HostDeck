import { describe, expect, it } from "vitest";
import { HostDeckCodexAdapterError } from "./errors.js";
import { buildCodexTuiResumeCommand } from "./tui-resume.js";

describe("Codex TUI resume command", () => {
  it("builds one immutable shell-free exact-thread command", () => {
    const command = buildCodexTuiResumeCommand({
      thread_id: "019fc8bd-25ef-74c3-a3bf-c6e59e4122a4",
      codex_bin: "/opt/codex/bin/codex"
    });

    expect(command).toEqual({
      executable: "/opt/codex/bin/codex",
      args: ["resume", "019fc8bd-25ef-74c3-a3bf-c6e59e4122a4"]
    });
    expect(Object.isFrozen(command)).toBe(true);
    expect(Object.isFrozen(command.args)).toBe(true);
  });

  it.each([
    { thread_id: "bad id" },
    { thread_id: "019fc8bd-25ef-74c3-a3bf-c6e59e4122a4", codex_bin: "codex --danger" },
    { thread_id: "019fc8bd-25ef-74c3-a3bf-c6e59e4122a4", codex_bin: "./codex" },
    { thread_id: "019fc8bd-25ef-74c3-a3bf-c6e59e4122a4", socket_path: "/tmp/private.sock" }
  ])("rejects ambiguous or injectable input %#", (candidate) => {
    expect(() => buildCodexTuiResumeCommand(candidate as never)).toThrow(HostDeckCodexAdapterError);
  });
});
