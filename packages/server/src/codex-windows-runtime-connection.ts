import {
  type CodexAuthenticatedLoopbackWebSocketEndpoint,
  type CodexLocalWebSocketTransportOptions,
  type CodexProtectedEnvironmentCredentialSource,
  type CodexRotatingTransportAcquireInput,
  type CodexTextTransport,
  type CodexTransportState,
  codexResourceOptionsFromBudget,
  createCodexLocalWebSocketTransport,
  createCodexRotatingTextTransport,
  HostDeckCodexAdapterError,
  parseCodexLocalEndpoint
} from "@hostdeck/codex-adapter";
import {
  assertResolvedResourceBudget,
  type ResourceBudget
} from "@hostdeck/contracts";
import {
  createOperationDeadline,
  type OperationDeadline
} from "@hostdeck/core";
import type {
  CodexWindowsRuntimeProcessExitObservation,
  CodexWindowsRuntimeSupervisorSnapshot,
  HostDeckCodexWindowsRuntimeSupervisor,
  StartedCodexWindowsRuntime
} from "./codex-windows-runtime-supervisor.js";

export const codexWindowsRuntimeConnectionPhases = Object.freeze([
  "idle",
  "starting",
  "active",
  "exited",
  "restarting",
  "closing",
  "closed",
  "failed"
] as const);

export type CodexWindowsRuntimeConnectionPhase =
  (typeof codexWindowsRuntimeConnectionPhases)[number];

export type CodexWindowsRuntimeConnectionErrorCode =
  | "invalid_config"
  | "runtime_unavailable"
  | "shutdown_failed";

export class HostDeckCodexWindowsRuntimeConnectionError extends Error {
  constructor(
    readonly code: CodexWindowsRuntimeConnectionErrorCode,
    message: string
  ) {
    super(message);
    this.name = "HostDeckCodexWindowsRuntimeConnectionError";
  }
}

export type CodexWindowsRuntimeInnerTransportFactory = (
  options: CodexLocalWebSocketTransportOptions
) => CodexTextTransport;

export interface CreateCodexWindowsRuntimeConnectionInput {
  readonly supervisor: HostDeckCodexWindowsRuntimeSupervisor;
  readonly resource_budget: ResourceBudget;
  readonly transport_factory?: CodexWindowsRuntimeInnerTransportFactory;
}

export interface CodexWindowsRuntimeTuiAuthority {
  readonly target: "windows-x64";
  readonly generation: number;
  readonly endpoint: CodexAuthenticatedLoopbackWebSocketEndpoint;
  readonly credential: CodexProtectedEnvironmentCredentialSource;
}

export interface CodexWindowsRuntimeConnectionSnapshot {
  readonly phase: CodexWindowsRuntimeConnectionPhase;
  readonly runtime_generation: number;
  readonly transport_generation: number;
  readonly transport_state: CodexTransportState;
  readonly supervisor_phase: CodexWindowsRuntimeSupervisorSnapshot["phase"];
  readonly process_state: CodexWindowsRuntimeSupervisorSnapshot["process_state"];
  readonly acquire_attempts: number;
  readonly runtime_starts: number;
  readonly runtime_restarts: number;
  readonly runtime_reuses: number;
  readonly observed_exits: number;
  readonly last_failure: CodexWindowsRuntimeConnectionErrorCode | null;
}

export interface HostDeckCodexWindowsRuntimeConnection {
  readonly transport: CodexTextTransport;
  readonly current_tui_authority: () => CodexWindowsRuntimeTuiAuthority;
  readonly close: (deadline: OperationDeadline) => Promise<void>;
  readonly snapshot: () => CodexWindowsRuntimeConnectionSnapshot;
}

interface ParsedInput {
  readonly supervisor: HostDeckCodexWindowsRuntimeSupervisor;
  readonly resourceBudget: ResourceBudget;
  readonly transportFactory: CodexWindowsRuntimeInnerTransportFactory;
}

interface MutableCounters {
  acquireAttempts: number;
  runtimeStarts: number;
  runtimeRestarts: number;
  runtimeReuses: number;
  observedExits: number;
}

const inputKeys = Object.freeze([
  "resource_budget",
  "supervisor",
  "transport_factory"
] as const);
const supervisorMethods = Object.freeze(["close", "restart", "snapshot", "start"] as const);

export function createCodexWindowsRuntimeConnection(
  input: CreateCodexWindowsRuntimeConnectionInput
): HostDeckCodexWindowsRuntimeConnection {
  const implementation = new DefaultCodexWindowsRuntimeConnection(
    parseInput(input)
  );
  return Object.freeze({
    transport: implementation.transport,
    current_tui_authority: () => implementation.currentTuiAuthority(),
    close: (deadline: OperationDeadline) => implementation.close(deadline),
    snapshot: () => implementation.snapshot()
  });
}

