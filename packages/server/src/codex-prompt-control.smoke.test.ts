import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, copyFile, lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CodexAppServerConnection,
  type CodexConnectionNotification,
  type CodexEventNormalizer,
  type CodexTurnClient,
  codexBindingDescriptor,
  createCodexAppServerConnection,
  createCodexEventNormalizer,
  createCodexModelClient,
  createCodexThreadClient,
  createCodexTurnClient,
  createCodexUnixWebSocketTransport,
  parseCodexCliVersionOutput
} from "@hostdeck/codex-adapter";
import {
  clientOperationIdSchema,
  type ManagedSessionTarget,
  type ModelCatalogEntry,
  managedSessionTargetSchema
} from "@hostdeck/contracts";
import type { CodexThreadId } from "@hostdeck/core";
import type { SelectedSessionState } from "@hostdeck/storage";
import { describe, expect, it } from "vitest";
import {
  type CodexPromptControlService,
  type CodexPromptControlStatePort,
  type CodexPromptModelPort,
  type CodexPromptPlanPort,
  createCodexPromptControlService
} from "./codex-prompt-control-service.js";

const requireSmoke = process.env.HOSTDECK_REQUIRE_CODEX_PROMPT_SMOKE === "1";
const codexBin = process.env.HOSTDECK_CODEX_BIN ?? "codex";

describe.skipIf(!requireSmoke)("installed Codex prompt-control smoke", () => {
  it(
    "starts and steers one exact turn while a second managed thread remains unchanged",
    async () => {
      const version = parseCodexCliVersionOutput(
        execFileSync(codexBin, ["--version"], { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 })
      );
      expect(version).toBe(codexBindingDescriptor.codex_version);

      const root = await mkdtemp(join(tmpdir(), "hostdeck-prompt-smoke-"));
      const runtimeDirectory = join(root, "runtime");
      const codexHome = join(root, "codex-home");
      const projectA = join(root, "project-a");
      const projectB = join(root, "project-b");
      const socketPath = join(runtimeDirectory, "app.sock");
      await Promise.all([
        mkdir(runtimeDirectory, { mode: 0o700 }),
        mkdir(codexHome, { mode: 0o700 }),
        mkdir(projectA, { mode: 0o700 }),
        mkdir(projectB, { mode: 0o700 })
      ]);
      try {
        await seedCodexAuthentication(codexHome);
        execFileSync("git", ["init", "-q", "-b", "main", projectA], { timeout: 10_000 });
        execFileSync("git", ["init", "-q", "-b", "main", projectB], { timeout: 10_000 });
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
      const threadIds: string[] = [];
      try {
        await waitForSocket(socketPath, child, () => appServerStderr);
        await connection.connect();

        const threads = createCodexThreadClient(port);
        const [threadA, threadB] = await Promise.all([
          createManagedThread(threads, projectA, "a"),
          createManagedThread(threads, projectB, "b")
        ]);
        threadIds.push(threadA, threadB);
        const targetA = managedTarget("sess_prompt_smoke_a", threadA);
        const targetB = managedTarget("sess_prompt_smoke_b", threadB);
        const states = new Map<string, SelectedSessionState>([
          [targetA.session_id, selectedState(targetA, "idle")],
          [targetB.session_id, selectedState(targetB, "idle")]
        ]);
        const modelSelection = selectBoundedSmokeModel((await createCodexModelClient(port).listCatalog()).models);
        const service = createPromptService(createCodexTurnClient(port), states, {
          session_id: targetA.session_id,
          runtime_model: modelSelection.model.runtime_model,
          reasoning_effort: modelSelection.reasoning_effort,
          revision: 1
        });
        const normalizer = createCodexEventNormalizer({
          is_managed_thread: (threadId) => threadId === threadA || threadId === threadB
        });
        const cursor = { value: notifications.length };

        const accepted = await service.dispatch({
          operation_id: "op_prompt_smoke_start_0001",
          target: targetA,
          kind: "prompt",
          text: "Use the shell tool to run `sleep 8`. After it finishes, reply with exactly INITIAL_DONE."
        });
        expect(accepted).toMatchObject({
          action: "start",
          thread_id: threadA,
          state: "accepted",
          model_revision: 1,
          steerable: false
        });
        expect((await service.snapshot(targetA)).phase).toBe("accepted");

        const started = await waitForNotification(
          notifications,
          "turn/started",
          (params) => params.threadId === threadA && isRecord(params.turn) && params.turn.id === accepted.turn_id,
          cursor.value,
          60_000
        );
        await processNotificationsThrough(notifications, cursor, started.index, normalizer, service, states);
        expect(await service.snapshot(targetA)).toMatchObject({
          phase: "steerable",
          turn_id: accepted.turn_id,
          started_at: expect.any(String)
        });

        const steered = await service.dispatch({
          operation_id: "op_prompt_smoke_steer_0001",
          target: targetA,
          kind: "prompt",
          text: "Keep waiting for the current command. Then reply with exactly STEER_OK."
        });
        expect(steered).toMatchObject({
          action: "steer",
          thread_id: threadA,
          turn_id: accepted.turn_id,
          state: "accepted",
          steerable: true
        });

        const completed = await waitForNotification(
          notifications,
          "turn/completed",
          (params) => params.threadId === threadA && isRecord(params.turn) && params.turn.id === accepted.turn_id,
          cursor.value,
          90_000
        );
        const completedParams = requireRecord(completed.notification.params, "turn/completed params");
        const completedTurn = requireRecord(completedParams.turn, "turn/completed turn");
        await processNotificationsThrough(notifications, cursor, completed.index, normalizer, service, states);
        expect(await service.snapshot(targetA)).toMatchObject({ phase: "idle", turn_id: null });
        expect(await service.snapshot(targetB)).toMatchObject({ phase: "idle", turn_id: null });

        const promptRequests = requests.filter((request) => ["turn/start", "turn/steer"].includes(request.method));
        expect(promptRequests).toHaveLength(2);
        expect(promptRequests[0]).toMatchObject({
          method: "turn/start",
          params: {
            threadId: threadA,
            clientUserMessageId: "op_prompt_smoke_start_0001",
            model: modelSelection.model.runtime_model,
            effort: modelSelection.reasoning_effort
          }
        });
        expect(promptRequests[1]).toMatchObject({
          method: "turn/steer",
          params: {
            threadId: threadA,
            expectedTurnId: accepted.turn_id,
            clientUserMessageId: "op_prompt_smoke_steer_0001"
          }
        });
        expect(
          notifications.filter(
            (notification) =>
              notification.method === "turn/started" &&
              isRecord(notification.params) &&
              notification.params.threadId === threadA &&
              isRecord(notification.params.turn) &&
              notification.params.turn.id === accepted.turn_id
          )
        ).toHaveLength(1);
        expect(
          notifications.some(
            (notification) =>
              ["turn/started", "turn/completed"].includes(notification.method) &&
              isRecord(notification.params) &&
              notification.params.threadId === threadB
          )
        ).toBe(false);

        await Promise.all([threads.archive(threadA), threads.archive(threadB)]);
        threadIds.length = 0;
        expect(completedTurn).toMatchObject({ id: accepted.turn_id, status: "completed", error: null });
      } catch (error) {
        smokeError = new Error(
          `Real Codex prompt control failed (threads=${threadIds.join(",") || "none"}, app_server_exit=${child.exitCode ?? "running"}, stderr=${appServerStderr || "empty"}).`,
          { cause: error }
        );
      }

      const cleanupErrors: unknown[] = [];
      await collectCleanupError(connection.close("HostDeck prompt-control smoke completed."), cleanupErrors);
      await collectCleanupError(stopChild(child), cleanupErrors);
      await collectCleanupError(rm(root, { recursive: true, force: true }), cleanupErrors);
      if (smokeError !== null && cleanupErrors.length > 0) {
        throw new AggregateError([smokeError, ...cleanupErrors], "Codex prompt-control smoke and cleanup failed.");
      }
      if (smokeError !== null) throw smokeError;
      if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "Codex prompt-control cleanup failed.");
    },
    180_000
  );
});

