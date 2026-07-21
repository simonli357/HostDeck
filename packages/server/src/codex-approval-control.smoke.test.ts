import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, copyFile, lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CodexAppServerConnection,
  type CodexConnectionNotification,
  type CodexEventNormalizer,
  type CodexProtocolIssue,
  codexBindingDescriptor,
  createCodexApprovalClient,
  createCodexAppServerConnection,
  createCodexEventNormalizer,
  createCodexModelClient,
  createCodexThreadClient,
  createCodexUnixWebSocketTransport,
  parseCodexCliVersionOutput
} from "@hostdeck/codex-adapter";
import {
  type ManagedSessionTarget,
  type ModelCatalogEntry,
  type PendingApproval,
  type SelectedSessionProjectionRecord,
  selectedSessionMappingRecordSchema,
  selectedSessionProjectionRecordSchema
} from "@hostdeck/contracts";
import type { CodexThreadId } from "@hostdeck/core";
import type { SelectedSessionState } from "@hostdeck/storage";
import { describe, expect, it } from "vitest";
import {
  type CodexApprovalControlService,
  createCodexApprovalControlService,
  HostDeckCodexApprovalControlError
} from "./codex-approval-control-service.js";
import {
  type WithTestOperationDeadlines,
  withTestOperationDeadlines
} from "./test-operation-deadline.js";

type TestApprovalControlService = WithTestOperationDeadlines<
  CodexApprovalControlService,
  "respond" | "waitForTerminal"
>;

const requireSmoke = process.env.HOSTDECK_REQUIRE_CODEX_APPROVAL_SMOKE === "1";
const codexBin = process.env.HOSTDECK_CODEX_BIN ?? "codex";

