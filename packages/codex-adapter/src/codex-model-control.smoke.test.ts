import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, copyFile, lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { codexBindingDescriptor } from "./binding.js";
import { parseCodexCliVersionOutput } from "./compatibility.js";
import { type CodexAppServerConnection, type CodexConnectionNotification, createCodexAppServerConnection } from "./connection.js";
import { createCodexModelClient } from "./model-client.js";
import { createCodexThreadClient } from "./thread-client.js";
import { createCodexUnixWebSocketTransport } from "./transport.js";

const requireSmoke = process.env.HOSTDECK_REQUIRE_CODEX_MODEL_SMOKE === "1";
const codexBin = process.env.HOSTDECK_CODEX_BIN ?? "codex";

describe.skipIf(!requireSmoke)("installed Codex model-control smoke", () => {
  it(
    "lists the live catalog and confirms one pending model through turn settings and later resume read-back",
    async () => {
      const version = parseCodexCliVersionOutput(
        execFileSync(codexBin, ["--version"], { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 })
      );
      expect(version).toBe(codexBindingDescriptor.codex_version);

      const root = await mkdtemp(join(tmpdir(), "hostdeck-model-smoke-"));
      const runtimeDirectory = join(root, "runtime");
      const codexHome = join(root, "codex-home");
      const projectDirectory = join(root, "project");
      const socketPath = join(runtimeDirectory, "app.sock");
      await Promise.all([
        mkdir(runtimeDirectory, { mode: 0o700 }),
        mkdir(codexHome, { mode: 0o700 }),
        mkdir(projectDirectory, { mode: 0o700 })
      ]);
      try {
        await seedCodexAuthentication(codexHome);
        execFileSync("git", ["init", "-q", "-b", "main", projectDirectory], { timeout: 10_000 });
      } catch (error) {
        await rm(root, { recursive: true, force: true });
        throw error;
      }

      const child = spawn(
        codexBin,
        ["-c", 'sandbox_mode="danger-full-access"', "-c", 'approval_policy="never"', "app-server", "--listen", `unix://${socketPath}`],
        {
        env: { ...process.env, CODEX_HOME: codexHome },
        stdio: ["ignore", "ignore", "pipe"]
        }
      );
      let appServerStderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        appServerStderr = boundedOutput(appServerStderr, chunk);
      });

      const notifications: CodexConnectionNotification[] = [];
      const connection = createCodexAppServerConnection({
        transport: createCodexUnixWebSocketTransport({ socket_path: socketPath }),
        observed_version: version,
        on_notification: (message) => notifications.push(message)
      });
      const requests: Array<{ readonly method: string; readonly params: unknown }> = [];
      const port = requestRecordingPort(connection, requests);
      let smokeError: Error | null = null;
      let threadId: string | null = null;
      try {
        await waitForSocket(socketPath, child, () => appServerStderr);
        await connection.connect();

        const threads = createCodexThreadClient(port);
        const started = await threads.start({ operation_id: "op_model_smoke_thread_0001", cwd: projectDirectory });
        threadId = started.thread.id;
        await threads.ensureMaterialized({
          thread_id: started.thread.id,
          operation_id: "op_model_smoke_thread_0001",
          cwd: projectDirectory,
          name: "hostdeck-model-smoke"
        });

        const models = createCodexModelClient(port);
        const catalog = await models.listCatalog();
        const currentBefore = await models.readCurrent(started.thread.id);
        const selected = catalog.models.find((model) => model.runtime_model !== currentBefore.runtime_model);
        expect(selected, "Exact Codex model smoke requires one visible non-current catalog model.").toBeDefined();
        if (selected === undefined) throw new Error("Exact Codex model catalog has no visible non-current model.");
        const effort =
          selected.reasoning_efforts.find((candidate) => ["minimal", "low"].includes(candidate.id)) ??
          selected.reasoning_efforts.find((candidate) => candidate.is_default);
        expect(effort).toBeDefined();
        if (effort === undefined) throw new Error("Selected Codex model has no usable reasoning effort.");

        const accepted = await models.startTurn({
          operation_id: "op_model_smoke_turn_0001",
          thread_id: started.thread.id,
          text: "Reply with exactly MODEL_OK. Do not use tools.",
          runtime_model: selected.runtime_model,
          reasoning_effort: effort.id
        });
        await waitForNotification(
          notifications,
          "thread/settings/updated",
          (params) =>
            params.threadId === started.thread.id &&
            isRecord(params.threadSettings) &&
            params.threadSettings.model === selected.runtime_model &&
            params.threadSettings.effort === effort.id,
          60_000
        );
        const completed = await waitForNotification(
          notifications,
          "turn/completed",
          (params) => params.threadId === started.thread.id && isRecord(params.turn) && params.turn.id === accepted.turn_id,
          90_000
        );
        const terminalTurn = asRecord(asRecord(completed.params, "turn/completed params").turn, "turn/completed turn");
        if (!["completed", "failed"].includes(terminalTurn.status as string)) {
          throw new Error(`Codex model smoke turn ended as ${String(terminalTurn.status)}: ${boundedJson(terminalTurn.error)}`);
        }
        if (terminalTurn.status === "failed" && !isRecord(terminalTurn.error)) {
          throw new Error("A failed Codex model smoke turn did not preserve its structured error.");
        }

        const currentAfter = await models.readCurrent(started.thread.id);
        expect(currentAfter).toMatchObject({
          thread_id: started.thread.id,
          runtime_model: selected.runtime_model,
          reasoning_effort: effort.id
        });
        expect(
          requests.some(
            (request) => request.method === "thread/resume" && isRecord(request.params) && Object.hasOwn(request.params, "model")
          )
        ).toBe(false);
        expect(
          requests.filter(
            (request) =>
              request.method === "turn/start" &&
              isRecord(request.params) &&
              request.params.threadId === started.thread.id &&
              request.params.model === selected.runtime_model &&
              request.params.effort === effort.id
          )
        ).toHaveLength(1);
        await threads.archive(started.thread.id);
        threadId = null;
      } catch (error) {
        smokeError = new Error(
          `Real Codex model control failed (thread=${threadId ?? "none"}, app_server_exit=${child.exitCode ?? "running"}, stderr=${appServerStderr || "empty"}).`,
          { cause: error }
        );
      }

      const cleanupErrors: unknown[] = [];
      await collectCleanupError(connection.close("HostDeck model-control smoke completed."), cleanupErrors);
      await collectCleanupError(stopChild(child), cleanupErrors);
      await collectCleanupError(rm(root, { recursive: true, force: true }), cleanupErrors);
      if (smokeError !== null && cleanupErrors.length > 0) {
        throw new AggregateError([smokeError, ...cleanupErrors], "Codex model-control smoke and cleanup failed.");
      }
      if (smokeError !== null) throw smokeError;
      if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "Codex model-control cleanup failed.");
    },
    120_000
  );
});

