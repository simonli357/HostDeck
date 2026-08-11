import { Buffer } from "node:buffer";
import { spawn as spawnProcess } from "node:child_process";
import { posix, win32 } from "node:path";
import { codexThreadIdSchema } from "@hostdeck/contracts";
import {
  type CodexAuthenticatedLoopbackWebSocketEndpoint,
  type CodexLocalEndpoint,
  type CodexProtectedEnvironmentCredentialSource,
  type CodexUnixSocketEndpoint,
  codexRemoteAuthEnvironmentVariable,
  parseCodexLocalEndpoint,
  resolveCodexEndpointConnection
} from "./transport-endpoint.js";

export const codexPlatformTuiResumeErrorCodes = Object.freeze([
  "invalid_config",
  "unsupported_platform",
  "credential_unavailable",
  "process_start_failed",
  "process_aborted",
  "process_terminated",
  "process_exited",
  "process_contract_invalid"
] as const);

export type CodexPlatformTuiResumeErrorCode =
  (typeof codexPlatformTuiResumeErrorCodes)[number];

export type CodexPlatformTuiResumeStage =
  | "configuration"
  | "credential"
  | "spawn"
  | "execution";

export class HostDeckCodexPlatformTuiResumeError extends Error {
  constructor(
    readonly code: CodexPlatformTuiResumeErrorCode,
    readonly stage: CodexPlatformTuiResumeStage,
    message: string
  ) {
    super(message);
    this.name = "HostDeckCodexPlatformTuiResumeError";
  }
}

export interface BuildCodexPlatformTuiResumeCommandInput {
  readonly target: "linux-x64" | "windows-x64";
  readonly endpoint: CodexLocalEndpoint;
  readonly thread_id: string;
  readonly codex_bin: string;
  readonly cwd: string;
}

interface CodexPlatformTuiResumeCommandBase {
  readonly executable: string;
  readonly cwd: string;
}

export interface CodexLinuxTuiResumeCommand
  extends CodexPlatformTuiResumeCommandBase {
  readonly target: "linux-x64";
  readonly endpoint: CodexUnixSocketEndpoint;
  readonly args: readonly ["resume", "--remote", string, string];
  readonly credential_environment_variable: null;
}

export interface CodexWindowsTuiResumeCommand
  extends CodexPlatformTuiResumeCommandBase {
  readonly target: "windows-x64";
  readonly endpoint: CodexAuthenticatedLoopbackWebSocketEndpoint;
  readonly args: readonly [
    "resume",
    "--remote",
    string,
    "--remote-auth-token-env",
    typeof codexRemoteAuthEnvironmentVariable,
    string
  ];
  readonly credential_environment_variable: typeof codexRemoteAuthEnvironmentVariable;
}

export type CodexPlatformTuiResumeCommand =
  | CodexLinuxTuiResumeCommand
  | CodexWindowsTuiResumeCommand;

export interface ExecuteCodexPlatformTuiResumeInput {
  readonly command: CodexPlatformTuiResumeCommand;
  readonly credential?: CodexProtectedEnvironmentCredentialSource;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly signal: AbortSignal;
}

export interface CodexPlatformTuiResumeChildProcess {
  readonly once: {
    (
      event: "error",
      listener: (error: Error) => void
    ): CodexPlatformTuiResumeChildProcess;
    (
      event: "exit",
      listener: (code: number | null, signal: NodeJS.Signals | null) => void
    ): CodexPlatformTuiResumeChildProcess;
    (
      event: "close",
      listener: (code: number | null, signal: NodeJS.Signals | null) => void
    ): CodexPlatformTuiResumeChildProcess;
  };
}

export interface CodexPlatformTuiResumeSpawnOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly shell: false;
  readonly signal: AbortSignal;
  readonly stdio: "inherit";
  readonly windowsHide: false;
}

export type CodexPlatformTuiResumeSpawn = (
  executable: string,
  args: readonly string[],
  options: CodexPlatformTuiResumeSpawnOptions
) => CodexPlatformTuiResumeChildProcess;

export interface CreateCodexPlatformTuiResumeExecutorInput {
  readonly spawn?: CodexPlatformTuiResumeSpawn;
  readonly platform_port?: () => string;
  readonly architecture_port?: () => string;
}

