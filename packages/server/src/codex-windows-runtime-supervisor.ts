import { randomBytes } from "node:crypto";
import { win32 } from "node:path";
import {
  type CodexAuthenticatedLoopbackWebSocketEndpoint,
  type CodexProtectedEnvironmentCredentialSource,
  codexRemoteAuthEnvironmentVariable,
  parseCodexLocalEndpoint
} from "@hostdeck/codex-adapter";
import {
  assertResolvedResourceBudget,
  deepFreezeExactData, 
  type ResourceBudget
} from "@hostdeck/contracts";
import {
  createOperationDeadline,
  type OperationDeadline,
  OperationDeadlineExceededError
} from "@hostdeck/core";
import {
  nodeCodexWindowsRuntimeAuthorityPort,
  nodeCodexWindowsRuntimeProcessPort,
  nodeCodexWindowsRuntimeReadinessPort
} from "./codex-windows-runtime-supervisor-node.js";

export const codexWindowsRuntimeSupervisorPhases = Object.freeze([
  "idle",
  "starting",
  "ready",
  "restarting",
  "exited",
  "closing",
  "closed",
  "failed"
] as const);

export type CodexWindowsRuntimeSupervisorPhase =
  (typeof codexWindowsRuntimeSupervisorPhases)[number];

export const codexWindowsRuntimeSupervisorErrorCodes = Object.freeze([
  "invalid_config",
  "unsupported_platform",
  "duplicate_supervisor",
  "authority_failed",
  "process_start_failed",
  "process_exited",
  "endpoint_invalid",
  "endpoint_not_rotated",
  "readiness_failed",
  "startup_timeout",
  "startup_aborted",
  "lifecycle_conflict",
  "shutdown_failed",
  "shutdown_timeout",
  "port_contract_invalid"
] as const);

export type CodexWindowsRuntimeSupervisorErrorCode =
  (typeof codexWindowsRuntimeSupervisorErrorCodes)[number];

export type CodexWindowsRuntimeSupervisorStage =
  | "configuration"
  | "claim"
  | "credential"
  | "spawn"
  | "endpoint"
  | "readiness"
  | "shutdown";

export type CodexWindowsRuntimeProcessExitKind =
  | "exited"
  | "spawn_failed"
  | "terminated"
  | "unknown";

export interface CodexWindowsRuntimeProcessExit {
  readonly kind: Exclude<CodexWindowsRuntimeProcessExitKind, "unknown">;
  readonly code: number | null;
  readonly spawn_failure:
    | "missing_binary"
    | "not_executable"
    | "failed"
    | null;
}

export interface CodexWindowsRuntimeProcessExitObservation {
  readonly kind: CodexWindowsRuntimeProcessExitKind;
  readonly expected: boolean;
  readonly code: number | null;
}

export interface CodexWindowsRuntimeProcessRequest {
  readonly executable: string;
  readonly args: readonly [
    "app-server",
    "--strict-config",
    "--listen",
    "ws://127.0.0.1:0",
    "--ws-auth",
    "capability-token",
    "--ws-token-file",
    string
  ];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
}

export interface CodexWindowsRuntimeChildProcess {
  readonly endpoint: Promise<unknown>;
  readonly exit: Promise<CodexWindowsRuntimeProcessExit>;
  readonly isRunning: () => boolean;
  readonly terminateTree: () => boolean;
}

export interface CodexWindowsRuntimeProcessPort {
  readonly spawn: (
    request: CodexWindowsRuntimeProcessRequest
  ) => CodexWindowsRuntimeChildProcess;
}

export interface CodexWindowsRuntimeAuthorityStage {
  readonly credential_path: string;
  readonly replaced_stale_credential: boolean;
}

export interface CodexWindowsRuntimeAuthority {
  readonly stageCredential: (
    credential: string
  ) => CodexWindowsRuntimeAuthorityStage;
  readonly discardCredential: () => void;
  readonly release: () => void;
}

export interface CodexWindowsRuntimeAuthorityPort {
  readonly tryAcquire: (
    endpointFilePath: string
  ) => CodexWindowsRuntimeAuthority | null;
}

export interface CodexWindowsRuntimeReadinessInput {
  readonly endpoint: CodexAuthenticatedLoopbackWebSocketEndpoint;
  readonly credential: CodexProtectedEnvironmentCredentialSource;
  readonly signal: AbortSignal;
  readonly resource_budget: ResourceBudget;
}

export interface CodexWindowsRuntimeReadinessPort {
  readonly authenticate: (
    input: CodexWindowsRuntimeReadinessInput
  ) => void | Promise<void>;
}

export interface StartCodexWindowsRuntimeSupervisorInput {
  readonly deadline: OperationDeadline;
  readonly resourceBudget: ResourceBudget;
}

export interface CloseCodexWindowsRuntimeSupervisorInput {
  readonly deadline: OperationDeadline;
}

export interface StartedCodexWindowsRuntime {
  readonly target: "windows-x64";
  readonly ownership: "owned_child";
  readonly generation: number;
  readonly endpoint: CodexAuthenticatedLoopbackWebSocketEndpoint;
  readonly credential: CodexProtectedEnvironmentCredentialSource;
  readonly credential_file_removed: true;
  readonly process_exit: Promise<CodexWindowsRuntimeProcessExitObservation>;
}

