import { defaultResourceBudget } from "@hostdeck/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  type CodexTextTransport,
  type CodexTransportEvent,
  type CodexTransportListener,
  type CodexTransportState,
  createCodexRotatingTextTransport,
  HostDeckCodexAdapterError
} from "./index.js";

const maxFrameBytes = defaultResourceBudget.protocol_max_frame_bytes;

describe("Codex rotating text transport", () => {
  it("maps replacement transports onto one monotonic public generation", async () => {
    const first = new ProbeTransport();
    const second = new ProbeTransport();
    const acquire = vi
      .fn<() => Promise<CodexTextTransport>>()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const transport = rotating(acquire);
    const events: CodexTransportEvent[] = [];
    transport.subscribe((event) => events.push(event));

    await transport.connect();
    expect(transport.state).toBe("open");
    expect(transport.generation).toBe(1);
    first.receive("first");
    await transport.sendText("outbound-first");
    first.disconnect("rotate");

    await transport.connect();
    expect(transport.state).toBe("open");
    expect(transport.generation).toBe(2);
    second.receive("second");
    await transport.sendText("outbound-second");

    expect(acquire).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ previous_generation: 0 })
    );
    expect(acquire).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ previous_generation: 1 })
    );
    expect(first.sent).toEqual(["outbound-first"]);
    expect(second.sent).toEqual(["outbound-second"]);
    expect(events).toEqual([
      { type: "open", generation: 1 },
      { type: "message", generation: 1, text: "first" },
      {
        type: "close",
        generation: 1,
        code: 1006,
        reason: "Codex inner transport closed.",
        clean: false
      },
      { type: "open", generation: 2 },
      { type: "message", generation: 2, text: "second" }
    ]);
  });

  it("keeps generations monotonic when a provider safely reuses one closed transport", async () => {
    const inner = new ProbeTransport();
    const transport = rotating(async () => inner);

    await transport.connect();
    inner.disconnect();
    await transport.connect();

    expect(inner.generation).toBe(2);
    expect(transport.generation).toBe(2);
    expect(transport.state).toBe("open");
  });

  it("ignores callbacks retained by a revoked inner generation", async () => {
    const stale = new ProbeTransport({ retainListeners: true });
    const current = new ProbeTransport();
    const transports = [stale, current];
    const transport = rotating(async () => {
      const next = transports.shift();
      if (next === undefined) throw new Error("exhausted");
      return next;
    });
    const events: CodexTransportEvent[] = [];
    transport.subscribe((event) => events.push(event));

    await transport.connect();
    stale.disconnect();
    await transport.connect();
    stale.emitRetained({ type: "message", generation: 1, text: "stale-secret" });
    stale.emitRetained({
      type: "close",
      generation: 1,
      code: 1006,
      reason: "late",
      clean: false
    });
    current.receive("current");

    expect(transport.state).toBe("open");
    expect(transport.generation).toBe(2);
    expect(events).not.toContainEqual(
      expect.objectContaining({ text: "stale-secret" })
    );
    expect(events.at(-1)).toEqual({
      type: "message",
      generation: 2,
      text: "current"
    });
  });

  it("sanitizes provider and inner failures without retaining private values", async () => {
    const secret = "private-runtime-authority";
    const providerFailure = rotating(async () => {
      throw new Error(secret);
    });
    const first = await captureFailure(providerFailure.connect());
    expect(first).toMatchObject({
      code: "invalid_transport_config",
      retry_safe: false,
      outcome: "not_sent"
    });
    expect(JSON.stringify(first)).not.toContain(secret);

    const inner = new ProbeTransport({
      connectFailure: new HostDeckCodexAdapterError(
        "transport_connect_failed",
        secret,
        { outcome: "not_sent", retry_safe: true }
      )
    });
    const second = await captureFailure(rotating(async () => inner).connect());
    expect(second).toMatchObject({
      code: "transport_connect_failed",
      retry_safe: true,
      message: "Codex rotating transport could not connect."
    });
    expect(JSON.stringify(second)).not.toContain(secret);
  });

  it("aborts a pending acquisition promptly and closes a late result", async () => {
    const acquired = deferred<CodexTextTransport>();
    const inner = new ProbeTransport();
    const controller = new AbortController();
    const transport = rotating(() => acquired.promise);
    const connection = transport.connect(controller.signal);

    controller.abort();
    await expect(connection).rejects.toMatchObject({
      code: "transport_aborted",
      retry_safe: true
    });
    expect(transport.state).toBe("closed");
    acquired.resolve(inner);
    await waitFor(() => inner.closeCalls === 1);
    expect(inner.state).toBe("closed");
    expect(transport.generation).toBe(0);
  });

  it("coordinates close with a pending acquisition and remains reusable", async () => {
    const acquired = deferred<CodexTextTransport>();
    const late = new ProbeTransport();
    const current = new ProbeTransport();
    let calls = 0;
    const transport = rotating(() => {
      calls += 1;
      return calls === 1 ? acquired.promise : Promise.resolve(current);
    });
    const connection = transport.connect();
    const firstClose = transport.close("shutdown");
    expect(transport.close("shutdown")).toBe(firstClose);

    await expect(connection).rejects.toMatchObject({ code: "transport_aborted" });
    await expect(firstClose).resolves.toBeUndefined();
    acquired.resolve(late);
    await waitFor(() => late.closeCalls === 1);
    await transport.connect();
    expect(transport.state).toBe("open");
    expect(transport.generation).toBe(1);
  });

  it("closes the current generation once and can acquire a later generation", async () => {
    const first = new ProbeTransport();
    const second = new ProbeTransport();
    const transports = [first, second];
    const transport = rotating(async () => {
      const next = transports.shift();
      if (next === undefined) throw new Error("exhausted");
      return next;
    });
    const events: CodexTransportEvent[] = [];
    transport.subscribe((event) => events.push(event));

    await transport.connect();
    await transport.close("normal close");
    expect(first.closeCalls).toBe(1);
    expect(transport.state).toBe("closed");
    await transport.connect();

    expect(transport.generation).toBe(2);
    expect(events.filter((event) => event.type === "close")).toEqual([
      {
        type: "close",
        generation: 1,
        code: 1000,
        reason: "Codex inner transport closed.",
        clean: true
      }
    ]);
  });

  it("fails closed when an application listener throws", async () => {
    const inner = new ProbeTransport();
    const transport = rotating(async () => inner);
    transport.subscribe((event) => {
      if (event.type === "message") throw new Error("observer failed");
    });

    await transport.connect();
    inner.receive("trigger");

    expect(inner.terminateCalls).toBe(1);
    expect(transport.state).toBe("closed");
    await expect(transport.sendText("blocked")).rejects.toMatchObject({
      code: "transport_not_open"
    });
  });

  it("rejects concurrent lifecycle operations before asking the provider twice", async () => {
    const acquired = deferred<CodexTextTransport>();
    const acquire = vi.fn(() => acquired.promise);
    const transport = rotating(acquire);
    const first = transport.connect();

    await expect(transport.connect()).rejects.toMatchObject({
      code: "transport_connect_failed"
    });
    expect(acquire).toHaveBeenCalledTimes(1);
    const close = transport.close("cancel");
    await expect(first).rejects.toMatchObject({ code: "transport_aborted" });
    await close;
  });

  it("rejects malformed options and provider results before admission", async () => {
    for (const candidate of [
      null,
      {},
      { provider: { acquire: async () => new ProbeTransport() }, extra: true },
      { provider: { acquire: 1 } },
      { provider: { acquire: async () => new ProbeTransport() }, max_frame_bytes: 0 }
    ]) {
      expect(() => createCodexRotatingTextTransport(candidate as never)).toThrow(
        expect.objectContaining({ code: "invalid_transport_config" })
      );
    }
    const accessor = Object.defineProperty({}, "provider", {
      enumerable: true,
      get() {
        throw new Error("must not run");
      }
    });
    expect(() => createCodexRotatingTextTransport(accessor as never)).toThrow(
      expect.objectContaining({ code: "invalid_transport_config" })
    );

    const nonPromise = rotating((() => new ProbeTransport()) as never);
    await expect(nonPromise.connect()).rejects.toMatchObject({
      code: "invalid_transport_config",
      retry_safe: false
    });
    const wrongBound = new ProbeTransport({ maxFrameBytes: maxFrameBytes / 2 });
    await expect(rotating(async () => wrongBound).connect()).rejects.toMatchObject({
      code: "invalid_transport_config",
      retry_safe: false
    });
    const active = new ProbeTransport();
    await active.connect();
    await expect(rotating(async () => active).connect()).rejects.toMatchObject({
      code: "invalid_transport_config",
      retry_safe: false
    });
  });

  it("rejects malformed signals, close reasons, and termination errors", async () => {
    const acquire = vi.fn(async () => new ProbeTransport());
    const transport = rotating(acquire);

    await expect(transport.connect({} as never)).rejects.toMatchObject({
      code: "invalid_transport_config"
    });
    await expect(transport.close("bad\nreason")).rejects.toMatchObject({
      code: "invalid_transport_config"
    });
    expect(() => transport.terminate(new Error("bad") as never)).toThrow(
      "termination error is invalid"
    );
    expect(acquire).not.toHaveBeenCalled();
  });

  it("preserves safe transport error semantics while removing inner diagnostics", async () => {
    const inner = new ProbeTransport();
    const transport = rotating(async () => inner);
    const events: CodexTransportEvent[] = [];
    transport.subscribe((event) => events.push(event));
    await transport.connect();

    inner.emitError(
      new HostDeckCodexAdapterError(
        "transport_closed",
        "token-and-endpoint-private",
        { outcome: "not_applicable", retry_safe: false }
      )
    );

    expect(events.at(-1)).toMatchObject({
      type: "error",
      generation: 1,
      error: {
        code: "transport_closed",
        message: "Codex rotating transport closed unexpectedly.",
        retry_safe: false
      }
    });
    expect(JSON.stringify(events)).not.toContain("token-and-endpoint-private");
  });

  it("makes a malformed current-generation event terminal", async () => {
    const inner = new ProbeTransport();
    const acquire = vi.fn(async () => inner);
    const transport = rotating(acquire);
    const events: CodexTransportEvent[] = [];
    transport.subscribe((event) => events.push(event));
    await transport.connect();

    inner.emitMalformed({ type: "message", generation: 1, text: 42 });

    expect(transport.state).toBe("closed");
    expect(inner.terminateCalls).toBe(1);
    expect(events.slice(-2)).toMatchObject([
      {
        type: "error",
        generation: 1,
        error: { code: "invalid_transport_config", retry_safe: false }
      },
      {
        type: "close",
        generation: 1,
        code: 1006,
        clean: false
      }
    ]);
    await expect(transport.connect()).rejects.toMatchObject({
      code: "invalid_transport_config",
      retry_safe: false
    });
    expect(acquire).toHaveBeenCalledTimes(1);
  });
});