export interface CodexPlatformTuiResumeExecutor {
  readonly execute: (
    input: ExecuteCodexPlatformTuiResumeInput
  ) => Promise<void>;
}

const buildInputKeys = Object.freeze([
  "codex_bin",
  "cwd",
  "endpoint",
  "target",
  "thread_id"
] as const);
const commandKeys = Object.freeze([
  "args",
  "credential_environment_variable",
  "cwd",
  "endpoint",
  "executable",
  "target"
] as const);
const executeInputKeys = Object.freeze([
  "command",
  "credential",
  "environment",
  "signal"
] as const);
const executorInputKeys = Object.freeze([
  "architecture_port",
  "platform_port",
  "spawn"
] as const);
const maximumPathLength = 32_767;
const maximumLinuxEnvironmentBytes = 1_048_576;
const maximumWindowsEnvironmentCharacters = 32_767;
const environmentKeyPattern = /^[^=\0]+$/u;
const invalidWindowsPathCharacterPattern = /[<>"|?*]/u;
const reservedWindowsPathSegmentPattern =
  /^(?:AUX|CON|NUL|PRN|COM[1-9]|LPT[1-9])(?:\.|$)/iu;

const defaultSpawn: CodexPlatformTuiResumeSpawn = (
  executable,
  args,
  options
) =>
  spawnProcess(executable, [...args], {
    cwd: options.cwd,
    env: { ...options.env },
    shell: false,
    signal: options.signal,
    stdio: "inherit",
    windowsHide: false
  });

export function buildCodexPlatformTuiResumeCommand(
  input: BuildCodexPlatformTuiResumeCommandInput
): CodexPlatformTuiResumeCommand {
  try {
    const values = exactData(
      input,
      buildInputKeys,
      buildInputKeys,
      "Codex platform TUI resume command input is invalid."
    );
    const target = parseTarget(values.target);
    const endpoint = parseCodexLocalEndpoint(values.endpoint);
    if (endpoint.target !== target) throw invalidConfiguration();
    const thread = codexThreadIdSchema.safeParse(values.thread_id);
    if (!thread.success) throw invalidConfiguration();
    const executable = parseTargetPath(values.codex_bin, target, true);
    const cwd = parseTargetPath(values.cwd, target, false);

    if (endpoint.kind === "unix_socket") {
      return deepFreeze({
        target: "linux-x64" as const,
        endpoint,
        executable,
        cwd,
        args: [
          "resume" as const,
          "--remote" as const,
          endpoint.address,
          thread.data
        ] as const,
        credential_environment_variable: null
      });
    }
    return deepFreeze({
      target: "windows-x64" as const,
      endpoint,
      executable,
      cwd,
      args: [
        "resume" as const,
        "--remote" as const,
        endpoint.address,
        "--remote-auth-token-env" as const,
        codexRemoteAuthEnvironmentVariable,
        thread.data
      ] as const,
      credential_environment_variable: codexRemoteAuthEnvironmentVariable
    });
  } catch {
    throw invalidConfiguration();
  }
}

export function createCodexPlatformTuiResumeExecutor(
  input: CreateCodexPlatformTuiResumeExecutorInput = {}
): CodexPlatformTuiResumeExecutor {
  let values: Readonly<Record<(typeof executorInputKeys)[number], unknown>>;
  try {
    values = exactData(
      input,
      executorInputKeys,
      [],
      "Codex platform TUI resume executor input is invalid."
    );
  } catch {
    throw invalidConfiguration();
  }
  if (
    (values.spawn !== undefined && typeof values.spawn !== "function") ||
    (values.platform_port !== undefined &&
      typeof values.platform_port !== "function") ||
    (values.architecture_port !== undefined &&
      typeof values.architecture_port !== "function")
  ) {
    throw invalidConfiguration();
  }
  const spawn = (values.spawn ?? defaultSpawn) as CodexPlatformTuiResumeSpawn;
  const platformPort = (values.platform_port ?? (() => process.platform)) as () =>
    string;
  const architecturePort = (values.architecture_port ?? (() => process.arch)) as () =>
    string;
  return Object.freeze({
    async execute(candidate: ExecuteCodexPlatformTuiResumeInput) {
      const parsed = parseExecutionInput(candidate);
      assertNativeTarget(parsed.command.target, platformPort, architecturePort);
      if (parsed.signal.aborted) throw aborted();
      if (parsed.command.target === "linux-x64" && parsed.credential !== undefined) {
        throw invalidConfiguration();
      }

      const environment = buildExecutionEnvironment(
        parsed.environment,
        parsed.command.target
      );

      let token: string | null = null;
      let child: unknown;
      try {
        if (parsed.command.target === "windows-x64") {
          token = resolveCredential(parsed.command, parsed.credential);
          environment[codexRemoteAuthEnvironmentVariable] = token;
          assertEnvironmentSize(environment, parsed.command.target);
        }
        if (parsed.signal.aborted) throw aborted();

        try {
          child = Reflect.apply(spawn, undefined, [
            parsed.command.executable,
            parsed.command.args,
            {
              cwd: parsed.command.cwd,
              env: environment,
              shell: false,
              signal: parsed.signal,
              stdio: "inherit",
              windowsHide: false
            } satisfies CodexPlatformTuiResumeSpawnOptions
          ]);
        } catch {
          throw parsed.signal.aborted ? aborted() : processStartFailed();
        }
      } finally {
        delete environment[codexRemoteAuthEnvironmentVariable];
        token = null;
      }
      await observeChild(child, parsed.signal);
    }
  });
}

function parseExecutionInput(input: unknown): {
  readonly command: CodexPlatformTuiResumeCommand;
  readonly credential: unknown;
  readonly environment: unknown;
  readonly signal: AbortSignal;
} {
  try {
    const values = exactData(
      input,
      executeInputKeys,
      ["command", "signal"],
      "Codex platform TUI resume execution input is invalid."
    );
    if (!(values.signal instanceof AbortSignal)) throw invalidConfiguration();
    return Object.freeze({
      command: parseCommand(values.command),
      credential: values.credential,
      environment: values.environment,
      signal: values.signal
    });
  } catch {
    throw invalidConfiguration();
  }
}

function parseCommand(candidate: unknown): CodexPlatformTuiResumeCommand {
  try {
    const values = exactData(
      candidate,
      commandKeys,
      commandKeys,
      "Codex platform TUI resume command is invalid."
    );
    const target = parseTarget(values.target);
    const expectedLength = target === "linux-x64" ? 4 : 6;
    const args = exactStringArray(values.args, expectedLength);
    const threadId = args.at(-1);
    if (threadId === undefined) throw invalidConfiguration();
    const rebuilt = buildCodexPlatformTuiResumeCommand({
      target,
      endpoint: values.endpoint as CodexLocalEndpoint,
      thread_id: threadId,
      codex_bin: values.executable as string,
      cwd: values.cwd as string
    });
    if (
      values.credential_environment_variable !==
        rebuilt.credential_environment_variable ||
      args.some((value, index) => value !== rebuilt.args[index])
    ) {
      throw invalidConfiguration();
    }
    return rebuilt;
  } catch {
    throw invalidConfiguration();
  }
}

function exactStringArray(candidate: unknown, expectedLength: number): readonly string[] {
  try {
    if (
      !Array.isArray(candidate) ||
      Object.getPrototypeOf(candidate) !== Array.prototype
    ) {
      throw new TypeError();
    }
    const keys = Reflect.ownKeys(candidate);
    const lengthDescriptor = Reflect.getOwnPropertyDescriptor(candidate, "length");
    if (
      keys.length !== expectedLength + 1 ||
      keys.some(
        (key) =>
          typeof key !== "string" ||
          (key !== "length" &&
            (!/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= expectedLength))
      ) ||
      lengthDescriptor === undefined ||
      !("value" in lengthDescriptor) ||
      lengthDescriptor.value !== expectedLength
    ) {
      throw new TypeError();
    }
    const output: string[] = [];
    for (let index = 0; index < expectedLength; index += 1) {
      const descriptor = Reflect.getOwnPropertyDescriptor(candidate, String(index));
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !("value" in descriptor) ||
        typeof descriptor.value !== "string"
      ) {
        throw new TypeError();
      }
      output.push(descriptor.value);
    }
    return Object.freeze(output);
  } catch {
    throw invalidConfiguration();
  }
}