describe.skipIf(!requireSmoke)("installed Codex approval-control smoke", () => {
  it(
    "declines and accepts exact requests with authoritative side-effect and terminal evidence",
    async () => {
      const version = parseCodexCliVersionOutput(
        execFileSync(codexBin, ["--version"], { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 })
      );
      expect(version).toBe(codexBindingDescriptor.codex_version);

      const root = await mkdtemp(join(tmpdir(), "hostdeck-approval-smoke-"));
      const runtimeDirectory = join(root, "runtime");
      const codexHome = join(root, "codex-home");
      const project = join(root, "project");
      const deniedMarker = join(root, "denied-marker");
      const approvedMarker = join(root, "approved-marker");
      const expiredMarker = join(root, "expired-marker");
      const socketPath = join(runtimeDirectory, "app.sock");
      await Promise.all([
        mkdir(runtimeDirectory, { mode: 0o700 }),
        mkdir(codexHome, { mode: 0o700 }),
        mkdir(project, { mode: 0o700 })
      ]);
      try {
        await seedCodexAuthentication(codexHome);
        execFileSync("git", ["init", "-q", "-b", "main", project], { timeout: 10_000 });
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
          'approval_policy="on-request"',
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
      const registrations: PendingApproval[] = [];
      const requestMethods: string[] = [];
      const requestTargets: Array<{ readonly thread_id: string; readonly turn_id: string; readonly item_id: string }> = [];
      const protocolIssues: CodexProtocolIssue[] = [];
      const registrationErrors: string[] = [];
      let service: TestApprovalControlService | null = null;
      const connection = createCodexAppServerConnection({
        transport: createCodexUnixWebSocketTransport({ socket_path: socketPath }),
        observed_version: version,
        on_notification: (message) => notifications.push(message),
        on_server_request: (message) => {
          if (service === null) throw new Error("Approval service is unavailable for a live server request.");
          requestMethods.push(message.method);
          const params = requireRecord(message.params, "approval server-request params");
          requestTargets.push({
            thread_id: String(params.threadId),
            turn_id: String(params.turnId),
            item_id: String(params.itemId)
          });
          try {
            registrations.push(service.register(message));
          } catch (error) {
            registrationErrors.push(errorSummary(error));
            throw error;
          }
        },
        on_protocol_issue: (issue) => protocolIssues.push(issue)
      });
      let smokeError: Error | null = null;
      let threadId: CodexThreadId | null = null;
      try {
        await waitForSocket(socketPath, child, () => appServerStderr);
        await connection.connect();
        const threads = createCodexThreadClient(connection);
        threadId = await createManagedThread(threads, project);
        const target = managedTarget("sess_approval_smoke", threadId);
        const states = new Map<string, SelectedSessionState>([[target.session_id, selectedState(target, project)]]);
        const backgroundErrors: Error[] = [];
        service = withTestOperationDeadlines(createCodexApprovalControlService({
          approvals: createCodexApprovalClient(connection),
          states: {
            get: (sessionId) => states.get(sessionId) ?? null,
            getByThreadId: (candidate) => [...states.values()].find((state) => state.mapping.codex_thread_id === candidate) ?? null
          },
          expiry_ms: 1_000,
          on_background_error: (error) => backgroundErrors.push(error)
        }), ["respond", "waitForTerminal"]);
        const normalizer = createCodexEventNormalizer({ is_managed_thread: (candidate) => candidate === threadId });
        const cursor = { value: notifications.length };
        const selection = selectBoundedSmokeModel((await createCodexModelClient(connection).listCatalog()).models);

        const deniedTurn = await startApprovalTurn(
          connection,
          threadId,
          "op_approval_smoke_deny_0001",
          `Use the shell tool to run exactly \`touch ${shellQuote(deniedMarker)}\` with elevated permission. Request approval, do not use file-editing tools, and do nothing else.`,
          selection
        );
        const denied = await waitForRegistration(
          registrations,
          0,
          registrationErrors,
          notifications,
          cursor.value,
          threadId,
          deniedTurn,
          60_000
        );
        expect(requestMethods[0]).toBe("item/commandExecution/requestApproval");
        expect(requestTargets[0]).toMatchObject({ thread_id: threadId, turn_id: deniedTurn, item_id: expect.any(String) });
        expect(denied).toMatchObject({
          state: "pending",
          target: { session_id: target.session_id, codex_thread_id: threadId },
          scope: project,
          risk: expect.stringMatching(/elevated|broad/u),
          expires_at: expect.any(String)
        });
        expect(denied.action).toContain("touch");
        expect(denied.action).toContain("denied-marker");
        expect(
          await service.respond(approvalIntent(denied, "deny", "op_approval_smoke_deny_response_0001"))
        ).toMatchObject({ state: "responding", decision: null });
        await expect(
          service.respond(approvalIntent(denied, "approve", "op_approval_smoke_duplicate_0001"))
        ).rejects.toBeInstanceOf(HostDeckCodexApprovalControlError);

        const deniedCompleted = await waitForTurnCompleted(notifications, threadId, deniedTurn, cursor.value, 90_000);
        expect(turnTerminalShape(deniedCompleted.notification)).toEqual({ status: "completed", error: null });
        await processNotificationsThrough(notifications, cursor, deniedCompleted.index, normalizer, service);
        expect(await service.snapshot(denied.target)).toMatchObject({ state: "denied", decision: "deny" });
        expect(await pathExists(deniedMarker)).toBe(false);

        const approvedTurn = await startApprovalTurn(
          connection,
          threadId,
          "op_approval_smoke_accept_0001",
          `Use the shell tool to run exactly \`touch ${shellQuote(approvedMarker)}\` with elevated permission. Request approval, do not use file-editing tools, and do nothing else.`,
          selection
        );
        const approved = await waitForRegistration(
          registrations,
          1,
          registrationErrors,
          notifications,
          cursor.value,
          threadId,
          approvedTurn,
          60_000
        );
        expect(requestMethods[1]).toBe("item/commandExecution/requestApproval");
        expect(requestTargets[1]).toMatchObject({ thread_id: threadId, turn_id: approvedTurn, item_id: expect.any(String) });
        expect(approved.action).toContain("approved-marker");
        expect(
          await service.respond(approvalIntent(approved, "approve", "op_approval_smoke_accept_response_0001"))
        ).toMatchObject({ state: "responding", decision: null });

        const approvedCompleted = await waitForTurnCompleted(notifications, threadId, approvedTurn, cursor.value, 90_000);
        expect(turnTerminalShape(approvedCompleted.notification)).toEqual({ status: "completed", error: null });
        await processNotificationsThrough(notifications, cursor, approvedCompleted.index, normalizer, service);
        expect(await service.snapshot(approved.target)).toMatchObject({ state: "approved", decision: "approve" });
        expect(await pathExists(approvedMarker)).toBe(true);

        const expiredTurn = await startApprovalTurn(
          connection,
          threadId,
          "op_approval_smoke_expiry_0001",
          `Use the shell tool to run exactly \`touch ${shellQuote(expiredMarker)}\` with elevated permission. Request approval, do not use file-editing tools, and do nothing else.`,
          selection
        );
        const expired = await waitForRegistration(
          registrations,
          2,
          registrationErrors,
          notifications,
          cursor.value,
          threadId,
          expiredTurn,
          60_000
        );
        expect(requestMethods[2]).toBe("item/commandExecution/requestApproval");
        expect(requestTargets[2]).toMatchObject({ thread_id: threadId, turn_id: expiredTurn, item_id: expect.any(String) });
        expect(expired.action).toContain("expired-marker");

        const expiredCompleted = await waitForTurnCompleted(notifications, threadId, expiredTurn, cursor.value, 90_000);
        expect(turnTerminalShape(expiredCompleted.notification)).toEqual({ status: "completed", error: null });
        await processNotificationsThrough(notifications, cursor, expiredCompleted.index, normalizer, service);
        expect(await service.snapshot(expired.target)).toMatchObject({ state: "expired", decision: null });
        await expect(
          service.respond(approvalIntent(expired, "approve", "op_approval_smoke_expired_response_0001"))
        ).rejects.toMatchObject({ code: "approval_not_pending", outcome: "not_sent" });
        expect(await pathExists(expiredMarker)).toBe(false);
        expect(backgroundErrors).toHaveLength(0);
        expect(requestMethods).toEqual([
          "item/commandExecution/requestApproval",
          "item/commandExecution/requestApproval",
          "item/commandExecution/requestApproval"
        ]);

        await threads.archive(threadId);
        threadId = null;
      } catch (error) {
        smokeError = new Error(
          `Real Codex approval control failed (thread=${threadId ?? "none"}, requests=${requestMethods.join(",") || "none"}, registration_errors=${registrationErrors.join("|") || "none"}, issues=${protocolIssues.map((issue) => `${issue.code}:${issue.method ?? "none"}`).join(",") || "none"}, notifications=${notificationShapeSummary(notifications)}, app_server_exit=${child.exitCode ?? "running"}, stderr=${appServerStderr || "empty"}).`,
          { cause: error }
        );
      }

      service?.close();
      const cleanupErrors: unknown[] = [];
      await collectCleanupError(connection.close("HostDeck approval-control smoke completed."), cleanupErrors);
      await collectCleanupError(stopChild(child), cleanupErrors);
      await collectCleanupError(rm(root, { recursive: true, force: true }), cleanupErrors);
      if (smokeError !== null && cleanupErrors.length > 0) {
        throw new AggregateError([smokeError, ...cleanupErrors], "Codex approval-control smoke and cleanup failed.");
      }
      if (smokeError !== null) throw smokeError;
      if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "Codex approval-control cleanup failed.");
    },
    240_000
  );
});

