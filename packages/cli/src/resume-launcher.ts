import { spawn as spawnProcess } from "node:child_process";
import {
  type SelectedResumeLaunch,
  selectedResumeLaunchSchema
} from "@hostdeck/contracts";
import {
  CliFailure,
  clientOperationFailure,
  internalFailure
} from "./errors.js";
import { cliExitCodes } from "./exit-codes.js";

export interface HostDeckResumeChildProcess {
  readonly once: {
    (
      event: "error",
      listener: (error: Error) => void
    ): HostDeckResumeChildProcess;
    (
      event: "exit",
      listener: (code: number | null, signal: NodeJS.Signals | null) => void
    ): HostDeckResumeChildProcess;
  };
}

export interface HostDeckResumeSpawnOptions {
  readonly shell: false;
  readonly stdio: "inherit";
}

export type HostDeckResumeSpawn = (
  executable: string,
  args: readonly string[],
  options: HostDeckResumeSpawnOptions
) => HostDeckResumeChildProcess;

export interface CreateHostDeckResumeLauncherOptions {
  readonly spawn?: HostDeckResumeSpawn;
}

export interface HostDeckResumeLauncher {
  readonly launch: (descriptor: SelectedResumeLaunch) => Promise<void>;
}

const optionKeys = ["spawn"] as const;
const spawnOptions = Object.freeze({
  shell: false as const,
  stdio: "inherit" as const
});
const defaultSpawn: HostDeckResumeSpawn = (executable, args, options) =>
  spawnProcess(executable, [...args], options);

export function createHostDeckResumeLauncher(
  input: CreateHostDeckResumeLauncherOptions = {}
): HostDeckResumeLauncher {
  const values = readExactOptions(input);
  if (values.spawn !== undefined && typeof values.spawn !== "function") {
    throw new TypeError("HostDeck resume launcher spawn port is invalid.");
  }
  const spawn = (values.spawn ?? defaultSpawn) as HostDeckResumeSpawn;
  const launcher: HostDeckResumeLauncher = {
    async launch(candidate) {
      const descriptor = parseLaunch(candidate);
      await launchProcess(spawn, descriptor);
    }
  };
  return Object.freeze(launcher);
}

function launchProcess(
  spawn: HostDeckResumeSpawn,
  descriptor: SelectedResumeLaunch
): Promise<void> {
  let child: HostDeckResumeChildProcess;
  try {
    child = Reflect.apply(spawn, undefined, [
      descriptor.executable,
      descriptor.args,
      spawnOptions
    ]) as HostDeckResumeChildProcess;
  } catch (error) {
    return Promise.reject(resumeStartFailure(error));
  }

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    try {
      child.once("error", (error) => fail(resumeStartFailure(error)));
      child.once("exit", (code, signal) => {
        if (settled) return;
        settled = true;
        if (signal !== null) {
          reject(
            clientOperationFailure(
              "runtime_unavailable",
              "Codex TUI resume was terminated before completion."
            )
          );
          return;
        }
        if (code === 0) {
          resolve();
          return;
        }
        if (code !== null && Number.isSafeInteger(code)) {
          reject(
            clientOperationFailure(
              "unknown_error",
              `Codex TUI resume exited with status ${code}.`
            )
          );
          return;
        }
        reject(internalFailure("Codex TUI resume exited without a status."));
      });
    } catch (error) {
      fail(internalFailure("Codex TUI resume process handle is invalid.", error));
    }
  });
}

function parseLaunch(candidate: unknown): SelectedResumeLaunch {
  const parsed = selectedResumeLaunchSchema.safeParse(candidate);
  if (!parsed.success) {
    throw internalFailure("Codex TUI resume launch descriptor is invalid.");
  }
  return deepFreeze(parsed.data);
}

function resumeStartFailure(cause: unknown): CliFailure {
  return new CliFailure({
    kind: "api_error",
    code: "runtime_unavailable",
    message: "Codex TUI resume could not be started.",
    exitCode: cliExitCodes.apiError,
    cause
  });
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function readExactOptions(
  candidate: unknown
): Readonly<Record<(typeof optionKeys)[number], unknown>> {
  const message = "HostDeck resume launcher options are invalid.";
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate)
  ) {
    throw new TypeError(message);
  }
  try {
    const prototype: unknown = Object.getPrototypeOf(candidate);
    const descriptors = Object.getOwnPropertyDescriptors(candidate);
    const keys = Reflect.ownKeys(descriptors);
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      keys.length > optionKeys.length ||
      keys.some((key) => {
        if (key !== "spawn") return true;
        const descriptor = descriptors.spawn;
        return (
          descriptor === undefined ||
          !descriptor.enumerable ||
          !("value" in descriptor)
        );
      })
    ) {
      throw new TypeError(message);
    }
    return Object.freeze({ spawn: descriptors.spawn?.value });
  } catch (error) {
    if (error instanceof TypeError && error.message === message) throw error;
    throw new TypeError(message);
  }
}