class DefaultCodexWindowsRuntimeConnection {
  readonly transport: CodexTextTransport;
  private readonly counters: MutableCounters = {
    acquireAttempts: 0,
    runtimeStarts: 0,
    runtimeRestarts: 0,
    runtimeReuses: 0,
    observedExits: 0
  };
  private phase: CodexWindowsRuntimeConnectionPhase = "idle";
  private runtime: StartedCodexWindowsRuntime | null = null;
  private closePromise: Promise<void> | null = null;
  private lastFailure: CodexWindowsRuntimeConnectionErrorCode | null = null;

  constructor(private readonly options: ParsedInput) {
    const resources = codexResourceOptionsFromBudget(options.resourceBudget);
    this.transport = createCodexRotatingTextTransport({
      max_frame_bytes: resources.transport.max_frame_bytes,
      provider: Object.freeze({
        acquire: ({ signal }: CodexRotatingTransportAcquireInput) =>
          this.acquireTransport(signal)
      })
    });
  }

  currentTuiAuthority(): CodexWindowsRuntimeTuiAuthority {
    const runtime = this.runtime;
    const supervisor = this.readSupervisorSnapshot();
    if (
      this.phase !== "active" ||
      runtime === null ||
      supervisor.phase !== "ready" ||
      !supervisor.endpoint_ready ||
      supervisor.process_state !== "running" ||
      supervisor.generation !== runtime.generation
    ) {
      throw connectionError(
        "runtime_unavailable",
        "Codex Windows TUI authority is unavailable."
      );
    }
    return Object.freeze({
      target: "windows-x64",
      generation: runtime.generation,
      endpoint: runtime.endpoint,
      credential: runtime.credential
    });
  }

  close(deadline: OperationDeadline): Promise<void> {
    let parsed: OperationDeadline;
    try {
      parsed = parseDeadline(deadline);
    } catch {
      return Promise.reject(
        connectionError(
          "invalid_config",
          "Codex Windows runtime connection shutdown input is invalid."
        )
      );
    }
    if (this.closePromise !== null) return this.closePromise;
    this.phase = "closing";
    let operation: Promise<void>;
    operation = this.closeInternal(parsed).finally(() => {
      if (this.closePromise === operation && this.phase !== "closed") {
        this.closePromise = null;
      }
    });
    this.closePromise = operation;
    return operation;
  }

  snapshot(): CodexWindowsRuntimeConnectionSnapshot {
    const supervisor = this.readSupervisorSnapshot();
    return deepFreeze({
      phase: this.phase,
      runtime_generation: this.runtime?.generation ?? 0,
      transport_generation: this.transport.generation,
      transport_state: this.transport.state,
      supervisor_phase: supervisor.phase,
      process_state: supervisor.process_state,
      acquire_attempts: this.counters.acquireAttempts,
      runtime_starts: this.counters.runtimeStarts,
      runtime_restarts: this.counters.runtimeRestarts,
      runtime_reuses: this.counters.runtimeReuses,
      observed_exits: this.counters.observedExits,
      last_failure: this.lastFailure
    });
  }

  private async acquireTransport(signal: AbortSignal): Promise<CodexTextTransport> {
    increment(this.counters, "acquireAttempts");
    if (
      this.phase === "closing" ||
      this.phase === "closed" ||
      this.phase === "failed"
    ) {
      throw terminalTransportFailure();
    }
    if (signal.aborted) throw abortedTransportFailure();

    let runtime: StartedCodexWindowsRuntime;
    const supervisor = this.readSupervisorSnapshot();
    if (supervisor.phase === "idle" && this.runtime === null) {
      this.phase = "starting";
      runtime = await this.startRuntime("start", signal);
      increment(this.counters, "runtimeStarts");
    } else if (
      supervisor.phase === "ready" &&
      supervisor.endpoint_ready &&
      supervisor.process_state === "running" &&
      this.runtime !== null &&
      this.runtime.generation === supervisor.generation
    ) {
      runtime = this.runtime;
      this.phase = "active";
      increment(this.counters, "runtimeReuses");
    } else if (
      supervisor.phase === "exited" &&
      this.runtime !== null &&
      this.runtime.generation === supervisor.generation
    ) {
      this.phase = "restarting";
      runtime = await this.startRuntime("restart", signal);
      increment(this.counters, "runtimeRestarts");
    } else {
      this.fail("runtime_unavailable");
      throw terminalTransportFailure();
    }

    if (signal.aborted) throw abortedTransportFailure();
    const resources = codexResourceOptionsFromBudget(this.options.resourceBudget);
    try {
      return this.options.transportFactory({
        host_target: "windows-x64",
        endpoint: runtime.endpoint,
        credential: runtime.credential,
        ...resources.transport
      });
    } catch {
      const afterFailure = this.readSupervisorSnapshot();
      if (
        afterFailure.phase === "exited" &&
        afterFailure.generation === runtime.generation
      ) {
        this.phase = "exited";
        throw retryableTransportFailure();
      }
      this.fail("runtime_unavailable");
      throw terminalTransportFailure();
    }
  }