interface ProbeTransportOptions {
  readonly connectFailure?: HostDeckCodexAdapterError;
  readonly maxFrameBytes?: number;
  readonly retainListeners?: boolean;
}

class ProbeTransport implements CodexTextTransport {
  readonly max_frame_bytes: number;
  readonly sent: string[] = [];
  closeCalls = 0;
  terminateCalls = 0;
  private readonly listeners = new Set<CodexTransportListener>();
  private readonly retainedListeners = new Set<CodexTransportListener>();
  private currentState: CodexTransportState = "idle";
  private currentGeneration = 0;

  constructor(private readonly options: ProbeTransportOptions = {}) {
    this.max_frame_bytes = options.maxFrameBytes ?? maxFrameBytes;
  }

  get state(): CodexTransportState {
    return this.currentState;
  }

  get generation(): number {
    return this.currentGeneration;
  }

  async connect(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw adapterFailure("transport_aborted", true);
    if (this.options.connectFailure !== undefined) {
      this.currentState = "closed";
      throw this.options.connectFailure;
    }
    if (this.currentState !== "idle" && this.currentState !== "closed") {
      throw adapterFailure("transport_connect_failed", true);
    }
    this.currentState = "open";
    this.currentGeneration += 1;
    this.emit({ type: "open", generation: this.currentGeneration });
  }

