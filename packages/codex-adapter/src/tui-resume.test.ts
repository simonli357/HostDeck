import { describe, expect, it } from "vitest";
import { HostDeckCodexAdapterError } from "./errors.js";
import { buildCodexTuiResumeCommand } from "./tui-resume.js";

describe("Codex TUI resume command", () => {
  it("builds one immutable shell-free exact-thread command", () => {
    const command = buildCodexTuiResumeCommand({
      socket_path: "/run/user/1000/hostdeck/app.sock",
      thread_id: "019f-thread-id",
      codex_bin: "/opt/codex/bin/codex"
    });

    expect(command).toEqual({
      executable: "/opt/codex/bin/codex",
      args: ["resume", "--remote", "unix:///run/user/1000/hostdeck/app.sock", "019f-thread-id"]
    });
    expect(Object.isFrozen(command)).toBe(true);
    expect(Object.isFrozen(command.args)).toBe(true);
  });

  it.each([
    { socket_path: "ws://127.0.0.1:4500", thread_id: "thread-a" },
    { socket_path: "/tmp/app.sock", thread_id: "bad id" },
    { socket_path: "/tmp/app.sock", thread_id: "thread-a", codex_bin: "codex --danger" },
    { socket_path: "/tmp/app.sock", thread_id: "thread-a", codex_bin: "./codex" },
    { socket_path: "/tmp/app%2fsock", thread_id: "thread-a" }
  ])("rejects ambiguous or injectable input %#", (candidate) => {
    expect(() => buildCodexTuiResumeCommand(candidate)).toThrow(HostDeckCodexAdapterError);
  });
});
