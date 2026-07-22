import { basename, isAbsolute, normalize } from "node:path";
import {
  assertResolvedResourceBudget,
  type ResourceBudget
} from "@hostdeck/contracts";
import {
  createOperationDeadline,
  type OperationDeadline,
  OperationDeadlineExceededError
} from "@hostdeck/core";
import { HostDeckLocalPathError } from "@hostdeck/storage";
import {
  nodeCodexRuntimeProcessPort,
  nodeCodexRuntimeSocketPort,
  nodeCodexRuntimeSupervisorClock
} from "./codex-runtime-supervisor-node.js";

export const codexRuntimeSupervisorModes = [
  "foreground_child",
  "service_owned"
] as const;
export type CodexRuntimeSupervisorMode =
  (typeof codexRuntimeSupervisorModes)[number];

export const codexRuntimeSupervisorPhases = [
  "idle",
  "starting",
  "ready",
  "exited",
  "closing",
  "closed",
  "failed"
] as const;
export type CodexRuntimeSupervisorPhase =
  (typeof codexRuntimeSupervisorPhases)[number];

export const codexRuntimeSupervisorErrorCodes = [
  "invalid_config",
  "lifecycle_conflict",
  "duplicate_supervisor",
  "socket_insecure",
  "socket_active",
  "socket_unavailable",
  "socket_cleanup_conflict",
  "binary_missing",
  "binary_not_executable",
  "process_start_failed",
  "process_exited",
  "startup_timeout",
  "startup_aborted",
  "startup_closed",
  "shutdown_timeout",
  "shutdown_failed",
  "port_contract_invalid"
] as const;
export type CodexRuntimeSupervisorErrorCode =
  (typeof codexRuntimeSupervisorErrorCodes)[number];

export const codexRuntimeSupervisorStages = [
  "configuration",
  "claim",
  "socket",
  "spawn",
  "readiness",
  "shutdown"
] as const;
export type CodexRuntimeSupervisorStage =
  (typeof codexRuntimeSupervisorStages)[number];

export const codexRuntimeProcessExitKinds = [
  "exited",
  "signaled",
  "spawn_failed",
  "unknown"
] as const;
export type CodexRuntimeProcessExitKind =
  (typeof codexRuntimeProcessExitKinds)[number];

export interface CodexRuntimeProcessExit {
  readonly kind: Exclude<CodexRuntimeProcessExitKind, "unknown">;
  readonly code: number | null;
  readonly signal: string | null;
  readonly spawn_failure:
    | "missing_binary"
    | "not_executable"
    | "failed"
    | null;
}

export interface CodexRuntimeProcessExitObservation {
  readonly kind: CodexRuntimeProcessExitKind;
  readonly expected: boolean;
  readonly code: number | null;
  readonly signal: string | null;
}

export interface CodexRuntimeProcessRequest {
  readonly executable: string;
  readonly args: readonly ["app-server", "--listen", string];
  readonly cwd: "/";
}

export interface CodexRuntimeChildProcess {
  readonly exit: Promise<CodexRuntimeProcessExit>;
  readonly isRunning: () => boolean;
  readonly signal: (signal: "SIGTERM" | "SIGKILL") => boolean;
}

export interface CodexRuntimeProcessPort {
  readonly spawn: (
    request: CodexRuntimeProcessRequest
  ) => CodexRuntimeChildProcess;
}

export type CodexRuntimeSocketObservation =
  | { readonly state: "missing" }
  | {
      readonly state: "socket";
      readonly identity: string;
      readonly mode_repaired: boolean;
    };

export type CodexRuntimeSocketProbe = "ready" | "refused" | "missing";

export interface CodexRuntimeSocketInspectionPolicy {
  readonly repair_mode: boolean;
}

export interface CodexRuntimeSocketPort {
  readonly inspect: (
    socketPath: string,
    policy: CodexRuntimeSocketInspectionPolicy
  ) => CodexRuntimeSocketObservation | Promise<CodexRuntimeSocketObservation>;
  readonly probe: (
    socketPath: string,
    signal: AbortSignal
  ) => CodexRuntimeSocketProbe | Promise<CodexRuntimeSocketProbe>;
  readonly remove: (
    socketPath: string,
    identity: string
  ) => "removed" | "missing" | Promise<"removed" | "missing">;
}

export interface CodexRuntimeSupervisorClock {
  readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export interface StartCodexRuntimeSupervisorInput {
  readonly deadline: OperationDeadline;
  readonly resourceBudget: ResourceBudget;
}

export interface CloseCodexRuntimeSupervisorInput {
  readonly deadline: OperationDeadline;
}

export interface CodexRuntimeSupervisorSnapshot {
  readonly mode: CodexRuntimeSupervisorMode;
  readonly phase: CodexRuntimeSupervisorPhase;
  readonly ownership: "foreground_child" | "service_owned";
  readonly claim_held: boolean;
  readonly socket_ready: boolean;
  readonly socket_mode_repaired: boolean;
  readonly stale_socket_removed: boolean;
  readonly process_state:
    | "not_applicable"
    | "not_started"
    | "running"
    | "exited"
    | "unknown";
  readonly process_exit: CodexRuntimeProcessExitObservation | null;
  readonly spawn_attempts: number;
  readonly startup_retries: number;
  readonly term_signals: number;
  readonly kill_signals: number;
  readonly cleanup_failures: number;
}

export interface StartedCodexRuntime {
  readonly mode: CodexRuntimeSupervisorMode;
  readonly ownership: "foreground_child" | "service_owned";
  readonly socket_path: string;
  readonly socket_mode_repaired: boolean;
  readonly stale_socket_removed: boolean;
  readonly process_exit: Promise<CodexRuntimeProcessExitObservation> | null;
}

export interface HostDeckCodexRuntimeSupervisor {
  readonly start: (
    input: StartCodexRuntimeSupervisorInput
  ) => Promise<StartedCodexRuntime>;
  readonly close: (
    input: CloseCodexRuntimeSupervisorInput
  ) => Promise<void>;
  readonly snapshot: () => CodexRuntimeSupervisorSnapshot;
}

export type CreateCodexRuntimeSupervisorInput =
  | {
      readonly mode: "foreground_child";
      readonly codex_bin: string;
      readonly socket_path: string;
      readonly process_port?: CodexRuntimeProcessPort;
      readonly socket_port?: CodexRuntimeSocketPort;
      readonly clock?: CodexRuntimeSupervisorClock;
    }
  | {
      readonly mode: "service_owned";
      readonly socket_path: string;
      readonly socket_port?: CodexRuntimeSocketPort;
      readonly clock?: CodexRuntimeSupervisorClock;
    };

export class HostDeckCodexRuntimeSupervisorError extends Error {
  readonly code: CodexRuntimeSupervisorErrorCode;
  readonly stage: CodexRuntimeSupervisorStage;

