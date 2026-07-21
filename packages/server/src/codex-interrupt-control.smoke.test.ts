import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, copyFile, lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CodexAppServerConnection,
  type CodexConnectionNotification,
  type CodexConnectionServerRequest,
  type CodexEventNormalizer,
  type CodexProtocolIssue,
  type CodexRequestInput,
  type CodexThreadClient,
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
  type ModelCatalogEntry,
  selectedSessionMappingRecordSchema,
  selectedSessionProjectionRecordSchema
} from "@hostdeck/contracts";
import type { CodexThreadId } from "@hostdeck/core";
import type { SelectedSessionState } from "@hostdeck/storage";
import { describe, expect, it } from "vitest";
import {
  type CodexInterruptControlService,
  createCodexInterruptControlService,
  HostDeckCodexInterruptControlError
} from "./codex-interrupt-control-service.js";
import {
  type WithTestOperationDeadlines,
  withTestOperationDeadlines
} from "./test-operation-deadline.js";

type TestInterruptControlService = WithTestOperationDeadlines<
  CodexInterruptControlService,
  "interrupt" | "waitForTerminal"
>;

const requireSmoke = process.env.HOSTDECK_REQUIRE_CODEX_INTERRUPT_SMOKE === "1";
const codexBin = process.env.HOSTDECK_CODEX_BIN ?? "codex";

