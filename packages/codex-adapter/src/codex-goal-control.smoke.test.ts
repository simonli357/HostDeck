import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, copyFile, lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { codexBindingDescriptor } from "./binding.js";
import { parseCodexCliVersionOutput } from "./compatibility.js";
import { type CodexAppServerConnection, type CodexConnectionNotification, createCodexAppServerConnection } from "./connection.js";
import { HostDeckCodexAdapterError } from "./errors.js";
import { createCodexGoalClient } from "./goal-client.js";
import { createCodexThreadClient } from "./thread-client.js";
import { createCodexUnixWebSocketTransport } from "./transport.js";

const requireSmoke = process.env.HOSTDECK_REQUIRE_CODEX_GOAL_SMOKE === "1";
const codexBin = process.env.HOSTDECK_CODEX_BIN ?? "codex";

describe.skipIf(!requireSmoke)("installed Codex goal-control smoke", () => {
  it(
    "proves passive paused edits and one bounded agentic activation before complete and clear",
    async () => {
      const version = parseCodexCliVersionOutput(
        execFileSync(codexBin, ["--version"], { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 })
      );
      expect(version).toBe(codexBindingDescriptor.codex_version);

      const root = await mkdtemp(join(tmpdir(), "hostdeck-goal-smoke-"));
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
      let activeTurnId: string | null = null;
      try {
        await waitForSocket(socketPath, child, () => appServerStderr);
        await connection.connect();

        const threads = createCodexThreadClient(port);
        const started = await threads.start({ operation_id: "op_goal_smoke_thread_0001", cwd: projectDirectory });
        threadId = started.thread.id;
        await threads.ensureMaterialized({
          thread_id: started.thread.id,
          operation_id: "op_goal_smoke_thread_0001",
          cwd: projectDirectory,
          name: "hostdeck-goal-smoke"
        });

        const goals = createCodexGoalClient(port);
        const goalRequestMark = requests.length;
        const notificationMark = notifications.length;
        const paused = await goals.setPaused(
          started.thread.id,
          "Produce one short status sentence for this bounded goal, then stop."
        );
        expect(paused.status).toBe("paused");
        expect((await goals.read(started.thread.id))?.revision).toBe(paused.revision);
        await delay(400);
        expect(
          notifications
            .slice(notificationMark)
            .some((notification) => notification.method === "turn/started" && notificationThreadId(notification) === started.thread.id)
        ).toBe(false);

        const active = await goals.setStatus(started.thread.id, "active");
        expect(active).toMatchObject({ objective: paused.objective, status: "active" });
        await waitForNotification(
          notifications,
          "thread/goal/updated",
          (params) => params.threadId === started.thread.id && isRecord(params.goal) && params.goal.status === "active",
          30_000
        );
        const turnStarted = await waitForNotification(
          notifications,
          "turn/started",
          (params) => params.threadId === started.thread.id && isRecord(params.turn),
          60_000
        );
        activeTurnId = asString(asRecord(asRecord(turnStarted.params, "turn/started params").turn, "turn/started turn").id, "turn id");

        const pausedAgain = await goals.setStatus(started.thread.id, "paused");
        expect(pausedAgain).toMatchObject({ objective: paused.objective, status: "paused" });
        await waitForNotification(
          notifications,
          "thread/goal/updated",
          (params) => params.threadId === started.thread.id && isRecord(params.goal) && params.goal.status === "paused",
          30_000
        );
        try {
          await connection.request({
            method: "turn/interrupt",
            params: { threadId: started.thread.id, turnId: activeTurnId },
            kind: "mutation"
          });
        } catch (error) {
          if (!(error instanceof HostDeckCodexAdapterError) || error.outcome !== "remote_rejected") throw error;
        }
        await waitForNotification(
          notifications,
          "turn/completed",
          (params) => params.threadId === started.thread.id && isRecord(params.turn) && params.turn.id === activeTurnId,
          60_000
        );
        activeTurnId = null;
        await delay(400);
        expect(
          notifications.filter(
            (notification) => notification.method === "turn/started" && notificationThreadId(notification) === started.thread.id
          )
        ).toHaveLength(1);

        const readPaused = await goals.read(started.thread.id);
        expect(readPaused).toMatchObject({ objective: paused.objective, status: "paused" });
        expect(readPaused?.tokens_used).toBeGreaterThanOrEqual(0);
        expect(readPaused?.time_used_seconds).toBeGreaterThanOrEqual(0);
        const completed = await goals.setStatus(started.thread.id, "complete");
        expect(completed).toMatchObject({ objective: paused.objective, status: "complete" });
        expect((await goals.read(started.thread.id))?.status).toBe("complete");
        await expect(goals.clear(started.thread.id)).resolves.toBe(true);
        await expect(goals.read(started.thread.id)).resolves.toBeNull();

        const goalRequests = requests.slice(goalRequestMark);
        expect(
          goalRequests.filter(
            (request) => request.method === "thread/goal/set" && isRecord(request.params) && request.params.status === "active"
          )
        ).toHaveLength(1);
        expect(goalRequests.some((request) => request.method === "turn/start")).toBe(false);
        await threads.archive(started.thread.id);
        threadId = null;
      } catch (error) {
        smokeError = new Error(
          `Real Codex goal control failed (thread=${threadId ?? "none"}, active_turn=${activeTurnId ?? "none"}, app_server_exit=${child.exitCode ?? "running"}, stderr=${appServerStderr || "empty"}).`,
          { cause: error }
        );
      }

      const cleanupErrors: unknown[] = [];
      if (threadId !== null && activeTurnId !== null) {
        await collectCleanupError(
          connection.request({
            method: "turn/interrupt",
            params: { threadId, turnId: activeTurnId },
            kind: "mutation"
          }),
          cleanupErrors
        );
      }
      await collectCleanupError(connection.close("HostDeck goal-control smoke completed."), cleanupErrors);
      await collectCleanupError(stopChild(child), cleanupErrors);
      await collectCleanupError(rm(root, { recursive: true, force: true }), cleanupErrors);
      if (smokeError !== null && cleanupErrors.length > 0) {
        throw new AggregateError([smokeError, ...cleanupErrors], "Codex goal-control smoke and cleanup failed.");
      }
      if (smokeError !== null) throw smokeError;
      if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "Codex goal-control cleanup failed.");
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
    await delay(20);
  }
  throw new Error(`Timed out waiting for ${method}.`);
}

function notificationThreadId(notification: CodexConnectionNotification): string | null {
  return isRecord(notification.params) && typeof notification.params.threadId === "string"
    ? notification.params.threadId
    : null;
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
    await delay(20);
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
    throw new Error("Installed Codex authentication must be a private regular auth.json file for the goal smoke.");
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

function asString(candidate: unknown, label: string): string {
  if (typeof candidate !== "string" || candidate.length === 0) throw new Error(`${label} must be a string.`);
  return candidate;
}

function isRecord(candidate: unknown): candidate is Record<string, unknown> {
  return candidate !== null && typeof candidate === "object" && !Array.isArray(candidate);
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