export interface CodexWindowsRuntimeSupervisorSnapshot {
  readonly target: "windows-x64";
  readonly phase: CodexWindowsRuntimeSupervisorPhase;
  readonly ownership: "owned_child";
  readonly claim_held: boolean;
  readonly endpoint_ready: boolean;
  readonly credential_file_present: boolean;
  readonly generation: number;
  readonly process_state:
    | "not_started"
    | "running"
    | "exited"
    | "unknown";
  readonly process_exit: CodexWindowsRuntimeProcessExitObservation | null;
  readonly spawn_attempts: number;
  readonly restart_attempts: number;
  readonly tree_terminations: number;
  readonly stale_credential_replacements: number;
  readonly cleanup_failures: number;
}

export interface HostDeckCodexWindowsRuntimeSupervisor {
  readonly start: (
    input: StartCodexWindowsRuntimeSupervisorInput
  ) => Promise<StartedCodexWindowsRuntime>;
  readonly restart: (
    input: StartCodexWindowsRuntimeSupervisorInput
  ) => Promise<StartedCodexWindowsRuntime>;
  readonly close: (
    input: CloseCodexWindowsRuntimeSupervisorInput
  ) => Promise<void>;
  readonly snapshot: () => CodexWindowsRuntimeSupervisorSnapshot;
}

export interface CreateCodexWindowsRuntimeSupervisorInput {
  readonly codex_bin: string;
  readonly cwd: string;
  readonly endpoint_file_path: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly authority_port?: CodexWindowsRuntimeAuthorityPort;
  readonly process_port?: CodexWindowsRuntimeProcessPort;
  readonly readiness_port?: CodexWindowsRuntimeReadinessPort;
  readonly credential_factory?: () => string;
  readonly platform_port?: () => string;
}

export class HostDeckCodexWindowsRuntimeSupervisorError extends Error {
  constructor(
    readonly code: CodexWindowsRuntimeSupervisorErrorCode,
    readonly stage: CodexWindowsRuntimeSupervisorStage,
    message: string
  ) {
    super(message);
    this.name = "HostDeckCodexWindowsRuntimeSupervisorError";
  }
}

interface ParsedSupervisorConfig {
  readonly codexBin: string;
  readonly cwd: string;
  readonly endpointFilePath: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly authorityPort: CodexWindowsRuntimeAuthorityPort;
  readonly processPort: CodexWindowsRuntimeProcessPort;
  readonly readinessPort: CodexWindowsRuntimeReadinessPort;
  readonly credentialFactory: () => string;
  readonly platformPort: () => string;
}

interface MutableCounters {
  spawnAttempts: number;
  restartAttempts: number;
  treeTerminations: number;
  staleCredentialReplacements: number;
  cleanupFailures: number;
}

const endpointListenAddress = "ws://127.0.0.1:0" as const;
const endpointFileName = "app-server.endpoint";
const maximumPathBytes = 32_767 * 3;
const maximumEnvironmentValueBytes = 32_767 * 3;
const maximumEnvironmentBytes = 128 * 1_024;
const maximumEndpointRotationAttempts = 3;
const credentialPattern = /^[A-Za-z0-9_-]{43,512}$/u;

export const codexWindowsRuntimeEnvironmentAllowlist = Object.freeze([
  "ALL_PROXY",
  "APPDATA",
  "CI",
  "CODEX_HOME",
  "CODEX_MANAGED_BY_PNPM",
  "CODEX_MANAGED_PACKAGE_ROOT",
  "COMSPEC",
  "HOMEDRIVE",
  "HOMEPATH",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "LOCALAPPDATA",
  "NO_COLOR",
  "NO_PROXY",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_ORGANIZATION",
  "OPENAI_PROJECT",
  "PATH",
  "PATHEXT",
  "PROGRAMDATA",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "TZ",
  "USERPROFILE",
  "WINDIR"
] as const);

export function createCodexWindowsRuntimeSupervisor(
  input: CreateCodexWindowsRuntimeSupervisorInput
): HostDeckCodexWindowsRuntimeSupervisor {
  return new DefaultCodexWindowsRuntimeSupervisor(parseSupervisorConfig(input));
}

export function buildCodexWindowsRuntimeEnvironment(
  source: Readonly<Record<string, string | undefined>>
): Readonly<Record<string, string>> {
  if (source === null || typeof source !== "object" || Array.isArray(source)) {
    throw new TypeError("Codex Windows inherited environment is invalid.");
  }
  const byCanonicalName = new Map<string, string>();
  for (const key of Object.keys(source)) {
    const canonical = key.toUpperCase();
    if (!codexWindowsRuntimeEnvironmentAllowlist.includes(canonical as never)) {
      continue;
    }
    const value = source[key];
    if (
      value === undefined ||
      typeof value !== "string" ||
      value.includes("\0") ||
      Buffer.byteLength(value, "utf8") > maximumEnvironmentValueBytes
    ) {
      throw new TypeError("Codex Windows inherited environment is invalid.");
    }
    const existing = byCanonicalName.get(canonical);
    if (existing !== undefined && existing !== value) {
      throw new TypeError("Codex Windows inherited environment is ambiguous.");
    }
    byCanonicalName.set(canonical, value);
  }
  byCanonicalName.set("NO_COLOR", "1");
  const entries = [...byCanonicalName.entries()].sort(([left], [right]) =>
    left.localeCompare(right)
  );
  const totalBytes = entries.reduce(
    (total, [name, value]) => total + Buffer.byteLength(`${name}=${value}\0`, "utf8"),
    1
  );
  if (totalBytes > maximumEnvironmentBytes) {
    throw new TypeError("Codex Windows inherited environment exceeds its bound.");
  }
  return Object.freeze(Object.fromEntries(entries));
}