describe.skipIf(!requireSmoke)("installed Codex interrupt-control smoke", () => {
  it(
    "interrupts one event-proven active turn without archiving or changing a second thread",
    async () => {
      const version = parseCodexCliVersionOutput(
        execFileSync(codexBin, ["--version"], { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 })
      );
      expect(version).toBe(codexBindingDescriptor.codex_version);

      const root = await mkdtemp(join(tmpdir(), "hostdeck-interrupt-smoke-"));
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
        [
          "--enable",
          "use_legacy_landlock",
          "-c",
          'sandbox_mode="read-only"',
          "-c",
          'approval_policy="never"',
          "app-server",
          "--listen",
          `unix://${socketPath}`
        ],
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
      const protocolIssues: CodexProtocolIssue[] = [];
      const serverRequests: CodexConnectionServerRequest[] = [];
      const connection = createCodexAppServerConnection({
        transport: createCodexUnixWebSocketTransport({ socket_path: socketPath }),
        observed_version: version,
        on_notification: (message) => notifications.push(message),
        on_server_request: (message) => serverRequests.push(message),
        on_protocol_issue: (issue) => protocolIssues.push(issue)
      });
      let smokeError: Error | null = null;
      const threadIds: CodexThreadId[] = [];
      try {
        await waitForSocket(socketPath, child, () => appServerStderr);
        await connection.connect();
        const threads = createCodexThreadClient(connection);
        const threadA = await createManagedThread(threads, projectA, "a");
        const threadB = await createManagedThread(threads, projectB, "b");
        threadIds.push(threadA, threadB);
        const targetA = turnTarget("sess_interrupt_smoke_a", threadA, "turn-pending");
        const states = new Map<string, SelectedSessionState>([
          [targetA.session_id, selectedState(targetA.session_id, threadA, projectA, "idle")],
          ["sess_interrupt_smoke_b", selectedState("sess_interrupt_smoke_b", threadB, projectB, "idle")]
        ]);
        const turnMethods: string[] = [];
        const turnPort = {
          get compatibility() {
            return connection.compatibility;
          },
          request(input: CodexRequestInput) {
            turnMethods.push(input.method);
            return connection.request(input);
          }
        };
        const turns = createCodexTurnClient(turnPort);
        const service = withTestOperationDeadlines(createCodexInterruptControlService({
          turns,
          states: {
            get: (sessionId) => states.get(sessionId) ?? null,
            getByThreadId: (candidate) => [...states.values()].find((state) => state.mapping.codex_thread_id === candidate) ?? null
          }
        }), ["interrupt", "waitForTerminal"]);
        const normalizer = createCodexEventNormalizer({ is_managed_thread: (candidate) => [threadA, threadB].includes(candidate) });
        const cursor = { value: notifications.length };
        const selection = selectBoundedSmokeModel((await createCodexModelClient(connection).listCatalog()).models);

        const acceptedTurnId = await startInterruptTurn(connection, threadA, selection);
        const exactTarget = turnTarget(targetA.session_id, threadA, acceptedTurnId);
        states.set(targetA.session_id, selectedState(targetA.session_id, threadA, projectA, "in_progress"));
        await expect(
          service.interrupt(interruptIntent(exactTarget, "op_interrupt_smoke_pre_event_0001"))
        ).rejects.toMatchObject({ code: "operation_conflict", outcome: "not_sent" });
        expect(turnMethods.filter((method) => method === "turn/interrupt")).toHaveLength(0);

        const started = await waitForTurnStarted(notifications, threadA, acceptedTurnId, cursor.value, 60_000);
        await processNotificationsThrough(notifications, cursor, started.index, normalizer, service);

        expect(await service.interrupt(interruptIntent(exactTarget, "op_interrupt_smoke_response_0001"))).toMatchObject({
          state: "accepted",
          target: exactTarget,
          turn_id: acceptedTurnId,
          error: null
        });
        expect(turnMethods.filter((method) => method === "turn/interrupt")).toHaveLength(1);
        const terminalWait = service.waitForTerminal(exactTarget, new AbortController().signal);

        const completed = await waitForTurnCompleted(notifications, threadA, acceptedTurnId, cursor.value, 60_000);
        expect(turnTerminalShape(completed.notification)).toEqual({ status: "interrupted", error: null });
        states.set(targetA.session_id, selectedState(targetA.session_id, threadA, projectA, "interrupted"));
        await processNotificationsThrough(notifications, cursor, completed.index, normalizer, service);
        await expect(terminalWait).resolves.toMatchObject({ state: "interrupted", error: null });
        expect(await service.snapshot(exactTarget)).toMatchObject({ state: "interrupted", error: null });

        const [threadAAfter, threadBAfter] = await Promise.all([threads.read(threadA), threads.read(threadB)]);
        expect(threadAAfter).toMatchObject({ id: threadA, status: "idle" });
        expect(threadAAfter.archived).not.toBe(true);
        expect(threadBAfter).toMatchObject({ id: threadB, status: "idle" });
        expect(threadBAfter.archived).not.toBe(true);
        expect(countTurnNotifications(notifications, threadB)).toBe(0);
        await expect(
          service.interrupt(interruptIntent(exactTarget, "op_interrupt_smoke_terminal_retry_0001"))
        ).rejects.toBeInstanceOf(HostDeckCodexInterruptControlError);
        expect(turnMethods.filter((method) => method === "turn/interrupt")).toHaveLength(1);
        expect(serverRequests).toHaveLength(0);
        expect(protocolIssues).toHaveLength(0);

        await threads.archive(threadA);
        threadIds.shift();
        await threads.archive(threadB);
        threadIds.shift();
      } catch (error) {
        smokeError = new Error(
          `Real Codex interrupt control failed (threads=${threadIds.length}, issues=${protocolIssues.map((issue) => `${issue.code}:${issue.method ?? "none"}`).join(",") || "none"}, server_requests=${serverRequests.map((request) => request.method).join(",") || "none"}, notifications=${notificationShapeSummary(notifications)}, app_server_exit=${child.exitCode ?? "running"}, stderr=${appServerStderr || "empty"}).`,
          { cause: error }
        );
      }

      const cleanupErrors: unknown[] = [];
      if (connection.state === "ready" && threadIds.length > 0) {
        const threads = createCodexThreadClient(connection);
        for (const threadId of [...threadIds]) {
          await collectCleanupError(threads.archive(threadId), cleanupErrors);
        }
      }
      await collectCleanupError(connection.close("HostDeck interrupt-control smoke completed."), cleanupErrors);
      await collectCleanupError(stopChild(child), cleanupErrors);
      await collectCleanupError(rm(root, { recursive: true, force: true }), cleanupErrors);
      if (smokeError !== null && cleanupErrors.length > 0) {
        throw new AggregateError([smokeError, ...cleanupErrors], "Codex interrupt-control smoke and cleanup failed.");
      }
      if (smokeError !== null) throw smokeError;
      if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "Codex interrupt-control cleanup failed.");
    },
    180_000
  );
});

