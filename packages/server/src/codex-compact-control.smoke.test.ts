import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, copyFile, lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CodexConnectionNotification,
  type CodexConnectionServerRequest,
  type CodexEventNormalizer,
  type CodexProtocolIssue,
  type CodexRequestInput,
  type CodexThreadClient,
  codexBindingDescriptor,
  createCodexAppServerConnection,
  createCodexCompactClient,
  createCodexEventNormalizer,
  createCodexThreadClient,
  createCodexTurnClient,
  createCodexUnixWebSocketTransport,
  createCodexUsageClient,
  parseCodexCliVersionOutput
} from "@hostdeck/codex-adapter";
import {
  selectedSessionMappingRecordSchema,
  selectedSessionProjectionRecordSchema
} from "@hostdeck/contracts";
import type { CodexThreadId } from "@hostdeck/core";
import type { SelectedSessionState } from "@hostdeck/storage";
import { describe, expect, it } from "vitest";
import {
  type CodexCompactControlService,
  createCodexCompactControlService
} from "./codex-compact-control-service.js";
import {
  type CodexInterruptControlService,
  createCodexInterruptControlService,
  HostDeckCodexInterruptControlError
} from "./codex-interrupt-control-service.js";
import {
  type CodexUsageControlService,
  createCodexUsageControlService
} from "./codex-usage-control-service.js";

const requireSmoke = process.env.HOSTDECK_REQUIRE_CODEX_COMPACT_SMOKE === "1";
const codexBin = process.env.HOSTDECK_CODEX_BIN ?? "codex";