function createPromptService(
  turns: CodexTurnClient,
  states: Map<string, SelectedSessionState>,
  modelSelection: SmokeModelSelection
): CodexPromptControlService {
  const statePort: CodexPromptControlStatePort = {
    get: (sessionId) => states.get(sessionId) ?? null,
    getByThreadId: (threadId) => [...states.values()].find((state) => state.mapping.codex_thread_id === threadId) ?? null
  };
  const models: CodexPromptModelPort = {
    readPendingSettings: (target) =>
      target.session_id === modelSelection.session_id
        ? [{ control: "model", revision: modelSelection.revision, phase: "pending" }]
        : [],
    dispatchPendingTurn: async (input, signal) => {
      const request = requireRecord(input, "prompt smoke pending-model request");
      const operationId = clientOperationIdSchema.parse(request.operation_id);
      const target = managedSessionTargetSchema.parse(request.target);
      if (typeof request.text !== "string" || request.expected_pending_revision !== modelSelection.revision) {
        throw new Error("Prompt smoke did not preserve the exact pending model revision.");
      }
      const accepted = await turns.startTurn({
        operation_id: operationId,
        thread_id: target.codex_thread_id,
        text: request.text,
        settings: {
          kind: "model",
          runtime_model: modelSelection.runtime_model,
          reasoning_effort: modelSelection.reasoning_effort
        },
        ...(signal === undefined ? {} : { signal })
      });
      return { ...accepted, pending_revision: modelSelection.revision };
    }
  };
  const plans: CodexPromptPlanPort = {
    readPendingSettings: () => [],
    dispatchPendingTurn: async () => {
      throw new Error("Prompt smoke unexpectedly selected the Plan pending-turn path.");
    }
  };
  return createCodexPromptControlService({ turns, models, plans, states: statePort });
}

