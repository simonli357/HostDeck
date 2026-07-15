import { EventEmitter } from "node:events";
import { selectedResumeLaunchSchema } from "@hostdeck/contracts";
import { describe, expect, it } from "vitest";
import {
  createHostDeckResumeLauncher,
  type HostDeckResumeChildProcess,
  type HostDeckResumeSpawn
} from "./resume-launcher.js";

const launch = selectedResumeLaunchSchema.parse({
  executable: "/opt/Codex Tools/cod'ex",
  args: [
    "resume",
    "--remote",
    "unix:///tmp/host deck/app's.sock",
    "thread-resume-launcher-001"
  ]
});

describe("local Codex TUI resume launcher", () => {
  it("spawns one exact structured argv with no shell and inherited stdio", async () => {
    const calls: unknown[] = [];
    let observedThis: unknown = "not-called";
    const spawn: HostDeckResumeSpawn = function spawnResume(
      this: void,
      executable,
      args,
      options
    ) {
      observedThis = this;
      calls.push({ executable, args, options });
      return childThatExits(0, null);
    };
    const launcher = createHostDeckResumeLauncher({ spawn });

    await expect(launcher.launch(launch)).resolves.toBeUndefined();
    expect(observedThis).toBeUndefined();
    expect(Object.isFrozen(launcher)).toBe(true);
    expect(calls).toEqual([
      {
        executable: "/opt/Codex Tools/cod'ex",
        args: [
          "resume",
          "--remote",
          "unix:///tmp/host deck/app's.sock",
          "thread-resume-launcher-001"
        ],
        options: { shell: false, stdio: "inherit" }
      }
    ]);
    const call = calls[0] as {
      readonly args: readonly string[];
      readonly options: object;
    };
    expect(Object.isFrozen(call.args)).toBe(true);
    expect(Object.isFrozen(call.options)).toBe(true);
    expect(calls).not.toContain(
      "'/opt/Codex Tools/cod'\"'\"'ex' resume --remote"
    );
  });

  it("snapshots one exact accessor-free optional spawn port", async () => {
    let calls = 0;
    const mutable = {
      spawn: (() => {
        calls += 1;
        return childThatExits(0, null);
      }) as HostDeckResumeSpawn
    };
    const launcher = createHostDeckResumeLauncher(mutable);
    mutable.spawn = () => {
      throw new Error("mutated-spawn-private-sentinel");
    };
    await launcher.launch(launch);
    expect(calls).toBe(1);

    const nullInput = Object.assign(Object.create(null) as Record<string, unknown>, {
      spawn: (() => childThatExits(0, null)) as HostDeckResumeSpawn
    });
    await expect(
      createHostDeckResumeLauncher(nullInput as never).launch(launch)
    ).resolves.toBeUndefined();

    let accessorCalls = 0;
    const accessor = Object.defineProperty({}, "spawn", {
      enumerable: true,
      get() {
        accessorCalls += 1;
        throw new Error("spawn-accessor-private-sentinel");
      }
    });
    const hostileProxy = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("launcher-options-proxy-private-sentinel");
        }
      }
    );
    for (const candidate of [
      null,
      [],
      { extra: true },
      { spawn: null },
      Object.assign(Object.create({ inherited: true }), {}),
      accessor,
      hostileProxy
    ]) {
      expect(() =>
        createHostDeckResumeLauncher(candidate as never)
      ).toThrow(TypeError);
    }
    expect(accessorCalls).toBe(0);
    expect(() => createHostDeckResumeLauncher()).not.toThrow();
  });

  it("rejects malformed descriptors before process creation", async () => {
    let calls = 0;
    const launcher = createHostDeckResumeLauncher({
      spawn: () => {
        calls += 1;
        return childThatExits(0, null);
      }
    });
    const candidates = [
      null,
      {},
      { ...launch, executable: "codex --shell" },
      { ...launch, args: ["exec", ...launch.args.slice(1)] },
      {
        ...launch,
        args: ["resume", "--remote", "https://example.test", launch.args[3]]
      },
      { ...launch, command: "codex resume --shell" }
    ];
    for (const candidate of candidates) {
      await expect(launcher.launch(candidate as never)).rejects.toMatchObject({
        code: "internal_error",
        exitCode: 1,
        message: "Codex TUI resume launch descriptor is invalid."
      });
    }
    expect(calls).toBe(0);
  });

  it("maps synchronous and asynchronous spawn failures without retrying or leaking", async () => {
    let syncCalls = 0;
    const synchronous = createHostDeckResumeLauncher({
      spawn: () => {
        syncCalls += 1;
        throw new Error("spawn-sync-private-sentinel");
      }
    });
    await expect(synchronous.launch(launch)).rejects.toMatchObject({
      code: "runtime_unavailable",
      exitCode: 70,
      message: "Codex TUI resume could not be started."
    });
    expect(syncCalls).toBe(1);

    let asyncCalls = 0;
    const asynchronous = createHostDeckResumeLauncher({
      spawn: () => {
        asyncCalls += 1;
        return childThatErrors(new Error("spawn-async-private-sentinel"));
      }
    });
    await expect(asynchronous.launch(launch)).rejects.toMatchObject({
      code: "runtime_unavailable",
      exitCode: 70,
      message: "Codex TUI resume could not be started."
    });
    expect(asyncCalls).toBe(1);
  });

  it("maps signal, nonzero, missing status, and invalid process handles without retrying", async () => {
    const cases: ReadonlyArray<{
      readonly child: () => HostDeckResumeChildProcess;
      readonly code: string;
      readonly message: string;
    }> = [
      {
        child: () => childThatExits(null, "SIGTERM"),
        code: "runtime_unavailable",
        message: "terminated before completion"
      },
      {
        child: () => childThatExits(23, null),
        code: "unknown_error",
        message: "exited with status 23"
      },
      {
        child: () => childThatExits(null, null),
        code: "internal_error",
        message: "exited without a status"
      },
      {
        child: () =>
          ({
            once() {
              throw new Error("invalid-handle-private-sentinel");
            }
          }) as HostDeckResumeChildProcess,
        code: "internal_error",
        message: "process handle is invalid"
      }
    ];
    let calls = 0;
    for (const testCase of cases) {
      const launcher = createHostDeckResumeLauncher({
        spawn: () => {
          calls += 1;
          return testCase.child();
        }
      });
      await expect(launcher.launch(launch)).rejects.toMatchObject({
        code: testCase.code,
        message: expect.stringContaining(testCase.message)
      });
    }
    expect(calls).toBe(cases.length);
  });
});

function childThatExits(
  code: number | null,
  signal: NodeJS.Signals | null
): HostDeckResumeChildProcess {
  const emitter = new EventEmitter();
  queueMicrotask(() => emitter.emit("exit", code, signal));
  return emitter as HostDeckResumeChildProcess;
}

function childThatErrors(error: Error): HostDeckResumeChildProcess {
  const emitter = new EventEmitter();
  queueMicrotask(() => emitter.emit("error", error));
  return emitter as HostDeckResumeChildProcess;
}