class DefaultCodexWindowsRuntimeSupervisor
  implements HostDeckCodexWindowsRuntimeSupervisor
{
  private readonly lifecycleAbort = new AbortController();
  private readonly counters: MutableCounters = {
    spawnAttempts: 0,
    restartAttempts: 0,
    treeTerminations: 0,
    staleCredentialReplacements: 0,
    cleanupFailures: 0
  };
  private phase: CodexWindowsRuntimeSupervisorPhase = "idle";
  private authority: CodexWindowsRuntimeAuthority | null = null;
  private child: CodexWindowsRuntimeChildProcess | null = null;
  private childExitPromise: Promise<CodexWindowsRuntimeProcessExitObservation> | null = null;
  private childExit: CodexWindowsRuntimeProcessExitObservation | null = null;
  private endpoint: CodexAuthenticatedLoopbackWebSocketEndpoint | null = null;
  private endpointReady = false;
  private credentialFilePresent = false;
  private activeCredential: string | null = null;
  private activeCredentialGeneration: number | null = null;
  private previousCredential: string | null = null;
  private generation = 0;
  private terminationExpected = false;
  private operationPromise: Promise<StartedCodexWindowsRuntime> | null = null;
  private closePromise: Promise<void> | null = null;

  constructor(private readonly config: ParsedSupervisorConfig) {}

  start(
    input: StartCodexWindowsRuntimeSupervisorInput
  ): Promise<StartedCodexWindowsRuntime> {
    let parsed: StartCodexWindowsRuntimeSupervisorInput;
    try {
      parsed = parseStartInput(input);
      this.assertPlatform();
    } catch (cause) {
      if (cause instanceof HostDeckCodexWindowsRuntimeSupervisorError) {
        return Promise.reject(cause);
      }
      return Promise.reject(
        runtimeError(
          "invalid_config",
          "configuration",
          "Codex Windows runtime supervisor configuration is invalid."
        )
      );
    }
    if (this.phase !== "idle" || this.operationPromise !== null) {
      return Promise.reject(lifecycleConflict());
    }
    this.phase = "starting";
    this.operationPromise = this.startInternal(parsed);
    return this.operationPromise;
  }

  restart(
    input: StartCodexWindowsRuntimeSupervisorInput
  ): Promise<StartedCodexWindowsRuntime> {
    let parsed: StartCodexWindowsRuntimeSupervisorInput;
    try {
      parsed = parseStartInput(input);
      this.assertPlatform();
    } catch (cause) {
      if (cause instanceof HostDeckCodexWindowsRuntimeSupervisorError) {
        return Promise.reject(cause);
      }
      return Promise.reject(
        runtimeError(
          "invalid_config",
          "configuration",
          "Codex Windows runtime supervisor restart input is invalid."
        )
      );
    }
    if (
      (this.phase !== "ready" && this.phase !== "exited") ||
      this.operationPromise !== null ||
      this.closePromise !== null ||
      this.authority === null
    ) {
      return Promise.reject(lifecycleConflict());
    }
    this.phase = "restarting";
    increment(this.counters, "restartAttempts");
    this.operationPromise = this.restartInternal(parsed).finally(() => {
      this.operationPromise = null;
    });
    return this.operationPromise;
  }

  close(input: CloseCodexWindowsRuntimeSupervisorInput): Promise<void> {
    let parsed: CloseCodexWindowsRuntimeSupervisorInput;
    try {
      parsed = parseCloseInput(input);
    } catch {
      return Promise.reject(
        runtimeError(
          "invalid_config",
          "shutdown",
          "Codex Windows runtime supervisor close input is invalid."
        )
      );
    }
    if (this.closePromise !== null) return this.closePromise;
    this.lifecycleAbort.abort();
    const closePromise = this.closeInternal(parsed.deadline);
    this.closePromise = closePromise;
    void closePromise.catch(() => {
      if (this.closePromise === closePromise) this.closePromise = null;
    });
    return closePromise;
  }

  snapshot(): CodexWindowsRuntimeSupervisorSnapshot {
    return deepFreezeExactData({
      target: "windows-x64" as const,
      phase: this.phase,
      ownership: "owned_child" as const,
      claim_held: this.authority !== null,
      endpoint_ready: this.endpointReady,
      credential_file_present: this.credentialFilePresent,
      generation: this.generation,
      process_state: this.processState(),
      process_exit:
        this.childExit === null ? null : Object.freeze({ ...this.childExit }),
      spawn_attempts: this.counters.spawnAttempts,
      restart_attempts: this.counters.restartAttempts,
      tree_terminations: this.counters.treeTerminations,
      stale_credential_replacements:
        this.counters.staleCredentialReplacements,
      cleanup_failures: this.counters.cleanupFailures
    });
  }

  private async startInternal(
    input: StartCodexWindowsRuntimeSupervisorInput
  ): Promise<StartedCodexWindowsRuntime> {
    try {
      this.acquireAuthority();
      const started = await this.launchGeneration(input, null);
      this.operationPromise = null;
      return started;
    } catch (cause) {
      const primary = this.mapStartupFailure(cause);
      await this.cleanupAfterFailure(input.resourceBudget);
      this.phase = "failed";
      this.operationPromise = null;
      throw primary;
    }
  }

  private async restartInternal(
    input: StartCodexWindowsRuntimeSupervisorInput
  ): Promise<StartedCodexWindowsRuntime> {
    const previousAddress = this.endpoint?.address ?? null;
    try {
      await this.stopCurrentChild(input.deadline);
      return await this.launchGeneration(input, previousAddress);
    } catch (cause) {
      const primary = this.mapStartupFailure(cause);
      await this.cleanupAfterFailure(input.resourceBudget);
      this.phase = "failed";
      throw primary;
    }
  }

  private async launchGeneration(
    input: StartCodexWindowsRuntimeSupervisorInput,
    previousAddress: string | null
  ): Promise<StartedCodexWindowsRuntime> {
    const signal = AbortSignal.any([
      input.deadline.signal,
      this.lifecycleAbort.signal
    ]);
    let observedSameEndpoint = false;
    for (
      let attempt = 1;
      attempt <= maximumEndpointRotationAttempts;
      attempt += 1
    ) {
      this.assertStartupOpen(input.deadline);
      const token = this.createCredential();
      const stage = this.stageCredential(token);
      const child = this.spawnChild(stage.credential_path);
      const candidateGeneration = this.generation + 1;
      this.child = child;
      this.childExit = null;
      this.terminationExpected = false;
      this.childExitPromise = this.observeExit(child, candidateGeneration);

      let endpoint: CodexAuthenticatedLoopbackWebSocketEndpoint;
      try {
        endpoint = await this.waitForEndpoint(child, signal);
      } catch (cause) {
        throw this.mapEndpointFailure(cause);
      }
      if (previousAddress !== null && endpoint.address === previousAddress) {
        observedSameEndpoint = true;
        await this.stopCurrentChild(input.deadline);
        continue;
      }

      this.endpoint = endpoint;
      this.activeCredential = token;
      this.activeCredentialGeneration = candidateGeneration;
      const credential = this.createCredentialSource(
        token,
        candidateGeneration
      );
      try {
        await this.waitForReadiness(
          endpoint,
          credential,
          child,
          signal,
          input.resourceBudget
        );
      } catch (cause) {
        throw this.mapReadinessFailure(cause);
      }
      this.discardCredential();
      this.assertStartupOpen(input.deadline);
      this.requireRunningChild(child);
      this.generation = candidateGeneration;
      this.endpointReady = true;
      this.phase = "ready";
      const exit = this.requireChildExitPromise();
      return Object.freeze({
        target: "windows-x64",
        ownership: "owned_child",
        generation: candidateGeneration,
        endpoint,
        credential,
        credential_file_removed: true,
        process_exit: exit
      });
    }
    throw runtimeError(
      observedSameEndpoint ? "endpoint_not_rotated" : "endpoint_invalid",
      "endpoint",
      observedSameEndpoint
        ? "Codex Windows runtime did not rotate its ephemeral endpoint."
        : "Codex Windows runtime endpoint could not be established."
    );
  }

  private acquireAuthority(): void {
    if (this.authority !== null) throw lifecycleConflict();
    let acquired: unknown;
    try {
      acquired = this.config.authorityPort.tryAcquire(
        this.config.endpointFilePath
      );
    } catch {
      throw runtimeError(
        "authority_failed",
        "claim",
        "Codex Windows runtime ownership could not be established."
      );
    }
    if (acquired === null) {
      throw runtimeError(
        "duplicate_supervisor",
        "claim",
        "Another HostDeck process owns the Codex Windows runtime."
      );
    }
    this.authority = parseAuthority(acquired);
  }

  private stageCredential(
    credential: string
  ): CodexWindowsRuntimeAuthorityStage {
    const authority = this.requireAuthority();
    let stage: unknown;
    try {
      stage = authority.stageCredential(credential);
    } catch {
      throw runtimeError(
        "authority_failed",
        "credential",
        "Codex Windows runtime credential could not be staged."
      );
    }
    const parsed = parseAuthorityStage(stage, this.config.endpointFilePath);
    this.credentialFilePresent = true;
    if (parsed.replaced_stale_credential) {
      increment(this.counters, "staleCredentialReplacements");
    }
    return parsed;
  }

  private discardCredential(): void {
    if (!this.credentialFilePresent) return;
    try {
      this.requireAuthority().discardCredential();
      this.credentialFilePresent = false;
    } catch {
      throw runtimeError(
        "authority_failed",
        "credential",
        "Codex Windows runtime credential cleanup failed."
      );
    }
  }

  private spawnChild(
    credentialPath: string
  ): CodexWindowsRuntimeChildProcess {
    increment(this.counters, "spawnAttempts");
    let child: unknown;
    try {
      child = this.config.processPort.spawn(
        Object.freeze({
          executable: this.config.codexBin,
          args: Object.freeze([
            "app-server",
            "--strict-config",
            "--listen",
            endpointListenAddress,
            "--ws-auth",
            "capability-token",
            "--ws-token-file",
            credentialPath
          ]) as CodexWindowsRuntimeProcessRequest["args"],
          cwd: this.config.cwd,
          environment: this.config.environment
        })
      );
    } catch {
      throw runtimeError(
        "process_start_failed",
        "spawn",
        "Codex Windows app-server process could not be started."
      );
    }
    return parseChild(child);
  }

  private observeExit(
    child: CodexWindowsRuntimeChildProcess,
    generation: number
  ): Promise<CodexWindowsRuntimeProcessExitObservation> {
    return Promise.resolve(child.exit).then(
      (candidate) => {
        let exit: CodexWindowsRuntimeProcessExit;
        try {
          exit = parseProcessExit(candidate);
        } catch {
          exit = Object.freeze({
            kind: "spawn_failed",
            code: null,
            spawn_failure: "failed"
          });
        }
        return this.recordExit(child, generation, exit);
      },
      () =>
        this.recordExit(
          child,
          generation,
          Object.freeze({
            kind: "spawn_failed",
            code: null,
            spawn_failure: "failed"
          })
        )
    );
  }

  private recordExit(
    child: CodexWindowsRuntimeChildProcess,
    generation: number,
    exit: CodexWindowsRuntimeProcessExit
  ): CodexWindowsRuntimeProcessExitObservation {
    const current = this.child === child;
    const observation = Object.freeze({
      kind: exit.kind,
      expected: current && this.terminationExpected,
      code: exit.code
    });
    if (current) {
      this.childExit = observation;
      this.endpointReady = false;
      this.invalidateCredential();
      if (this.phase === "ready" && generation === this.generation) {
        this.phase = "exited";
      }
    }
    return observation;
  }

  private async waitForEndpoint(
    child: CodexWindowsRuntimeChildProcess,
    signal: AbortSignal
  ): Promise<CodexAuthenticatedLoopbackWebSocketEndpoint> {
    const winner = await raceWithSignal(
      Promise.race([
        child.endpoint.then((endpoint) => ({ kind: "endpoint" as const, endpoint })),
        this.requireChildExitPromise().then((exit) => ({ kind: "exit" as const, exit }))
      ]),
      signal
    );
    if (winner.kind === "exit") {
      throw runtimeError(
        "process_exited",
        "endpoint",
        "Codex Windows app-server exited before endpoint discovery."
      );
    }
    const endpoint = parseCodexLocalEndpoint(winner.endpoint);
    if (endpoint.kind !== "authenticated_loopback_websocket") {
      throw runtimeError(
        "endpoint_invalid",
        "endpoint",
        "Codex Windows app-server returned an invalid private endpoint."
      );
    }
    this.requireRunningChild(child);
    return endpoint;
  }

  private async waitForReadiness(
    endpoint: CodexAuthenticatedLoopbackWebSocketEndpoint,
    credential: CodexProtectedEnvironmentCredentialSource,
    child: CodexWindowsRuntimeChildProcess,
    signal: AbortSignal,
    resourceBudget: ResourceBudget
  ): Promise<void> {
    let readiness: Promise<void>;
    try {
      readiness = Promise.resolve(
        this.config.readinessPort.authenticate(
          Object.freeze({
            endpoint,
            credential,
            signal,
            resource_budget: resourceBudget
          })
        )
      );
    } catch {
      throw runtimeError(
        "readiness_failed",
        "readiness",
        "Codex Windows app-server authentication failed."
      );
    }
    const winner = await raceWithSignal(
      Promise.race([
        readiness.then(() => "ready" as const),
        this.requireChildExitPromise().then(() => "exit" as const)
      ]),
      signal
    );
    if (winner === "exit") {
      throw runtimeError(
        "process_exited",
        "readiness",
        "Codex Windows app-server exited before authenticated readiness."
      );
    }
    this.requireRunningChild(child);
  }

  private createCredential(): string {
    let credential: unknown;
    try {
      credential = this.config.credentialFactory();
    } catch {
      throw runtimeError(
        "authority_failed",
        "credential",
        "Codex Windows runtime credential generation failed."
      );
    }
    if (
      typeof credential !== "string" ||
      !credentialPattern.test(credential) ||
      credential === this.previousCredential
    ) {
      throw runtimeError(
        "port_contract_invalid",
        "credential",
        "Codex Windows runtime credential generator returned invalid data."
      );
    }
    this.previousCredential = credential;
    return credential;
  }

  private createCredentialSource(
    token: string,
    generation: number
  ): CodexProtectedEnvironmentCredentialSource {
    return Object.freeze({
      kind: "protected_environment",
      environment_variable: codexRemoteAuthEnvironmentVariable,
      read: (name: string): string | undefined =>
        name === codexRemoteAuthEnvironmentVariable &&
        this.activeCredential === token &&
        this.activeCredentialGeneration === generation
          ? token
          : undefined
    });
  }

  private async stopCurrentChild(deadline: OperationDeadline): Promise<void> {
    this.endpointReady = false;
    this.invalidateCredential();
    let cleanupFailure: HostDeckCodexWindowsRuntimeSupervisorError | null = null;
    if (this.credentialFilePresent) {
      try {
        this.discardCredential();
      } catch (cause) {
        cleanupFailure = mapShutdownFailure(cause);
      }
    }
    const child = this.child;
    if (child === null) {
      if (cleanupFailure !== null) throw cleanupFailure;
      return;
    }
    if (safeRunning(child)) {
      this.terminationExpected = true;
      increment(this.counters, "treeTerminations");
      let accepted: unknown;
      try {
        accepted = child.terminateTree();
      } catch {
        cleanupFailure = runtimeError(
          "shutdown_failed",
          "shutdown",
          "Owned Codex Windows process tree could not be terminated."
        );
      }
      if (accepted !== true && safeRunning(child)) {
        cleanupFailure = runtimeError(
          "shutdown_failed",
          "shutdown",
          "Owned Codex Windows process tree rejected termination."
        );
      }
    }
    if (this.childExit === null) {
      try {
        await raceWithSignal(this.requireChildExitPromise(), deadline.signal);
      } catch {
        cleanupFailure = runtimeError(
          deadline.signal.aborted ? "shutdown_timeout" : "shutdown_failed",
          "shutdown",
          deadline.signal.aborted
            ? "Codex Windows runtime shutdown exceeded its deadline."
            : "Owned Codex Windows process tree did not terminate."
        );
      }
    }
    if (safeRunning(child)) {
      throw runtimeError(
        "shutdown_failed",
        "shutdown",
        "Owned Codex Windows process tree remained active."
      );
    }
    this.child = null;
    this.childExitPromise = null;
    this.endpoint = null;
    this.terminationExpected = false;
    if (cleanupFailure !== null) throw cleanupFailure;
  }

  private async closeInternal(deadline: OperationDeadline): Promise<void> {
    if (this.phase === "idle") {
      this.phase = "closed";
      return;
    }
    if (this.operationPromise !== null) {
      try {
        await this.operationPromise;
      } catch {
        // The operation keeps its own primary error; close still verifies cleanup.
      }
    }
    this.phase = "closing";
    let failed = false;
    try {
      await this.stopCurrentChild(deadline);
    } catch {
      failed = true;
      increment(this.counters, "cleanupFailures");
    }
    if (this.child === null) {
      try {
        this.releaseAuthority();
      } catch {
        failed = true;
        increment(this.counters, "cleanupFailures");
      }
    }
    this.endpointReady = false;
    this.invalidateCredential();
    if (failed) {
      this.phase = "failed";
      throw runtimeError(
        deadline.signal.aborted ? "shutdown_timeout" : "shutdown_failed",
        "shutdown",
        deadline.signal.aborted
          ? "Codex Windows runtime shutdown exceeded its deadline."
          : "Codex Windows runtime shutdown did not complete cleanly."
      );
    }
    this.phase = "closed";
  }

  private async cleanupAfterFailure(budget: ResourceBudget): Promise<void> {
    const deadline = createOperationDeadline({
      timeoutMs: budget.lifecycle_cleanup_step_timeout_ms
    });
    try {
      try {
        await this.stopCurrentChild(deadline);
      } catch {
        increment(this.counters, "cleanupFailures");
      }
      if (this.child === null) {
        try {
          this.releaseAuthority();
        } catch {
          increment(this.counters, "cleanupFailures");
        }
      }
    } finally {
      deadline.dispose();
    }
  }

  private releaseAuthority(): void {
    const authority = this.authority;
    if (authority === null) return;
    if (this.credentialFilePresent) this.discardCredential();
    try {
      authority.release();
      this.authority = null;
    } catch {
      throw runtimeError(
        "authority_failed",
        "shutdown",
        "Codex Windows runtime ownership could not be released."
      );
    }
  }

  private invalidateCredential(): void {
    this.activeCredential = null;
    this.activeCredentialGeneration = null;
  }

  private requireAuthority(): CodexWindowsRuntimeAuthority {
    if (this.authority === null) {
      throw runtimeError(
        "port_contract_invalid",
        "claim",
        "Codex Windows runtime authority is unavailable."
      );
    }
    return this.authority;
  }

  private requireChildExitPromise(): Promise<CodexWindowsRuntimeProcessExitObservation> {
    if (this.childExitPromise === null) {
      throw runtimeError(
        "port_contract_invalid",
        "spawn",
        "Codex Windows process exit observation is unavailable."
      );
    }
    return this.childExitPromise;
  }

  private requireRunningChild(child: CodexWindowsRuntimeChildProcess): void {
    if (this.child !== child || !safeRunning(child)) {
      throw runtimeError(
        "process_exited",
        "readiness",
        "Codex Windows app-server exited before runtime readiness."
      );
    }
  }

  private assertPlatform(): void {
    let platform: unknown;
    try {
      platform = this.config.platformPort();
    } catch {
      platform = null;
    }
    if (platform !== "win32") {
      throw runtimeError(
        "unsupported_platform",
        "configuration",
        "Codex Windows runtime supervision requires native Windows."
      );
    }
  }

  private assertStartupOpen(deadline: OperationDeadline): void {
    if (this.lifecycleAbort.signal.aborted) {
      throw runtimeError(
        "startup_aborted",
        "readiness",
        "Codex Windows runtime startup was aborted."
      );
    }
    deadline.throwIfAborted();
  }

  private mapStartupFailure(
    cause: unknown
  ): HostDeckCodexWindowsRuntimeSupervisorError {
    if (cause instanceof HostDeckCodexWindowsRuntimeSupervisorError) return cause;
    if (
      cause instanceof OperationDeadlineExceededError ||
      (cause instanceof Error && cause.name === "OperationDeadlineExceededError")
    ) {
      return runtimeError(
        "startup_timeout",
        "readiness",
        "Codex Windows runtime startup exceeded its deadline."
      );
    }
    return runtimeError(
      "startup_aborted",
      "readiness",
      "Codex Windows runtime startup was aborted."
    );
  }

  private mapEndpointFailure(
    cause: unknown
  ): HostDeckCodexWindowsRuntimeSupervisorError {
    if (cause instanceof HostDeckCodexWindowsRuntimeSupervisorError) return cause;
    if (cause instanceof OperationDeadlineExceededError) return this.mapStartupFailure(cause);
    return runtimeError(
      "endpoint_invalid",
      "endpoint",
      "Codex Windows app-server returned an invalid private endpoint."
    );
  }

  private mapReadinessFailure(
    cause: unknown
  ): HostDeckCodexWindowsRuntimeSupervisorError {
    if (cause instanceof HostDeckCodexWindowsRuntimeSupervisorError) return cause;
    if (cause instanceof OperationDeadlineExceededError) return this.mapStartupFailure(cause);
    return runtimeError(
      "readiness_failed",
      "readiness",
      "Codex Windows app-server authentication failed."
    );
  }

  private processState(): CodexWindowsRuntimeSupervisorSnapshot["process_state"] {
    if (this.childExit !== null) return "exited";
    if (this.child === null) return "not_started";
    try {
      return this.child.isRunning() ? "running" : "unknown";
    } catch {
      return "unknown";
    }
  }
}