function assertNativeTarget(
  target: CodexPlatformTuiResumeCommand["target"],
  platformPort: () => string,
  architecturePort: () => string
): void {
  let platform: unknown;
  let architecture: unknown;
  try {
    platform = platformPort();
    architecture = architecturePort();
  } catch {
    throw unsupportedPlatform();
  }
  const matches =
    architecture === "x64" &&
    ((target === "linux-x64" && platform === "linux") ||
      (target === "windows-x64" && platform === "win32"));
  if (!matches) throw unsupportedPlatform();
}

function resolveCredential(
  command: CodexWindowsTuiResumeCommand,
  candidate: unknown
): string {
  try {
    const resolved = resolveCodexEndpointConnection(
      command.endpoint,
      command.target,
      candidate
    );
    if (resolved.authorization_header === null) throw new TypeError();
    return resolved.authorization_header.slice("Bearer ".length);
  } catch {
    throw new HostDeckCodexPlatformTuiResumeError(
      "credential_unavailable",
      "credential",
      "Codex Windows TUI resume credential is unavailable."
    );
  }
}

function buildExecutionEnvironment(
  candidate: unknown,
  target: CodexPlatformTuiResumeCommand["target"]
): Record<string, string> {
  const source = candidate === undefined ? process.env : candidate;
  if (source === null || typeof source !== "object" || Array.isArray(source)) {
    throw invalidConfiguration();
  }
  let descriptors: PropertyDescriptorMap;
  try {
    if (
      source !== process.env &&
      Object.getPrototypeOf(source) !== Object.prototype &&
      Object.getPrototypeOf(source) !== null
    ) {
      throw new TypeError();
    }
    descriptors = Object.getOwnPropertyDescriptors(source);
  } catch {
    throw invalidConfiguration();
  }
  const environment: Record<string, string> = Object.create(null);
  const windowsNames = new Set<string>();
  for (const key of Reflect.ownKeys(descriptors)) {
    if (
      typeof key !== "string" ||
      !environmentKeyPattern.test(key) ||
      containsControl(key)
    ) {
      throw invalidConfiguration();
    }
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      throw invalidConfiguration();
    }
    const value = descriptor.value;
    if (value === undefined) continue;
    if (
      typeof value !== "string" ||
      containsControl(value) ||
      key.length > maximumWindowsEnvironmentCharacters ||
      value.length > maximumWindowsEnvironmentCharacters
    ) {
      throw invalidConfiguration();
    }
    const canonical = key.toUpperCase();
    if (canonical === codexRemoteAuthEnvironmentVariable) continue;
    if (target === "windows-x64") {
      if (windowsNames.has(canonical)) throw invalidConfiguration();
      windowsNames.add(canonical);
    }
    environment[key] = value;
  }
  assertEnvironmentSize(environment, target);
  return environment;
}

