import { defaultResourceBudget } from "@hostdeck/contracts";
import { createOperationDeadline } from "@hostdeck/core";
import { describe, expect, it } from "vitest";
import {
  type CodexRuntimeChildProcess,
  type CodexRuntimeProcessExit,
  type CodexRuntimeProcessPort,
  type CodexRuntimeProcessRequest,
  type CodexRuntimeSocketObservation,
  type CodexRuntimeSocketPort,
  type CodexRuntimeSupervisorClock,
  createCodexRuntimeSupervisor,
  type HostDeckCodexRuntimeSupervisorError
} from "./codex-runtime-supervisor.js";

const socketPath = "/run/user/1000/hostdeck/app-server.sock";
const codexBin = "/opt/hostdeck/codex";

describe("Codex runtime supervisor", () => {
  it("strictly validates mode-specific construction without invoking accessors", () => {
    expect(() =>
      createCodexRuntimeSupervisor({
        mode: "foreground_child",
        codex_bin: "codex",
        socket_path: socketPath
      })
    ).toThrow(TypeError);
    expect(() =>
      createCodexRuntimeSupervisor({
        mode: "foreground_child",
        codex_bin: codexBin,
        socket_path: "/run/user/1000/hostdeck/other.sock"
      })
    ).toThrow(TypeError);
    expect(() =>
      createCodexRuntimeSupervisor({
        mode: "foreground_child",
        codex_bin: codexBin,
        socket_path: "/run/user/1000/hostdeck/../hostdeck/app-server.sock"
      })
    ).toThrow(TypeError);
    expect(() =>
      createCodexRuntimeSupervisor({
        mode: "service_owned",
        socket_path: socketPath,
        codex_bin: codexBin
      } as never)
    ).toThrow(TypeError);
    expect(() =>
      createCodexRuntimeSupervisor({
        mode: "service_owned",
        socket_path: socketPath,
        process_port: fakeProcess().port
      } as never)
    ).toThrow(TypeError);

    let accessed = false;
    const hostile = Object.defineProperty(
      { mode: "service_owned", socket_path: socketPath },
      "clock",
      {
        enumerable: true,
        get() {
          accessed = true;
          return immediateClock();
        }
      }
    );
    expect(() => createCodexRuntimeSupervisor(hostile as never)).toThrow(
      TypeError
    );
    expect(accessed).toBe(false);
  });

  it("starts one fixed Unix-only foreground child and closes only that child", async () => {
    const socket = fakeSocket("missing");
    const process = fakeProcess({
      onSpawn() {
        socket.setSocket("owned-socket", true);
      },
      exitOn: "SIGTERM"
    });
    const supervisor = createCodexRuntimeSupervisor({
      mode: "foreground_child",
      codex_bin: codexBin,
      socket_path: socketPath,
      process_port: process.port,
      socket_port: socket.port,
      clock: immediateClock()
    });
    const startDeadline = createOperationDeadline({ timeoutMs: 1_000 });
    const started = await supervisor.start({
      deadline: startDeadline,
      resourceBudget: defaultResourceBudget
    });
    startDeadline.dispose();

    expect(process.requests).toEqual([
      {
        executable: codexBin,
        args: ["app-server", "--listen", `unix://${socketPath}`],
        cwd: "/"
      }
    ]);
    expect(Object.isFrozen(process.requests[0]?.args)).toBe(true);
    expect(socket.inspectionRepairModes.every((value) => value)).toBe(true);
    expect(started).toMatchObject({
      mode: "foreground_child",
      ownership: "foreground_child",
      socket_path: socketPath,
      socket_mode_repaired: true,
      stale_socket_removed: false
    });
    expect(started.process_exit).not.toBeNull();
    expect(supervisor.snapshot()).toMatchObject({
      phase: "ready",
      claim_held: true,
      socket_ready: true,
      process_state: "running",
      spawn_attempts: 1,
      term_signals: 0,
      kill_signals: 0
    });
    const serialized = JSON.stringify(supervisor.snapshot());
    expect(serialized).not.toContain(socketPath);
    expect(serialized).not.toContain(codexBin);
    expect(serialized).not.toContain("pid");

    const closeDeadline = createOperationDeadline({ timeoutMs: 1_000 });
    await supervisor.close({ deadline: closeDeadline });
    closeDeadline.dispose();
    await expect(started.process_exit).resolves.toEqual({
      kind: "signaled",
      expected: true,
      code: null,
      signal: "SIGTERM"
    });
    expect(process.signals).toEqual(["SIGTERM"]);
    expect(socket.removeCalls).toEqual(["owned-socket"]);
    expect(supervisor.snapshot()).toMatchObject({
      phase: "closed",
      claim_held: false,
      socket_ready: false,
      process_state: "exited",
      term_signals: 1,
      kill_signals: 0,
      cleanup_failures: 0
    });
  });

  it("waits for a service sibling and never gains process or socket ownership", async () => {
    const socket = fakeSocket("missing");
    const clock = immediateClock(() => socket.setSocket("service-socket"));
    const supervisor = createCodexRuntimeSupervisor({
      mode: "service_owned",
      socket_path: socketPath,
      socket_port: socket.port,
      clock
    });
    const startDeadline = createOperationDeadline({ timeoutMs: 1_000 });
    const started = await supervisor.start({
      deadline: startDeadline,
      resourceBudget: defaultResourceBudget
    });
    startDeadline.dispose();

    expect(started).toMatchObject({
      mode: "service_owned",
      ownership: "service_owned",
      process_exit: null,
      stale_socket_removed: false
    });
    expect(socket.inspectionRepairModes).not.toHaveLength(0);
    expect(socket.inspectionRepairModes.every((value) => !value)).toBe(true);
    expect(supervisor.snapshot()).toMatchObject({
      phase: "ready",
      process_state: "not_applicable",
      spawn_attempts: 0,
      term_signals: 0,
      kill_signals: 0,
      startup_retries: 1
    });

    const closeDeadline = createOperationDeadline({ timeoutMs: 1_000 });
    const firstClose = supervisor.close({ deadline: closeDeadline });
    const secondClose = supervisor.close({ deadline: closeDeadline });
    expect(secondClose).toBe(firstClose);
    await firstClose;
    closeDeadline.dispose();
    expect(socket.removeCalls).toEqual([]);
    expect(socket.current()).toMatchObject({
      state: "socket",
      identity: "service-socket"
    });
    expect(supervisor.snapshot()).toMatchObject({
      phase: "closed",
      claim_held: false,
      term_signals: 0,
      kill_signals: 0
    });
  });

  it("rejects an active foreground socket without spawning or removing it", async () => {
    const socket = fakeSocket("socket");
    const process = fakeProcess();
    const supervisor = createCodexRuntimeSupervisor({
      mode: "foreground_child",
      codex_bin: codexBin,
      socket_path: socketPath,
      process_port: process.port,
      socket_port: socket.port,
      clock: immediateClock()
    });
    await expectStartError(supervisor, "socket_active");
    expect(process.requests).toEqual([]);
    expect(process.signals).toEqual([]);
    expect(socket.removeCalls).toEqual([]);
    expect(supervisor.snapshot()).toMatchObject({
      phase: "failed",
      claim_held: false,
      spawn_attempts: 0
    });
  });

  it("removes only a refused stale foreground socket before spawning", async () => {
    const socket = fakeSocket("socket", { probe: "refused" });
    const staleIdentity = socket.identity();
    const process = fakeProcess({
      onSpawn() {
        socket.setSocket("fresh-owned-socket");
        socket.setProbe("ready");
      },
      exitOn: "SIGTERM"
    });
    const supervisor = createCodexRuntimeSupervisor({
      mode: "foreground_child",
      codex_bin: codexBin,
      socket_path: socketPath,
      process_port: process.port,
      socket_port: socket.port,
      clock: immediateClock()
    });
    const startDeadline = createOperationDeadline({ timeoutMs: 1_000 });
    const started = await supervisor.start({
      deadline: startDeadline,
      resourceBudget: defaultResourceBudget
    });
    startDeadline.dispose();
    expect(started.stale_socket_removed).toBe(true);
    expect(socket.removeCalls).toEqual([staleIdentity]);

    const closeDeadline = createOperationDeadline({ timeoutMs: 1_000 });
    await supervisor.close({ deadline: closeDeadline });
    closeDeadline.dispose();
    expect(socket.removeCalls).toEqual([
      staleIdentity,
      "fresh-owned-socket"
    ]);
  });

  it("rejects a duplicate process-wide socket claim and releases it after close", async () => {
    const socket = fakeSocket("socket");
    const first = createCodexRuntimeSupervisor({
      mode: "service_owned",
      socket_path: socketPath,
      socket_port: socket.port,
      clock: immediateClock()
    });
    const secondSocket = fakeSocket("socket");
    const second = createCodexRuntimeSupervisor({
      mode: "service_owned",
      socket_path: socketPath,
      socket_port: secondSocket.port,
      clock: immediateClock()
    });
    const firstDeadline = createOperationDeadline({ timeoutMs: 1_000 });
    await first.start({
      deadline: firstDeadline,
      resourceBudget: defaultResourceBudget
    });
    firstDeadline.dispose();
    await expectStartError(second, "duplicate_supervisor");
    expect(secondSocket.inspectCalls).toBe(0);

    const closeDeadline = createOperationDeadline({ timeoutMs: 1_000 });
    await first.close({ deadline: closeDeadline });
    closeDeadline.dispose();

    const third = createCodexRuntimeSupervisor({
      mode: "service_owned",
      socket_path: socketPath,
      socket_port: secondSocket.port,
      clock: immediateClock()
    });
    const thirdDeadline = createOperationDeadline({ timeoutMs: 1_000 });
    await third.start({
      deadline: thirdDeadline,
      resourceBudget: defaultResourceBudget
    });
    thirdDeadline.dispose();
    const thirdCloseDeadline = createOperationDeadline({ timeoutMs: 1_000 });
    await third.close({ deadline: thirdCloseDeadline });
    thirdCloseDeadline.dispose();
  });

  it.each([
    ["missing_binary", "binary_missing"],
    ["not_executable", "binary_not_executable"],
    ["failed", "process_start_failed"]
  ] as const)(
    "maps %s spawn failure without retaining a child or claim",
    async (spawnFailure, expectedCode) => {
      const socket = fakeSocket("missing");
      const process = fakeProcess({ spawnFailure });
      const supervisor = createCodexRuntimeSupervisor({
        mode: "foreground_child",
        codex_bin: codexBin,
        socket_path: uniqueSocketPath(spawnFailure),
        process_port: process.port,
        socket_port: socket.port,
        clock: immediateClock()
      });
      await expectStartError(supervisor, expectedCode);
      expect(supervisor.snapshot()).toMatchObject({
        phase: "failed",
        claim_held: false,
        process_state: "exited",
        spawn_attempts: 1
      });
    }
  );

  it("reports child exit before and after readiness without restarting", async () => {
    const earlySocket = fakeSocket("missing");
    const earlyProcess = fakeProcess({ exitImmediately: 23 });
    const early = createCodexRuntimeSupervisor({
      mode: "foreground_child",
      codex_bin: codexBin,
      socket_path: uniqueSocketPath("early"),
      process_port: earlyProcess.port,
      socket_port: earlySocket.port,
      clock: immediateClock()
    });
    await expectStartError(early, "process_exited");
    expect(earlyProcess.requests).toHaveLength(1);

    const socket = fakeSocket("missing");
    const process = fakeProcess({
      onSpawn() {
        socket.setSocket("exit-after-ready");
      }
    });
    const supervisor = createCodexRuntimeSupervisor({
      mode: "foreground_child",
      codex_bin: codexBin,
      socket_path: uniqueSocketPath("later"),
      process_port: process.port,
      socket_port: socket.port,
      clock: immediateClock()
    });
    const startDeadline = createOperationDeadline({ timeoutMs: 1_000 });
    const started = await supervisor.start({
      deadline: startDeadline,
      resourceBudget: defaultResourceBudget
    });
    startDeadline.dispose();
    process.exitNow({
      kind: "exited",
      code: 7,
      signal: null,
      spawn_failure: null
    });
    await expect(started.process_exit).resolves.toEqual({
      kind: "exited",
      expected: false,
      code: 7,
      signal: null
    });
    expect(supervisor.snapshot()).toMatchObject({
      phase: "exited",
      socket_ready: false,
      spawn_attempts: 1,
      process_state: "exited"
    });
    expect(process.requests).toHaveLength(1);

    const closeDeadline = createOperationDeadline({ timeoutMs: 1_000 });
    await supervisor.close({ deadline: closeDeadline });
    closeDeadline.dispose();
  });

  it("times out and aborts service readiness without touching the socket", async () => {
    const timeoutSocket = fakeSocket("missing");
    const timed = createCodexRuntimeSupervisor({
      mode: "service_owned",
      socket_path: uniqueSocketPath("timeout"),
      socket_port: timeoutSocket.port
    });
    const timeoutDeadline = createOperationDeadline({ timeoutMs: 30 });
    await expect(
      timed.start({
        deadline: timeoutDeadline,
        resourceBudget: defaultResourceBudget
      })
    ).rejects.toMatchObject({ code: "startup_timeout" });
    timeoutDeadline.dispose();
    expect(timeoutSocket.removeCalls).toEqual([]);
    expect(timed.snapshot().claim_held).toBe(false);

    const abortSocket = fakeSocket("missing");
    const aborted = createCodexRuntimeSupervisor({
      mode: "service_owned",
      socket_path: uniqueSocketPath("abort"),
      socket_port: abortSocket.port
    });
    const controller = new AbortController();
    const abortDeadline = createOperationDeadline({
      timeoutMs: 1_000,
      parentSignal: controller.signal
    });
    const starting = aborted.start({
      deadline: abortDeadline,
      resourceBudget: defaultResourceBudget
    });
    controller.abort(new Error("test abort"));
    await expect(starting).rejects.toMatchObject({ code: "startup_aborted" });
    abortDeadline.dispose();
    expect(abortSocket.removeCalls).toEqual([]);
    expect(aborted.snapshot().claim_held).toBe(false);
  });

  it("allows close during startup and releases the claim without service mutation", async () => {
    const socket = fakeSocket("missing");
    const supervisor = createCodexRuntimeSupervisor({
      mode: "service_owned",
      socket_path: uniqueSocketPath("close-during-start"),
      socket_port: socket.port
    });
    const startDeadline = createOperationDeadline({ timeoutMs: 1_000 });
    const starting = supervisor.start({
      deadline: startDeadline,
      resourceBudget: defaultResourceBudget
    });
    const closeDeadline = createOperationDeadline({ timeoutMs: 1_000 });
    await supervisor.close({ deadline: closeDeadline });
    await expect(starting).rejects.toMatchObject({ code: "startup_closed" });
    startDeadline.dispose();
    closeDeadline.dispose();
    expect(socket.removeCalls).toEqual([]);
    expect(supervisor.snapshot()).toMatchObject({
      phase: "closed",
      claim_held: false,
      process_state: "not_applicable"
    });
  });

  it("escalates an owned child from TERM to KILL within one close", async () => {
    const socket = fakeSocket("missing");
    const process = fakeProcess({
      onSpawn() {
        socket.setSocket("kill-owned");
      },
      exitOn: "SIGKILL"
    });
    const supervisor = createCodexRuntimeSupervisor({
      mode: "foreground_child",
      codex_bin: codexBin,
      socket_path: uniqueSocketPath("escalate"),
      process_port: process.port,
      socket_port: socket.port,
      clock: immediateClock()
    });
    const startDeadline = createOperationDeadline({ timeoutMs: 1_000 });
    await supervisor.start({
      deadline: startDeadline,
      resourceBudget: defaultResourceBudget
    });
    startDeadline.dispose();
    const closeDeadline = createOperationDeadline({ timeoutMs: 1_000 });
    await supervisor.close({ deadline: closeDeadline });
    closeDeadline.dispose();
    expect(process.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(supervisor.snapshot()).toMatchObject({
      phase: "closed",
      term_signals: 1,
      kill_signals: 1,
      cleanup_failures: 0
    });
  });

  it("does not unlink a running child on expired close and finishes cleanup after late reap", async () => {
    const socket = fakeSocket("missing");
    const process = fakeProcess({
      onSpawn() {
        socket.setSocket("late-reap-owned");
      }
    });
    const supervisor = createCodexRuntimeSupervisor({
      mode: "foreground_child",
      codex_bin: codexBin,
      socket_path: uniqueSocketPath("late-reap"),
      process_port: process.port,
      socket_port: socket.port,
      clock: immediateClock()
    });
    const startDeadline = createOperationDeadline({ timeoutMs: 1_000 });
    const started = await supervisor.start({
      deadline: startDeadline,
      resourceBudget: defaultResourceBudget
    });
    startDeadline.dispose();

    const controller = new AbortController();
    controller.abort(new Error("shutdown already expired"));
    const closeDeadline = createOperationDeadline({
      timeoutMs: 1_000,
      parentSignal: controller.signal
    });
    await expect(supervisor.close({ deadline: closeDeadline })).rejects.toMatchObject({
      code: "shutdown_timeout"
    });
    closeDeadline.dispose();
    expect(process.signals).toEqual(["SIGKILL"]);
    expect(socket.removeCalls).toEqual([]);
    expect(supervisor.snapshot()).toMatchObject({
      phase: "failed",
      claim_held: true,
      socket_ready: false
    });

    process.exitNow({
      kind: "signaled",
      code: null,
      signal: "SIGKILL",
      spawn_failure: null
    });
    await expect(started.process_exit).resolves.toMatchObject({
      expected: true,
      kind: "signaled",
      signal: "SIGKILL"
    });
    await eventually(() => supervisor.snapshot().claim_held === false);
    expect(socket.removeCalls).toEqual(["late-reap-owned"]);
    expect(supervisor.snapshot()).toMatchObject({
      phase: "failed",
      claim_held: false,
      process_state: "exited"
    });
  });

  it("preserves refused service state through timeout and rejects socket replacement on cleanup", async () => {
    const staleServiceSocket = fakeSocket("socket", { probe: "refused" });
    const service = createCodexRuntimeSupervisor({
      mode: "service_owned",
      socket_path: uniqueSocketPath("service-stale"),
      socket_port: staleServiceSocket.port
    });
    const serviceDeadline = createOperationDeadline({ timeoutMs: 30 });
    await expect(
      service.start({
        deadline: serviceDeadline,
        resourceBudget: defaultResourceBudget
      })
    ).rejects.toMatchObject({ code: "startup_timeout" });
    serviceDeadline.dispose();
    expect(staleServiceSocket.removeCalls).toEqual([]);
    expect(staleServiceSocket.current().state).toBe("socket");

    const socket = fakeSocket("missing");
    const process = fakeProcess({
      onSpawn() {
        socket.setSocket("original-owned");
      },
      exitOn: "SIGTERM"
    });
    const foreground = createCodexRuntimeSupervisor({
      mode: "foreground_child",
      codex_bin: codexBin,
      socket_path: uniqueSocketPath("replacement"),
      process_port: process.port,
      socket_port: socket.port,
      clock: immediateClock()
    });
    const startDeadline = createOperationDeadline({ timeoutMs: 1_000 });
    await foreground.start({
      deadline: startDeadline,
      resourceBudget: defaultResourceBudget
    });
    startDeadline.dispose();
    socket.setSocket("replacement-socket");
    const closeDeadline = createOperationDeadline({ timeoutMs: 1_000 });
    await expect(foreground.close({ deadline: closeDeadline })).rejects.toMatchObject({
      code: "shutdown_failed"
    });
    closeDeadline.dispose();
    expect(socket.removeCalls).toEqual(["original-owned"]);
    expect(socket.current()).toMatchObject({
      state: "socket",
      identity: "replacement-socket"
    });
    expect(foreground.snapshot().claim_held).toBe(true);
  });

  it("rejects a startup deadline larger than the resolved budget before any port call", async () => {
    const socket = fakeSocket("socket");
    const supervisor = createCodexRuntimeSupervisor({
      mode: "service_owned",
      socket_path: uniqueSocketPath("oversized-deadline"),
      socket_port: socket.port
    });
    const deadline = createOperationDeadline({
      timeoutMs: defaultResourceBudget.lifecycle_startup_timeout_ms + 1
    });
    await expect(
      supervisor.start({
        deadline,
        resourceBudget: defaultResourceBudget
      })
    ).rejects.toMatchObject({ code: "invalid_config" });
    deadline.dispose();
    expect(socket.inspectCalls).toBe(0);
    expect(supervisor.snapshot()).toMatchObject({
      phase: "idle",
      claim_held: false
    });
  });

  it("fails loudly for malformed process, socket, and clock port contracts", async () => {
    const malformedSocket = createCodexRuntimeSupervisor({
      mode: "service_owned",
      socket_path: uniqueSocketPath("bad-socket"),
      socket_port: {
        inspect: () => ({
          state: "socket",
          identity: "identity",
          mode_repaired: "yes"
        }) as never,
        probe: () => "ready",
        remove: () => "removed"
      },
      clock: immediateClock()
    });
    await expectStartError(malformedSocket, "port_contract_invalid");

    const socket = fakeSocket("missing");
    const malformedProcess = createCodexRuntimeSupervisor({
      mode: "foreground_child",
      codex_bin: codexBin,
      socket_path: uniqueSocketPath("bad-process"),
      process_port: {
        spawn: () => ({ exit: Promise.resolve(null) }) as never
      },
      socket_port: socket.port,
      clock: immediateClock()
    });
    await expectStartError(malformedProcess, "port_contract_invalid");

    const malformedExitSocket = fakeSocket("missing");
    let malformedExitRunning = true;
    const malformedExit = createCodexRuntimeSupervisor({
      mode: "foreground_child",
      codex_bin: codexBin,
      socket_path: uniqueSocketPath("bad-exit"),
      process_port: {
        spawn: () => {
          malformedExitSocket.setSocket("bad-exit-owned");
          return {
            exit: Promise.resolve({ kind: "not-an-exit" } as never),
            isRunning: () => malformedExitRunning,
            signal: () => {
              malformedExitRunning = false;
              return true;
            }
          };
        }
      },
      socket_port: malformedExitSocket.port,
      clock: immediateClock()
    });
    await expectStartError(malformedExit, "port_contract_invalid");
    expect(malformedExitSocket.removeCalls).toEqual(["bad-exit-owned"]);

    const waitingSocket = fakeSocket("missing");
    const malformedClock = createCodexRuntimeSupervisor({
      mode: "service_owned",
      socket_path: uniqueSocketPath("bad-clock"),
      socket_port: waitingSocket.port,
      clock: { sleep: () => undefined as never }
    });
    await expectStartError(malformedClock, "port_contract_invalid");
  });

  it("rejects repeated start and start after close without side effects", async () => {
    const socket = fakeSocket("socket");
    const supervisor = createCodexRuntimeSupervisor({
      mode: "service_owned",
      socket_path: uniqueSocketPath("one-shot"),
      socket_port: socket.port,
      clock: immediateClock()
    });
    const startDeadline = createOperationDeadline({ timeoutMs: 1_000 });
    await supervisor.start({
      deadline: startDeadline,
      resourceBudget: defaultResourceBudget
    });
    await expect(
      supervisor.start({
        deadline: startDeadline,
        resourceBudget: defaultResourceBudget
      })
    ).rejects.toMatchObject({ code: "lifecycle_conflict" });
    startDeadline.dispose();
    const closeDeadline = createOperationDeadline({ timeoutMs: 1_000 });
    await supervisor.close({ deadline: closeDeadline });
    await expect(
      supervisor.start({
        deadline: closeDeadline,
        resourceBudget: defaultResourceBudget
      })
    ).rejects.toMatchObject({ code: "lifecycle_conflict" });
    closeDeadline.dispose();
    expect(socket.removeCalls).toEqual([]);
  });
});

async function expectStartError(
  supervisor: ReturnType<typeof createCodexRuntimeSupervisor>,
  code: HostDeckCodexRuntimeSupervisorError["code"]
): Promise<void> {
  const deadline = createOperationDeadline({ timeoutMs: 1_000 });
  try {
    await expect(
      supervisor.start({
        deadline,
        resourceBudget: defaultResourceBudget
      })
    ).rejects.toMatchObject({
      name: "HostDeckCodexRuntimeSupervisorError",
      code
    });
  } finally {
    deadline.dispose();
  }
}

function uniqueSocketPath(label: string): string {
  return `/run/user/1000/hostdeck-${label}/app-server.sock`;
}

function immediateClock(
  onSleep?: () => void
): CodexRuntimeSupervisorClock {
  return {
    async sleep(_milliseconds, signal) {
      if (signal.aborted) throw signal.reason;
      onSleep?.();
      await Promise.resolve();
      if (signal.aborted) throw signal.reason;
    }
  };
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("Expected asynchronous supervisor cleanup to settle.");
}

function fakeSocket(
  initial: "missing" | "socket",
  options: { readonly probe?: "ready" | "refused" | "missing" } = {}
): {
  readonly port: CodexRuntimeSocketPort;
  readonly removeCalls: string[];
  readonly inspectCalls: number;
  readonly inspectionRepairModes: readonly boolean[];
  readonly current: () => CodexRuntimeSocketObservation;
  readonly identity: () => string;
  readonly setProbe: (probe: "ready" | "refused" | "missing") => void;
  readonly setSocket: (identity: string, repaired?: boolean) => void;
} {
  let observation: CodexRuntimeSocketObservation =
    initial === "missing"
      ? Object.freeze({ state: "missing" })
      : Object.freeze({
          state: "socket",
          identity: "socket-identity",
          mode_repaired: false
        });
  let probe = options.probe ?? "ready";
  let inspectCalls = 0;
  const inspectionRepairModes: boolean[] = [];
  const removeCalls: string[] = [];
  const port: CodexRuntimeSocketPort = {
    inspect(_path, policy) {
      inspectCalls += 1;
      inspectionRepairModes.push(policy.repair_mode);
      return observation;
    },
    probe() {
      return observation.state === "missing" ? "missing" : probe;
    },
    remove(_path, identity) {
      removeCalls.push(identity);
      if (observation.state === "missing") return "missing";
      if (observation.identity !== identity) {
        throw new Error("fake socket identity mismatch");
      }
      observation = Object.freeze({ state: "missing" });
      return "removed";
    }
  };
  return {
    port,
    removeCalls,
    get inspectCalls() {
      return inspectCalls;
    },
    inspectionRepairModes,
    current: () => observation,
    identity: () =>
      observation.state === "socket" ? observation.identity : "missing",
    setProbe(value) {
      probe = value;
    },
    setSocket(identity, repaired = false) {
      observation = Object.freeze({
        state: "socket",
        identity,
        mode_repaired: repaired
      });
    }
  };
}

function fakeProcess(
  options: {
    readonly exitImmediately?: number;
    readonly exitOn?: "SIGTERM" | "SIGKILL";
    readonly onSpawn?: (request: CodexRuntimeProcessRequest) => void;
    readonly spawnFailure?: NonNullable<
      CodexRuntimeProcessExit["spawn_failure"]
    >;
  } = {}
): {
  readonly port: CodexRuntimeProcessPort;
  readonly requests: CodexRuntimeProcessRequest[];
  readonly signals: string[];
  readonly exitNow: (exit: CodexRuntimeProcessExit) => void;
} {
  const requests: CodexRuntimeProcessRequest[] = [];
  const signals: string[] = [];
  let resolveExit: (exit: CodexRuntimeProcessExit) => void = () => undefined;
  let running = false;
  let settled = false;
  const exit = new Promise<CodexRuntimeProcessExit>((resolve) => {
    resolveExit = resolve;
  });
  const exitNow = (result: CodexRuntimeProcessExit) => {
    if (settled) return;
    settled = true;
    running = false;
    resolveExit(Object.freeze({ ...result }));
  };
  const child: CodexRuntimeChildProcess = {
    exit,
    isRunning: () => running,
    signal(signal) {
      signals.push(signal);
      if (options.exitOn === signal) {
        exitNow({
          kind: "signaled",
          code: null,
          signal,
          spawn_failure: null
        });
      }
      return running;
    }
  };
  const port: CodexRuntimeProcessPort = {
    spawn(request) {
      requests.push(request);
      running = true;
      options.onSpawn?.(request);
      if (options.spawnFailure !== undefined) {
        exitNow({
          kind: "spawn_failed",
          code: null,
          signal: null,
          spawn_failure: options.spawnFailure
        });
      } else if (options.exitImmediately !== undefined) {
        exitNow({
          kind: "exited",
          code: options.exitImmediately,
          signal: null,
          spawn_failure: null
        });
      }
      return child;
    }
  };
  return { port, requests, signals, exitNow };
}
