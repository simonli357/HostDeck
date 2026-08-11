import {
  type CodexLocalWebSocketTransportOptions,
  type CodexReconnectLifecyclePort,
  type CodexTextTransport,
  codexRemoteAuthEnvironmentVariable,
  createCodexRuntimeReconnectController,
  HostDeckCodexAdapterError
} from "@hostdeck/codex-adapter";
import { ScriptedCodexTransport } from "@hostdeck/codex-adapter/testing";
import { defaultResourceBudget } from "@hostdeck/contracts";
import { createOperationDeadline, type OperationDeadline } from "@hostdeck/core";
import { describe, expect, it, vi } from "vitest";
import {
  createCodexWindowsRuntimeConnection
} from "./codex-windows-runtime-connection.js";
import type {
  CodexWindowsRuntimeProcessExitObservation,
  CodexWindowsRuntimeSupervisorSnapshot,
  HostDeckCodexWindowsRuntimeSupervisor,
  StartedCodexWindowsRuntime
} from "./codex-windows-runtime-supervisor.js";

describe("Codex Windows runtime connection", () => {
  it("starts, reuses, rotates, and closes authority behind one transport", async () => {
    const supervisor = new FakeWindowsSupervisor();
    const inner: ProbeTransport[] = [];
    const options: CodexLocalWebSocketTransportOptions[] = [];
    const owner = createCodexWindowsRuntimeConnection({
      supervisor,
      resource_budget: defaultResourceBudget,
      transport_factory(candidate) {
        options.push(candidate);
        const transport = new ProbeTransport();
        inner.push(transport);
        return transport;
      }
    });
    const events: unknown[] = [];
    owner.transport.subscribe((event) => events.push(event));

    await owner.transport.connect();
    const firstAuthority = owner.current_tui_authority();
    const firstToken = readToken(firstAuthority.credential);
    expect(firstAuthority.generation).toBe(1);
    expect(owner.snapshot()).toMatchObject({
      phase: "active",
      runtime_generation: 1,
      transport_generation: 1,
      runtime_starts: 1,
      runtime_restarts: 0,
      runtime_reuses: 0
    });

    inner[0]?.disconnect("ordinary socket loss");
    await owner.transport.connect();
    expect(owner.current_tui_authority().generation).toBe(1);
    expect(owner.snapshot()).toMatchObject({
      transport_generation: 2,
      runtime_starts: 1,
      runtime_restarts: 0,
      runtime_reuses: 1
    });

    supervisor.crash();
    inner[1]?.disconnect("owned child exited");
    expect(firstAuthority.credential.read(codexRemoteAuthEnvironmentVariable)).toBeUndefined();
    await owner.transport.connect();
    const secondAuthority = owner.current_tui_authority();
    const secondToken = readToken(secondAuthority.credential);

    expect(secondAuthority.generation).toBe(2);
    expect(secondAuthority.endpoint.address).not.toBe(firstAuthority.endpoint.address);
    expect(secondToken).not.toBe(firstToken);
    expect(owner.snapshot()).toMatchObject({
      phase: "active",
      runtime_generation: 2,
      transport_generation: 3,
      runtime_starts: 1,
      runtime_restarts: 1,
      runtime_reuses: 1,
      observed_exits: 1
    });
    expect(options.map((entry) => entry.endpoint.address)).toEqual([
      firstAuthority.endpoint.address,
      firstAuthority.endpoint.address,
      secondAuthority.endpoint.address
    ]);
    expect(events).toEqual(
      expect.arrayContaining([
        { type: "open", generation: 1 },
        { type: "open", generation: 2 },
        { type: "open", generation: 3 }
      ])
    );
    expect(JSON.stringify(owner.snapshot())).not.toContain(firstToken);
    expect(JSON.stringify(owner.snapshot())).not.toContain(secondToken);
    expect(JSON.stringify(owner.snapshot())).not.toContain("ws://");

    const deadline = cleanupDeadline();
    try {
      await owner.close(deadline);
    } finally {
      deadline.dispose();
    }
    expect(owner.snapshot()).toMatchObject({
      phase: "closed",
      transport_state: "closed",
      supervisor_phase: "closed",
      process_state: "not_started"
    });
    expect(secondAuthority.credential.read(codexRemoteAuthEnvironmentVariable)).toBeUndefined();
    expect(supervisor.closeCalls).toBe(1);
  });

  it("drives the real reconnect controller through one crash boundary exactly once", async () => {
    const supervisor = new FakeWindowsSupervisor();
    const inner: ScriptedCodexTransport[] = [];
    const lifecycleEvents: string[] = [];
    const owner = createCodexWindowsRuntimeConnection({
      supervisor,
      resource_budget: defaultResourceBudget,
      transport_factory() {
        const transport = respondingTransport();
        inner.push(transport);
        return transport;
      }
    });
    const lifecycle: CodexReconnectLifecyclePort = {
      disconnected({ generation }) {
        lifecycleEvents.push(`disconnected:${generation}`);
      },
      reconcile({ generation }) {
        lifecycleEvents.push(`reconcile:${generation}`);
        return { continuity: generation === 1 ? "continuous" : "boundary_required" };
      },
      resubscribe({ generation }) {
        lifecycleEvents.push(`resubscribe:${generation}`);
      },
      ready({ generation }) {
        lifecycleEvents.push(`ready:${generation}`);
      }
    };
    const backgroundErrors: unknown[] = [];
    const reconnect = createCodexRuntimeReconnectController({
      transport: owner.transport,
      observed_version: "0.144.0",
      host_target: "windows-x64",
      resource_budget: defaultResourceBudget,
      lifecycle,
      random: () => 0,
      on_background_error: (error) => backgroundErrors.push(error)
    });

    await expect(reconnect.start()).resolves.toMatchObject({
      generation: 1,
      continuity: "continuous",
      reconnected: false
    });
    expect(lifecycleEvents).toEqual(["reconcile:1", "resubscribe:1", "ready:1"]);

    supervisor.crash();
    inner[0]?.disconnect("forced process exit");
    await waitFor(() => reconnect.snapshot().phase === "ready" && reconnect.generation === 2);

    expect(reconnect.snapshot()).toMatchObject({
      phase: "ready",
      current_generation: 2,
      admitted_generation: 2,
      completed_reconnects: 1,
      disconnect_cleanups: 1
    });
    expect(owner.snapshot()).toMatchObject({
      runtime_generation: 2,
      transport_generation: 2,
      runtime_restarts: 1,
      observed_exits: 1
    });
    expect(lifecycleEvents).toEqual([
      "reconcile:1",
      "resubscribe:1",
      "ready:1",
      "disconnected:1",
      "reconcile:2",
      "resubscribe:2",
      "ready:2"
    ]);
    expect(backgroundErrors).toEqual([]);

    await reconnect.close();
    const deadline = cleanupDeadline();
    try {
      await owner.close(deadline);
    } finally {
      deadline.dispose();
    }
  });

  it("fails terminally on contradictory supervisor state without creating a transport", async () => {
    const supervisor = new FakeWindowsSupervisor();
    supervisor.forceContradiction();
    const factory = vi.fn(() => new ProbeTransport());
    const owner = createCodexWindowsRuntimeConnection({
      supervisor,
      resource_budget: defaultResourceBudget,
      transport_factory: factory
    });

    await expect(owner.transport.connect()).rejects.toMatchObject({
      code: "invalid_transport_config",
      retry_safe: false,
      message: "Codex rotating transport configuration is invalid."
    });
    expect(factory).not.toHaveBeenCalled();
    expect(owner.snapshot()).toMatchObject({
      phase: "failed",
      last_failure: "runtime_unavailable"
    });
    expect(() => owner.current_tui_authority()).toThrow(
      expect.objectContaining({ code: "runtime_unavailable" })
    );
  });

  it("continues supervisor cleanup after transport close failure and permits a retry", async () => {
    const supervisor = new FakeWindowsSupervisor();
    const inner = new ProbeTransport({ closeFailure: true });
    const owner = createCodexWindowsRuntimeConnection({
      supervisor,
      resource_budget: defaultResourceBudget,
      transport_factory: () => inner
    });
    await owner.transport.connect();

    const firstDeadline = cleanupDeadline();
    await expect(owner.close(firstDeadline)).rejects.toEqual(
      expect.objectContaining({
        name: "HostDeckCodexWindowsRuntimeConnectionError",
        code: "shutdown_failed"
      })
    );
    firstDeadline.dispose();
    expect(supervisor.closeCalls).toBe(1);
    expect(owner.snapshot().phase).toBe("failed");

    inner.closeFailure = false;
    const secondDeadline = cleanupDeadline();
    try {
      await expect(owner.close(secondDeadline)).resolves.toBeUndefined();
    } finally {
      secondDeadline.dispose();
    }
    expect(owner.snapshot().phase).toBe("closed");
  });

  it("rejects malformed configuration and shutdown input without side effects", async () => {
    for (const candidate of [
      null,
      {},
      { supervisor: {}, resource_budget: defaultResourceBudget },
      {
        supervisor: new FakeWindowsSupervisor(),
        resource_budget: { ...defaultResourceBudget }
      },
      {
        supervisor: new FakeWindowsSupervisor(),
        resource_budget: defaultResourceBudget,
        transport_factory: 1
      }
    ]) {
      expect(() => createCodexWindowsRuntimeConnection(candidate as never)).toThrow(
        expect.objectContaining({ code: "invalid_config" })
      );
    }
    const supervisor = new FakeWindowsSupervisor();
    const owner = createCodexWindowsRuntimeConnection({
      supervisor,
      resource_budget: defaultResourceBudget,
      transport_factory: () => new ProbeTransport()
    });
    await expect(owner.close({} as never)).rejects.toMatchObject({
      code: "invalid_config"
    });
    expect(supervisor.closeCalls).toBe(0);
  });
});