describe.skipIf(!requireSmoke)("exact Codex compact-control smoke", () => {
  it(
    "keeps empty acceptance distinct from context-item and terminal proof",
    async () => {
      const version = parseCodexCliVersionOutput(
        execFileSync(codexBin, ["--version"], { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 })
      );
      expect(version).toBe(codexBindingDescriptor.codex_version);

      const root = await mkdtemp(join(tmpdir(), "hostdeck-compact-smoke-"));
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
      const threadIds: CodexThreadId[] = [];
      let smokeError: Error | null = null;
      try {
        await waitForSocket(socketPath, child, () => appServerStderr);
        await connection.connect();
        const threads = createCodexThreadClient(connection);
        const threadA = await createManagedThread(threads, projectA, "a");
        const threadB = await createManagedThread(threads, projectB, "b");
        threadIds.push(threadA, threadB);

        const sessionA = "sess_compact_smoke_a";
        const sessionB = "sess_compact_smoke_b";
        const targetA = managedTarget(sessionA, threadA);
        const states = new Map<string, SelectedSessionState>([
          [sessionA, selectedState(sessionA, threadA, projectA, version, "idle")],
          [sessionB, selectedState(sessionB, threadB, projectB, version, "idle")]
        ]);
        const statePort = {
          get: (sessionId: string) => states.get(sessionId) ?? null,
          getByThreadId: (threadId: string) =>
            [...states.values()].find((state) => state.mapping.codex_thread_id === threadId) ?? null
        };
        const compactMethods: string[] = [];
        const compactClient = createCodexCompactClient({
          get compatibility() {
            return connection.compatibility;
          },
          get generation() {
            return connection.generation;
          },
          request(input) {
            compactMethods.push(input.method);
            return connection.request(input);
          }
        });
        const compactService = createCodexCompactControlService({ compact: compactClient, states: statePort });
        const usageService = createCodexUsageControlService({
          usage: createCodexUsageClient(connection),
          states: statePort
        });

        const turnMethods: string[] = [];
        const turns = createCodexTurnClient({
          get compatibility() {
            return connection.compatibility;
          },
          request(input: CodexRequestInput) {
            turnMethods.push(input.method);
            return connection.request(input);
          }
        });
        const interruptService = createCodexInterruptControlService({ turns, states: statePort });
        const normalizer = createCodexEventNormalizer({
          is_managed_thread: (candidate) => candidate === threadA || candidate === threadB
        });
        const cursor = { value: notifications.length };

        const accepted = await compactService.compact({
          operation_id: "op_compact_smoke_0001",
          target: targetA,
          kind: "compact",
          confirm: true
        });
        expect(accepted).toMatchObject({ state: "accepted", target: targetA, turn_id: null, error: null });
        expect(compactMethods.filter((method) => method === "thread/compact/start")).toHaveLength(1);

        const itemStarted = await waitForNotification(
          notifications,
          cursor.value,
          60_000,
          (notification) => notificationIsContextItem(notification, threadA, "item/started"),
          "context-compaction item start"
        );
        await processNotificationsThrough(
          notifications,
          cursor,
          itemStarted.index,
          normalizer,
          compactService,
          interruptService,
          usageService,
          connection.generation
        );
        const compactTurnId = notificationTurnId(itemStarted.notification);
        expect(await compactService.snapshot(targetA)).toMatchObject({ state: "running", turn_id: compactTurnId });
        states.set(sessionA, selectedState(sessionA, threadA, projectA, version, "in_progress"));

        let itemCompleted = false;
        let terminal: NotificationMatch | null = await waitForOptionalNotification(
          notifications,
          cursor.value,
          10_000,
          (notification) =>
            notificationIsContextItem(notification, threadA, "item/completed", compactTurnId) ||
            notificationIsTurnCompleted(notification, threadA, compactTurnId)
        );
        if (terminal !== null && notificationIsContextItem(terminal.notification, threadA, "item/completed", compactTurnId)) {
          itemCompleted = true;
          await processNotificationsThrough(
            notifications,
            cursor,
            terminal.index,
            normalizer,
            compactService,
            interruptService,
            usageService,
            connection.generation
          );
          terminal = await waitForOptionalNotification(
            notifications,
            cursor.value,
            10_000,
            (notification) => notificationIsTurnCompleted(notification, threadA, compactTurnId)
          );
        }

        let interruptAttempted = false;
        if (terminal === null) {
          interruptAttempted = true;
          const exactTurnTarget = turnTarget(sessionA, threadA, compactTurnId);
          try {
            await interruptService.interrupt({
              operation_id: "op_compact_smoke_interrupt_0001",
              target: exactTurnTarget,
              kind: "interrupt",
              confirm: true
            });
          } catch (error) {
            if (!(error instanceof HostDeckCodexInterruptControlError) || error.outcome !== "remote_rejected") throw error;
          }
          terminal = await waitForNotification(
            notifications,
            cursor.value,
            30_000,
            (notification) => notificationIsTurnCompleted(notification, threadA, compactTurnId),
            "compact turn terminal after bounded observation"
          );
        }

        await processNotificationsThrough(
          notifications,
          cursor,
          terminal.index,
          normalizer,
          compactService,
          interruptService,
          usageService,
          connection.generation
        );
        const terminalStatus = notificationTurnStatus(terminal.notification);
        states.set(
          sessionA,
          selectedState(
            sessionA,
            threadA,
            projectA,
            version,
            terminalStatus === "completed" ? "completed" : terminalStatus === "failed" ? "failed" : "interrupted"
          )
        );
        const finalProgress = await compactService.snapshot(targetA);
        if (terminalStatus === "completed") {
          expect(itemCompleted).toBe(true);
          expect(finalProgress).toMatchObject({ state: "completed", turn_id: compactTurnId, error: null });
        } else if (terminalStatus === "failed") {
          expect(finalProgress).toMatchObject({ state: "failed", turn_id: compactTurnId });
        } else {
          expect(finalProgress).toMatchObject({ state: "interrupted", turn_id: compactTurnId, error: null });
        }
        const usageSnapshot = await usageService.read({
          operation_id: "op_compact_smoke_usage_0001",
          target: targetA,
          kind: "usage"
        });
        expect(usageSnapshot.thread).toMatchObject({ state: "observed", turn_id: compactTurnId });
        if (usageSnapshot.thread.state !== "observed") throw new Error("Compact smoke lost its thread usage observation.");
        if (interruptAttempted) {
          expect(turnMethods.filter((method) => method === "turn/interrupt")).toHaveLength(1);
        }

        expect(countContextItemNotifications(notifications, threadA, "item/started")).toBe(1);
        expect(countTurnNotifications(notifications, threadB)).toBe(0);
        expect(await compactService.snapshot(managedTarget(sessionB, threadB))).toBeNull();
        expect(serverRequests).toHaveLength(0);
        expect(protocolIssues).toHaveLength(0);

        const [threadAAfter, threadBAfter] = await Promise.all([threads.read(threadA), threads.read(threadB)]);
        expect(threadAAfter).toMatchObject({ id: threadA, status: "idle" });
        expect(threadAAfter.archived).not.toBe(true);
        expect(threadBAfter).toMatchObject({ id: threadB, status: "idle" });
        expect(threadBAfter.archived).not.toBe(true);

        await threads.archive(threadA);
        threadIds.shift();
        await threads.archive(threadB);
        threadIds.shift();
      } catch (error) {
        smokeError = new Error(
          `Real Codex compact control failed (threads=${threadIds.length}, methods=${notificationShapeSummary(notifications)}, issues=${protocolIssues.map((issue) => issue.code).join(",") || "none"}, requests=${serverRequests.length}, stderr_bytes=${Buffer.byteLength(appServerStderr, "utf8")}).`,
          { cause: error }
        );
      }

      const cleanupErrors: unknown[] = [];
      if (connection.state === "ready" && threadIds.length > 0) {
        const threads = createCodexThreadClient(connection);
        for (const threadId of [...threadIds]) await collectCleanupError(threads.archive(threadId), cleanupErrors);
      }
      await collectCleanupError(connection.close("HostDeck compact-control smoke completed."), cleanupErrors);
      await collectCleanupError(stopChild(child), cleanupErrors);
      await collectCleanupError(rm(root, { recursive: true, force: true }), cleanupErrors);
      if (smokeError !== null && cleanupErrors.length > 0) {
        throw new AggregateError([smokeError, ...cleanupErrors], "Codex compact-control smoke and cleanup failed.");
      }
      if (smokeError !== null) throw smokeError;
      if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "Codex compact-control cleanup failed.");
    },
    180_000
  );
});