function parseSupervisorConfig(input: unknown): ParsedSupervisorConfig {
  const values = exactData(
    input,
    [
      "authority_port",
      "codex_bin",
      "credential_factory",
      "cwd",
      "endpoint_file_path",
      "environment",
      "platform_port",
      "process_port",
      "readiness_port"
    ],
    ["codex_bin", "cwd", "endpoint_file_path"],
    "Codex Windows runtime supervisor input is invalid."
  );
  const authorityPort = values.authority_port ?? nodeCodexWindowsRuntimeAuthorityPort;
  const processPort = values.process_port ?? nodeCodexWindowsRuntimeProcessPort;
  const readinessPort = values.readiness_port ?? nodeCodexWindowsRuntimeReadinessPort;
  const credentialFactory = values.credential_factory ?? defaultCredentialFactory;
  const platformPort = values.platform_port ?? (() => process.platform);
  if (
    !isMethodPort(authorityPort, ["tryAcquire"]) ||
    !isMethodPort(processPort, ["spawn"]) ||
    !isMethodPort(readinessPort, ["authenticate"]) ||
    typeof credentialFactory !== "function" ||
    typeof platformPort !== "function"
  ) {
    throw new TypeError("Codex Windows runtime supervisor ports are invalid.");
  }
  return Object.freeze({
    codexBin: parseWindowsPath(values.codex_bin, "executable", true),
    cwd: parseWindowsPath(values.cwd, "working directory", false),
    endpointFilePath: parseEndpointFilePath(values.endpoint_file_path),
    environment: buildCodexWindowsRuntimeEnvironment(
      (values.environment ?? process.env) as Readonly<
        Record<string, string | undefined>
      >
    ),
    authorityPort: authorityPort as CodexWindowsRuntimeAuthorityPort,
    processPort: processPort as CodexWindowsRuntimeProcessPort,
    readinessPort: readinessPort as CodexWindowsRuntimeReadinessPort,
    credentialFactory: credentialFactory as () => string,
    platformPort: platformPort as () => string
  });
}

