import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  buildCodexPlatformTuiResumeCommand,
  type CodexAuthenticatedLoopbackWebSocketEndpoint,
  type CodexPlatformTuiResumeChildProcess,
  type CodexPlatformTuiResumeCommand,
  type CodexPlatformTuiResumeExecutor,
  type CodexPlatformTuiResumeSpawn,
  type CodexPlatformTuiResumeSpawnOptions,
  codexRemoteAuthEnvironmentVariable,
  createCodexPlatformTuiResumeExecutor,
  createCodexUnixSocketEndpoint,
  HostDeckCodexPlatformTuiResumeError
} from "./index.js";

const threadId = "thr_hostdeck_resume_001";
const currentCredential = "C".repeat(64);
const staleCredential = "S".repeat(64);
const windowsEndpoint: CodexAuthenticatedLoopbackWebSocketEndpoint =
  Object.freeze({
    schema_version: 1,
    target: "windows-x64",
    kind: "authenticated_loopback_websocket",
    address: "ws://127.0.0.1:43871",
    port_allocation: "ephemeral_random",
    credential_source: "protected_environment"
  });

describe("platform Codex TUI resume command", () => {
  it("builds exact immutable Linux and Windows commands without credential material", () => {
    const linux = linuxCommand("/");
    const windows = windowsCommand("C:\\");

    expect(linux).toEqual({
      target: "linux-x64",
      endpoint: createCodexUnixSocketEndpoint("/tmp/hostdeck/app.sock"),
      executable: "/opt/hostdeck/codex",
      cwd: "/",
      args: [
        "resume",
        "--remote",
        "unix:///tmp/hostdeck/app.sock",
        threadId
      ],
      credential_environment_variable: null
    });
    expect(windows).toEqual({
      target: "windows-x64",
      endpoint: windowsEndpoint,
      executable: "C:\\HostDeck\\codex.exe",
      cwd: "C:\\",
      args: [
        "resume",
        "--remote",
        "ws://127.0.0.1:43871",
        "--remote-auth-token-env",
        codexRemoteAuthEnvironmentVariable,
        threadId
      ],
      credential_environment_variable: codexRemoteAuthEnvironmentVariable
    });
    for (const command of [linux, windows]) {
      expect(Object.isFrozen(command)).toBe(true);
      expect(Object.isFrozen(command.args)).toBe(true);
      expect(Object.isFrozen(command.endpoint)).toBe(true);
      expect(JSON.stringify(command)).not.toContain(currentCredential);
    }
  });

  it.each([
    {
      target: "linux-x64",
      endpoint: windowsEndpoint,
      thread_id: threadId,
      codex_bin: "/opt/hostdeck/codex",
      cwd: "/work/repo"
    },
    {
      target: "windows-x64",
      endpoint: windowsEndpoint,
      thread_id: threadId,
      codex_bin: "C:\\HostDeck\\codex",
      cwd: "C:\\work\\repo"
    },
    {
      target: "windows-x64",
      endpoint: windowsEndpoint,
      thread_id: threadId,
      codex_bin: "C:/HostDeck/codex.exe",
      cwd: "C:\\work\\repo"
    },
    {
      target: "windows-x64",
      endpoint: windowsEndpoint,
      thread_id: threadId,
      codex_bin: "C:\\HostDeck\\codex.exe",
      cwd: "C:\\work\\..\\repo"
    },
    {
      target: "windows-x64",
      endpoint: windowsEndpoint,
      thread_id: threadId,
      codex_bin: "C:\\HostDeck\\codex.exe",
      cwd: "C:\\work\\NUL"
    },
    {
      target: "windows-x64",
      endpoint: windowsEndpoint,
      thread_id: threadId,
      codex_bin: "C:\\HostDeck\\codex.exe",
      cwd: "C:\\work\\repo."
    },
    {
      target: "windows-x64",
      endpoint: windowsEndpoint,
      thread_id: threadId,
      codex_bin: "C:\\HostDeck\\codex.exe",
      cwd: "C:\\work\\bad*repo"
    },
    {
      target: "linux-x64",
      endpoint: createCodexUnixSocketEndpoint("/tmp/hostdeck/app.sock"),
      thread_id: "bad thread",
      codex_bin: "/opt/hostdeck/codex",
      cwd: "/work/repo"
    },
    {
      target: "linux-x64",
      endpoint: createCodexUnixSocketEndpoint("/tmp/hostdeck/app.sock"),
      thread_id: threadId,
      codex_bin: "codex",
      cwd: "/work/repo"
    },
    {
      target: "linux-x64",
      endpoint: createCodexUnixSocketEndpoint("/tmp/hostdeck/app.sock"),
      thread_id: threadId,
      codex_bin: "/opt/hostdeck/codex",
      cwd: "/work/repo",
      extra: true
    }
  ])("rejects mixed-target, injectable, or noncanonical input %#", (candidate) => {
    expect(() => buildCodexPlatformTuiResumeCommand(candidate as never)).toThrow(
      expect.objectContaining({
        code: "invalid_config",
        stage: "configuration"
      })
    );
  });

  it("rejects accessors without evaluating private input", () => {
    let reads = 0;
    const endpoint = {
      ...windowsEndpoint,
      get kind(): never {
        reads += 1;
        throw new Error(currentCredential);
      }
    };

    const error = captureResumeError(() =>
      buildCodexPlatformTuiResumeCommand({
        target: "windows-x64",
        endpoint,
        thread_id: threadId,
        codex_bin: "C:\\HostDeck\\codex.exe",
        cwd: "C:\\work\\repo"
      } as never)
    );
    expect(error).toMatchObject({
      code: "invalid_config",
      stage: "configuration"
    });
    expect(reads).toBe(0);
    expect(JSON.stringify(error)).not.toContain(currentCredential);
  });
});