interface ManagedTarget {
  readonly type: "managed_session";
  readonly session_id: string;
  readonly codex_thread_id: string;
}

interface TurnTarget {
  readonly type: "turn";
  readonly session_id: string;
  readonly codex_thread_id: string;
  readonly turn_id: string;
}

interface NotificationMatch {
  readonly index: number;
  readonly notification: CodexConnectionNotification;
}

async function createManagedThread(
  threads: CodexThreadClient,
  projectDirectory: string,
  suffix: "a" | "b"
): Promise<CodexThreadId> {
  const operationId = `op_compact_smoke_thread_${suffix}_0001`;
  const started = await threads.start({ operation_id: operationId, cwd: projectDirectory });
  await threads.ensureMaterialized({
    thread_id: started.thread.id,
    operation_id: operationId,
    cwd: projectDirectory,
    name: `hostdeck-compact-smoke-${suffix}`
  });
  return started.thread.id;
}

function managedTarget(sessionId: string, threadId: string): ManagedTarget {
  return { type: "managed_session", session_id: sessionId, codex_thread_id: threadId };
}

function turnTarget(sessionId: string, threadId: string, turnId: string): TurnTarget {
  return { type: "turn", session_id: sessionId, codex_thread_id: threadId, turn_id: turnId };
}

function selectedState(
  sessionId: string,
  threadId: string,
  cwd: string,
  runtimeVersion: string,
  turnState: "idle" | "in_progress" | "completed" | "failed" | "interrupted"
): SelectedSessionState {
  const now = new Date().toISOString();
  return {
    mapping: selectedSessionMappingRecordSchema.parse({
      id: sessionId,
      name: sessionId,
      codex_thread_id: threadId,
      cwd,
      runtime_source: "codex_app_server",
      runtime_version: runtimeVersion,
      disposition: "selected",
      created_at: now,
      updated_at: now,
      archived_at: null
    }),
    projection: selectedSessionProjectionRecordSchema.parse({
      session: {
        id: sessionId,
        name: sessionId,
        codex_thread_id: threadId,
        cwd,
        runtime_source: "codex_app_server",
        runtime_version: runtimeVersion,
        created_at: now,
        archived_at: null,
        session_state: "active",
        turn_state: turnState,
        attention: turnState === "failed" ? "failed" : turnState === "in_progress" ? "watch" : "none",
        freshness: "current",
        freshness_reason: null,
        updated_at: now,
        last_activity_at: null,
        branch: null,
        model: null,
        goal: null,
        recent_summary: "",
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
  compactService: CodexCompactControlService,
  interruptService: CodexInterruptControlService,
  usageService: CodexUsageControlService,
  generation: number
): Promise<void> {
  for (let index = cursor.value; index <= endIndex; index += 1) {
    const notification = notifications[index];
    if (notification === undefined) throw new Error(`Missing Codex notification at index ${index}.`);
    const result = normalizer.normalize(notification);
    if (result.kind !== "event") continue;
    await compactService.observe(result.event, generation);
    await interruptService.observeEvent(result.event);
    usageService.observe(result.event, generation);
  }
  cursor.value = endIndex + 1;
}

async function waitForNotification(
  notifications: readonly CodexConnectionNotification[],
  startIndex: number,
  timeoutMs: number,
  predicate: (notification: CodexConnectionNotification) => boolean,
  label: string
): Promise<NotificationMatch> {
  const match = await waitForOptionalNotification(notifications, startIndex, timeoutMs, predicate);
  if (match === null) throw new Error(`Timed out waiting for ${label}.`);
  return match;
}

async function waitForOptionalNotification(
  notifications: readonly CodexConnectionNotification[],
  startIndex: number,
  timeoutMs: number,
  predicate: (notification: CodexConnectionNotification) => boolean
): Promise<NotificationMatch | null> {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    for (let index = startIndex; index < notifications.length; index += 1) {
      const notification = notifications[index];
      if (notification !== undefined && predicate(notification)) return { index, notification };
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return null;
}

function notificationIsContextItem(
  notification: CodexConnectionNotification,
  threadId: string,
  method: "item/started" | "item/completed",
  turnId?: string
): boolean {
  return (
    notification.method === method &&
    isRecord(notification.params) &&
    notification.params.threadId === threadId &&
    (turnId === undefined || notification.params.turnId === turnId) &&
    isRecord(notification.params.item) &&
    notification.params.item.type === "contextCompaction"
  );
}

function notificationIsTurnCompleted(
  notification: CodexConnectionNotification,
  threadId: string,
  turnId: string
): boolean {
  return (
    notification.method === "turn/completed" &&
    isRecord(notification.params) &&
    notification.params.threadId === threadId &&
    isRecord(notification.params.turn) &&
    notification.params.turn.id === turnId
  );
}

function notificationTurnId(notification: CodexConnectionNotification): string {
  const params = requireRecord(notification.params, "context item params");
  if (typeof params.turnId !== "string" || params.turnId.length === 0) {
    throw new Error("Context item notification has no bounded turn id.");
  }
  return params.turnId;
}

function notificationTurnStatus(notification: CodexConnectionNotification): "completed" | "failed" | "interrupted" {
  const params = requireRecord(notification.params, "turn/completed params");
  const turn = requireRecord(params.turn, "turn/completed turn");
  if (!new Set(["completed", "failed", "interrupted"]).has(turn.status as string)) {
    throw new Error("Compact turn has an unsupported terminal status.");
  }
  return turn.status as "completed" | "failed" | "interrupted";
}

function countContextItemNotifications(
  notifications: readonly CodexConnectionNotification[],
  threadId: string,
  method: "item/started" | "item/completed"
): number {
  return notifications.filter((notification) => notificationIsContextItem(notification, threadId, method)).length;
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
        if (notification.method === "turn/completed" && isRecord(notification.params) && isRecord(notification.params.turn)) {
          return `${notification.method}:${String(notification.params.turn.status)}`;
        }
        if (["item/started", "item/completed"].includes(notification.method) && isRecord(notification.params) && isRecord(notification.params.item)) {
          return `${notification.method}:${String(notification.params.item.type)}`;
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
      throw new Error(`Codex app-server exited before creating its compact-smoke socket: ${readStderr()}`);
    }
    try {
      if ((await lstat(socketPath)).isSocket()) return;
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Codex app-server did not create its compact-smoke socket: ${readStderr()}`);
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit").then(() => undefined);
  child.kill("SIGTERM");
  if (await settlesWithin(exited, 2_000)) return;
  child.kill("SIGKILL");
  if (!(await settlesWithin(exited, 1_000))) throw new Error("Codex compact-smoke app-server did not exit after SIGKILL.");
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
    throw new Error("Installed Codex authentication must be a private regular auth.json file for the compact smoke.");
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
