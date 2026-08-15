import { homedir } from "node:os";
import {
  defaultResourceBudget,
  type SharedCodexEndpoint,
  type SharedCodexEndpointLocation,
  sharedCodexRuntimeVersion
} from "@hostdeck/contracts";
import {
  HostDeckSharedCodexBrokerError,
  probeCodexVersion,
  resolveSharedCodexEndpointLocation,
  type SharedCodexBrokerAttachment,
  startSharedCodexBroker,
  stopOwnedSharedCodexBroker
} from "@hostdeck/server";
import { resolveHostDeckCodexExecutable } from "./config.js";

export interface HostDeckBrokerHostOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly poll_interval_ms?: number;
  readonly probeVersion?: typeof probeCodexVersion;
  readonly signal?: AbortSignal;
  readonly sleep?: (
    duration_ms: number,
    signal: AbortSignal
  ) => Promise<void>;
  readonly startBroker?: typeof startSharedCodexBroker;
  readonly stopBroker?: typeof stopOwnedSharedCodexBroker;
  readonly writeReady?: (output: string) => void;
}

const brokerCheckArgument = "--check-ready";
const brokerFailurePrefix = "HostDeck Codex broker service failed";
const defaultPollIntervalMs = 2_000;
const minimumPollIntervalMs = 50;
const maximumPollIntervalMs = 60_000;
const maximumReadyOutputBytes = 256;

export async function runHostDeckBrokerHost(
  args: readonly string[],
  options: HostDeckBrokerHostOptions = {}
): Promise<string> {
  const mode = parseArguments(args);
  const signal = options.signal ?? new AbortController().signal;
  if (!(signal instanceof AbortSignal)) {
    throw new TypeError("HostDeck broker service signal is invalid.");
  }
  const pollIntervalMs = parsePollInterval(options.poll_interval_ms);
  const env = options.env ?? process.env;
  if (typeof env.HOSTDECK_CODEX_BIN !== "string") {
    throw new TypeError(
      "HOSTDECK_CODEX_BIN is required for the HostDeck broker service."
    );
  }
  const codexBin = resolveHostDeckCodexExecutable(env);
  const probeVersion = options.probeVersion ?? probeCodexVersion;
  const observedVersion = await probeVersion({
    executable: codexBin,
    signal,
    timeout_ms: defaultResourceBudget.protocol_read_timeout_ms
  });
  if (observedVersion !== sharedCodexRuntimeVersion) {
    throw new TypeError("The HostDeck broker Codex version is unsupported.");
  }
  const location = resolveSharedCodexEndpointLocation({
    home_directory: homedir(),
    ...(env.CODEX_HOME === undefined ? {} : { codex_home: env.CODEX_HOME })
  });
  const ports = Object.freeze({
    sleep: options.sleep ?? sleepWithSignal,
    startBroker: options.startBroker ?? startSharedCodexBroker,
    stopBroker: options.stopBroker ?? stopOwnedSharedCodexBroker
  });

  if (mode === "check") {
    await waitForBrokerReady(
      codexBin,
      location,
      observedVersion,
      signal,
      pollIntervalMs,
      ports
    );
    return "";
  }

  const initial = await openOrRecoverBroker(
    codexBin,
    location,
    observedVersion,
    signal,
    ports.startBroker,
    ports.stopBroker
  );
  let observed = initial;
  const readyOutput = `HostDeck Codex broker ready (${initial.ownership}).\n`;
  assertReadyOutput(readyOutput);
  options.writeReady?.(readyOutput);

  try {
    while (!signal.aborted) {
      try {
        await ports.sleep(pollIntervalMs, signal);
      } catch (error) {
        if (signal.aborted) break;
        throw error;
      }
      if (signal.aborted) break;

      let current: SharedCodexEndpoint;
      try {
        current = await openBroker(
          "attach_only",
          codexBin,
          location,
          observedVersion,
          signal,
          ports.startBroker
        );
      } catch (error) {
        await handleUnavailableBroker(
          error,
          observed,
          location,
          ports.stopBroker
        );
        return options.writeReady === undefined ? readyOutput : "";
      }
      if (current.generation !== observed.generation) {
        if (observed.ownership === "owned") {
          await stopUnexpectedOwnedBroker(location, ports.stopBroker);
          throw new Error("The owned shared Codex broker identity changed.");
        }
        if (current.ownership !== "attached") {
          throw new Error("The replacement shared Codex broker ownership is invalid.");
        }
        observed = current;
      } else if (current.ownership !== observed.ownership) {
        throw new Error("The shared Codex broker ownership changed in place.");
      }
    }
  } finally {
    if (signal.aborted && observed.ownership === "owned") {
      await stopForServiceShutdown(location, ports.stopBroker);
    }
  }
  return options.writeReady === undefined ? readyOutput : "";
}