  constructor(
    code: CodexRuntimeSupervisorErrorCode,
    stage: CodexRuntimeSupervisorStage,
    message: string,
    cause?: unknown
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "HostDeckCodexRuntimeSupervisorError";
    this.code = code;
    this.stage = stage;
  }
}

interface ParsedForegroundConfig {
  readonly mode: "foreground_child";
  readonly codexBin: string;
  readonly socketPath: string;
  readonly processPort: CodexRuntimeProcessPort;
  readonly socketPort: CodexRuntimeSocketPort;
  readonly clock: CodexRuntimeSupervisorClock;
}

interface ParsedServiceConfig {
  readonly mode: "service_owned";
  readonly socketPath: string;
  readonly socketPort: CodexRuntimeSocketPort;
  readonly clock: CodexRuntimeSupervisorClock;
}

type ParsedSupervisorConfig = ParsedForegroundConfig | ParsedServiceConfig;

interface MutableCounters {
  spawnAttempts: number;
  startupRetries: number;
  termSignals: number;
  killSignals: number;
  cleanupFailures: number;
}

interface ParsedSocketObservation {
  readonly state: "missing" | "socket";
  readonly identity: string | null;
  readonly modeRepaired: boolean;
}

const selectedSocketName = "app-server.sock";
const maxUnixSocketPathBytes = 107;
const maxExecutablePathBytes = 4_096;
const readinessRetryMilliseconds = 20;
const activeSocketClaims = new Map<
  string,
  DefaultCodexRuntimeSupervisor
>();

const defaultClock = nodeCodexRuntimeSupervisorClock;
const defaultProcessPort = nodeCodexRuntimeProcessPort;
const defaultSocketPort = nodeCodexRuntimeSocketPort;

export function createCodexRuntimeSupervisor(
  input: CreateCodexRuntimeSupervisorInput
): HostDeckCodexRuntimeSupervisor {
  return new DefaultCodexRuntimeSupervisor(parseSupervisorConfig(input));
}

class DefaultCodexRuntimeSupervisor
  implements HostDeckCodexRuntimeSupervisor
{
  private readonly config: ParsedSupervisorConfig;
  private readonly lifecycleAbort = new AbortController();
  private readonly counters: MutableCounters = {
    spawnAttempts: 0,
    startupRetries: 0,
    termSignals: 0,
    killSignals: 0,
    cleanupFailures: 0
  };
  private phase: CodexRuntimeSupervisorPhase = "idle";
  private claimHeld = false;
  private socketReady = false;
  private socketModeRepaired = false;
  private staleSocketRemoved = false;
  private child: CodexRuntimeChildProcess | null = null;
  private childExit: CodexRuntimeProcessExitObservation | null = null;
  private childSpawnFailure: CodexRuntimeProcessExit["spawn_failure"] = null;
  private childExitContractInvalid = false;
  private childExitPromise: Promise<CodexRuntimeProcessExitObservation> | null =
    null;
  private socketIdentity: string | null = null;
  private startPromise: Promise<StartedCodexRuntime> | null = null;
  private closePromise: Promise<void> | null = null;
  private terminationRequested = false;
  private lateExitCleanupScheduled = false;

  constructor(config: ParsedSupervisorConfig) {
    this.config = config;
  }

  start(
    input: StartCodexRuntimeSupervisorInput
  ): Promise<StartedCodexRuntime> {
    let parsed: StartCodexRuntimeSupervisorInput;
    try {
      parsed = parseStartInput(input);
    } catch (cause) {
      return Promise.reject(
        supervisorError(
          "invalid_config",
          "configuration",
          "Codex runtime supervisor start input is invalid.",
          cause
        )
      );
    }
    if (this.phase !== "idle" || this.startPromise !== null) {
      return Promise.reject(
        supervisorError(
          "lifecycle_conflict",
          "configuration",
          "Codex runtime supervisor can start only once."
        )
      );
    }

    this.phase = "starting";
    this.startPromise = this.startInternal(parsed);
    return this.startPromise;
  }

  close(input: CloseCodexRuntimeSupervisorInput): Promise<void> {
    let parsed: CloseCodexRuntimeSupervisorInput;
    try {
      parsed = parseCloseInput(input);
    } catch (cause) {
      return Promise.reject(
        supervisorError(
          "invalid_config",
          "shutdown",
          "Codex runtime supervisor close input is invalid.",
          cause
        )
      );
    }
    if (this.closePromise !== null) return this.closePromise;
    this.lifecycleAbort.abort(
      supervisorError(
        "startup_closed",
        "readiness",
        "Codex runtime startup was closed before readiness."
      )
    );
    this.closePromise = this.closeInternal(parsed.deadline);
    return this.closePromise;
  }

  snapshot(): CodexRuntimeSupervisorSnapshot {
    return deepFreeze({
      mode: this.config.mode,
      phase: this.phase,
      ownership: this.config.mode,
      claim_held: this.claimHeld,
      socket_ready: this.socketReady,
      socket_mode_repaired: this.socketModeRepaired,
      stale_socket_removed: this.staleSocketRemoved,
      process_state: this.processState(),
      process_exit:
        this.childExit === null ? null : Object.freeze({ ...this.childExit }),
      spawn_attempts: this.counters.spawnAttempts,
      startup_retries: this.counters.startupRetries,
      term_signals: this.counters.termSignals,
      kill_signals: this.counters.killSignals,
      cleanup_failures: this.counters.cleanupFailures
    });
  }

  private async startInternal(
    input: StartCodexRuntimeSupervisorInput
  ): Promise<StartedCodexRuntime> {
    let primary: unknown = null;
    try {
      this.acquireClaim();
      const signal = AbortSignal.any([
        input.deadline.signal,
        this.lifecycleAbort.signal
      ]);
      this.assertStartupOpen(input.deadline);

      if (this.config.mode === "foreground_child") {
        await this.prepareForegroundSocket(input.deadline, signal);
        this.assertStartupOpen(input.deadline);
        this.spawnForegroundChild();
        await this.waitForReadySocket(input.deadline, signal, true);
      } else {
        await this.waitForReadySocket(input.deadline, signal, false);
      }

      this.assertStartupOpen(input.deadline);
      if (this.config.mode === "foreground_child") {
        this.requireRunningChild();
      }
      this.phase = "ready";
      return Object.freeze({
        mode: this.config.mode,
        ownership: this.config.mode,
        socket_path: this.config.socketPath,
        socket_mode_repaired: this.socketModeRepaired,
        stale_socket_removed: this.staleSocketRemoved,
        process_exit:
          this.config.mode === "foreground_child"
            ? this.requireChildExitPromise()
            : null
      });
    } catch (cause) {
      primary = this.mapStartupFailure(cause);
      const cleanupErrors = await this.cleanupAfterStartupFailure(
        input.resourceBudget
      );
      this.phase = "failed";
      if (cleanupErrors.length === 0) throw primary;
      throw supervisorError(
        primary instanceof HostDeckCodexRuntimeSupervisorError
          ? primary.code
          : "process_start_failed",
        primary instanceof HostDeckCodexRuntimeSupervisorError
          ? primary.stage
          : "readiness",
        primary instanceof HostDeckCodexRuntimeSupervisorError
          ? primary.message
          : "Codex runtime startup failed.",
        new AggregateError(
          [primary, ...cleanupErrors],
          "Codex runtime startup and cleanup failed."
        )
      );
    }
  }

  private async closeInternal(deadline: OperationDeadline): Promise<void> {
    if (this.phase === "idle") {
      this.phase = "closed";
      return;
    }

    if (this.phase === "starting" && this.startPromise !== null) {
      try {
        await this.startPromise;
      } catch {
        // Startup owns its primary error and reverse cleanup.
      }
    }

    if (!this.claimHeld && this.child === null) {
      this.socketReady = false;
      this.phase = "closed";
      return;
    }

    this.phase = "closing";
    const errors: unknown[] = [];
    let socketSettled = this.config.mode === "service_owned";
    if (this.config.mode === "foreground_child") {
      errors.push(...(await this.stopOwnedChild(deadline)));
      if (!this.safeChildRunning()) {
        const socketErrors = await this.removeOwnedSocket();
        errors.push(...socketErrors);
        socketSettled = socketErrors.length === 0;
      }
    }

    const childStillRunning = this.child !== null && this.safeChildRunning();
    if (!childStillRunning && socketSettled) {
      try {
        this.releaseClaim();
      } catch (error) {
        errors.push(error);
      }
    }
    this.socketReady = false;

    if (errors.length > 0 || childStillRunning) {
      if (childStillRunning) {
        this.scheduleLateExitCleanup();
        errors.push(
          supervisorError(
            deadline.signal.aborted
              ? "shutdown_timeout"
              : "shutdown_failed",
            "shutdown",
            deadline.signal.aborted
              ? "Codex runtime shutdown exceeded its deadline."
              : "Owned Codex app-server did not terminate."
          )
        );
      }
      this.phase = "failed";
      throw supervisorError(
        deadline.signal.aborted ? "shutdown_timeout" : "shutdown_failed",
        "shutdown",
        deadline.signal.aborted
          ? "Codex runtime shutdown exceeded its deadline."
          : "Codex runtime shutdown did not complete cleanly.",
        new AggregateError(errors, "Codex runtime cleanup failed.")
      );
    }

    this.child = null;
    this.socketIdentity = null;
    this.phase = "closed";
  }

  private acquireClaim(): void {
    const existing = activeSocketClaims.get(this.config.socketPath);
    if (existing !== undefined && existing !== this) {
      throw supervisorError(
        "duplicate_supervisor",
        "claim",
        "Another HostDeck runtime supervisor already owns this socket."
      );
    }
    if (existing === this || this.claimHeld) {
      throw supervisorError(
        "lifecycle_conflict",
        "claim",
        "Codex runtime supervisor claim is already active."
      );
    }
    activeSocketClaims.set(this.config.socketPath, this);
    this.claimHeld = true;
  }

  private releaseClaim(): void {
    if (!this.claimHeld) return;
    if (activeSocketClaims.get(this.config.socketPath) !== this) {
      throw supervisorError(
        "port_contract_invalid",
        "shutdown",
        "Codex runtime supervisor claim identity changed unexpectedly."
      );
    }
    activeSocketClaims.delete(this.config.socketPath);
    this.claimHeld = false;
  }

  private async prepareForegroundSocket(
    deadline: OperationDeadline,
    signal: AbortSignal
  ): Promise<void> {
    const observation = await this.inspectSocket();
    if (observation.state === "missing") return;
    const identity = requireSocketIdentity(observation);
    const probe = await this.probeSocket(signal);
    this.assertStartupOpen(deadline);
    if (probe === "ready") {
      throw supervisorError(
        "socket_active",
        "socket",
        "A Codex app-server is already accepting this private socket."
      );
    }
    if (probe === "missing") return;
    increment(this.counters, "startupRetries");
    await this.waitForRetry(deadline, signal, false);
    const confirmed = await this.inspectSocket();
    if (confirmed.state === "missing") return;
    if (requireSocketIdentity(confirmed) !== identity) {
      throw supervisorError(
        "socket_cleanup_conflict",
        "socket",
        "Codex socket identity changed during stale-state confirmation."
      );
    }
    const confirmedProbe = await this.probeSocket(signal);
    this.assertStartupOpen(deadline);
    if (confirmedProbe === "ready") {
      throw supervisorError(
        "socket_active",
        "socket",
        "A Codex app-server became active during stale-state confirmation."
      );
    }
    if (confirmedProbe === "missing") return;
    let removed: "removed" | "missing";
    try {
      removed = parseSocketRemoval(
        await this.config.socketPort.remove(this.config.socketPath, identity)
      );
    } catch (cause) {
      if (cause instanceof HostDeckCodexRuntimeSupervisorError) throw cause;
      throw supervisorError(
        "socket_cleanup_conflict",
        "socket",
        "Stale Codex socket could not be removed safely.",
        cause
      );
    }
    this.assertStartupOpen(deadline);
    if (removed === "removed") this.staleSocketRemoved = true;
    const after = await this.inspectSocket();
    if (after.state !== "missing") {
      throw supervisorError(
        "socket_cleanup_conflict",
        "socket",
        "Stale Codex socket cleanup did not leave the selected path empty."
      );
    }
  }

  private spawnForegroundChild(): void {
    if (this.config.mode !== "foreground_child" || this.child !== null) {
      throw supervisorError(
        "lifecycle_conflict",
        "spawn",
        "Codex foreground child ownership is already initialized."
      );
    }
    increment(this.counters, "spawnAttempts");
    let child: unknown;
    try {
      child = this.config.processPort.spawn(
        Object.freeze({
          executable: this.config.codexBin,
          args: Object.freeze([
            "app-server",
            "--listen",
            `unix://${this.config.socketPath}`
          ]) as CodexRuntimeProcessRequest["args"],
          cwd: "/"
        })
      );
    } catch (cause) {
      throw supervisorError(
        "process_start_failed",
        "spawn",
        "Codex app-server process could not be started.",
        cause
      );
    }
    let parsed: CodexRuntimeChildProcess;
    try {
      parsed = parseChildProcess(child);
    } catch (cause) {
      throw supervisorError(
        "port_contract_invalid",
        "spawn",
        "Codex process port returned an invalid child handle.",
        cause
      );
    }
    this.child = parsed;
    this.childExitPromise = Promise.resolve(parsed.exit).then(
      (exit) => {
        try {
          return this.observeChildExit(parseProcessExit(exit));
        } catch {
          this.childExitContractInvalid = true;
          return this.observeChildExit(
            Object.freeze({
              kind: "unknown",
              code: null,
              signal: null,
              spawn_failure: null
            })
          );
        }
      },
      () => {
        this.childExitContractInvalid = true;
        return this.observeChildExit(
          Object.freeze({
            kind: "unknown",
            code: null,
            signal: null,
            spawn_failure: null
          })
        );
      }
    );
  }

  private observeChildExit(
    exit:
      | CodexRuntimeProcessExit
      | {
          readonly kind: "unknown";
          readonly code: null;
          readonly signal: null;
          readonly spawn_failure: null;
        }
  ): CodexRuntimeProcessExitObservation {
    const expected = this.terminationRequested;
    const observation = Object.freeze({
      kind: exit.kind,
      expected,
      code: exit.code,
      signal: exit.signal
    });
    this.childSpawnFailure = exit.spawn_failure;
    this.childExit = observation;
    if (this.phase === "ready") {
      this.phase = "exited";
      this.socketReady = false;
    }
    return observation;
  }

  private async waitForReadySocket(
    deadline: OperationDeadline,
    signal: AbortSignal,
    requireOwnedChild: boolean
  ): Promise<void> {
    while (true) {
      this.assertStartupOpen(deadline);
      const before = await this.inspectSocket();
      this.assertStartupOpen(deadline);
      if (requireOwnedChild) this.requireRunningChild();
      if (before.state === "socket") {
        const probe = await this.probeSocket(signal);
        this.assertStartupOpen(deadline);
        if (probe === "ready") {
          if (requireOwnedChild) this.requireRunningChild();
          const after = await this.inspectSocket();
          if (
            after.state === "socket" &&
            after.identity === before.identity
          ) {
            if (requireOwnedChild) this.requireRunningChild();
            this.socketIdentity = requireSocketIdentity(after);
            this.socketReady = true;
            return;
          }
        }
      }
      increment(this.counters, "startupRetries");
      await this.waitForRetry(deadline, signal, requireOwnedChild);
    }
  }

  private async waitForRetry(
    deadline: OperationDeadline,
    signal: AbortSignal,
    requireOwnedChild: boolean
  ): Promise<void> {
    this.assertStartupOpen(deadline);
    const delay = deadline.timeoutMs(readinessRetryMilliseconds);
    let sleep: Promise<void>;
    try {
      sleep = this.config.clock.sleep(delay, signal);
      if (!(sleep instanceof Promise)) throw new TypeError();
    } catch (cause) {
      throw supervisorError(
        "port_contract_invalid",
        "readiness",
        "Codex supervisor clock returned an invalid retry wait.",
        cause
      );
    }
    try {
      if (!requireOwnedChild) {
        await sleep;
        return;
      }
      const exit = this.requireChildExitPromise();
      const winner = await Promise.race([
        sleep.then(() => "sleep" as const),
        exit.then(() => "exit" as const)
      ]);
      if (winner === "exit") this.requireRunningChild();
    } catch (cause) {
      if (signal.aborted) throw signal.reason;
      if (cause instanceof HostDeckCodexRuntimeSupervisorError) throw cause;
      throw supervisorError(
        "port_contract_invalid",
        "readiness",
        "Codex supervisor clock failed during a retry wait.",
        cause
      );
    }
  }

  private async inspectSocket(): Promise<ParsedSocketObservation> {
    let raw: unknown;
    try {
      raw = await this.config.socketPort.inspect(
        this.config.socketPath,
        Object.freeze({
          repair_mode: this.config.mode === "foreground_child"
        })
      );
    } catch (cause) {
      if (cause instanceof HostDeckCodexRuntimeSupervisorError) throw cause;
      throw supervisorError(
        cause instanceof HostDeckLocalPathError
          ? "socket_insecure"
          : "socket_unavailable",
        "socket",
        cause instanceof HostDeckLocalPathError
          ? "Codex app-server socket ownership or type is insecure."
          : "Codex app-server socket could not be inspected.",
        cause
      );
    }
    let observation: ParsedSocketObservation;
    try {
      observation = parseSocketObservation(raw);
    } catch (cause) {
      if (cause instanceof HostDeckCodexRuntimeSupervisorError) throw cause;
      throw supervisorError(
        "port_contract_invalid",
        "socket",
        "Codex socket port returned an invalid observation.",
        cause
      );
    }
    this.socketModeRepaired ||= observation.modeRepaired;
    return observation;
  }

  private async probeSocket(signal: AbortSignal): Promise<CodexRuntimeSocketProbe> {
    let raw: unknown;
    try {
      raw = await this.config.socketPort.probe(
        this.config.socketPath,
        signal
      );
    } catch (cause) {
      if (signal.aborted) throw signal.reason;
      throw supervisorError(
        "socket_unavailable",
        "socket",
        "Codex app-server socket readiness probe failed.",
        cause
      );
    }
    return parseSocketProbe(raw);
  }

  private requireRunningChild(): void {
    if (this.child === null) {
      throw supervisorError(
        "port_contract_invalid",
        "readiness",
        "Foreground Codex child is unavailable during readiness."
      );
    }
    let running: boolean;
    try {
      running = this.child.isRunning();
    } catch (cause) {
      throw supervisorError(
        "port_contract_invalid",
        "readiness",
        "Codex process port could not report child state.",
        cause
      );
    }
    if (typeof running !== "boolean") {
      throw supervisorError(
        "port_contract_invalid",
        "readiness",
        "Codex process port returned an invalid child state."
      );
    }
    if (this.childExitContractInvalid) {
      throw supervisorError(
        "port_contract_invalid",
        "readiness",
        "Codex process port returned invalid exit state."
      );
    }
    const exit = this.childExit;
    if (exit?.kind === "spawn_failed") {
      throw supervisorError(
        this.childSpawnFailure === "missing_binary"
          ? "binary_missing"
          : this.childSpawnFailure === "not_executable"
            ? "binary_not_executable"
            : "process_start_failed",
        "spawn",
        this.childSpawnFailure === "missing_binary"
          ? "Configured Codex executable is unavailable."
          : this.childSpawnFailure === "not_executable"
            ? "Configured Codex executable is not executable."
            : "Codex app-server process could not be started."
      );
    }
    if (exit !== null || !running) {
      throw supervisorError(
        "process_exited",
        "readiness",
        "Codex app-server exited before runtime readiness."
      );
    }
  }

  private requireChildExitPromise(): Promise<CodexRuntimeProcessExitObservation> {
    if (this.childExitPromise === null) {
      throw supervisorError(
        "port_contract_invalid",
        "readiness",
        "Codex process exit observation is unavailable."
      );
    }
    return this.childExitPromise;
  }

  private assertStartupOpen(deadline: OperationDeadline): void {
    if (this.lifecycleAbort.signal.aborted) {
      throw this.lifecycleAbort.signal.reason;
    }
    try {
      deadline.throwIfAborted();
    } catch (cause) {
      throw mapDeadlineFailure(cause);
    }
  }

  private mapStartupFailure(cause: unknown): HostDeckCodexRuntimeSupervisorError {
    if (cause instanceof HostDeckCodexRuntimeSupervisorError) return cause;
    if (cause instanceof OperationDeadlineExceededError) {
      return supervisorError(
        "startup_timeout",
        "readiness",
        "Codex runtime startup exceeded its deadline.",
        cause
      );
    }
    return supervisorError(
      "startup_aborted",
      "readiness",
      "Codex runtime startup was aborted.",
      cause
    );
  }

  private async cleanupAfterStartupFailure(
    budget: ResourceBudget
  ): Promise<unknown[]> {
    const errors: unknown[] = [];
    let socketSettled = this.child === null;
    if (this.config.mode === "foreground_child" && this.child !== null) {
      const deadline = createOperationDeadline({
        timeoutMs: budget.lifecycle_cleanup_step_timeout_ms
      });
      try {
        errors.push(...(await this.stopOwnedChild(deadline)));
        if (!this.safeChildRunning()) {
          const socketErrors = await this.removeOwnedSocket();
          errors.push(...socketErrors);
          socketSettled = socketErrors.length === 0;
        }
      } finally {
        deadline.dispose();
      }
    }
    const childStillRunning = this.child !== null && this.safeChildRunning();
    if (childStillRunning) this.scheduleLateExitCleanup();
    if (!childStillRunning && socketSettled) {
      try {
        this.releaseClaim();
      } catch (error) {
        errors.push(error);
      }
    }
    return errors;
  }

  private async stopOwnedChild(
    deadline: OperationDeadline
  ): Promise<unknown[]> {
    const errors: unknown[] = [];
    const child = this.child;
    if (child === null || !this.safeChildRunning()) return errors;
    this.terminationRequested = true;

    if (deadline.signal.aborted) {
      this.trySignalChild(child, "SIGKILL", errors);
      if (this.safeChildRunning()) {
        increment(this.counters, "cleanupFailures");
        errors.push(
          supervisorError(
            "shutdown_timeout",
            "shutdown",
            "Codex runtime shutdown exceeded its deadline."
          )
        );
      }
      return errors;
    }

    this.trySignalChild(child, "SIGTERM", errors);
    if (this.safeChildRunning()) {
      const remaining = safeDeadlineTimeout(deadline);
      if (remaining > 0) {
        const grace = Math.max(1, Math.floor(remaining / 2));
        await this.waitForChildOrDelay(grace, deadline.signal);
      }
    }
    if (this.safeChildRunning()) {
      this.trySignalChild(child, "SIGKILL", errors);
    }
    if (this.safeChildRunning() && !deadline.signal.aborted) {
      const remaining = safeDeadlineTimeout(deadline);
      if (remaining > 0) {
        await this.waitForChildOrDelay(remaining, deadline.signal);
      }
    }
    if (this.safeChildRunning()) {
      increment(this.counters, "cleanupFailures");
      errors.push(
        supervisorError(
          deadline.signal.aborted ? "shutdown_timeout" : "shutdown_failed",
          "shutdown",
          deadline.signal.aborted
            ? "Codex runtime shutdown exceeded its deadline."
            : "Owned Codex app-server did not terminate."
        )
      );
    }
    return errors;
  }

  private trySignalChild(
    child: CodexRuntimeChildProcess,
    signal: "SIGTERM" | "SIGKILL",
    errors: unknown[]
  ): void {
    increment(
      this.counters,
      signal === "SIGTERM" ? "termSignals" : "killSignals"
    );
    try {
      const accepted = child.signal(signal);
      if (typeof accepted !== "boolean" || (!accepted && this.safeChildRunning())) {
        throw new TypeError("Codex process port rejected an owned-child signal.");
      }
    } catch (cause) {
      increment(this.counters, "cleanupFailures");
      errors.push(
        supervisorError(
          "shutdown_failed",
          "shutdown",
          "Owned Codex app-server could not be signaled.",
          cause
        )
      );
    }
  }

  private async waitForChildOrDelay(
    milliseconds: number,
    signal: AbortSignal
  ): Promise<void> {
    if (!this.safeChildRunning()) return;
    try {
      await Promise.race([
        this.requireChildExitPromise().then(() => undefined),
        this.config.clock.sleep(milliseconds, signal)
      ]);
    } catch {}
  }

  private async removeOwnedSocket(): Promise<unknown[]> {
    const errors: unknown[] = [];
    let identity = this.socketIdentity;
    if (identity === null) {
      try {
        const observation = await this.inspectSocket();
        if (observation.state === "missing") return errors;
        identity = requireSocketIdentity(observation);
      } catch (error) {
        increment(this.counters, "cleanupFailures");
        errors.push(error);
        return errors;
      }
    }
    try {
      parseSocketRemoval(
        await this.config.socketPort.remove(this.config.socketPath, identity)
      );
      this.socketIdentity = null;
    } catch (cause) {
      increment(this.counters, "cleanupFailures");
      errors.push(
        supervisorError(
          "socket_cleanup_conflict",
          "shutdown",
          "Owned Codex socket could not be removed safely.",
          cause
        )
      );
    }
    return errors;
  }

  private scheduleLateExitCleanup(): void {
    if (
      this.lateExitCleanupScheduled ||
      this.config.mode !== "foreground_child" ||
      this.childExitPromise === null
    ) {
      return;
    }
    this.lateExitCleanupScheduled = true;
    void this.childExitPromise.then(async () => {
      if (this.safeChildRunning()) return;
      const socketErrors = await this.removeOwnedSocket();
      if (socketErrors.length > 0) return;
      try {
        this.releaseClaim();
        this.child = null;
        this.socketReady = false;
      } catch {
        increment(this.counters, "cleanupFailures");
      }
    });
  }

  private safeChildRunning(): boolean {
    if (this.child === null) return false;
    try {
      return this.child.isRunning() === true;
    } catch {
      return true;
    }
  }

  private processState(): CodexRuntimeSupervisorSnapshot["process_state"] {
    if (this.config.mode === "service_owned") return "not_applicable";
    if (this.childExit?.kind === "unknown") return "unknown";
    if (this.childExit !== null) return "exited";
    if (this.child === null) return "not_started";
    try {
      return this.child.isRunning() ? "running" : "unknown";
    } catch {
      return "unknown";
    }
  }
}

function parseSupervisorConfig(
  input: unknown
): ParsedSupervisorConfig {
  assertPlainDataObject(input, "Codex runtime supervisor input");
  const mode = dataProperty(input, "mode");
  if (mode === "foreground_child") {
    assertExactKeys(
      input,
      [
        "clock",
        "codex_bin",
        "mode",
        "process_port",
        "socket_path",
        "socket_port"
      ],
      ["mode", "codex_bin", "socket_path"],
      "Codex foreground supervisor input"
    );
    return Object.freeze({
      mode,
      codexBin: parseExecutablePath(dataProperty(input, "codex_bin")),
      socketPath: parseSocketPath(dataProperty(input, "socket_path")),
      processPort: parseProcessPort(
        optionalDataProperty(input, "process_port") ?? defaultProcessPort
      ),
      socketPort: parseSocketPort(
        optionalDataProperty(input, "socket_port") ?? defaultSocketPort
      ),
      clock: parseClock(optionalDataProperty(input, "clock") ?? defaultClock)
    });
  }
  if (mode === "service_owned") {
    assertExactKeys(
      input,
      ["clock", "mode", "socket_path", "socket_port"],
      ["mode", "socket_path"],
      "Codex service supervisor input"
    );
    return Object.freeze({
      mode,
      socketPath: parseSocketPath(dataProperty(input, "socket_path")),
      socketPort: parseSocketPort(
        optionalDataProperty(input, "socket_port") ?? defaultSocketPort
      ),
      clock: parseClock(optionalDataProperty(input, "clock") ?? defaultClock)
    });
  }
  throw new TypeError("Codex runtime supervisor mode is invalid.");
}

function parseStartInput(input: unknown): StartCodexRuntimeSupervisorInput {
  assertPlainDataObject(input, "Codex runtime supervisor start input");
  assertExactKeys(
    input,
    ["deadline", "resourceBudget"],
    ["deadline", "resourceBudget"],
    "Codex runtime supervisor start input"
  );
  const deadline = parseDeadline(dataProperty(input, "deadline"));
  const resourceBudget = dataProperty(input, "resourceBudget");
  assertResolvedResourceBudget(resourceBudget);
  if (!Object.isFrozen(resourceBudget)) {
    throw new TypeError("Codex runtime supervisor requires a frozen resource budget.");
  }
  const deadlineDuration = deadline.expiresAtMs - deadline.startedAtMs;
  if (
    !Number.isFinite(deadlineDuration) ||
    deadlineDuration < 1 ||
    deadlineDuration > resourceBudget.lifecycle_startup_timeout_ms + 0.001
  ) {
    throw new TypeError(
      "Codex runtime startup deadline exceeds the resolved lifecycle budget."
    );
  }
  return Object.freeze({ deadline, resourceBudget });
}

function parseCloseInput(input: unknown): CloseCodexRuntimeSupervisorInput {
  assertPlainDataObject(input, "Codex runtime supervisor close input");
  assertExactKeys(
    input,
    ["deadline"],
    ["deadline"],
    "Codex runtime supervisor close input"
  );
  return Object.freeze({ deadline: parseDeadline(dataProperty(input, "deadline")) });
}

function parseDeadline(value: unknown): OperationDeadline {
  assertPlainDataObject(value, "Operation deadline");
  assertExactKeys(
    value,
    [
      "dispose",
      "expiresAtMs",
      "remainingMs",
      "signal",
      "startedAtMs",
      "throwIfAborted",
      "timeoutMs"
    ],
    [
      "dispose",
      "expiresAtMs",
      "remainingMs",
      "signal",
      "startedAtMs",
      "throwIfAborted",
      "timeoutMs"
    ],
    "Operation deadline"
  );
  const candidate = value as unknown as OperationDeadline;
  if (
    !Object.isFrozen(candidate) ||
    !Number.isFinite(candidate.startedAtMs) ||
    candidate.startedAtMs < 0 ||
    !Number.isFinite(candidate.expiresAtMs) ||
    candidate.expiresAtMs < candidate.startedAtMs ||
    !(candidate.signal instanceof AbortSignal) ||
    typeof candidate.remainingMs !== "function" ||
    typeof candidate.timeoutMs !== "function" ||
    typeof candidate.throwIfAborted !== "function" ||
    typeof candidate.dispose !== "function"
  ) {
    throw new TypeError("Operation deadline contract is invalid.");
  }
  return candidate;
}

function parseProcessPort(value: unknown): CodexRuntimeProcessPort {
  assertPlainDataObject(value, "Codex runtime process port");
  assertExactKeys(
    value,
    ["spawn"],
    ["spawn"],
    "Codex runtime process port"
  );
  const spawnMethod = dataProperty(value, "spawn");
  if (typeof spawnMethod !== "function") {
    throw new TypeError("Codex runtime process port spawn must be a function.");
  }
  return value as CodexRuntimeProcessPort;
}

function parseSocketPort(value: unknown): CodexRuntimeSocketPort {
  assertPlainDataObject(value, "Codex runtime socket port");
  assertExactKeys(
    value,
    ["inspect", "probe", "remove"],
    ["inspect", "probe", "remove"],
    "Codex runtime socket port"
  );
  if (
    typeof dataProperty(value, "inspect") !== "function" ||
    typeof dataProperty(value, "probe") !== "function" ||
    typeof dataProperty(value, "remove") !== "function"
  ) {
    throw new TypeError("Codex runtime socket port methods are invalid.");
  }
  return value as CodexRuntimeSocketPort;
}

function parseClock(value: unknown): CodexRuntimeSupervisorClock {
  assertPlainDataObject(value, "Codex runtime supervisor clock");
  assertExactKeys(
    value,
    ["sleep"],
    ["sleep"],
    "Codex runtime supervisor clock"
  );
  if (typeof dataProperty(value, "sleep") !== "function") {
    throw new TypeError("Codex runtime supervisor clock sleep must be a function.");
  }
  return value as CodexRuntimeSupervisorClock;
}

function parseChildProcess(value: unknown): CodexRuntimeChildProcess {
  assertPlainDataObject(value, "Codex runtime child process");
  assertExactKeys(
    value,
    ["exit", "isRunning", "signal"],
    ["exit", "isRunning", "signal"],
    "Codex runtime child process"
  );
  const exit = dataProperty(value, "exit");
  if (
    !(exit instanceof Promise) ||
    typeof dataProperty(value, "isRunning") !== "function" ||
    typeof dataProperty(value, "signal") !== "function"
  ) {
    throw new TypeError("Codex runtime child process contract is invalid.");
  }
  return value as CodexRuntimeChildProcess;
}

function parseSocketObservation(value: unknown): ParsedSocketObservation {
  assertPlainDataObject(value, "Codex runtime socket observation");
  const state = dataProperty(value, "state");
  if (state === "missing") {
    assertExactKeys(
      value,
      ["state"],
      ["state"],
      "Missing Codex runtime socket observation"
    );
    return Object.freeze({
      state,
      identity: null,
      modeRepaired: false
    });
  }
  if (state === "socket") {
    assertExactKeys(
      value,
      ["identity", "mode_repaired", "state"],
      ["identity", "mode_repaired", "state"],
      "Present Codex runtime socket observation"
    );
    const identity = dataProperty(value, "identity");
    const modeRepaired = dataProperty(value, "mode_repaired");
    if (
      typeof identity !== "string" ||
      identity.length < 1 ||
      identity.length > 128 ||
      containsControl(identity) ||
      typeof modeRepaired !== "boolean"
    ) {
      throw supervisorError(
        "port_contract_invalid",
        "socket",
        "Codex socket port returned an invalid observation."
      );
    }
    return Object.freeze({ state, identity, modeRepaired });
  }
  throw supervisorError(
    "port_contract_invalid",
    "socket",
    "Codex socket port returned an unknown observation."
  );
}

function parseSocketProbe(value: unknown): CodexRuntimeSocketProbe {
  if (value !== "ready" && value !== "refused" && value !== "missing") {
    throw supervisorError(
      "port_contract_invalid",
      "socket",
      "Codex socket port returned an invalid readiness result."
    );
  }
  return value;
}

function parseSocketRemoval(value: unknown): "removed" | "missing" {
  if (value !== "removed" && value !== "missing") {
    throw supervisorError(
      "port_contract_invalid",
      "shutdown",
      "Codex socket port returned an invalid cleanup result."
    );
  }
  return value;
}

function parseProcessExit(value: unknown): CodexRuntimeProcessExit {
  assertPlainDataObject(value, "Codex runtime process exit");
  assertExactKeys(
    value,
    ["code", "kind", "signal", "spawn_failure"],
    ["code", "kind", "signal", "spawn_failure"],
    "Codex runtime process exit"
  );
  const kind = dataProperty(value, "kind");
  const code = dataProperty(value, "code");
  const signal = dataProperty(value, "signal");
  const spawnFailure = dataProperty(value, "spawn_failure");
  const validCode =
    code === null ||
    (typeof code === "number" &&
      Number.isSafeInteger(code) &&
      code >= 0 &&
      code <= 255);
  const validSignal =
    signal === null ||
    (typeof signal === "string" &&
      signal.length >= 1 &&
      signal.length <= 32 &&
      !containsControl(signal));
  const validSpawnFailure =
    spawnFailure === null ||
    spawnFailure === "missing_binary" ||
    spawnFailure === "not_executable" ||
    spawnFailure === "failed";
  const validShape =
    validCode &&
    validSignal &&
    validSpawnFailure &&
    ((kind === "exited" && code !== null && signal === null && spawnFailure === null) ||
      (kind === "signaled" && code === null && signal !== null && spawnFailure === null) ||
      (kind === "spawn_failed" && code === null && signal === null && spawnFailure !== null));
  if (!validShape) {
    throw supervisorError(
      "port_contract_invalid",
      "spawn",
      "Codex process port returned an invalid exit result."
    );
  }
  return Object.freeze({
    kind,
    code,
    signal,
    spawn_failure: spawnFailure
  }) as CodexRuntimeProcessExit;
}

function parseSocketPath(value: unknown): string {
  if (
    typeof value !== "string" ||
    !isAbsolute(value) ||
    value === "/" ||
    normalize(value) !== value ||
    basename(value) !== selectedSocketName ||
    Buffer.byteLength(value, "utf8") > maxUnixSocketPathBytes ||
    containsControl(value) ||
    [":", "?", "#", "%"].some((character) => value.includes(character))
  ) {
    throw new TypeError(
      "Codex runtime socket_path must be the canonical absolute private app-server.sock path."
    );
  }
  return value;
}

function parseExecutablePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    !isAbsolute(value) ||
    value === "/" ||
    normalize(value) !== value ||
    Buffer.byteLength(value, "utf8") > maxExecutablePathBytes ||
    containsControl(value)
  ) {
    throw new TypeError(
      "Codex foreground executable must be a canonical absolute path."
    );
  }
  return value;
}