function assertEnvironmentSize(
  environment: Readonly<Record<string, string>>,
  target: CodexPlatformTuiResumeCommand["target"]
): void {
  const entries = Object.entries(environment);
  const size = entries.reduce(
    (total, [key, value]) =>
      total +
      (target === "windows-x64"
        ? `${key}=${value}\0`.length
        : Buffer.byteLength(`${key}=${value}\0`, "utf8")),
    1
  );
  if (
    (target === "windows-x64" &&
      size > maximumWindowsEnvironmentCharacters) ||
    (target === "linux-x64" && size > maximumLinuxEnvironmentBytes)
  ) {
    throw invalidConfiguration();
  }
}

function observeChild(candidate: unknown, signal: AbortSignal): Promise<void> {
  let oncePort: unknown;
  try {
    if (candidate === null || typeof candidate !== "object") {
      throw new TypeError();
    }
    oncePort = Reflect.get(candidate, "once");
    if (typeof oncePort !== "function") throw new TypeError();
  } catch {
    return Promise.reject(processContractInvalid());
  }
  const child = candidate as CodexPlatformTuiResumeChildProcess;
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const fail = (error: HostDeckCodexPlatformTuiResumeError) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    try {
      Reflect.apply(oncePort, child, ["error", () => {
        if (!signal.aborted) fail(processStartFailed());
      }]);
      if (settled) return;
      Reflect.apply(oncePort, child, ["exit", (code: unknown, exitSignal: unknown) => {
        if (settled) return;
        settled = true;
        if (signal.aborted) {
          reject(aborted());
        } else if (
          typeof exitSignal === "string" &&
          /^[A-Z][A-Z0-9]{1,15}$/u.test(exitSignal)
        ) {
          reject(
            new HostDeckCodexPlatformTuiResumeError(
              "process_terminated",
              "execution",
              "Codex TUI resume was terminated before completion."
            )
          );
        } else if (exitSignal !== null) {
          reject(processContractInvalid());
        } else if (code === 0) {
          resolve();
        } else if (
          typeof code === "number" &&
          Number.isSafeInteger(code) &&
          code > 0
        ) {
          reject(
            new HostDeckCodexPlatformTuiResumeError(
              "process_exited",
              "execution",
              `Codex TUI resume exited with status ${code}.`
            )
          );
        } else {
          reject(processContractInvalid());
        }
      }]);
      if (settled) return;
      Reflect.apply(oncePort, child, ["close", () => {
        fail(signal.aborted ? aborted() : processContractInvalid());
      }]);
    } catch {
      fail(processContractInvalid());
    }
  });
}