async function startApprovalTurn(
  connection: CodexAppServerConnection,
  threadId: CodexThreadId,
  operationId: string,
  text: string,
  selection: SmokeModelSelection
): Promise<string> {
  const result = requireRecord(
    await connection.request({
      method: "turn/start",
      params: {
        threadId,
        clientUserMessageId: operationId,
        input: [{ type: "text", text, text_elements: [] }],
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        model: selection.runtime_model,
        effort: selection.reasoning_effort
      },
      kind: "mutation",
      timeout_ms: 30_000
    }),
    "approval turn/start result"
  );
  const turn = requireRecord(result.turn, "approval turn/start turn");
  if (typeof turn.id !== "string" || turn.id.length === 0 || turn.status !== "inProgress") {
    throw new Error("Approval turn/start did not return one accepted in-progress turn.");
  }
  return turn.id;
}

async function processNotificationsThrough(
  notifications: readonly CodexConnectionNotification[],
  cursor: { value: number },
  endIndex: number,
  normalizer: CodexEventNormalizer,
  service: TestApprovalControlService
): Promise<void> {
  for (let index = cursor.value; index <= endIndex; index += 1) {
    const notification = notifications[index];
    if (notification === undefined) throw new Error(`Missing Codex notification at index ${index}.`);
    const result = normalizer.normalize(notification);
    if (result.kind === "event") await service.observeEvent(result.event);
  }
  cursor.value = endIndex + 1;
}

