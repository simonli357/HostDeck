import { defaultResourceBudget } from "@hostdeck/contracts";
import { createOperationDeadline } from "@hostdeck/core";
import { describe, expect, it } from "vitest";
import {
  buildCodexWindowsRuntimeEnvironment,
  type CodexWindowsRuntimeAuthority,
  type CodexWindowsRuntimeAuthorityPort,
  type CodexWindowsRuntimeChildProcess,
  type CodexWindowsRuntimeProcessExit,
  type CodexWindowsRuntimeProcessPort,
  type CodexWindowsRuntimeProcessRequest,
  type CodexWindowsRuntimeReadinessInput,
  type CodexWindowsRuntimeReadinessPort,
  createCodexWindowsRuntimeSupervisor,
  HostDeckCodexWindowsRuntimeSupervisorError
} from "./codex-windows-runtime-supervisor.js";

const runtimeDirectory = "C:\\Users\\selected\\AppData\\Local\\HostDeck\\Runtime";
const endpointFilePath = `${runtimeDirectory}\\app-server.endpoint`;
const credentialFilePath = `${runtimeDirectory}\\app-server.credential`;
const codexBin = "C:\\Program Files\\Codex\\codex.exe";
const tokenA = "A".repeat(64);
const tokenB = "B".repeat(64);
const tokenC = "C".repeat(64);