function parseStartInput(input: unknown): StartCodexWindowsRuntimeSupervisorInput {
  const values = exactData(
    input,
    ["deadline", "resourceBudget"],
    ["deadline", "resourceBudget"],
    "Codex Windows runtime start input is invalid."
  );
  const deadline = parseDeadline(values.deadline);
  assertResolvedResourceBudget(values.resourceBudget);
  if (!Object.isFrozen(values.resourceBudget)) {
    throw new TypeError("Codex Windows runtime requires a frozen resource budget.");
  }
  const duration = deadline.expiresAtMs - deadline.startedAtMs;
  if (
    !Number.isFinite(duration) ||
    duration < 1 ||
    duration > values.resourceBudget.lifecycle_startup_timeout_ms + 0.001
  ) {
    throw new TypeError("Codex Windows runtime startup deadline exceeds its budget.");
  }
  return Object.freeze({
    deadline,
    resourceBudget: values.resourceBudget
  });
}

function parseCloseInput(input: unknown): CloseCodexWindowsRuntimeSupervisorInput {
  const values = exactData(
    input,
    ["deadline"],
    ["deadline"],
    "Codex Windows runtime close input is invalid."
  );
  return Object.freeze({ deadline: parseDeadline(values.deadline) });
}

function parseDeadline(candidate: unknown): OperationDeadline {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    !Object.isFrozen(candidate)
  ) {
    throw new TypeError("Codex Windows runtime deadline is invalid.");
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
    throw new TypeError("Codex Windows runtime deadline is invalid.");
  }
  return deadline;
}