async function waitForRegistration(
  registrations: readonly PendingApproval[],
  index: number,
  registrationErrors: readonly string[],
  notifications: readonly CodexConnectionNotification[],
  notificationStartIndex: number,
  threadId: string,
  turnId: string,
  timeoutMs: number
): Promise<PendingApproval> {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    if (registrationErrors.length > 0) {
      throw new Error(`Approval registration failed: ${registrationErrors.join("|")}`);
    }
    const approval = registrations[index];
    if (approval !== undefined && approval.target.codex_thread_id === threadId) return approval;
    for (let notificationIndex = notificationStartIndex; notificationIndex < notifications.length; notificationIndex += 1) {
      const notification = notifications[notificationIndex];
      if (
        notification?.method === "turn/completed" &&
        isRecord(notification.params) &&
        notification.params.threadId === threadId &&
        isRecord(notification.params.turn) &&
        notification.params.turn.id === turnId
      ) {
        throw new Error(
          `Turn ${turnId} completed before approval registration (status=${String(notification.params.turn.status)}, error=${boundedJson(notification.params.turn.error)}).`
        );
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for approval registration for turn ${turnId}.`);
}

function boundedJson(value: unknown): string {
  try {
    return JSON.stringify(value).slice(0, 1_000);
  } catch {
    return "unserializable";
  }
}

function errorSummary(error: unknown): string {
  if (!(error instanceof Error)) return String(error).slice(0, 500);
  const issues = validationIssues(error);
  return `${error.name}:${"code" in error ? String(error.code) : "none"}:${error.message}:issues=${issues}`.slice(0, 1_000);
}

function validationIssues(error: Error): string {
  let candidate: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (candidate !== null && typeof candidate === "object" && "issues" in candidate && Array.isArray(candidate.issues)) {
      return candidate.issues
        .slice(0, 8)
        .map((issue) =>
          isRecord(issue)
            ? `${Array.isArray(issue.path) ? issue.path.join(".") : "unknown"}:${String(issue.message ?? "invalid")}`
            : "invalid"
        )
        .join(",");
    }
    candidate = candidate instanceof Error ? candidate.cause : null;
  }
  return "none";
}

function notificationShapeSummary(notifications: readonly CodexConnectionNotification[]): string {
  return notifications
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
    .join("|") || "none";
}

async function waitForTurnCompleted(
  notifications: readonly CodexConnectionNotification[],
  threadId: string,
  turnId: string,
  startIndex: number,
  timeoutMs: number
): Promise<{ readonly index: number; readonly notification: CodexConnectionNotification }> {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    for (let index = startIndex; index < notifications.length; index += 1) {
      const notification = notifications[index];
      if (
        notification?.method === "turn/completed" &&
        isRecord(notification.params) &&
        notification.params.threadId === threadId &&
        isRecord(notification.params.turn) &&
        notification.params.turn.id === turnId
      ) {
        return { index, notification };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for turn/completed for ${turnId}.`);
}

function approvalIntent(
  approval: PendingApproval,
  decision: "approve" | "deny",
  operationId: string
) {
  return {
    operation_id: operationId,
    target: approval.target,
    kind: "approval_response",
    decision,
    confirm: true
  } as const;
}

function turnTerminalShape(notification: CodexConnectionNotification): { readonly status: unknown; readonly error: unknown } {
  const params = requireRecord(notification.params, "turn/completed params");
  const turn = requireRecord(params.turn, "turn/completed turn");
  return { status: turn.status, error: turn.error };
}

interface SmokeModelSelection {
  readonly runtime_model: string;
  readonly reasoning_effort: string;
}

function selectBoundedSmokeModel(models: readonly ModelCatalogEntry[]): SmokeModelSelection {
  const model =
    models.find((candidate) => /mini/iu.test(`${candidate.id} ${candidate.runtime_model} ${candidate.label}`)) ??
    models.find((candidate) => /spark/iu.test(`${candidate.id} ${candidate.runtime_model} ${candidate.label}`));
  if (model === undefined) throw new Error("Exact Codex catalog exposes no visible mini or spark model for the bounded approval smoke.");
  const effort =
    model.reasoning_efforts.find((candidate) => candidate.id === "minimal") ??
    model.reasoning_efforts.find((candidate) => candidate.id === "low") ??
    model.reasoning_efforts.find((candidate) => candidate.is_default);
  if (effort === undefined) throw new Error("Selected approval-smoke model has no supported reasoning effort.");
  return { runtime_model: model.runtime_model, reasoning_effort: effort.id };
}

function selectedState(targetInput: ManagedSessionTarget, cwd: string): SelectedSessionState {
  const observedAt = new Date().toISOString();
  const mapping = selectedSessionMappingRecordSchema.parse({
    id: targetInput.session_id,
    name: "approval-smoke",
    codex_thread_id: targetInput.codex_thread_id,
    cwd,
    runtime_source: "codex_app_server",
    runtime_version: codexBindingDescriptor.codex_version,
    disposition: "selected",
    created_at: observedAt,
    updated_at: observedAt,
    archived_at: null
  });
  const projection: SelectedSessionProjectionRecord = selectedSessionProjectionRecordSchema.parse({
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
      turn_state: "waiting_for_approval",
      attention: "needs_approval",
      freshness: "current",
      freshness_reason: null,
      updated_at: observedAt,
      last_activity_at: observedAt,
      branch: "main",
      model: null,
      goal: null,
      recent_summary: "Managed approval smoke session.",
      last_event_cursor: null
    },
    retained_event_count: 0,
    retained_event_bytes: 0,
    earliest_retained_cursor: null,
    retention_boundary_cursor: null
  });
  return { mapping, projection };
}

function managedTarget(sessionId: string, threadId: string): ManagedSessionTarget {
  return { type: "managed_session", session_id: sessionId, codex_thread_id: threadId } as ManagedSessionTarget;
}

async function createManagedThread(
  threads: ReturnType<typeof createCodexThreadClient>,
  projectDirectory: string
): Promise<CodexThreadId> {
  const operationId = "op_approval_smoke_thread_0001";
  const started = await threads.start({ operation_id: operationId, cwd: projectDirectory });
  await threads.ensureMaterialized({
    thread_id: started.thread.id,
    operation_id: operationId,
    cwd: projectDirectory,
    name: "hostdeck-approval-smoke"
  });
  return started.thread.id;
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
    throw new Error("Installed Codex authentication must be a private regular auth.json file for the approval smoke.");
  }
  const destination = join(codexHome, "auth.json");
  await copyFile(source, destination);
  await chmod(destination, 0o600);
  const destinationMetadata = await lstat(destination);
  if (!destinationMetadata.isFile() || (destinationMetadata.mode & 0o077) !== 0) {
    throw new Error("Temporary Codex authentication copy is not private.");
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
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