  async sendText(text: string): Promise<void> {
    if (this.currentState !== "open") {
      throw adapterFailure("transport_not_open", true);
    }
    this.sent.push(text);
  }

  async close(reason: string): Promise<void> {
    this.closeCalls += 1;
    const wasOpen = this.currentState === "open";
    this.currentState = "closed";
    if (wasOpen) {
      this.emit({
        type: "close",
        generation: this.currentGeneration,
        code: 1000,
        reason,
        clean: true
      });
    }
  }

  terminate(error: HostDeckCodexAdapterError): void {
    this.terminateCalls += 1;
    this.emit({ type: "error", generation: this.currentGeneration, error });
    this.currentState = "closed";
    this.emit({
      type: "close",
      generation: this.currentGeneration,
      code: 1006,
      reason: "terminated",
      clean: false
    });
  }

  subscribe(listener: CodexTransportListener): () => void {
    this.listeners.add(listener);
    this.retainedListeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      if (!this.options.retainListeners) this.retainedListeners.delete(listener);
    };
  }

  receive(text: string): void {
    if (this.currentState !== "open") throw new Error("probe is not open");
    this.emit({ type: "message", generation: this.currentGeneration, text });
  }

  disconnect(reason = "disconnected"): void {
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

  emitError(error: HostDeckCodexAdapterError): void {
    this.emit({ type: "error", generation: this.currentGeneration, error });
  }

  emitRetained(event: CodexTransportEvent): void {
    for (const listener of [...this.retainedListeners]) listener(event);
  }

  emitMalformed(event: unknown): void {
    for (const listener of [...this.listeners]) {
      listener(event as CodexTransportEvent);
    }
  }

  private emit(event: CodexTransportEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }
}

function rotating(
  acquire: () => Promise<CodexTextTransport>
): CodexTextTransport {
  return createCodexRotatingTextTransport({
    max_frame_bytes: maxFrameBytes,
    provider: { acquire }
  });
}

function adapterFailure(
  code: HostDeckCodexAdapterError["code"],
  retrySafe: boolean
): HostDeckCodexAdapterError {
  return new HostDeckCodexAdapterError(code, "probe failure", {
    outcome: "not_sent",
    retry_safe: retrySafe
  });
}

async function captureFailure(
  operation: Promise<unknown>
): Promise<HostDeckCodexAdapterError> {
  try {
    await operation;
  } catch (error) {
    if (error instanceof HostDeckCodexAdapterError) return error;
    throw error;
  }
  throw new Error("Expected rotating transport failure.");
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
    if (Date.now() - started > 2_000) {
      throw new Error("Rotating transport condition timed out.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