export async function mainHostDeckBrokerHost(
  args = process.argv.slice(2),
  options: HostDeckBrokerHostOptions = {}
): Promise<0 | 1> {
  const processLifetime = createProcessLifetimeOwner();
  const processSignals =
    options.signal === undefined ? createProcessSignalOwner() : null;
  const signal = options.signal ?? processSignals?.signal;
  if (signal === undefined) {
    throw new TypeError("HostDeck broker process signal is unavailable.");
  }
  try {
    await runHostDeckBrokerHost(args, {
      ...options,
      signal,
      writeReady:
        options.writeReady ??
        ((output) => {
          process.stdout.write(output);
        })
    });
    process.exitCode = 0;
    return 0;
  } catch (error) {
    process.exitCode = 1;
    try {
      process.stderr.write(formatBrokerHostFailure(error));
    } catch {
      // No reliable process output channel remains.
    }
    return 1;
  } finally {
    processSignals?.close();
    processLifetime.close();
  }
}

export function formatBrokerHostFailure(error: unknown): string {
  if (error instanceof HostDeckSharedCodexBrokerError) {
    return `${brokerFailurePrefix} (${error.code}/${error.stage}).\n`;
  }
  return `${brokerFailurePrefix}.\n`;
}

async function waitForBrokerReady(
  codexBin: string,
  location: SharedCodexEndpointLocation,
  observedVersion: string,
  signal: AbortSignal,
  pollIntervalMs: number,
  ports: Readonly<{
    sleep: (duration_ms: number, signal: AbortSignal) => Promise<void>;
    startBroker: typeof startSharedCodexBroker;
  }>
): Promise<void> {
  const deadline = Date.now() + defaultResourceBudget.lifecycle_startup_timeout_ms;
  while (true) {
    try {
      await openBroker(
        "attach_only",
        codexBin,
        location,
        observedVersion,
        signal,
        ports.startBroker
      );
      return;
    } catch (error) {
      if (!isBrokerError(error, "broker_absent") || Date.now() >= deadline) {
        throw error;
      }
    }
    await ports.sleep(
      Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())),
      signal
    );
  }
}

async function openBroker(
  mode: "attach_only" | "attach_or_start",
  codexBin: string,
  location: SharedCodexEndpointLocation,
  observedVersion: string,
  signal: AbortSignal,
  startBroker: typeof startSharedCodexBroker
): Promise<SharedCodexEndpoint> {
  const attachment = await startBroker({
    codex_bin: codexBin,
    location,
    mode,
    observed_version: observedVersion,
    signal,
    startup_timeout_ms: defaultResourceBudget.lifecycle_startup_timeout_ms
  });
  try {
    assertReadyAttachment(attachment);
    return attachment.endpoint;
  } finally {
    await attachment.close();
  }
}

async function openOrRecoverBroker(
  codexBin: string,
  location: SharedCodexEndpointLocation,
  observedVersion: string,
  signal: AbortSignal,
  startBroker: typeof startSharedCodexBroker,
  stopBroker: typeof stopOwnedSharedCodexBroker
): Promise<SharedCodexEndpoint> {
  try {
    return await openBroker(
      "attach_or_start",
      codexBin,
      location,
      observedVersion,
      signal,
      startBroker
    );
  } catch (error) {
    if (!isBrokerError(error, "ownership_ambiguous")) throw error;
    await stopBroker({
      location,
      signal,
      stop_timeout_ms: defaultResourceBudget.lifecycle_shutdown_timeout_ms
    });
    return await openBroker(
      "attach_or_start",
      codexBin,
      location,
      observedVersion,
      signal,
      startBroker
    );
  }
}