interface SmokeModelSelection {
  readonly runtime_model: string;
  readonly reasoning_effort: string;
}

interface SmokeTurnTarget {
  readonly type: "turn";
  readonly session_id: string;
  readonly codex_thread_id: string;
  readonly turn_id: string;
}

function selectBoundedSmokeModel(models: readonly ModelCatalogEntry[]): SmokeModelSelection {
  const model =
    models.find((candidate) => /mini/iu.test(`${candidate.id} ${candidate.runtime_model} ${candidate.label}`)) ??
    models.find((candidate) => /spark/iu.test(`${candidate.id} ${candidate.runtime_model} ${candidate.label}`));
  if (model === undefined) throw new Error("Exact Codex catalog exposes no visible mini or spark model for the bounded interrupt smoke.");
  const effort =
    model.reasoning_efforts.find((candidate) => candidate.id === "minimal") ??
    model.reasoning_efforts.find((candidate) => candidate.id === "low") ??
    model.reasoning_efforts.find((candidate) => candidate.is_default);
  if (effort === undefined) throw new Error("Selected interrupt-smoke model has no supported reasoning effort.");
  return { runtime_model: model.runtime_model, reasoning_effort: effort.id };
}

async function startInterruptTurn(
  connection: CodexAppServerConnection,
  threadId: CodexThreadId,
  selection: SmokeModelSelection
): Promise<string> {
  const result = requireRecord(
    await connection.request({
      method: "turn/start",
      params: {
        threadId,
        clientUserMessageId: "op_interrupt_smoke_turn_0001",
        input: [
          {
            type: "text",
            text: "Without using any tools, write 300 numbered one-sentence observations about deterministic software testing. Do not stop early.",
            text_elements: []
          }
        ],
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        model: selection.runtime_model,
        effort: selection.reasoning_effort
      },
      kind: "mutation",
      timeout_ms: 30_000
    }),
    "interrupt turn/start result"
  );
  const turn = requireRecord(result.turn, "interrupt turn/start turn");
  if (typeof turn.id !== "string" || turn.id.length === 0 || turn.status !== "inProgress") {
    throw new Error("Interrupt turn/start did not return one accepted in-progress turn.");
  }
  return turn.id;
}

async function createManagedThread(
  threads: CodexThreadClient,
  projectDirectory: string,
  suffix: "a" | "b"
): Promise<CodexThreadId> {
  const operationId = `op_interrupt_smoke_thread_${suffix}_0001`;
  const started = await threads.start({ operation_id: operationId, cwd: projectDirectory });
  await threads.ensureMaterialized({
    thread_id: started.thread.id,
    operation_id: operationId,
    cwd: projectDirectory,
    name: `hostdeck-interrupt-smoke-${suffix}`
  });
  return started.thread.id;
}

function turnTarget(sessionId: string, threadId: string, turnId: string): SmokeTurnTarget {
  return { type: "turn", session_id: sessionId, codex_thread_id: threadId, turn_id: turnId };
}

function interruptIntent(target: SmokeTurnTarget, operationId: string) {
  return { operation_id: operationId, target, kind: "interrupt", confirm: true } as const;
}

function selectedState(
  sessionId: string,
  threadId: string,
  cwd: string,
  turnState: "idle" | "in_progress" | "interrupted" | "waiting_for_approval"
): SelectedSessionState {
  const mapping = selectedSessionMappingRecordSchema.parse({
    id: sessionId,
    name: sessionId,
    codex_thread_id: threadId,
    cwd,
    runtime_source: "codex_app_server",
    runtime_version: codexBindingDescriptor.codex_version,
    disposition: "selected",
    created_at: "2026-07-10T00:00:00.000Z",
    updated_at: "2026-07-10T00:00:00.000Z",
    archived_at: null
  });
  return {
    mapping,
    projection: selectedSessionProjectionRecordSchema.parse({
      session: {
        id: mapping.id,
        name: mapping.name,
        codex_thread_id: mapping.codex_thread_id,
        cwd: mapping.cwd,
        runtime_source: mapping.runtime_source,
        runtime_version: mapping.runtime_version,
        created_at: mapping.created_at,
        archived_at: null,
        session_state: "active",
        turn_state: turnState,
        attention: turnState === "waiting_for_approval" ? "needs_approval" : "none",
        freshness: "current",
        freshness_reason: null,
        updated_at: mapping.updated_at,
        last_activity_at: mapping.updated_at,
        branch: null,
        model: null,
        goal: null,
        recent_summary: "Managed interrupt smoke session.",
        last_event_cursor: null
      },
      retained_event_count: 0,
      retained_event_bytes: 0,
      earliest_retained_cursor: null,
      retention_boundary_cursor: null
    })
  };
}

