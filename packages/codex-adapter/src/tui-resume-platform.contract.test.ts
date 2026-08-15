import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type CodexAuthenticatedLoopbackWebSocketEndpoint,
  codexRemoteAuthEnvironmentVariable,
  createCodexUnixSocketEndpoint
} from "./transport-endpoint.js";
import {
  buildCodexPlatformTuiResumeCommand,
  type CodexPlatformTuiResumeCommand,
  createCodexPlatformTuiResumeExecutor,
  HostDeckCodexPlatformTuiResumeError
} from "./tui-resume-platform.js";

const threadId = "thr_native_resume_contract_001";
const credential = "N".repeat(64);
const staleCredential = "S".repeat(64);
const windowsEndpoint: CodexAuthenticatedLoopbackWebSocketEndpoint =
  Object.freeze({
    schema_version: 1,
    target: "windows-x64",
    kind: "authenticated_loopback_websocket",
    address: "ws://127.0.0.1:43871",
    port_allocation: "ephemeral_random",
    credential_source: "protected_environment"
  });

const fixtureSource = `
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const mode = process.env.HOSTDECK_RESUME_FIXTURE_MODE;
const resultPath = process.env.HOSTDECK_RESUME_FIXTURE_RESULT;
if (typeof mode !== "string" || typeof resultPath !== "string") process.exit(91);
const token = process.env.HOSTDECK_CODEX_REMOTE_AUTH;
const observedArgs = [path.basename(process.argv[1]), ...process.argv.slice(2)];
const result = {
  args: observedArgs,
  cwd: process.cwd(),
  credential_length: typeof token === "string" ? token.length : 0,
  credential_present: typeof token === "string",
  pid: process.pid,
  token_in_args: typeof token === "string" && observedArgs.includes(token)
};
fs.writeFileSync(resultPath, JSON.stringify(result), { encoding: "utf8", mode: 0o600 });
if (mode === "failure") process.exit(23);
if (mode === "wait") setInterval(() => {}, 1000);
`.trimStart();

describe("native platform Codex TUI resume process contract", () => {
  it("runs exact target argv/cwd with auth present only in the Windows child environment", async () => {
    const fixture = await createFixture("success");
    try {
      const command = nativeCommand(fixture.root);
      await expect(
        createCodexPlatformTuiResumeExecutor().execute({
          command,
          ...nativeCredential(),
          environment: nativeEnvironment(fixture.result, "success"),
          signal: new AbortController().signal
        })
      ).resolves.toBeUndefined();

      const source = await readFile(fixture.result, "utf8");
      const result = JSON.parse(source) as NativeFixtureResult;
      expect(result.args).toEqual(command.args);
      expect(normalizeNativePath(result.cwd)).toBe(
        normalizeNativePath(command.cwd)
      );
      expect(result.credential_present).toBe(process.platform === "win32");
      expect(result.credential_length).toBe(
        process.platform === "win32" ? credential.length : 0
      );
      expect(result.token_in_args).toBe(false);
      expect(source).not.toContain(credential);
      expect(source).not.toContain(staleCredential);
      expect(JSON.stringify(command)).not.toContain(credential);
    } finally {
      await removeFixture(fixture.root);
    }
  });

  it("maps a native nonzero endpoint failure without retaining output or credentials", async () => {
    const fixture = await createFixture("failure");
    try {
      const error = await captureResumeRejection(
        createCodexPlatformTuiResumeExecutor().execute({
          command: nativeCommand(fixture.root),
          ...nativeCredential(),
          environment: nativeEnvironment(fixture.result, "failure"),
          signal: new AbortController().signal
        })
      );
      expect(error).toMatchObject({
        code: "process_exited",
        stage: "execution",
        message: "Codex TUI resume exited with status 23."
      });
      expect(`${error.message}:${JSON.stringify(error)}`).not.toContain(
        credential
      );
      expect(`${error.message}:${JSON.stringify(error)}`).not.toContain(
        fixture.root
      );
    } finally {
      await removeFixture(fixture.root);
    }
  });

  it("propagates abort and waits for the native child to terminate", async () => {
    const fixture = await createFixture("wait");
    const controller = new AbortController();
    const execution = createCodexPlatformTuiResumeExecutor().execute({
      command: nativeCommand(fixture.root),
      ...nativeCredential(),
      environment: nativeEnvironment(fixture.result, "wait"),
      signal: controller.signal
    });
    try {
      await Promise.race([
        waitForFile(fixture.result, 5_000),
        execution.then(
          () => Promise.reject(new Error("Native resume child exited before abort.")),
          (error: unknown) => Promise.reject(error)
        )
      ]);
      const result = JSON.parse(
        await readFile(fixture.result, "utf8")
      ) as NativeFixtureResult;
      expect(processExists(result.pid)).toBe(true);

      controller.abort();
      const error = await captureResumeRejection(execution);
      expect(error).toMatchObject({
        code: "process_aborted",
        stage: "execution"
      });
      await waitFor(() => !processExists(result.pid), 5_000);
      expect(processExists(result.pid)).toBe(false);
      expect(JSON.stringify(error)).not.toContain(credential);
    } finally {
      controller.abort();
      await execution.catch(() => undefined);
      await removeFixture(fixture.root);
    }
  }, 15_000);
});