describe("Codex Windows runtime supervisor", () => {
  it("starts one exact child and admits readiness only after authenticated upgrade", async () => {
    const harness = createHarness({
      credentials: [tokenA],
      endpoints: [endpoint(31_001)],
      staleCredential: true
    });
    const supervisor = harness.supervisor();
    const started = await start(supervisor);

    expect(harness.requests).toHaveLength(1);
    expect(harness.requests[0]).toEqual({
      executable: codexBin,
      args: [
        "app-server",
        "--strict-config",
        "--listen",
        "ws://127.0.0.1:0",
        "--ws-auth",
        "capability-token",
        "--ws-token-file",
        credentialFilePath
      ],
      cwd: runtimeDirectory,
      environment: {
        CODEX_HOME: "C:\\Users\\selected\\.codex",
        NO_COLOR: "1",
        PATH: "C:\\Windows\\System32",
        SYSTEMROOT: "C:\\Windows"
      }
    });
    expect(harness.authenticatedTokens).toEqual([tokenA]);
    expect(harness.authority.staged).toEqual([tokenA]);
    expect(harness.authority.discards).toBe(1);
    expect(started).toMatchObject({
      target: "windows-x64",
      ownership: "owned_child",
      generation: 1,
      endpoint: endpoint(31_001),
      credential_file_removed: true
    });
    expect(started.credential.read("HOSTDECK_CODEX_REMOTE_AUTH")).toBe(tokenA);
    expect(supervisor.snapshot()).toEqual({
      target: "windows-x64",
      phase: "ready",
      ownership: "owned_child",
      claim_held: true,
      endpoint_ready: true,
      credential_file_present: false,
      generation: 1,
      process_state: "running",
      process_exit: null,
      spawn_attempts: 1,
      restart_attempts: 0,
      tree_terminations: 0,
      stale_credential_replacements: 1,
      cleanup_failures: 0
    });
    const serialized = JSON.stringify({ started, snapshot: supervisor.snapshot() });
    expect(serialized).not.toContain(tokenA);
    expect(serialized).not.toContain(credentialFilePath);

    await close(supervisor);
    expect(started.credential.read("HOSTDECK_CODEX_REMOTE_AUTH")).toBeUndefined();
    expect(harness.authority.releases).toBe(1);
    expect(harness.children[0]?.terminateCalls).toBe(1);
    await expect(started.process_exit).resolves.toEqual({
      kind: "terminated",
      expected: true,
      code: null
    });
  });

  it("rotates token and port across restart and retries a reused ephemeral port", async () => {
    const harness = createHarness({
      credentials: [tokenA, tokenB, tokenC],
      endpoints: [endpoint(31_001), endpoint(31_001), endpoint(31_002)]
    });
    const supervisor = harness.supervisor();
    const first = await start(supervisor);
    const second = await restart(supervisor);

    expect(first.generation).toBe(1);
    expect(second.generation).toBe(2);
    expect(second.endpoint.address).toBe("ws://127.0.0.1:31002");
    expect(first.credential.read("HOSTDECK_CODEX_REMOTE_AUTH")).toBeUndefined();
    expect(second.credential.read("HOSTDECK_CODEX_REMOTE_AUTH")).toBe(tokenC);
    expect(harness.authenticatedTokens).toEqual([tokenA, tokenC]);
    expect(harness.authority.staged).toEqual([tokenA, tokenB, tokenC]);
    expect(harness.children.map((child) => child.terminateCalls)).toEqual([1, 1, 0]);
    expect(supervisor.snapshot()).toMatchObject({
      phase: "ready",
      generation: 2,
      spawn_attempts: 3,
      restart_attempts: 1,
      tree_terminations: 2
    });

    await close(supervisor);
  });

  it("invalidates authority on an unexpected child crash and can restart under the held claim", async () => {
    const harness = createHarness({
      credentials: [tokenA, tokenB],
      endpoints: [endpoint(31_001), endpoint(31_002)]
    });
    const supervisor = harness.supervisor();
    const first = await start(supervisor);
    harness.children[0]?.crash(23);

    await expect(first.process_exit).resolves.toEqual({
      kind: "exited",
      expected: false,
      code: 23
    });
    expect(first.credential.read("HOSTDECK_CODEX_REMOTE_AUTH")).toBeUndefined();
    expect(supervisor.snapshot()).toMatchObject({
      phase: "exited",
      claim_held: true,
      endpoint_ready: false,
      process_state: "exited"
    });

    const recovered = await restart(supervisor);
    expect(recovered.generation).toBe(2);
    expect(recovered.endpoint.address).toBe("ws://127.0.0.1:31002");
    await close(supervisor);
  });

  it("rejects a duplicate native owner before credential staging or spawn", async () => {
    const sharedAuthority = createFakeAuthority();
    const firstHarness = createHarness({
      authority: sharedAuthority,
      credentials: [tokenA],
      endpoints: [endpoint(31_001)]
    });
    const secondHarness = createHarness({
      authority: sharedAuthority,
      credentials: [tokenB],
      endpoints: [endpoint(31_002)]
    });
    const first = firstHarness.supervisor();
    const second = secondHarness.supervisor();
    await start(first);

    await expectSupervisorError(start(second), "duplicate_supervisor", "claim");
    expect(secondHarness.requests).toHaveLength(0);
    expect(sharedAuthority.staged).toEqual([tokenA]);

    await close(first);
    const replacement = secondHarness.supervisor();
    await expect(start(replacement)).resolves.toMatchObject({ generation: 1 });
    await close(replacement);
  });

  it("fails closed on invalid endpoint or authentication and removes staged authority", async () => {
    for (const failure of ["endpoint", "readiness"] as const) {
      const harness = createHarness({
        credentials: [failure === "endpoint" ? tokenA : tokenB],
        endpoints: [
          failure === "endpoint"
            ? { ...endpoint(31_001), address: "ws://0.0.0.0:31001" }
            : endpoint(31_002)
        ],
        readinessFailure: failure === "readiness"
      });
      const supervisor = harness.supervisor();
      await expectSupervisorError(
        start(supervisor),
        failure === "endpoint" ? "endpoint_invalid" : "readiness_failed",
        failure
      );
      expect(harness.authority.discards).toBe(1);
      expect(harness.authority.releases).toBe(1);
      expect(harness.children[0]?.terminateCalls).toBe(1);
      expect(JSON.stringify(supervisor.snapshot())).not.toMatch(/A{20}|B{20}/u);
    }
  });

  it("terminates the owned tree when startup credential cleanup repeatedly fails", async () => {
    const authority = createFakeAuthority({ discardFailures: 2 });
    const harness = createHarness({
      authority,
      credentials: [tokenA],
      endpoints: [endpoint(31_001)]
    });
    const supervisor = harness.supervisor();

    await expectSupervisorError(
      start(supervisor),
      "authority_failed",
      "credential"
    );
    await expect(harness.children[0]?.handle.exit).resolves.toEqual({
      kind: "terminated",
      code: null,
      spawn_failure: null
    });
    expect(harness.children[0]?.terminateCalls).toBe(1);
    expect(authority.releases).toBe(1);
    expect(supervisor.snapshot()).toMatchObject({
      phase: "failed",
      claim_held: false,
      process_state: "exited",
      process_exit: {
        kind: "terminated",
        expected: true,
        code: null
      },
      cleanup_failures: 1
    });

    await close(supervisor);
    expect(supervisor.snapshot().phase).toBe("closed");
  });

  it("retains ownership until a rejected tree termination is later proven exited", async () => {
    const harness = createHarness({
      credentials: [tokenA],
      endpoints: [endpoint(31_001)],
      rejectTermination: true
    });
    const supervisor = harness.supervisor();
    const started = await start(supervisor);

    await expectSupervisorError(
      closeWithTimeout(supervisor, 25),
      "shutdown_timeout",
      "shutdown"
    );
    expect(harness.authority.releases).toBe(0);
    expect(supervisor.snapshot()).toMatchObject({
      phase: "failed",
      claim_held: true,
      process_state: "running",
      cleanup_failures: 1
    });

    harness.children[0]?.crash(9);
    await expect(started.process_exit).resolves.toEqual({
      kind: "exited",
      expected: true,
      code: 9
    });
    await close(supervisor);
    expect(harness.authority.releases).toBe(1);
    expect(supervisor.snapshot()).toMatchObject({
      phase: "closed",
      claim_held: false,
      process_state: "exited"
    });
  });

  it("rejects invalid native platform, path, credential, and one-shot lifecycle states", async () => {
    const unsupported = createHarness({
      credentials: [tokenA],
      endpoints: [endpoint(31_001)],
      platform: "linux"
    }).supervisor();
    await expectSupervisorError(
      start(unsupported),
      "unsupported_platform",
      "configuration"
    );

    expect(() =>
      createHarness({
        credentials: [tokenA],
        endpoints: [endpoint(31_001)]
      }).supervisor({ endpoint_file_path: `${runtimeDirectory}\\other.file` })
    ).toThrow("endpoint owner file");

    const badCredential = createHarness({
      credentials: ["secret"],
      endpoints: [endpoint(31_001)]
    }).supervisor();
    await expectSupervisorError(
      start(badCredential),
      "port_contract_invalid",
      "credential"
    );

    const harness = createHarness({
      credentials: [tokenA],
      endpoints: [endpoint(31_001)]
    });
    const oneShot = harness.supervisor();
    await start(oneShot);
    await expectSupervisorError(start(oneShot), "lifecycle_conflict", "configuration");
    await close(oneShot);
    await expectSupervisorError(restart(oneShot), "lifecycle_conflict", "configuration");
  });

  it("constructs a sorted bounded case-insensitive environment allowlist", () => {
    const environment = buildCodexWindowsRuntimeEnvironment({
      Path: "C:\\Windows\\System32",
      SystemRoot: "C:\\Windows",
      CODEX_HOME: "C:\\Users\\selected\\.codex",
      OPENAI_API_KEY: "private-api-key",
      HOSTDECK_PRIVATE: "must-not-inherit",
      npm_config_user_agent: "must-not-inherit",
      NO_COLOR: "0"
    });
    expect(environment).toEqual({
      CODEX_HOME: "C:\\Users\\selected\\.codex",
      NO_COLOR: "1",
      OPENAI_API_KEY: "private-api-key",
      PATH: "C:\\Windows\\System32",
      SYSTEMROOT: "C:\\Windows"
    });
    expect(Object.keys(environment)).toEqual([
      "CODEX_HOME",
      "NO_COLOR",
      "OPENAI_API_KEY",
      "PATH",
      "SYSTEMROOT"
    ]);
    expect(() =>
      buildCodexWindowsRuntimeEnvironment({ PATH: "one", Path: "two" })
    ).toThrow("ambiguous");
    expect(() =>
      buildCodexWindowsRuntimeEnvironment({ PATH: `bad\0value` })
    ).toThrow("invalid");
  });
});