async function handleUnavailableBroker(
  error: unknown,
  observed: SharedCodexEndpoint,
  location: SharedCodexEndpointLocation,
  stopBroker: typeof stopOwnedSharedCodexBroker
): Promise<void> {
  if (
    !(error instanceof HostDeckSharedCodexBrokerError) ||
    ![
      "broker_absent",
      "broker_exited",
      "ownership_ambiguous",
      "socket_changed",
      "socket_stale"
    ].includes(error.code)
  ) {
    throw error;
  }
  if (observed.ownership !== "owned") throw error;
  try {
    await stopBroker({
      location,
      signal: new AbortController().signal,
      stop_timeout_ms: defaultResourceBudget.lifecycle_shutdown_timeout_ms
    });
  } catch (stopError) {
    if (isBrokerError(stopError, "broker_not_owned")) return;
    throw stopError;
  }
  throw new Error("The owned shared Codex broker stopped unexpectedly.");
}

async function stopUnexpectedOwnedBroker(
  location: SharedCodexEndpointLocation,
  stopBroker: typeof stopOwnedSharedCodexBroker
): Promise<void> {
  await stopBroker({
    location,
    signal: new AbortController().signal,
    stop_timeout_ms: defaultResourceBudget.lifecycle_shutdown_timeout_ms
  });
}

async function stopForServiceShutdown(
  location: SharedCodexEndpointLocation,
  stopBroker: typeof stopOwnedSharedCodexBroker
): Promise<void> {
  try {
    await stopBroker({
      location,
      signal: new AbortController().signal,
      stop_timeout_ms: defaultResourceBudget.lifecycle_shutdown_timeout_ms
    });
  } catch (error) {
    if (!isBrokerError(error, "broker_not_owned")) throw error;
  }
}

function assertReadyAttachment(
  attachment: SharedCodexBrokerAttachment
): void {
  if (
    attachment.endpoint.state !== "ready" ||
    attachment.endpoint.generation < 1 ||
    (attachment.endpoint.ownership !== "attached" &&
      attachment.endpoint.ownership !== "owned")
  ) {
    throw new TypeError("The shared Codex broker attachment is contradictory.");
  }
}

function parseArguments(candidate: unknown): "check" | "supervise" {
  if (
    !Array.isArray(candidate) ||
    Object.getPrototypeOf(candidate) !== Array.prototype ||
    Reflect.ownKeys(candidate).some(
      (key) => key !== "length" && key !== "0"
    ) ||
    (candidate.length !== 0 &&
      (candidate.length !== 1 || candidate[0] !== brokerCheckArgument))
  ) {
    throw new TypeError("HostDeck broker service arguments are invalid.");
  }
  return candidate.length === 0 ? "supervise" : "check";
}

function parsePollInterval(candidate: unknown): number {
  const value = candidate ?? defaultPollIntervalMs;
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimumPollIntervalMs ||
    (value as number) > maximumPollIntervalMs
  ) {
    throw new TypeError("HostDeck broker poll interval is invalid.");
  }
  return value as number;
}

function assertReadyOutput(output: string): void {
  if (
    Buffer.byteLength(output, "utf8") > maximumReadyOutputBytes ||
    /[\0\r\x7f]/u.test(output)
  ) {
    throw new TypeError("HostDeck broker readiness output is invalid.");
  }
}

function isBrokerError(
  error: unknown,
  code: HostDeckSharedCodexBrokerError["code"]
): boolean {
  return error instanceof HostDeckSharedCodexBrokerError && error.code === code;
}

async function sleepWithSignal(
  durationMs: number,
  signal: AbortSignal
): Promise<void> {
  if (signal.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, durationMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function createProcessSignalOwner(): Readonly<{
  close: () => void;
  signal: AbortSignal;
}> {
  const controller = new AbortController();
  const onSignal = () => {
    if (!controller.signal.aborted) {
      controller.abort(new Error("HostDeck broker service was stopped."));
    }
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  return Object.freeze({
    close() {
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
    },
    signal: controller.signal
  });
}

function createProcessLifetimeOwner(): Readonly<{ close: () => void }> {
  const timer = setInterval(() => undefined, maximumPollIntervalMs);
  return Object.freeze({
    close() {
      clearInterval(timer);
    }
  });
}

if (import.meta.main) {
  await mainHostDeckBrokerHost();
}