function parseAuthority(candidate: unknown): CodexWindowsRuntimeAuthority {
  if (!isMethodPort(candidate, ["discardCredential", "release", "stageCredential"])) {
    throw runtimeError(
      "port_contract_invalid",
      "claim",
      "Codex Windows authority port returned an invalid handle."
    );
  }
  return candidate as CodexWindowsRuntimeAuthority;
}

function parseAuthorityStage(
  candidate: unknown,
  endpointFilePath: string
): CodexWindowsRuntimeAuthorityStage {
  const values = exactData(
    candidate,
    ["credential_path", "replaced_stale_credential"],
    ["credential_path", "replaced_stale_credential"],
    "Codex Windows credential stage is invalid."
  );
  const credentialPath = parseWindowsPath(
    values.credential_path,
    "credential file",
    false
  );
  if (
    win32.dirname(credentialPath).toUpperCase() !==
      win32.dirname(endpointFilePath).toUpperCase() ||
    win32.basename(credentialPath).toLowerCase() !== "app-server.credential" ||
    typeof values.replaced_stale_credential !== "boolean"
  ) {
    throw runtimeError(
      "port_contract_invalid",
      "credential",
      "Codex Windows authority returned invalid credential metadata."
    );
  }
  return Object.freeze({
    credential_path: credentialPath,
    replaced_stale_credential: values.replaced_stale_credential
  });
}