interface HarnessOptions {
  readonly authority?: ReturnType<typeof createFakeAuthority>;
  readonly credentials: readonly string[];
  readonly endpoints: readonly unknown[];
  readonly platform?: string;
  readonly readinessFailure?: boolean;
  readonly rejectTermination?: boolean;
  readonly staleCredential?: boolean;
}

function createHarness(options: HarnessOptions) {
  const requests: CodexWindowsRuntimeProcessRequest[] = [];
  const children: FakeChild[] = [];
  const authenticatedTokens: string[] = [];
  const authority =
    options.authority ??
    (options.staleCredential === undefined
      ? createFakeAuthority()
      : createFakeAuthority({ staleCredential: options.staleCredential }));
  let credentialIndex = 0;
  let endpointIndex = 0;
  const processPort: CodexWindowsRuntimeProcessPort = Object.freeze({
    spawn(request: CodexWindowsRuntimeProcessRequest) {
      requests.push(request);
      const child = new FakeChild(
        options.endpoints[endpointIndex],
        options.rejectTermination === true
      );
      endpointIndex += 1;
      children.push(child);
      return child.handle;
    }
  });
  const readinessPort: CodexWindowsRuntimeReadinessPort = Object.freeze({
    authenticate(input: CodexWindowsRuntimeReadinessInput) {
      const token = input.credential.read("HOSTDECK_CODEX_REMOTE_AUTH");
      if (typeof token !== "string") throw new Error("missing credential");
      authenticatedTokens.push(token);
      if (options.readinessFailure) throw new Error(`private ${token}`);
    }
  });
  return {
    authenticatedTokens,
    authority,
    children,
    requests,
    supervisor(
      overrides: Partial<
        Parameters<typeof createCodexWindowsRuntimeSupervisor>[0]
      > = {}
    ) {
      return createCodexWindowsRuntimeSupervisor({
        codex_bin: codexBin,
        cwd: runtimeDirectory,
        endpoint_file_path: endpointFilePath,
        environment: {
          PATH: "C:\\Windows\\System32",
          SystemRoot: "C:\\Windows",
          CODEX_HOME: "C:\\Users\\selected\\.codex",
          HOSTDECK_PRIVATE: "must-not-inherit"
        },
        authority_port: authority.port,
        process_port: processPort,
        readiness_port: readinessPort,
        credential_factory: () => {
          const token = options.credentials[credentialIndex];
          credentialIndex += 1;
          if (token === undefined) throw new Error("credential fixture exhausted");
          return token;
        },
        platform_port: () => options.platform ?? "win32",
        ...overrides
      });
    }
  };
}