interface ProbeTransportOptions {
  readonly closeFailure?: boolean;
}

class ProbeTransport implements CodexTextTransport {
  readonly max_frame_bytes = defaultResourceBudget.protocol_max_frame_bytes;
  closeCalls = 0;
  closeFailure: boolean;
  private currentState: CodexTextTransport["state"] = "idle";
  private currentGeneration = 0;
  private readonly listeners = new Set<(event: Parameters<CodexTextTransport["subscribe"]>[0] extends (event: infer T) => void ? T : never) => void>();

  constructor(options: ProbeTransportOptions = {}) {
    this.closeFailure = options.closeFailure ?? false;
  }

  get state() {
    return this.currentState;
  }

  get generation() {
    return this.currentGeneration;
  }

  async connect(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw adapterError("transport_aborted");
    this.currentState = "open";
    this.currentGeneration += 1;
    this.emit({ type: "open", generation: this.currentGeneration });
  }

  async sendText(): Promise<void> {
    if (this.currentState !== "open") throw adapterError("transport_not_open");
  }

  async close(reason: string): Promise<void> {
    this.closeCalls += 1;
    if (this.closeFailure) throw adapterError("transport_closed");
    const open = this.currentState === "open";
    this.currentState = "closed";
    if (open) {
      this.emit({
        type: "close",
        generation: this.currentGeneration,
        code: 1000,
        reason,
        clean: true
      });
    }
  }