function parseChild(candidate: unknown): CodexWindowsRuntimeChildProcess {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    !((candidate as CodexWindowsRuntimeChildProcess).endpoint instanceof Promise) ||
    !((candidate as CodexWindowsRuntimeChildProcess).exit instanceof Promise) ||
    typeof (candidate as CodexWindowsRuntimeChildProcess).isRunning !== "function" ||
    typeof (candidate as CodexWindowsRuntimeChildProcess).terminateTree !== "function"
  ) {
    throw runtimeError(
      "port_contract_invalid",
      "spawn",
      "Codex Windows process port returned an invalid child handle."
    );
  }
  return candidate as CodexWindowsRuntimeChildProcess;
}

function mapShutdownFailure(
  cause: unknown
): HostDeckCodexWindowsRuntimeSupervisorError {
  return cause instanceof HostDeckCodexWindowsRuntimeSupervisorError
    ? cause
    : runtimeError(
        "shutdown_failed",
        "shutdown",
        "Codex Windows runtime shutdown did not complete cleanly."
      );
}

function parseProcessExit(candidate: unknown): CodexWindowsRuntimeProcessExit {
  const values = exactData(
    candidate,
    ["code", "kind", "spawn_failure"],
    ["code", "kind", "spawn_failure"],
    "Codex Windows process exit is invalid."
  );
  const validCode =
    values.code === null ||
    (typeof values.code === "number" &&
      Number.isSafeInteger(values.code) &&
      values.code >= 0 &&
      values.code <= 0xffff_ffff);
  const valid =
    validCode &&
    ((values.kind === "exited" &&
      values.code !== null &&
      values.spawn_failure === null) ||
      (values.kind === "terminated" &&
        values.code === null &&
        values.spawn_failure === null) ||
      (values.kind === "spawn_failed" &&
        values.code === null &&
        (values.spawn_failure === "missing_binary" ||
          values.spawn_failure === "not_executable" ||
          values.spawn_failure === "failed")));
  if (!valid) {
    throw runtimeError(
      "port_contract_invalid",
      "spawn",
      "Codex Windows process port returned invalid exit state."
    );
  }
  return Object.freeze({
    kind: values.kind,
    code: values.code,
    spawn_failure: values.spawn_failure
  }) as CodexWindowsRuntimeProcessExit;
}