function safeDeadlineTimeout(deadline: OperationDeadline): number {
  if (deadline.signal.aborted) return 0;
  try {
    return deadline.timeoutMs();
  } catch {
    return 0;
  }
}

function mapDeadlineFailure(
  cause: unknown
): HostDeckCodexRuntimeSupervisorError {
  if (cause instanceof HostDeckCodexRuntimeSupervisorError) return cause;
  if (cause instanceof OperationDeadlineExceededError) {
    return supervisorError(
      "startup_timeout",
      "readiness",
      "Codex runtime startup exceeded its deadline.",
      cause
    );
  }
  return supervisorError(
    "startup_aborted",
    "readiness",
    "Codex runtime startup was aborted.",
    cause
  );
}

function requireSocketIdentity(
  observation: ParsedSocketObservation
): string {
  if (observation.state !== "socket" || observation.identity === null) {
    throw supervisorError(
      "port_contract_invalid",
      "socket",
      "Codex socket identity is unavailable."
    );
  }
  return observation.identity;
}

function increment(
  counters: MutableCounters,
  key: keyof MutableCounters
): void {
  counters[key] = Math.min(Number.MAX_SAFE_INTEGER, counters[key] + 1);
}

function supervisorError(
  code: CodexRuntimeSupervisorErrorCode,
  stage: CodexRuntimeSupervisorStage,
  message: string,
  cause?: unknown
): HostDeckCodexRuntimeSupervisorError {
  return new HostDeckCodexRuntimeSupervisorError(
    code,
    stage,
    message,
    cause
  );
}

function assertPlainDataObject(value: unknown, label: string): asserts value is object {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null) ||
    Object.getOwnPropertySymbols(value).length > 0
  ) {
    throw new TypeError(`${label} must be a plain data object.`);
  }
  for (const descriptor of Object.values(
    Object.getOwnPropertyDescriptors(value)
  )) {
    if (
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      descriptor.enumerable !== true
    ) {
      throw new TypeError(`${label} must contain enumerable data properties only.`);
    }
  }
}

function assertExactKeys(
  value: object,
  allowed: readonly string[],
  required: readonly string[],
  label: string
): void {
  const keys = Object.keys(value);
  if (
    keys.some((key) => !allowed.includes(key)) ||
    required.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new TypeError(`${label} has an invalid property set.`);
  }
}

function dataProperty(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (
    descriptor === undefined ||
    descriptor.get !== undefined ||
    descriptor.set !== undefined
  ) {
    throw new TypeError(`Required data property ${key} is unavailable.`);
  }
  return descriptor.value;
}

function optionalDataProperty(value: object, key: string): unknown {
  if (!Object.hasOwn(value, key)) return undefined;
  return dataProperty(value, key);
}

function containsControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}