  terminate(error: ReturnType<typeof adapterError>): void {
    this.emit({ type: "error", generation: this.currentGeneration, error });
    this.disconnect("terminated");
  }

  subscribe(listener: Parameters<CodexTextTransport["subscribe"]>[0]): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  disconnect(reason: string): void {
    if (this.currentState !== "open") return;
    this.currentState = "closed";
    this.emit({
      type: "close",
      generation: this.currentGeneration,
      code: 1006,
      reason,
      clean: false
    });
  }

  private emit(event: Parameters<Parameters<CodexTextTransport["subscribe"]>[0]>[0]): void {
    for (const listener of [...this.listeners]) listener(event);
  }
}

class FakeWindowsSupervisor implements HostDeckCodexWindowsRuntimeSupervisor {
  closeCalls = 0;
  private phase: CodexWindowsRuntimeSupervisorSnapshot["phase"] = "idle";
  private generation = 0;
  private active: FakeRuntime | null = null;
  private contradictory = false;

  async start(): Promise<StartedCodexWindowsRuntime> {
    if (this.phase !== "idle") throw new Error("start conflict");
    return this.launch();
  }

  async restart(): Promise<StartedCodexWindowsRuntime> {
    if (this.phase !== "exited") throw new Error("restart conflict");
    return this.launch();
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    const active = this.active;
    this.active = null;
    this.phase = "closed";
    active?.invalidate(true);
  }