function parseTarget(candidate: unknown): "linux-x64" | "windows-x64" {
  if (candidate !== "linux-x64" && candidate !== "windows-x64") {
    throw invalidConfiguration();
  }
  return candidate;
}

function parseTargetPath(
  candidate: unknown,
  target: "linux-x64" | "windows-x64",
  executable: boolean
): string {
  const dialect = target === "linux-x64" ? posix : win32;
  if (
    typeof candidate !== "string" ||
    candidate.length < (executable ? 2 : 1) ||
    candidate.length > maximumPathLength ||
    !dialect.isAbsolute(candidate) ||
    dialect.normalize(candidate) !== candidate ||
    (executable && dialect.parse(candidate).root === candidate) ||
    containsControl(candidate) ||
    (target === "windows-x64" && candidate.slice(2).includes(":")) ||
    (target === "windows-x64" && !isCanonicalWindowsPath(candidate)) ||
    (target === "windows-x64" &&
      executable &&
      (!/^[A-Za-z]:\\/u.test(candidate) ||
        !candidate.toLowerCase().endsWith(".exe")))
  ) {
    throw invalidConfiguration();
  }
  return candidate;
}

function isCanonicalWindowsPath(candidate: string): boolean {
  if (
    candidate.startsWith("\\\\.\\") ||
    candidate.startsWith("\\\\?\\") ||
    invalidWindowsPathCharacterPattern.test(candidate)
  ) {
    return false;
  }
  const segments = candidate.split("\\").filter((segment) => segment !== "");
  if (/^[A-Za-z]:$/u.test(segments[0] ?? "")) segments.shift();
  return segments.every(
    (segment) =>
      segment !== "." &&
      segment !== ".." &&
      !segment.endsWith(".") &&
      !segment.endsWith(" ") &&
      !reservedWindowsPathSegmentPattern.test(segment)
  );
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

function containsControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function invalidConfiguration(): HostDeckCodexPlatformTuiResumeError {
  return new HostDeckCodexPlatformTuiResumeError(
    "invalid_config",
    "configuration",
    "Codex platform TUI resume configuration is invalid."
  );
}

function unsupportedPlatform(): HostDeckCodexPlatformTuiResumeError {
  return new HostDeckCodexPlatformTuiResumeError(
    "unsupported_platform",
    "configuration",
    "Codex TUI resume target does not match the native host."
  );
}

function processStartFailed(): HostDeckCodexPlatformTuiResumeError {
  return new HostDeckCodexPlatformTuiResumeError(
    "process_start_failed",
    "spawn",
    "Codex TUI resume could not be started."
  );
}

function aborted(): HostDeckCodexPlatformTuiResumeError {
  return new HostDeckCodexPlatformTuiResumeError(
    "process_aborted",
    "execution",
    "Codex TUI resume was aborted."
  );
}

function processContractInvalid(): HostDeckCodexPlatformTuiResumeError {
  return new HostDeckCodexPlatformTuiResumeError(
    "process_contract_invalid",
    "execution",
    "Codex TUI resume process state is invalid."
  );
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