class FakeChild {
  readonly handle: CodexWindowsRuntimeChildProcess;
  terminateCalls = 0;
  private running = true;
  private resolveExit: (exit: CodexWindowsRuntimeProcessExit) => void =
    () => undefined;

  constructor(
    endpointCandidate: unknown,
    private readonly rejectTermination = false
  ) {
    const exit = new Promise<CodexWindowsRuntimeProcessExit>((resolve) => {
      this.resolveExit = resolve;
    });
    this.handle = Object.freeze({
      endpoint: Promise.resolve(endpointCandidate),
      exit,
      isRunning: () => this.running,
      terminateTree: () => {
        this.terminateCalls += 1;
        if (!this.running) return false;
        if (this.rejectTermination) return false;
        this.running = false;
        this.resolveExit(
          Object.freeze({
            kind: "terminated",
            code: null,
            spawn_failure: null
          })
        );
        return true;
      }
    });
  }

  crash(code: number): void {
    if (!this.running) return;
    this.running = false;
    this.resolveExit(
      Object.freeze({ kind: "exited", code, spawn_failure: null })
    );
  }
}

function createFakeAuthority(
  options: {
    readonly discardFailures?: number;
    readonly staleCredential?: boolean;
  } = {}
) {
  const state = {
    held: false,
    credentialPresent: false,
    staged: [] as string[],
    discards: 0,
    releases: 0
  };
  let discardFailures = options.discardFailures ?? 0;
  const port: CodexWindowsRuntimeAuthorityPort = Object.freeze({
    tryAcquire() {
      if (state.held) return null;
      state.held = true;
      const authority: CodexWindowsRuntimeAuthority = Object.freeze({
        stageCredential(token: string) {
          if (state.credentialPresent) throw new Error("already staged");
          const stale = state.staged.length === 0 && options.staleCredential === true;
          state.credentialPresent = true;
          state.staged.push(token);
          return Object.freeze({
            credential_path: credentialFilePath,
            replaced_stale_credential: stale
          });
        },
        discardCredential() {
          if (!state.credentialPresent) return;
          if (discardFailures > 0) {
            discardFailures -= 1;
            throw new Error("private credential cleanup detail");
          }
          state.credentialPresent = false;
          state.discards += 1;
        },
        release() {
          if (!state.held) return;
          if (state.credentialPresent) {
            state.credentialPresent = false;
            state.discards += 1;
          }
          state.held = false;
          state.releases += 1;
        }
      });
      return authority;
    }
  });
  return {
    port,
    get staged() {
      return state.staged;
    },
    get discards() {
      return state.discards;
    },
    get releases() {
      return state.releases;
    }
  };
}