  snapshot(): CodexWindowsRuntimeSupervisorSnapshot {
    const ready = this.phase === "ready";
    return Object.freeze({
      target: "windows-x64",
      phase: this.contradictory ? "ready" : this.phase,
      ownership: "owned_child",
      claim_held: this.phase !== "idle" && this.phase !== "closed",
      endpoint_ready: this.contradictory || ready,
      credential_file_present: false,
      generation: this.generation,
      process_state: this.contradictory
        ? "not_started"
        : ready
          ? "running"
          : this.phase === "exited"
            ? "exited"
            : "not_started",
      process_exit: null,
      spawn_attempts: this.generation,
      restart_attempts: Math.max(0, this.generation - 1),
      tree_terminations: 0,
      stale_credential_replacements: 0,
      cleanup_failures: 0
    });
  }

  crash(): void {
    if (this.phase !== "ready" || this.active === null) {
      throw new Error("no active runtime");
    }
    this.phase = "exited";
    this.active.invalidate(false);
  }

  forceContradiction(): void {
    this.contradictory = true;
  }

  private launch(): StartedCodexWindowsRuntime {
    this.generation += 1;
    this.phase = "ready";
    this.active = new FakeRuntime(this.generation);
    return this.active.started;
  }
}

class FakeRuntime {
  readonly started: StartedCodexWindowsRuntime;
  private valid = true;
  private readonly exit = deferred<CodexWindowsRuntimeProcessExitObservation>();
  private readonly token: string;

  constructor(generation: number) {
    this.token = `${"T".repeat(63)}${generation}`;
    const credential = Object.freeze({
      kind: "protected_environment" as const,
      environment_variable: codexRemoteAuthEnvironmentVariable,
      read: (name: string) =>
        this.valid && name === codexRemoteAuthEnvironmentVariable
          ? this.token
          : undefined
    });
    this.started = Object.freeze({
      target: "windows-x64" as const,
      ownership: "owned_child" as const,
      generation,
      endpoint: Object.freeze({
        schema_version: 1 as const,
        target: "windows-x64" as const,
        kind: "authenticated_loopback_websocket" as const,
        address: `ws://127.0.0.1:${41_000 + generation}`,
        port_allocation: "ephemeral_random" as const,
        credential_source: "protected_environment" as const
      }),
      credential,
      credential_file_removed: true as const,
      process_exit: this.exit.promise
    });
  }

  invalidate(expected: boolean): void {
    if (!this.valid) return;
    this.valid = false;
    this.exit.resolve(
      Object.freeze({ kind: "terminated", expected, code: null })
    );
  }
}

function respondingTransport(): ScriptedCodexTransport {
  return new ScriptedCodexTransport({
    on_send(text, transport) {
      const message = JSON.parse(text) as {
        readonly id?: number;
        readonly method?: string;
      };
      if (message.method === "initialize") {
        transport.receive(
          JSON.stringify({
            id: message.id,
            result: {
              userAgent: "hostdeck/0.144.0 (Windows 11; x86_64)",
              codexHome: "/tmp/codex-home",
              platformFamily: "windows",
              platformOs: "windows"
            }
          })
        );
        return;
      }
      if (message.method === "collaborationMode/list") {
        transport.receive(
          JSON.stringify({
            id: message.id,
            result: { data: [{ name: "Default" }, { name: "Plan" }] }
          })
        );
      }
    }
  });
}

function readToken(
  credential: StartedCodexWindowsRuntime["credential"]
): string {
  const token = credential.read(codexRemoteAuthEnvironmentVariable);
  if (token === undefined) throw new Error("test credential unavailable");
  return token;
}

function cleanupDeadline(): OperationDeadline {
  return createOperationDeadline({
    timeoutMs: defaultResourceBudget.lifecycle_cleanup_step_timeout_ms
  });
}

function adapterError(
  code: "transport_aborted" | "transport_closed" | "transport_not_open"
): HostDeckCodexAdapterError {
  const retrySafe = code !== "transport_closed";
  return new HostDeckCodexAdapterError(code, "probe transport failure", {
    outcome: "not_sent",
    retry_safe: retrySafe
  });
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 5_000) {
      throw new Error("Windows runtime connection condition timed out.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
