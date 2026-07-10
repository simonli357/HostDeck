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
import { createCodexPlanClient } from "./plan-client.js";
import { createCodexThreadClient } from "./thread-client.js";
import { createCodexUnixWebSocketTransport } from "./transport.js";

const requireSmoke = process.env.HOSTDECK_REQUIRE_CODEX_PLAN_SMOKE === "1";
const codexBin = process.env.HOSTDECK_CODEX_BIN ?? "codex";

describe.skipIf(!requireSmoke)("installed Codex Plan-control smoke", () => {
  it(
    "applies composed model plus Plan settings, observes plan evidence, then exits through a later Default turn",
    async () => {
      const version = parseCodexCliVersionOutput(
        execFileSync(codexBin, ["--version"], { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 })
      );
      expect(version).toBe(codexBindingDescriptor.codex_version);

      const root = await mkdtemp(join(tmpdir(), "hostdeck-plan-smoke-"));
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
        const started = await threads.start({ operation_id: "op_plan_smoke_thread_0001", cwd: projectDirectory });
        threadId = started.thread.id;
        await threads.ensureMaterialized({
          thread_id: started.thread.id,
          operation_id: "op_plan_smoke_thread_0001",
          cwd: projectDirectory,
          name: "hostdeck-plan-smoke"
        });

        const models = createCodexModelClient(port);
        const plans = createCodexPlanClient(port);
        const modelCatalog = await models.listCatalog();
        const currentBefore = await models.readCurrent(started.thread.id);
        const selectedModel = modelCatalog.models.find((model) => model.runtime_model !== currentBefore.runtime_model);
        expect(selectedModel, "Exact Plan smoke requires one visible non-current model for composition proof.").toBeDefined();
        if (selectedModel === undefined) throw new Error("Exact Codex model catalog has no visible non-current model.");
        const selectedEffort =
          selectedModel.reasoning_efforts.find((effort) => ["minimal", "low"].includes(effort.id)) ??
          selectedModel.reasoning_efforts.find((effort) => effort.is_default);
        expect(selectedEffort).toBeDefined();
        if (selectedEffort === undefined) throw new Error("Selected Codex model has no usable reasoning effort.");

        const planCatalog = await plans.listCatalog();
        const planMode = planCatalog.modes.find((mode) => mode.mode === "plan");
        const defaultMode = planCatalog.modes.find((mode) => mode.mode === "default");
        expect(planMode).toBeDefined();
        expect(defaultMode).toBeDefined();
        if (planMode === undefined || defaultMode === undefined) throw new Error("Exact Codex collaboration catalog is incomplete.");

        const planMark = notifications.length;
        const acceptedPlan = await plans.startTurn({
          operation_id: "op_plan_smoke_turn_0001",
          thread_id: started.thread.id,
          text: "Produce a concise two-step plan for inspecting README.md. Do not call tools or modify files.",
          mode: planMode,
          runtime_model: selectedModel.runtime_model,
          reasoning_effort: selectedEffort.id
        });
        await waitForNotification(
          notifications,
          "thread/settings/updated",
          (params) => settingsMatch(params, started.thread.id, "plan", selectedModel.runtime_model, selectedEffort.id),
          planMark,
          60_000
        );
        await waitForPlanEvidence(notifications, started.thread.id, acceptedPlan.turn_id, planMark, 90_000);
        await waitForTerminalTurn(notifications, started.thread.id, acceptedPlan.turn_id, planMark, 90_000);

        const currentAfterPlan = await models.readCurrent(started.thread.id);
        expect(currentAfterPlan).toMatchObject({
          runtime_model: selectedModel.runtime_model,
          reasoning_effort: selectedEffort.id
        });
        const planRequest = requireTurnRequest(requests, "op_plan_smoke_turn_0001");
        expect(planRequest).not.toHaveProperty("model");
        expect(planRequest).not.toHaveProperty("effort");
        expect(planRequest).toMatchObject({
          collaborationMode: {
            mode: "plan",
            settings: {
              model: selectedModel.runtime_model,
              reasoning_effort: selectedEffort.id,
              developer_instructions: null
            }
          }
        });

        const defaultMark = notifications.length;
        const defaultModel = defaultMode.preset_model ?? currentAfterPlan.runtime_model;
        const acceptedDefault = await plans.startTurn({
          operation_id: "op_plan_smoke_turn_0002",
          thread_id: started.thread.id,
          text: "Reply with exactly DEFAULT_OK. Do not use tools.",
          mode: defaultMode,
          runtime_model: defaultModel,
          reasoning_effort: defaultMode.preset_reasoning_effort
        });
        await waitForNotification(
          notifications,
          "thread/settings/updated",
          (params) =>
            settingsMatch(
              params,
              started.thread.id,
              "default",
              defaultModel,
              defaultMode.preset_reasoning_effort
            ),
          defaultMark,
          60_000
        );
        await waitForTerminalTurn(notifications, started.thread.id, acceptedDefault.turn_id, defaultMark, 90_000);

        const defaultRequest = requireTurnRequest(requests, "op_plan_smoke_turn_0002");
        expect(defaultRequest).not.toHaveProperty("model");
        expect(defaultRequest).not.toHaveProperty("effort");
        expect(defaultRequest).toMatchObject({
          collaborationMode: {
            mode: "default",
            settings: {
              model: defaultModel,
              reasoning_effort: defaultMode.preset_reasoning_effort,
              developer_instructions: null
            }
          }
        });
        expect(requests.filter((request) => request.method === "turn/start")).toHaveLength(2);
        expect(requests.some((request) => request.method === "thread/settings/update")).toBe(false);
        expect(JSON.stringify(requests.filter((request) => request.method === "turn/start"))).not.toContain('"/plan"');

        await threads.archive(started.thread.id);
        threadId = null;
      } catch (error) {
        smokeError = new Error(
          `Real Codex Plan control failed (thread=${threadId ?? "none"}, app_server_exit=${child.exitCode ?? "running"}, stderr=${appServerStderr || "empty"}).`,
          { cause: error }
        );
      }

      const cleanupErrors: unknown[] = [];
      await collectCleanupError(connection.close("HostDeck Plan-control smoke completed."), cleanupErrors);
      await collectCleanupError(stopChild(child), cleanupErrors);
      await collectCleanupError(rm(root, { recursive: true, force: true }), cleanupErrors);
      if (smokeError !== null && cleanupErrors.length > 0) {
        throw new AggregateError([smokeError, ...cleanupErrors], "Codex Plan-control smoke and cleanup failed.");
      }
      if (smokeError !== null) throw smokeError;
      if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "Codex Plan-control cleanup failed.");
    },
    180_000
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

function requireTurnRequest(
  requests: readonly { readonly method: string; readonly params: unknown }[],
  operationId: string
): Record<string, unknown> {
  const request = requests.find(
    (candidate) =>
      candidate.method === "turn/start" &&
      isRecord(candidate.params) &&
      candidate.params.clientUserMessageId === operationId
  );
  if (request === undefined || !isRecord(request.params)) throw new Error(`Missing exact turn/start request ${operationId}.`);
  return request.params;
}

function settingsMatch(
  params: Record<string, unknown>,
  threadId: string,
  mode: "default" | "plan",
  model: string,
  effort: string | null
): boolean {
  if (params.threadId !== threadId || !isRecord(params.threadSettings)) return false;
  const settings = params.threadSettings;
  return (
    settings.model === model &&
    settings.effort === effort &&
    isRecord(settings.collaborationMode) &&
    settings.collaborationMode.mode === mode &&
    isRecord(settings.collaborationMode.settings) &&
    settings.collaborationMode.settings.model === model &&
    settings.collaborationMode.settings.reasoning_effort === effort
  );
}

async function waitForPlanEvidence(
  notifications: readonly CodexConnectionNotification[],
  threadId: string,
  turnId: string,
  startIndex: number,
  timeoutMs: number
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    const match = notifications.slice(startIndex).some((notification) => {
      if (!isRecord(notification.params) || notification.params.threadId !== threadId) return false;
      const params = notification.params;
      if (params.turnId !== turnId && (!isRecord(params.turn) || params.turn.id !== turnId)) return false;
      if (notification.method === "item/plan/delta" || notification.method === "turn/plan/updated") return true;
      return (
        (notification.method === "item/started" || notification.method === "item/completed") &&
        isRecord(params.item) &&
        params.item.type === "plan"
      );
    });
    if (match) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for exact Plan item or delta evidence.");
}

async function waitForTerminalTurn(
  notifications: readonly CodexConnectionNotification[],
  threadId: string,
  turnId: string,
  startIndex: number,
  timeoutMs: number
): Promise<void> {
  const notification = await waitForNotification(
    notifications,
    "turn/completed",
    (params) => params.threadId === threadId && isRecord(params.turn) && params.turn.id === turnId,
    startIndex,
    timeoutMs
  );
  const turn = asRecord(asRecord(notification.params, "turn/completed params").turn, "turn/completed turn");
  if (!["completed", "failed"].includes(turn.status as string)) {
    throw new Error(`Codex Plan smoke turn ended as ${String(turn.status)}: ${boundedJson(turn.error)}`);
  }
  if (turn.status === "failed" && !isRecord(turn.error)) {
    throw new Error("A failed Codex Plan smoke turn did not preserve its structured error.");
  }
}

async function waitForNotification(
  notifications: readonly CodexConnectionNotification[],
  method: string,
  predicate: (params: Record<string, unknown>) => boolean,
  startIndex: number,
  timeoutMs: number
): Promise<CodexConnectionNotification> {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    const match = notifications.slice(startIndex).find((notification) => {
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
    throw new Error("Installed Codex authentication must be a private regular auth.json file for the Plan smoke.");
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