describe("platform Codex TUI resume execution", () => {
  it("launches Windows with exact argv/cwd and one current environment-only credential", async () => {
    const child = fakeChild();
    let reads = 0;
    let capture: SpawnCapture | undefined;
    let parentEnvironment: Readonly<Record<string, string>> | undefined;
    const controller = new AbortController();
    const executor = windowsExecutor((executable, args, options) => {
      parentEnvironment = options.env;
      capture = cloneCapture(executable, args, options);
      return child;
    });

    const execution = executor.execute({
      command: windowsCommand(),
      credential: credentialSource(() => {
        reads += 1;
        return currentCredential;
      }),
      environment: {
        Path: "C:\\Windows\\System32",
        HOSTDECK_CODEX_REMOTE_AUTH: staleCredential,
        hostdeck_codex_remote_auth: staleCredential,
        SAFE_VALUE: "retained"
      },
      signal: controller.signal
    });

    expect(reads).toBe(1);
    expect(parentEnvironment?.[codexRemoteAuthEnvironmentVariable]).toBeUndefined();
    expect(capture).toEqual({
      executable: "C:\\HostDeck\\codex.exe",
      args: [
        "resume",
        "--remote",
        "ws://127.0.0.1:43871",
        "--remote-auth-token-env",
        codexRemoteAuthEnvironmentVariable,
        threadId
      ],
      options: {
        cwd: "C:\\work\\repo",
        env: {
          Path: "C:\\Windows\\System32",
          SAFE_VALUE: "retained",
          [codexRemoteAuthEnvironmentVariable]: currentCredential
        },
        shell: false,
        signal: controller.signal,
        stdio: "inherit",
        windowsHide: false
      }
    });
    expect(capture?.args).not.toContain(currentCredential);
    expect(JSON.stringify(windowsCommand())).not.toContain(currentCredential);

    child.emit("exit", 0, null);
    await expect(execution).resolves.toBeUndefined();
  });

  it("launches Linux without credentials and strips stale auth environment variants", async () => {
    let capture: SpawnCapture | undefined;
    const child = fakeChild();
    const controller = new AbortController();
    const executor = linuxExecutor((executable, args, options) => {
      capture = cloneCapture(executable, args, options);
      queueMicrotask(() => child.emit("exit", 0, null));
      return child;
    });

    await expect(
      executor.execute({
        command: linuxCommand(),
        environment: {
          PATH: "/usr/bin",
          HOSTDECK_CODEX_REMOTE_AUTH: staleCredential,
          hostdeck_codex_remote_auth: staleCredential
        },
        signal: controller.signal
      })
    ).resolves.toBeUndefined();

    expect(capture).toEqual({
      executable: "/opt/hostdeck/codex",
      args: [
        "resume",
        "--remote",
        "unix:///tmp/hostdeck/app.sock",
        threadId
      ],
      options: {
        cwd: "/work/repo",
        env: { PATH: "/usr/bin" },
        shell: false,
        signal: controller.signal,
        stdio: "inherit",
        windowsHide: false
      }
    });
  });

  it("fails stale or throwing Windows authority before spawn without leaking details", async () => {
    let spawnCalls = 0;
    const executor = windowsExecutor(() => {
      spawnCalls += 1;
      return fakeChild();
    });
    for (const read of [
      () => undefined,
      () => {
        throw new Error(`${currentCredential}-private-canary`);
      }
    ]) {
      const error = await captureResumeRejection(
        executor.execute({
          command: windowsCommand(),
          credential: credentialSource(read),
          environment: { SAFE_VALUE: "retained" },
          signal: new AbortController().signal
        })
      );
      expect(error).toMatchObject({
        code: "credential_unavailable",
        stage: "credential"
      });
      expect(`${error.name}:${error.message}:${JSON.stringify(error)}`).not.toContain(
        currentCredential
      );
    }
    expect(spawnCalls).toBe(0);
  });

  it("rejects invalid environment before consulting protected authority", async () => {
    let reads = 0;
    let accessorReads = 0;
    const accessorEnvironment = Object.create(null) as Record<string, string>;
    Object.defineProperty(accessorEnvironment, "PRIVATE", {
      enumerable: true,
      get() {
        accessorReads += 1;
        throw new Error(currentCredential);
      }
    });
    const invalidEnvironments = [
      { Path: "one", PATH: "two" },
      accessorEnvironment,
      { OVERSIZED: "A".repeat(32_767) },
      { CONTROL: "line\nbreak" },
      { "BAD\nKEY": "value" }
    ];
    const executor = windowsExecutor(() => {
      throw new Error("spawn must not run");
    });

    for (const environment of invalidEnvironments) {
      const error = await captureResumeRejection(
        executor.execute({
          command: windowsCommand(),
          credential: credentialSource(() => {
            reads += 1;
            return currentCredential;
          }),
          environment,
          signal: new AbortController().signal
        })
      );
      expect(error).toMatchObject({
        code: "invalid_config",
        stage: "configuration"
      });
      expect(JSON.stringify(error)).not.toContain(currentCredential);
    }
    expect(reads).toBe(0);
    expect(accessorReads).toBe(0);
  });

  it("rejects wrong native targets and pre-aborted execution before credentials or spawn", async () => {
    let reads = 0;
    let spawnCalls = 0;
    const wrongHost = createCodexPlatformTuiResumeExecutor({
      platform_port: () => "linux",
      architecture_port: () => "x64",
      spawn: () => {
        spawnCalls += 1;
        return fakeChild();
      }
    });
    const credential = credentialSource(() => {
      reads += 1;
      return currentCredential;
    });

    await expect(
      wrongHost.execute({
        command: windowsCommand(),
        credential,
        signal: new AbortController().signal
      })
    ).rejects.toMatchObject({ code: "unsupported_platform" });

    const controller = new AbortController();
    controller.abort();
    await expect(
      windowsExecutor(() => {
        spawnCalls += 1;
        return fakeChild();
      }).execute({
        command: windowsCommand(),
        credential,
        signal: controller.signal
      })
    ).rejects.toMatchObject({ code: "process_aborted" });
    expect(reads).toBe(0);
    expect(spawnCalls).toBe(0);
  });

  it("rejects malformed commands without invoking argument accessors or spawn", async () => {
    const command = linuxCommand();
    const accessorArgs = [...command.args];
    let reads = 0;
    Object.defineProperty(accessorArgs, "3", {
      enumerable: true,
      get() {
        reads += 1;
        throw new Error(currentCredential);
      }
    });
    let spawnCalls = 0;
    const executor = linuxExecutor(() => {
      spawnCalls += 1;
      return fakeChild();
    });

    const error = await captureResumeRejection(
      executor.execute({
        command: { ...command, args: accessorArgs } as never,
        signal: new AbortController().signal
      })
    );
    expect(error).toMatchObject({
      code: "invalid_config",
      stage: "configuration"
    });
    expect(reads).toBe(0);
    expect(spawnCalls).toBe(0);
    expect(JSON.stringify(error)).not.toContain(currentCredential);
  });

  it("maps synchronous and asynchronous process failures once without raw causes", async () => {
    const canary = "private-process-canary";
    const cases: readonly {
      readonly spawn: CodexPlatformTuiResumeSpawn;
      readonly code: string;
      readonly stage: string;
    }[] = [
      {
        spawn: () => {
          throw new Error(canary);
        },
        code: "process_start_failed",
        stage: "spawn"
      },
      {
        spawn: () => scheduledChild((child) => child.emit("error", new Error(canary))),
        code: "process_start_failed",
        stage: "spawn"
      },
      {
        spawn: () => scheduledChild((child) => child.emit("exit", 23, null)),
        code: "process_exited",
        stage: "execution"
      },
      {
        spawn: () => scheduledChild((child) => child.emit("exit", null, "SIGTERM")),
        code: "process_terminated",
        stage: "execution"
      },
      {
        spawn: () => scheduledChild((child) => child.emit("exit", null, null)),
        code: "process_contract_invalid",
        stage: "execution"
      },
      {
        spawn: () => scheduledChild((child) => child.emit("exit", -1, null)),
        code: "process_contract_invalid",
        stage: "execution"
      },
      {
        spawn: () => scheduledChild((child) => child.emit("close", 0, null)),
        code: "process_contract_invalid",
        stage: "execution"
      },
      {
        spawn: () => ({ once: 1 }) as never,
        code: "process_contract_invalid",
        stage: "execution"
      }
    ];

    for (const entry of cases) {
      let calls = 0;
      const executor = linuxExecutor((...args) => {
        calls += 1;
        return Reflect.apply(entry.spawn, undefined, args);
      });
      const error = await captureResumeRejection(
        executor.execute({
          command: linuxCommand(),
          signal: new AbortController().signal
        })
      );
      expect(error).toMatchObject({ code: entry.code, stage: entry.stage });
      expect(`${error.name}:${error.message}:${JSON.stringify(error)}`).not.toContain(
        canary
      );
      expect(calls).toBe(1);
    }
  });

  it("waits for an aborted child to exit before reporting cancellation", async () => {
    const child = fakeChild();
    const controller = new AbortController();
    let exited = false;
    const executor = linuxExecutor((_executable, _args, options) => {
      options.signal.addEventListener(
        "abort",
        () => {
          child.emit("error", new Error("abort-private-canary"));
          queueMicrotask(() => {
            exited = true;
            child.emit("close", null, "SIGTERM");
          });
        },
        { once: true }
      );
      return child;
    });

    const execution = executor.execute({
      command: linuxCommand(),
      signal: controller.signal
    });
    controller.abort();
    const error = await captureResumeRejection(execution);

    expect(exited).toBe(true);
    expect(error).toMatchObject({
      code: "process_aborted",
      stage: "execution"
    });
    expect(JSON.stringify(error)).not.toContain("abort-private-canary");
  });

  it("rejects invalid executor configuration with the stable module error", () => {
    for (const candidate of [
      null,
      { spawn: true },
      { platform_port: "linux" },
      { architecture_port: 64 },
      { extra: true }
    ]) {
      expect(() => createCodexPlatformTuiResumeExecutor(candidate as never)).toThrow(
        expect.objectContaining({
          code: "invalid_config",
          stage: "configuration"
        })
      );
    }
  });
});