interface SmokeModelSelection {
  readonly session_id: string;
  readonly runtime_model: string;
  readonly reasoning_effort: string;
  readonly revision: number;
}

function selectBoundedSmokeModel(models: readonly ModelCatalogEntry[]): {
  readonly model: ModelCatalogEntry;
  readonly reasoning_effort: string;
} {
  const model =
    models.find((candidate) => /mini/iu.test(`${candidate.id} ${candidate.runtime_model} ${candidate.label}`)) ??
    models.find((candidate) => /spark/iu.test(`${candidate.id} ${candidate.runtime_model} ${candidate.label}`));
  if (model === undefined) throw new Error("Exact Codex catalog exposes no visible mini or spark model for the bounded prompt smoke.");
  const effort =
    model.reasoning_efforts.find((candidate) => candidate.id === "minimal") ??
    model.reasoning_efforts.find((candidate) => candidate.id === "low") ??
    model.reasoning_efforts.find((candidate) => candidate.is_default);
  if (effort === undefined) throw new Error("Selected bounded prompt-smoke model has no supported reasoning effort.");
  return { model, reasoning_effort: effort.id };
}

async function processNotificationsThrough(
  notifications: readonly CodexConnectionNotification[],
  cursor: { value: number },
  endIndex: number,
  normalizer: CodexEventNormalizer,
  service: CodexPromptControlService,
  states: Map<string, SelectedSessionState>
): Promise<void> {
  for (let index = cursor.value; index <= endIndex; index += 1) {
    const notification = notifications[index];
    if (notification === undefined) throw new Error(`Missing Codex notification at index ${index}.`);
    const result = normalizer.normalize(notification);
    if (result.kind !== "event") continue;
    const selected = "thread_id" in result.event ? findStateByThread(states, result.event.thread_id) : null;
    if (selected !== null && result.event.method === "turn/started") {
      states.set(selected.mapping.id, selectedState(managedTarget(selected.mapping.id, result.event.thread_id), "in_progress"));
    }
    if (selected !== null && result.event.method === "turn/completed") {
      states.set(selected.mapping.id, selectedState(managedTarget(selected.mapping.id, result.event.thread_id), "completed"));
    }
    await service.observeEvent(result.event);
  }
  cursor.value = endIndex + 1;
}

function findStateByThread(states: Map<string, SelectedSessionState>, threadId: string): SelectedSessionState | null {
  return [...states.values()].find((state) => state.mapping.codex_thread_id === threadId) ?? null;
}

function selectedState(target: ManagedSessionTarget, turnState: string): SelectedSessionState {
  return {
    mapping: { id: target.session_id, codex_thread_id: target.codex_thread_id, archived_at: null },
    projection: {
      session: { session_state: "active", freshness: "current", turn_state: turnState }
    }
  } as unknown as SelectedSessionState;
}

function managedTarget(sessionId: string, threadId: string): ManagedSessionTarget {
  return { type: "managed_session", session_id: sessionId, codex_thread_id: threadId } as ManagedSessionTarget;
}

async function createManagedThread(
  threads: ReturnType<typeof createCodexThreadClient>,
  projectDirectory: string,
  suffix: "a" | "b"
): Promise<CodexThreadId> {
  const operationId = `op_prompt_smoke_thread_${suffix}`;
  const started = await threads.start({ operation_id: operationId, cwd: projectDirectory });
  await threads.ensureMaterialized({
    thread_id: started.thread.id,
    operation_id: operationId,
    cwd: projectDirectory,
    name: `hostdeck-prompt-smoke-${suffix}`
  });
  return started.thread.id;
}

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
  startIndex: number,
  timeoutMs: number
): Promise<{ readonly index: number; readonly notification: CodexConnectionNotification }> {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    for (let index = startIndex; index < notifications.length; index += 1) {
      const notification = notifications[index];
      if (notification?.method === method && isRecord(notification.params) && predicate(notification.params)) {
        return { index, notification };
      }
    }
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
    throw new Error("Installed Codex authentication must be a private regular auth.json file for the prompt smoke.");
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

function isRecord(candidate: unknown): candidate is Record<string, unknown> {
  return candidate !== null && typeof candidate === "object" && !Array.isArray(candidate);
}

function requireRecord(candidate: unknown, label: string): Record<string, unknown> {
  if (!isRecord(candidate)) throw new Error(`${label} must be an object.`);
  return candidate;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
