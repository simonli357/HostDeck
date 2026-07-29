import { describe, expect, it, vi } from "vitest";
import {
  createHostDeckSystemdUserManager,
  type HostDeckSystemdCommandResult,
  HostDeckSystemdManagerError
} from "./systemd-user-manager.js";

const activeHostDeck = [
  "LoadState=loaded",
  "UnitFileState=enabled",
  "ActiveState=active",
  "SubState=running",
  "MainPID=357357",
  "FragmentPath=/home/test/.config/systemd/user/hostdeck.service",
  "NeedDaemonReload=no",
  ""
].join("\n");

describe("IFC-V1-056 systemd user-manager adapter", () => {
  it("uses only fixed user-manager command forms and parses exact unit state", async () => {
    const calls: readonly string[][] = [];
    const observed: string[][] = calls as string[][];
    const run = vi.fn(async (args: readonly string[]) => {
      observed.push([...args]);
      return result(args.includes("show") ? activeHostDeck : "");
    });
    const manager = createHostDeckSystemdUserManager({ run });

    await manager.daemonReload();
    await manager.enableHostDeck();
    await manager.startHostDeck();
    await manager.restartHostDeck();
    await manager.stopHostDeck();
    await manager.stopCodex();
    await manager.disableHostDeck();
    const state = await manager.show("hostdeck.service");

    expect(observed.slice(0, 7)).toEqual([
      ["--user", "--no-pager", "daemon-reload"],
      ["--user", "--no-pager", "enable", "hostdeck.service"],
      ["--user", "--no-pager", "start", "hostdeck.service"],
      ["--user", "--no-pager", "restart", "hostdeck.service"],
      ["--user", "--no-pager", "stop", "hostdeck.service"],
      ["--user", "--no-pager", "stop", "hostdeck-codex.service"],
      ["--user", "--no-pager", "disable", "hostdeck.service"]
    ]);
    expect(observed[7]).toEqual([
      "--user",
      "--no-pager",
      "show",
      "hostdeck.service",
      "--property=LoadState",
      "--property=UnitFileState",
      "--property=ActiveState",
      "--property=SubState",
      "--property=MainPID",
      "--property=FragmentPath",
      "--property=NeedDaemonReload"
    ]);
    expect(state).toEqual({
      active_state: "active",
      fragment_path: "/home/test/.config/systemd/user/hostdeck.service",
      load_state: "loaded",
      main_pid: 357357,
      need_daemon_reload: false,
      sub_state: "running",
      unit_file_state: "enabled"
    });
    expect(Object.isFrozen(state)).toBe(true);
  });

  it("rejects command failure and malformed, duplicate, contradictory, or oversized output", async () => {
    const malformed = [
      "LoadState=loaded\n",
      activeHostDeck.replace("LoadState=loaded\n", "LoadState=loaded\nLoadState=loaded\n"),
      activeHostDeck.replace("MainPID=357357", "MainPID=private"),
      activeHostDeck.replace("MainPID=357357", "MainPID=0"),
      activeHostDeck.replace("NeedDaemonReload=no", "NeedDaemonReload=maybe"),
      activeHostDeck.replace(
        "FragmentPath=/home/test/.config/systemd/user/hostdeck.service",
        `FragmentPath=/${"x".repeat(4_096)}`
      )
    ];

    for (const stdout of malformed) {
      const manager = createHostDeckSystemdUserManager({
        run: async () => result(stdout)
      });
      await expect(manager.show("hostdeck.service")).rejects.toMatchObject({
        code: "invalid_output",
        stage: "show_hostdeck"
      });
    }

    const failed = createHostDeckSystemdUserManager({
      run: async () => ({ ...result(""), exit_code: 1, stderr: "private" })
    });
    await expect(failed.enableHostDeck()).rejects.toMatchObject({
      code: "command_failed",
      stage: "enable"
    });

    const hostileResults = [
      { ...result(""), extra: true },
      Object.create(result("")),
      Object.defineProperty(
        { exit_code: 0, stderr: "" },
        "stdout",
        { enumerable: true, get: () => activeHostDeck }
      ),
      {
        exit_code: 0,
        stderr: "y".repeat(32_769),
        stdout: "x".repeat(32_768)
      }
    ];
    for (const hostile of hostileResults) {
      const manager = createHostDeckSystemdUserManager({
        run: async () => hostile as HostDeckSystemdCommandResult
      });
      await expect(manager.daemonReload()).rejects.toMatchObject({
        code: "invalid_output",
        stage: "daemon_reload"
      });
    }
  });

  it("maps runner errors without retaining raw manager output or paths", async () => {
    const manager = createHostDeckSystemdUserManager({
      run: async () => {
        throw new Error("private /home/test secret");
      }
    });
    let observed: unknown;
    try {
      await manager.daemonReload();
    } catch (error) {
      observed = error;
    }
    expect(observed).toBeInstanceOf(HostDeckSystemdManagerError);
    expect(observed).toMatchObject({
      code: "manager_unavailable",
      stage: "daemon_reload",
      message: "HostDeck systemd user-manager operation failed."
    });
    expect(String(observed)).not.toMatch(/private|\/home\/test|secret/u);

    const start = createHostDeckSystemdUserManager({
      run: async () => {
        throw new HostDeckSystemdManagerError("timed_out", "daemon_reload");
      }
    });
    await expect(start.startHostDeck()).rejects.toMatchObject({
      code: "timed_out",
      stage: "start_hostdeck"
    });
  });

  it("rejects unit names outside the fixed HostDeck allowlist", async () => {
    const run = vi.fn(async () => result(activeHostDeck));
    const manager = createHostDeckSystemdUserManager({ run });

    await expect(manager.show("foreign.service" as never)).rejects.toMatchObject(
      {
        code: "invalid_output",
        stage: "show_hostdeck"
      }
    );
    expect(run).not.toHaveBeenCalled();
  });
});

function result(stdout: string): HostDeckSystemdCommandResult {
  return { exit_code: 0, stderr: "", stdout };
}