function linuxCommand(cwd = "/work/repo"): CodexPlatformTuiResumeCommand {
  return buildCodexPlatformTuiResumeCommand({
    target: "linux-x64",
    endpoint: createCodexUnixSocketEndpoint("/tmp/hostdeck/app.sock"),
    thread_id: threadId,
    codex_bin: "/opt/hostdeck/codex",
    cwd
  });
}

function windowsCommand(cwd = "C:\\work\\repo"): CodexPlatformTuiResumeCommand {
  return buildCodexPlatformTuiResumeCommand({
    target: "windows-x64",
    endpoint: windowsEndpoint,
    thread_id: threadId,
    codex_bin: "C:\\HostDeck\\codex.exe",
    cwd
  });
}

function windowsExecutor(spawn: CodexPlatformTuiResumeSpawn): CodexPlatformTuiResumeExecutor {
  return createCodexPlatformTuiResumeExecutor({
    spawn,
    platform_port: () => "win32",
    architecture_port: () => "x64"
  });
}

function linuxExecutor(spawn: CodexPlatformTuiResumeSpawn): CodexPlatformTuiResumeExecutor {
  return createCodexPlatformTuiResumeExecutor({
    spawn,
    platform_port: () => "linux",
    architecture_port: () => "x64"
  });
}