function endpoint(port: number) {
  return Object.freeze({
    schema_version: 1,
    target: "windows-x64",
    kind: "authenticated_loopback_websocket",
    address: `ws://127.0.0.1:${port}`,
    port_allocation: "ephemeral_random",
    credential_source: "protected_environment"
  });
}

async function start(
  supervisor: ReturnType<typeof createCodexWindowsRuntimeSupervisor>
) {
  const deadline = createOperationDeadline({
    timeoutMs: defaultResourceBudget.lifecycle_startup_timeout_ms
  });
  try {
    return await supervisor.start({
      deadline,
      resourceBudget: defaultResourceBudget
    });
  } finally {
    deadline.dispose();
  }
}

async function restart(
  supervisor: ReturnType<typeof createCodexWindowsRuntimeSupervisor>
) {
  const deadline = createOperationDeadline({
    timeoutMs: defaultResourceBudget.lifecycle_startup_timeout_ms
  });
  try {
    return await supervisor.restart({
      deadline,
      resourceBudget: defaultResourceBudget
    });
  } finally {
    deadline.dispose();
  }
}

async function close(
  supervisor: ReturnType<typeof createCodexWindowsRuntimeSupervisor>
): Promise<void> {
  return closeWithTimeout(supervisor, 2_000);
}

async function closeWithTimeout(
  supervisor: ReturnType<typeof createCodexWindowsRuntimeSupervisor>,
  timeoutMs: number
): Promise<void> {
  const deadline = createOperationDeadline({ timeoutMs });
  try {
    await supervisor.close({ deadline });
  } finally {
    deadline.dispose();
  }
}

async function expectSupervisorError(
  promise: Promise<unknown>,
  code: string,
  stage: string
): Promise<void> {
  await expect(promise).rejects.toEqual(
    expect.objectContaining({
      name: "HostDeckCodexWindowsRuntimeSupervisorError",
      code,
      stage
    })
  );
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(HostDeckCodexWindowsRuntimeSupervisorError);
    expect(JSON.stringify(error)).not.toMatch(/A{20}|B{20}|C{20}/u);
  }
}