  private async startRuntime(
    operation: "restart" | "start",
    signal: AbortSignal
  ): Promise<StartedCodexWindowsRuntime> {
    const deadline = createOperationDeadline({
      timeoutMs: this.options.resourceBudget.lifecycle_startup_timeout_ms,
      parentSignal: signal
    });
    try {
      const started = await this.options.supervisor[operation]({
        deadline,
        resourceBudget: this.options.resourceBudget
      });
      const runtime = parseStartedRuntime(
        started,
        this.readSupervisorSnapshot()
      );
      this.runtime = runtime;
      this.phase = "active";
      this.lastFailure = null;
      this.observeRuntimeExit(runtime);
      return runtime;
    } catch {
      if (signal.aborted) throw abortedTransportFailure();
      this.fail("runtime_unavailable");
      throw terminalTransportFailure();
    } finally {
      deadline.dispose();
    }
  }

  private observeRuntimeExit(runtime: StartedCodexWindowsRuntime): void {
    void Promise.resolve(runtime.process_exit).then(
      (observation) => this.recordRuntimeExit(runtime, observation),
      () => {
        if (this.runtime !== runtime || this.phase === "closing" || this.phase === "closed") {
          return;
        }
        this.fail("runtime_unavailable");
      }
    );
  }

  private recordRuntimeExit(
    runtime: StartedCodexWindowsRuntime,
    observation: CodexWindowsRuntimeProcessExitObservation
  ): void {
    if (this.runtime !== runtime) return;
    increment(this.counters, "observedExits");
    if (this.phase === "closing" || this.phase === "closed") return;
    if (observation.expected) {
      this.fail("runtime_unavailable");
      return;
    }
    this.phase = "exited";
  }

  private async closeInternal(deadline: OperationDeadline): Promise<void> {
    let failed = false;
    try {
      await this.transport.close(
        "HostDeck is closing the Codex Windows runtime connection."
      );
    } catch {
      failed = true;
    }
    try {
      await this.options.supervisor.close({ deadline });
    } catch {
      failed = true;
    }
    this.runtime = null;
    if (failed) {
      this.fail("shutdown_failed");
      throw connectionError(
        "shutdown_failed",
        "Codex Windows runtime connection did not shut down cleanly."
      );
    }
    this.phase = "closed";
    this.lastFailure = null;
  }

  private readSupervisorSnapshot(): CodexWindowsRuntimeSupervisorSnapshot {
    try {
      const snapshot = this.options.supervisor.snapshot();
      if (
        snapshot === null ||
        typeof snapshot !== "object" ||
        snapshot.target !== "windows-x64" ||
        snapshot.ownership !== "owned_child" ||
        !Number.isSafeInteger(snapshot.generation) ||
        snapshot.generation < 0
      ) {
        throw new TypeError();
      }
      return snapshot;
    } catch {
      this.fail("runtime_unavailable");
      throw connectionError(
        "runtime_unavailable",
        "Codex Windows runtime supervisor state is unavailable."
      );
    }
  }

  private fail(code: CodexWindowsRuntimeConnectionErrorCode): void {
    this.phase = "failed";
    this.lastFailure = code;
  }
}

function parseInput(candidate: unknown): ParsedInput {
  try {
    const values = exactData(candidate, inputKeys, ["resource_budget", "supervisor"]);
    const supervisor = values.supervisor;
    if (!hasMethods(supervisor, supervisorMethods)) throw new TypeError();
    assertResolvedResourceBudget(values.resource_budget);
    if (!Object.isFrozen(values.resource_budget)) throw new TypeError();
    const transportFactory =
      values.transport_factory === undefined
        ? createCodexLocalWebSocketTransport
        : values.transport_factory;
    if (typeof transportFactory !== "function") throw new TypeError();
    return Object.freeze({
      supervisor: supervisor as unknown as HostDeckCodexWindowsRuntimeSupervisor,
      resourceBudget: values.resource_budget as ResourceBudget,
      transportFactory: transportFactory as CodexWindowsRuntimeInnerTransportFactory
    });
  } catch {
    throw connectionError(
      "invalid_config",
      "Codex Windows runtime connection configuration is invalid."
    );
  }
}