function credentialSource(read: () => string | undefined) {
  return {
    kind: "protected_environment" as const,
    environment_variable: codexRemoteAuthEnvironmentVariable,
    read
  };
}

function fakeChild(): EventEmitter & CodexPlatformTuiResumeChildProcess {
  return new EventEmitter() as EventEmitter & CodexPlatformTuiResumeChildProcess;
}

function scheduledChild(
  event: (child: EventEmitter & CodexPlatformTuiResumeChildProcess) => void
): EventEmitter & CodexPlatformTuiResumeChildProcess {
  const child = fakeChild();
  queueMicrotask(() => event(child));
  return child;
}

interface SpawnCapture {
  readonly executable: string;
  readonly args: readonly string[];
  readonly options: CodexPlatformTuiResumeSpawnOptions;
}

function cloneCapture(
  executable: string,
  args: readonly string[],
  options: CodexPlatformTuiResumeSpawnOptions
): SpawnCapture {
  return {
    executable,
    args: [...args],
    options: {
      ...options,
      env: { ...options.env }
    }
  };
}

function captureResumeError(work: () => unknown): HostDeckCodexPlatformTuiResumeError {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(HostDeckCodexPlatformTuiResumeError);
    return error as HostDeckCodexPlatformTuiResumeError;
  }
  throw new Error("Expected platform TUI resume error.");
}

async function captureResumeRejection(
  work: Promise<void>
): Promise<HostDeckCodexPlatformTuiResumeError> {
  try {
    await work;
  } catch (error) {
    expect(error).toBeInstanceOf(HostDeckCodexPlatformTuiResumeError);
    return error as HostDeckCodexPlatformTuiResumeError;
  }
  throw new Error("Expected platform TUI resume rejection.");
}