async function processNotificationsThrough(
  notifications: readonly CodexConnectionNotification[],
  cursor: { value: number },
  endIndex: number,
  normalizer: CodexEventNormalizer,
  service: TestInterruptControlService
): Promise<void> {
  for (let index = cursor.value; index <= endIndex; index += 1) {
    const notification = notifications[index];
    if (notification === undefined) throw new Error(`Missing Codex notification at index ${index}.`);
    const result = normalizer.normalize(notification);
    if (result.kind === "event") await service.observeEvent(result.event);
  }
  cursor.value = endIndex + 1;
}

async function waitForTurnStarted(
  notifications: readonly CodexConnectionNotification[],
  threadId: string,
  turnId: string,
  startIndex: number,
  timeoutMs: number
): Promise<{ readonly index: number; readonly notification: CodexConnectionNotification }> {
  return waitForNotification(
    notifications,
    startIndex,
    timeoutMs,
    (notification) =>
      notification.method === "turn/started" &&
      isRecord(notification.params) &&
      notification.params.threadId === threadId &&
      isRecord(notification.params.turn) &&
      notification.params.turn.id === turnId,
    `turn/started for ${turnId}`
  );
}

async function waitForTurnCompleted(
  notifications: readonly CodexConnectionNotification[],
  threadId: string,
  turnId: string,
  startIndex: number,
  timeoutMs: number
): Promise<{ readonly index: number; readonly notification: CodexConnectionNotification }> {
  return waitForNotification(
    notifications,
    startIndex,
    timeoutMs,
    (notification) =>
      notification.method === "turn/completed" &&
      isRecord(notification.params) &&
      notification.params.threadId === threadId &&
      isRecord(notification.params.turn) &&
      notification.params.turn.id === turnId,
    `turn/completed for ${turnId}`
  );
}

async function waitForNotification(
  notifications: readonly CodexConnectionNotification[],
  startIndex: number,
  timeoutMs: number,
  predicate: (notification: CodexConnectionNotification) => boolean,
  label: string
): Promise<{ readonly index: number; readonly notification: CodexConnectionNotification }> {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    for (let index = startIndex; index < notifications.length; index += 1) {
      const notification = notifications[index];
      if (notification !== undefined && predicate(notification)) return { index, notification };
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function turnTerminalShape(notification: CodexConnectionNotification): { readonly status: unknown; readonly error: unknown } {
  const params = requireRecord(notification.params, "turn/completed params");
  const turn = requireRecord(params.turn, "turn/completed turn");
  return { status: turn.status, error: turn.error };
}

function countTurnNotifications(notifications: readonly CodexConnectionNotification[], threadId: string): number {
  return notifications.filter(
    (notification) =>
      ["turn/started", "turn/completed"].includes(notification.method) &&
      isRecord(notification.params) &&
      notification.params.threadId === threadId
  ).length;
}

function notificationShapeSummary(notifications: readonly CodexConnectionNotification[]): string {
  return (
    notifications
      .slice(-24)
      .map((notification) => {
        if (!isRecord(notification.params)) return notification.method;
        if (notification.method === "turn/completed" && isRecord(notification.params.turn)) {
          return `${notification.method}:${String(notification.params.turn.status)}`;
        }
        if (["item/started", "item/completed"].includes(notification.method) && isRecord(notification.params.item)) {
          return `${notification.method}:${String(notification.params.item.type)}:${String(notification.params.item.status ?? "none")}`;
        }
        return notification.method;
      })
      .join("|") || "none"
  );
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
    throw new Error("Installed Codex authentication must be a private regular auth.json file for the interrupt smoke.");
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
