import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultResourceBudget } from "@hostdeck/contracts";
import {
  assertHostDeckProductionServiceServe,
  type HostDeckProductionServiceServe,
  type StartHostDeckProductionServiceServeInput,
  startHostDeckProductionServiceServe
} from "@hostdeck/server";
import {
  loadCliConfig,
  resolveCanonicalRuntimePackageRoot,
  resolveHostDeckCodexExecutable
} from "./config.js";

export interface HostDeckServiceHostOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly packageRoot?: string;
  readonly signal?: AbortSignal;
  readonly startService?: (
    input: StartHostDeckProductionServiceServeInput
  ) => Promise<HostDeckProductionServiceServe>;
  readonly writeReady?: (output: string) => void;
}

const serviceHostModulePackageRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  ".."
);
const selectedBrowserRoutes = Object.freeze([
  "/",
  "/sessions/:session_id"
] as const);
const maximumServiceOutputBytes = 1_024;
const serviceFailureOutput =
  "HostDeck service failed to start or stop cleanly.\n";

export async function runHostDeckServiceHost(
  args: readonly string[],
  options: HostDeckServiceHostOptions = {}
): Promise<string> {
  assertNoServiceArguments(args);
  const env = options.env ?? process.env;
  if (typeof env.HOSTDECK_CODEX_BIN !== "string") {
    throw new TypeError(
      "HOSTDECK_CODEX_BIN is required for the HostDeck service process."
    );
  }
  const config = loadCliConfig({ env });
  if (config.runtimeDir === null) {
    throw new TypeError("XDG_RUNTIME_DIR is required for the HostDeck service.");
  }
  const packageRoot = resolveCanonicalRuntimePackageRoot(
    options.packageRoot ?? serviceHostModulePackageRoot
  );
  const codexBin = resolveHostDeckCodexExecutable(env);
  const input: StartHostDeckProductionServiceServeInput = {
    browser_routes: selectedBrowserRoutes,
    codex_bin: codexBin,
    config_dir: config.configDir,
    database_path: config.databasePath,
    loopback_port: Number(config.baseUrl.port),
    observe_issue: () => undefined,
    resource_budget: defaultResourceBudget,
    runtime_dir: config.runtimeDir,
    state_dir: config.stateDir,
    static_build_root: join(packageRoot, "web"),
    ...(options.signal === undefined ? {} : { signal: options.signal })
  };
  const start = options.startService ?? startHostDeckProductionServiceServe;
  const service = await start(input);
  if (start === startHostDeckProductionServiceServe) {
    assertHostDeckProductionServiceServe(service);
  } else {
    assertInjectedServiceOwner(service);
  }

  let readyOutput: string;
  try {
    const snapshot = service.snapshot();
    if (
      snapshot.phase !== "ready" ||
      snapshot.listener_health !== "ready" ||
      service.local_origin !== config.baseUrl.origin
    ) {
      throw new TypeError("HostDeck service readiness is contradictory.");
    }
    readyOutput = `HostDeck service ready at ${service.local_origin}.\n`;
    assertServiceOutput(readyOutput);
    const writeResult: unknown = options.writeReady?.(readyOutput);
    if (isPromiseLike(writeResult)) {
      throw new TypeError("HostDeck service readiness writer must be synchronous.");
    }
  } catch (error) {
    const cleanupError = await closeAfterProcessBoundaryFailure(service);
    throw combineProcessBoundaryErrors(error, cleanupError);
  }

  let terminal: Awaited<HostDeckProductionServiceServe["terminated"]>;
  try {
    terminal = await service.terminated;
  } catch (error) {
    const cleanupError = await closeAfterProcessBoundaryFailure(service);
    throw combineProcessBoundaryErrors(error, cleanupError);
  }
  if (
    terminal.phase !== "closed" ||
    terminal.listener_health !== "closed" ||
    terminal.listener.listening
  ) {
    const cleanupError = await closeAfterProcessBoundaryFailure(service);
    throw combineProcessBoundaryErrors(terminal, cleanupError);
  }
  return options.writeReady === undefined ? readyOutput : "";
}

export async function mainHostDeckServiceHost(
  args = process.argv.slice(2),
  options: HostDeckServiceHostOptions = {}
): Promise<0 | 1> {
  try {
    await runHostDeckServiceHost(args, {
      ...options,
      packageRoot: options.packageRoot ?? serviceHostModulePackageRoot,
      writeReady:
        options.writeReady ??
        ((output) => {
          process.stdout.write(output);
        })
    });
    process.exitCode = 0;
    return 0;
  } catch {
    process.exitCode = 1;
    try {
      process.stderr.write(serviceFailureOutput);
    } catch {
      // No reliable process output channel remains.
    }
    return 1;
  }
}

function assertNoServiceArguments(candidate: unknown): asserts candidate is [] {
  if (
    !Array.isArray(candidate) ||
    Object.getPrototypeOf(candidate) !== Array.prototype ||
    candidate.length !== 0 ||
    Reflect.ownKeys(candidate).some((key) => key !== "length")
  ) {
    throw new TypeError("HostDeck service process does not accept arguments.");
  }
}

function assertInjectedServiceOwner(
  candidate: unknown
): asserts candidate is HostDeckProductionServiceServe {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    !Object.isFrozen(candidate) ||
    typeof (candidate as { readonly local_origin?: unknown }).local_origin !==
      "string" ||
    typeof (candidate as { readonly close?: unknown }).close !== "function" ||
    typeof (candidate as { readonly snapshot?: unknown }).snapshot !==
      "function" ||
    !((candidate as { readonly terminated?: unknown }).terminated instanceof
      Promise)
  ) {
    throw new TypeError("Injected HostDeck service owner is invalid.");
  }
}

function assertServiceOutput(output: string): void {
  if (
    Buffer.byteLength(output, "utf8") > maximumServiceOutputBytes ||
    containsInvalidOutputControl(output)
  ) {
    throw new TypeError("HostDeck service output is invalid.");
  }
}

function containsInvalidOutputControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if ((code <= 0x1f && code !== 0x0a) || code === 0x7f) return true;
  }
  return false;
}

async function closeAfterProcessBoundaryFailure(
  service: HostDeckProductionServiceServe
): Promise<unknown | null> {
  try {
    await service.close();
    return null;
  } catch (error) {
    return error;
  }
}

function combineProcessBoundaryErrors(
  primary: unknown,
  cleanup: unknown | null
): unknown {
  return cleanup === null
    ? primary
    : new AggregateError(
        [primary, cleanup],
        "HostDeck service process boundary and cleanup failed."
      );
}

function isPromiseLike(candidate: unknown): candidate is PromiseLike<unknown> {
  return (
    candidate !== null &&
    (typeof candidate === "object" || typeof candidate === "function") &&
    typeof (candidate as { readonly then?: unknown }).then === "function"
  );
}

if (import.meta.main) {
  await mainHostDeckServiceHost();
}