interface NativeFixture {
  readonly root: string;
  readonly result: string;
}

interface NativeFixtureResult {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly credential_length: number;
  readonly credential_present: boolean;
  readonly pid: number;
  readonly token_in_args: boolean;
}

async function createFixture(mode: string): Promise<NativeFixture> {
  requireSupportedNativeHost();
  const root = await mkdtemp(join(tmpdir(), "hostdeck tui resume-"));
  const executable = join(root, "resume");
  const result = join(root, `${mode}.json`);
  try {
    await writeFile(executable, fixtureSource, { encoding: "utf8", mode: 0o700 });
    if (process.platform !== "win32") await chmod(executable, 0o700);
    return Object.freeze({ root, result });
  } catch (error) {
    await removeFixture(root);
    throw error;
  }
}

function nativeCommand(root: string): CodexPlatformTuiResumeCommand {
  if (process.platform === "win32") {
    return buildCodexPlatformTuiResumeCommand({
      target: "windows-x64",
      endpoint: windowsEndpoint,
      thread_id: threadId,
      codex_bin: process.execPath,
      cwd: root
    });
  }
  return buildCodexPlatformTuiResumeCommand({
    target: "linux-x64",
    endpoint: createCodexUnixSocketEndpoint(join(root, "app.sock")),
    thread_id: threadId,
    codex_bin: process.execPath,
    cwd: root
  });
}

function nativeCredential(): Readonly<{
  credential?: {
    readonly kind: "protected_environment";
    readonly environment_variable: typeof codexRemoteAuthEnvironmentVariable;
    readonly read: () => string;
  };
}> {
  if (process.platform !== "win32") return Object.freeze({});
  return Object.freeze({
    credential: Object.freeze({
      kind: "protected_environment" as const,
      environment_variable: codexRemoteAuthEnvironmentVariable,
      read: () => credential
    })
  });
}

function nativeEnvironment(
  result: string,
  mode: string
): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {
    HOSTDECK_RESUME_FIXTURE_MODE: mode,
    HOSTDECK_RESUME_FIXTURE_RESULT: result,
    HOSTDECK_CODEX_REMOTE_AUTH: staleCredential
  };
  for (const name of ["SYSTEMROOT", "TEMP", "TMP", "WINDIR"] as const) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return Object.freeze(environment);
}

function normalizeNativePath(path: string): string {
  return process.platform === "win32" ? win32.normalize(path).toLowerCase() : path;
}

function requireSupportedNativeHost(): void {
  if (
    process.arch !== "x64" ||
    (process.platform !== "linux" && process.platform !== "win32")
  ) {
    throw new Error("Platform TUI resume contract requires native Linux or Windows x64.");
  }
}

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  await waitFor(async () => {
    try {
      await readFile(path);
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }, timeoutMs);
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number
): Promise<void> {
  const started = Date.now();
  while (!(await predicate())) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("Native resume process condition timed out.");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ESRCH")
  );
}

async function removeFixture(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

async function captureResumeRejection(
  work: Promise<void>
): Promise<HostDeckCodexPlatformTuiResumeError> {
  try {
    await work;
  } catch (error) {
    expect(error).toBeInstanceOf(HostDeckCodexPlatformTuiResumeError);
    return error as HostDeckCodexPlatformTuiResumeError;
  }
  throw new Error("Expected native platform TUI resume rejection.");
}