function parseEndpointFilePath(candidate: unknown): string {
  const path = parseWindowsPath(candidate, "endpoint owner file", false);
  if (win32.basename(path).toLowerCase() !== endpointFileName) {
    throw new TypeError("Codex Windows endpoint owner file is invalid.");
  }
  return path;
}

function parseWindowsPath(
  candidate: unknown,
  label: string,
  executable: boolean
): string {
  if (
    typeof candidate !== "string" ||
    !win32.isAbsolute(candidate) ||
    win32.normalize(candidate) !== candidate ||
    win32.parse(candidate).root === candidate ||
    Buffer.byteLength(candidate, "utf8") > maximumPathBytes ||
    containsControl(candidate) ||
    candidate.slice(2).includes(":") ||
    (executable && !candidate.toLowerCase().endsWith(".exe"))
  ) {
    throw new TypeError(`Codex Windows ${label} path is invalid.`);
  }
  return candidate;
}

function exactData<const Key extends string>(
  candidate: unknown,
  allowed: readonly Key[],
  required: readonly Key[],
  message: string
): Readonly<Record<Key, unknown>> {
  try {
    if (
      candidate === null ||
      typeof candidate !== "object" ||
      Array.isArray(candidate) ||
      (Object.getPrototypeOf(candidate) !== Object.prototype &&
        Object.getPrototypeOf(candidate) !== null)
    ) {
      throw new TypeError();
    }
    const descriptors = Object.getOwnPropertyDescriptors(candidate);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.some(
        (key) => typeof key !== "string" || !allowed.includes(key as Key)
      ) ||
      required.some((key) => !Object.hasOwn(descriptors, key))
    ) {
      throw new TypeError();
    }
    const output: Record<string, unknown> = Object.create(null);
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
      output[key] = descriptor.value;
    }
    return Object.freeze(output) as Readonly<Record<Key, unknown>>;
  } catch {
    throw new TypeError(message);
  }
}

function isMethodPort(candidate: unknown, names: readonly string[]): boolean {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate)
  ) {
    return false;
  }
  return names.every((name) => {
    const descriptor = Object.getOwnPropertyDescriptor(candidate, name);
    return (
      descriptor !== undefined &&
      "value" in descriptor &&
      descriptor.enumerable &&
      typeof descriptor.value === "function"
    );
  });
}

function defaultCredentialFactory(): string {
  return randomBytes(48).toString("base64url");
}

function safeRunning(child: CodexWindowsRuntimeChildProcess): boolean {
  try {
    return child.isRunning() === true;
  } catch {
    return true;
  }
}

function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      }
    );
  });
}

function lifecycleConflict(): HostDeckCodexWindowsRuntimeSupervisorError {
  return runtimeError(
    "lifecycle_conflict",
    "configuration",
    "Codex Windows runtime supervisor lifecycle operation conflicts."
  );
}

function runtimeError(
  code: CodexWindowsRuntimeSupervisorErrorCode,
  stage: CodexWindowsRuntimeSupervisorStage,
  message: string
): HostDeckCodexWindowsRuntimeSupervisorError {
  return new HostDeckCodexWindowsRuntimeSupervisorError(code, stage, message);
}

function increment(counters: MutableCounters, key: keyof MutableCounters): void {
  counters[key] = Math.min(Number.MAX_SAFE_INTEGER, counters[key] + 1);
}

function containsControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