function requestRecordingPort(
  connection: CodexAppServerConnection,
  requests: Array<{ readonly method: string; readonly params: unknown }>
) {
  return {
    get compatibility() {
      return connection.compatibility;
    },
    request(input: Parameters<CodexAppServerConnection["request"]>[0]) {
      requests.push({ method: input.method, params: input.params });
      return connection.request(input);
    }
  };
}

async function waitForNotification(
  notifications: readonly CodexConnectionNotification[],
  method: string,
  predicate: (params: Record<string, unknown>) => boolean,
  timeoutMs: number
): Promise<CodexConnectionNotification> {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    const match = notifications.find((notification) => {
      if (notification.method !== method || !isRecord(notification.params)) return false;
      return predicate(notification.params);
    });
    if (match !== undefined) return match;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${method}.`);
}

async function waitForSocket(socketPath: string, child: ChildProcess, readStderr: () => string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started <= 5_000) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Codex app-server exited before creating its Unix socket: ${readStderr()}`);
    }
    try {
      if ((await lstat(socketPath)).isSocket()) return;
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Codex app-server did not create its Unix socket: ${readStderr()}`);
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit").then(() => undefined);
  child.kill("SIGTERM");
  if (await settlesWithin(exited, 2_000)) return;
  child.kill("SIGKILL");
  if (!(await settlesWithin(exited, 1_000))) throw new Error("Codex app-server did not exit after SIGKILL.");
}

async function settlesWithin(promise: Promise<void>, milliseconds: number): Promise<boolean> {
  let timeout: NodeJS.Timeout | undefined;
  const expired = new Promise<false>((resolve) => {
    timeout = setTimeout(() => resolve(false), milliseconds);
    timeout.unref();
  });
  const settled = await Promise.race([promise.then(() => true as const), expired]);
  if (timeout !== undefined) clearTimeout(timeout);
  return settled;
}

async function seedCodexAuthentication(codexHome: string): Promise<void> {
  const sourceHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const source = join(sourceHome, "auth.json");
  const sourceMetadata = await lstat(source);
  if (!sourceMetadata.isFile() || (sourceMetadata.mode & 0o077) !== 0) {
    throw new Error("Installed Codex authentication must be a private regular auth.json file for the model smoke.");
  }
  const destination = join(codexHome, "auth.json");
  await copyFile(source, destination);
  await chmod(destination, 0o600);
  const destinationMetadata = await lstat(destination);
  if (!destinationMetadata.isFile() || (destinationMetadata.mode & 0o077) !== 0) {
    throw new Error("Temporary Codex authentication copy is not private.");
  }
}

function boundedOutput(current: string, chunk: Buffer): string {
  return `${current}${chunk.toString("utf8")}`.slice(-32_000);
}

function boundedJson(value: unknown): string {
  return JSON.stringify(value).slice(0, 2_000);
}

async function collectCleanupError(operation: Promise<unknown>, errors: unknown[]): Promise<void> {
  try {
    await operation;
  } catch (error) {
    errors.push(error);
  }
}

function asRecord(candidate: unknown, label: string): Record<string, unknown> {
  if (!isRecord(candidate)) throw new Error(`${label} must be an object.`);
  return candidate;
}

function isRecord(candidate: unknown): candidate is Record<string, unknown> {
  return candidate !== null && typeof candidate === "object" && !Array.isArray(candidate);
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