function parseStartedRuntime(
  candidate: unknown,
  supervisor: CodexWindowsRuntimeSupervisorSnapshot
): StartedCodexWindowsRuntime {
  try {
    if (candidate === null || typeof candidate !== "object" || !Object.isFrozen(candidate)) {
      throw new TypeError();
    }
    const runtime = candidate as StartedCodexWindowsRuntime;
    const endpoint = parseCodexLocalEndpoint(runtime.endpoint);
    if (
      runtime.target !== "windows-x64" ||
      runtime.ownership !== "owned_child" ||
      runtime.credential_file_removed !== true ||
      !Number.isSafeInteger(runtime.generation) ||
      runtime.generation < 1 ||
      endpoint.kind !== "authenticated_loopback_websocket" ||
      endpoint.target !== "windows-x64" ||
      runtime.credential === null ||
      typeof runtime.credential !== "object" ||
      runtime.credential.kind !== "protected_environment" ||
      typeof runtime.credential.read !== "function" ||
      !isPromiseLike(runtime.process_exit) ||
      supervisor.phase !== "ready" ||
      !supervisor.endpoint_ready ||
      supervisor.process_state !== "running" ||
      supervisor.generation !== runtime.generation
    ) {
      throw new TypeError();
    }
    return runtime;
  } catch {
    throw terminalTransportFailure();
  }
}

function parseDeadline(candidate: unknown): OperationDeadline {
  if (candidate === null || typeof candidate !== "object" || !Object.isFrozen(candidate)) {
    throw new TypeError();
  }
  const deadline = candidate as OperationDeadline;
  if (
    !(deadline.signal instanceof AbortSignal) ||
    !Number.isFinite(deadline.startedAtMs) ||
    !Number.isFinite(deadline.expiresAtMs) ||
    deadline.expiresAtMs < deadline.startedAtMs ||
    typeof deadline.throwIfAborted !== "function" ||
    typeof deadline.timeoutMs !== "function" ||
    typeof deadline.dispose !== "function"
  ) {
    throw new TypeError();
  }
  return deadline;
}

function exactData<const Key extends string>(
  candidate: unknown,
  allowed: readonly Key[],
  required: readonly Key[]
): Readonly<Record<Key, unknown>> {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new TypeError();
  }
  const prototype: unknown = Object.getPrototypeOf(candidate);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError();
  const descriptors = Object.getOwnPropertyDescriptors(candidate);
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.some((key) => typeof key !== "string" || !allowed.includes(key as Key)) ||
    required.some((key) => !Object.hasOwn(descriptors, key))
  ) {
    throw new TypeError();
  }
  const output = Object.create(null) as Record<Key, unknown>;
  for (const key of keys) {
    if (typeof key !== "string") throw new TypeError();
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      throw new TypeError();
    }
    output[key as Key] = descriptor.value;
  }
  return Object.freeze(output);
}

function hasMethods(
  candidate: unknown,
  methods: readonly string[]
): candidate is Record<string, (...args: never[]) => unknown> {
  if (candidate === null || typeof candidate !== "object") return false;
  try {
    return methods.every((method) => typeof Reflect.get(candidate, method) === "function");
  } catch {
    return false;
  }
}

function increment(counters: MutableCounters, key: keyof MutableCounters): void {
  const current = counters[key];
  if (!Number.isSafeInteger(current) || current >= Number.MAX_SAFE_INTEGER) {
    throw connectionError(
      "runtime_unavailable",
      "Codex Windows runtime connection counter overflowed."
    );
  }
  counters[key] = current + 1;
}

function isPromiseLike(candidate: unknown): candidate is Promise<unknown> {
  return (
    candidate !== null &&
    (typeof candidate === "object" || typeof candidate === "function") &&
    typeof (candidate as { readonly then?: unknown }).then === "function"
  );
}

function retryableTransportFailure(): HostDeckCodexAdapterError {
  return new HostDeckCodexAdapterError(
    "transport_connect_failed",
    "Codex Windows runtime exited during transport acquisition.",
    { outcome: "not_sent", retry_safe: true }
  );
}

function abortedTransportFailure(): HostDeckCodexAdapterError {
  return new HostDeckCodexAdapterError(
    "transport_aborted",
    "Codex Windows runtime transport acquisition was aborted.",
    { outcome: "not_sent", retry_safe: true }
  );
}

function terminalTransportFailure(): HostDeckCodexAdapterError {
  return new HostDeckCodexAdapterError(
    "invalid_transport_config",
    "Codex Windows runtime transport authority is unavailable.",
    { outcome: "not_sent", retry_safe: false }
  );
}

function connectionError(
  code: CodexWindowsRuntimeConnectionErrorCode,
  message: string
): HostDeckCodexWindowsRuntimeConnectionError {
  return new HostDeckCodexWindowsRuntimeConnectionError(code, message);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}
