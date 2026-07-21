import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cliExitCodes, runCli } from "../packages/cli/src/index.js";
import type {
  CodexApprovalClient,
  CodexApprovalRequest,
  CodexApprovalResponseInput,
  NormalizedCodexEvent
} from "../packages/codex-adapter/src/index.js";
import {
  codexItemIdSchema,
  codexThreadIdSchema,
  codexTurnIdSchema,
  defaultResourceBudget,
  isoTimestampSchema,
  managedSessionTargetSchema,
  runtimeCompatibilitySchema,
  runtimeRequestIdSchema,
  type SelectedSessionProjectionRecord,
  selectedSessionMappingRecordSchema,
  selectedSessionProjectionRecordSchema
} from "../packages/contracts/src/index.js";
import {
  createCodexApprovalControlService,
  createHostDeckApprovalRouteRegistration,
  createHostDeckCsrfPolicy,
  createHostDeckFastifyApp,
  createHostDeckHostLockPolicy,
  createHostDeckRequestAuthenticationPolicy,
  createHostDeckRequestTrustPolicy,
  createHostDeckSelectedWriteAdmissionPolicy,
  createHostDeckSelectedWriteAuditExecutor
} from "../packages/server/src/index.js";
import {
  createSelectedAuditRepository,
  createSelectedStateRepository,
  openMigratedDatabase
} from "../packages/storage/src/index.js";

const directories: string[] = [];
const timestamp = "2026-07-16T08:00:00.000Z";
const auditTimestamp = "2026-07-16T08:00:01.000Z";
const runtimeVersion = "0.144.0";
const generation = 1;
const sessionId = "sess_approval_vertical_001";
const threadId = codexThreadIdSchema.parse("thread-approval-vertical-001");
const secondSessionId = "sess_approval_vertical_002";
const secondThreadId = codexThreadIdSchema.parse("thread-approval-vertical-002");
const emptySessionId = "sess_approval_vertical_003";
const emptyThreadId = codexThreadIdSchema.parse("thread-approval-vertical-003");
const turnId = codexTurnIdSchema.parse("turn-approval-vertical-001");
const secondTurnId = codexTurnIdSchema.parse("turn-approval-vertical-002");
const itemId = codexItemIdSchema.parse("item-approval-vertical-001");
const secondItemId = codexItemIdSchema.parse("item-approval-vertical-002");
const requestId = runtimeRequestIdSchema.parse("string:approval-vertical-001");
const secondRequestId = runtimeRequestIdSchema.parse("string:approval-vertical-002");
const operationId = "op_approval_vertical_001";
const duplicateOperationId = "op_approval_vertical_002";
const target = managedSessionTargetSchema.parse({
  type: "managed_session",
  session_id: sessionId,
  codex_thread_id: threadId
});
const runtimeCapabilities = [
  "thread_lifecycle",
  "turn_input",
  "turn_steer",
  "turn_interrupt",
  "model",
  "goal",
  "plan",
  "usage",
  "compact",
  "skills",
  "approvals",
  "multi_client"
] as const;

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("managed-session approval selected vertical", () => {
  it("finalizes one exact approval through the real CLI, selected API, gate, production service, and SQLite", async () => {
    const directory = mkdtempSync(join(tmpdir(), "hostdeck-approval-vertical-"));
    directories.push(directory);
    const open = openMigratedDatabase(join(directory, "hostdeck.sqlite"), {
      now: () => new Date(timestamp)
    });
    const states = createSelectedStateRepository(open.db);
    states.create(activeState(sessionId, threadId, "approval-vertical-one"));
    states.create(activeState(secondSessionId, secondThreadId, "approval-vertical-two"));
    states.create(activeState(emptySessionId, emptyThreadId, "approval-vertical-empty"));

    const firstRequest = approvalRequest({
      request_id: requestId,
      protocol_request_id: "approval-vertical-001",
      thread_id: threadId,
      turn_id: turnId,
      item_id: itemId,
      action: "touch /tmp/hostdeck-vertical-approved",
      scope: "/tmp/hostdeck-approval-vertical-private",
      reason: "The vertical sandbox requires an explicit approval."
    });
    const secondRequest = approvalRequest({
      request_id: secondRequestId,
      protocol_request_id: "approval-vertical-002",
      thread_id: secondThreadId,
      turn_id: secondTurnId,
      item_id: secondItemId,
      action: "printf isolated",
      scope: "/tmp/hostdeck-approval-vertical-isolated",
      reason: "This request belongs to another managed session."
    });
    const adapter = createVerticalApprovalClient([firstRequest, secondRequest]);
    const approvalService = createCodexApprovalControlService({
      approvals: adapter.client,
      states: {
        get: (candidate) => states.get(candidate),
        getByThreadId: (candidate) => states.getByThreadId(candidate)
      },
      expiry_ms: 120_000,
      now: () => timestamp,
      on_background_error(error) {
        throw error;
      }
    });
    approvalService.register(firstRequest);
    approvalService.register(secondRequest);

    const auditRepository = createSelectedAuditRepository(open.db);
    let auditRecord = 0;
    const audit = createHostDeckSelectedWriteAuditExecutor({
      repository: auditRepository,
      now: () => auditTimestamp,
      create_record_id: () => `audit_approval_vertical_${++auditRecord}`
    });
    const csrf = createHostDeckCsrfPolicy({
      csrf: {
        authorizeBrowserWrite() {
          throw new Error("Loopback approval vertical must not authorize browser CSRF.");
        },
        rotateBootstrap() {
          throw new Error("Loopback approval vertical must not rotate browser CSRF.");
        }
      },
      now: () => new Date(auditTimestamp)
    });
    const lock = createHostDeckHostLockPolicy({
      settings: {
        read: () => settings(),
        transition() {
          throw new Error("Approval vertical must not transition host lock.");
        }
      },
      now: () => new Date(auditTimestamp)
    });
    const registration = createHostDeckApprovalRouteRegistration({
      admission: createHostDeckSelectedWriteAdmissionPolicy({
        resourceBudget: defaultResourceBudget,
        now: () => performance.now()
      }),
      approvals: {
        list: approvalService.list,
        respond: approvalService.respond,
        snapshot: approvalService.snapshot,
        waitForTerminal: approvalService.waitForTerminal
      },
      audit,
      csrf,
      lock,
      runtime: { read: () => runtime() },
      state: { get: (candidate) => states.get(candidate) }
    });
    const port = await availableLoopbackPort();
    const app = createHostDeckFastifyApp({
      observeInternalError: () => undefined,
      requestAuthenticationPolicy: createHostDeckRequestAuthenticationPolicy({
        authenticateDeviceToken: () => {
          throw new Error("Loopback approval vertical must not authenticate a device.");
        },
        now: () => new Date(auditTimestamp)
      }),
      requestTrustPolicy: createHostDeckRequestTrustPolicy({
        allowedOrigin: `http://127.0.0.1:${port}`
      }),
      resourceBudget: defaultResourceBudget,
      routePlugins: [registration]
    });
    await app.listen({ host: "127.0.0.1", port, listenTextResolver: () => "" });

    try {
      const address = app.server.address();
      if (address === null || typeof address === "string") {
        throw new Error("Approval vertical listener is unavailable.");
      }
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const listArgs = ["--api-url", baseUrl, "approvals", sessionId, "--json"] as const;
      const initial = await runCli(listArgs, { env: {} });
      expect(initial).toMatchObject({ exitCode: cliExitCodes.ok, stderr: "" });
      expect(JSON.parse(initial.stdout)).toMatchObject({
        target,
        approvals: [
          {
            target: { ...target, type: "approval", request_id: requestId },
            action: firstRequest.action,
            scope: firstRequest.scope,
            reason: firstRequest.reason,
            state: "pending",
            decision: null
          }
        ]
      });
      expect(initial.stdout).not.toContain(secondRequestId);
      const empty = await runCli(["--api-url", baseUrl, "approvals", emptySessionId, "--json"], { env: {} });
      expect(empty).toMatchObject({ exitCode: cliExitCodes.ok, stderr: "" });
      expect(JSON.parse(empty.stdout)).toEqual({
        target: { type: "managed_session", session_id: emptySessionId, codex_thread_id: emptyThreadId },
        approvals: []
      });

      const respondArgs = [
        "--api-url",
        baseUrl,
        "approvals",
        sessionId,
        requestId,
        "approve",
        "--confirm",
        "--json"
      ] as const;
      let responseSettled = false;
      const responsePromise = runCli(respondArgs, {
        env: {},
        createApprovalOperationId: () => operationId
      }).finally(() => {
        responseSettled = true;
      });
      await adapter.responseStarted;
      expect(adapter.responses).toHaveLength(1);
      expect(adapter.responses[0]).toMatchObject({
        request: firstRequest,
        decision: "approve",
        deadline: { signal: expect.any(AbortSignal) }
      });

      const inFlight = await runCli(listArgs, { env: {} });
      expect(inFlight).toMatchObject({ exitCode: cliExitCodes.ok, stderr: "" });
      expect(JSON.parse(inFlight.stdout).approvals).toMatchObject([
        { target: { request_id: requestId }, state: "responding", decision: null }
      ]);
      expect(responseSettled).toBe(false);

      await approvalService.observeEvent(resolvedEvent(firstRequest));
      await Promise.resolve();
      expect(responseSettled).toBe(false);
      expect((await approvalService.snapshot(firstRequestTarget(firstRequest)))?.state).toBe("responding");

      await approvalService.observeEvent(itemCompletedEvent(firstRequest));
      const response = await responsePromise;
      expect(response).toMatchObject({ exitCode: cliExitCodes.ok, stderr: "" });
      expect(JSON.parse(response.stdout)).toEqual({
        operation_id: operationId,
        requested_decision: "approve",
        approval: {
          target: { ...target, type: "approval", request_id: requestId },
          action: firstRequest.action,
          scope: firstRequest.scope,
          reason: firstRequest.reason,
          risk: "elevated",
          grant_scope: "one_time",
          state: "approved",
          created_at: timestamp,
          expires_at: "2026-07-16T08:02:00.000Z",
          decision: "approve"
        }
      });

      const final = await runCli(listArgs, { env: {} });
      expect(JSON.parse(final.stdout).approvals).toMatchObject([
        { target: { request_id: requestId }, state: "approved", decision: "approve" }
      ]);
      const isolated = await runCli(
        ["--api-url", baseUrl, "approvals", secondSessionId, "--json"],
        { env: {} }
      );
      expect(JSON.parse(isolated.stdout).approvals).toMatchObject([
        { target: { request_id: secondRequestId }, state: "pending", decision: null }
      ]);

      const replay = await runCli(respondArgs, {
        env: {},
        createApprovalOperationId: () => operationId
      });
      expect(replay).toMatchObject({ exitCode: cliExitCodes.ok, stderr: "" });
      expect(replay.stdout).toBe(response.stdout);
      expect(adapter.responses).toHaveLength(1);

      const duplicate = await runCli(respondArgs, {
        env: {},
        createApprovalOperationId: () => duplicateOperationId
      });
      expect(duplicate).toMatchObject({ exitCode: cliExitCodes.apiError, stdout: "" });
      expect(duplicate.stderr).toContain("approval_not_pending");
      expect(adapter.responses).toHaveLength(1);

      expect(auditRepository.require(operationId)).toMatchObject({
        state: "terminal",
        records: [
          {
            id: "audit_approval_vertical_1",
            phase: "accepted",
            outcome: "accepted",
            action: "approval_response",
            target: { type: "approval", session_id: sessionId, codex_thread_id: threadId, request_id: requestId },
            payload_summary: { schema_version: 1, decision: "approve", confirmed: true }
          },
          {
            id: "audit_approval_vertical_2",
            phase: "terminal",
            outcome: "succeeded",
            payload_summary: { schema_version: 1, decision_finalized: true }
          }
        ]
      });
      const rawAudit = open.db
        .prepare("SELECT record_json FROM selected_audit_events WHERE operation_id = ? ORDER BY phase")
        .all(operationId) as readonly { readonly record_json: string }[];
      const rawAuditText = rawAudit.map((row) => row.record_json).join("\n");
      expect(rawAudit).toHaveLength(2);
      expect(rawAuditText).toContain(sessionId);
      expect(rawAuditText).toContain(threadId);
      expect(rawAuditText).toContain(requestId);
      expect(rawAuditText).not.toContain(firstRequest.action);
      expect(rawAuditText).not.toContain(firstRequest.scope ?? "unreachable-scope");
      expect(rawAuditText).not.toContain(firstRequest.reason ?? "unreachable-reason");
      expect(rawAuditText).not.toContain(secondSessionId);
      expect(auditRepository.get(duplicateOperationId)).toBeNull();
    } finally {
      approvalService.close();
      await app.close();
      if (open.db.open) open.db.close();
    }
  });
});

function createVerticalApprovalClient(requests: readonly CodexApprovalRequest[]): {
  readonly client: CodexApprovalClient;
  readonly responses: CodexApprovalResponseInput[];
  readonly responseStarted: Promise<void>;
} {
  const responses: CodexApprovalResponseInput[] = [];
  let notifyResponseStarted: () => void = () => undefined;
  const responseStarted = new Promise<void>((resolve) => {
    notifyResponseStarted = resolve;
  });
  const client: CodexApprovalClient = {
    runtime_version: runtimeVersion,
    generation,
    parseRequest(message) {
      const request = requests.find((candidate) => candidate === message);
      if (request === undefined) throw new TypeError("Approval vertical received an unknown runtime request.");
      return request;
    },
    async respond(input) {
      responses.push(input);
      notifyResponseStarted();
    }
  };
  return { client, responses, responseStarted };
}

function approvalRequest(
  input: Pick<
    CodexApprovalRequest,
    "request_id" | "protocol_request_id" | "thread_id" | "turn_id" | "item_id" | "action" | "scope" | "reason"
  >
): CodexApprovalRequest {
  return {
    method: "item/commandExecution/requestApproval",
    ...input,
    generation,
    started_at: isoTimestampSchema.parse(timestamp),
    risk: "elevated",
    grant_scope: "one_time"
  };
}

function firstRequestTarget(request: CodexApprovalRequest) {
  return {
    type: "approval" as const,
    session_id: sessionId,
    codex_thread_id: request.thread_id,
    request_id: request.request_id
  };
}

function resolvedEvent(request: CodexApprovalRequest): NormalizedCodexEvent {
  return {
    sequence: 1,
    method: "serverRequest/resolved",
    captured_at: timestamp,
    upstream_at: null,
    codex_event_id: `request:${request.request_id}:resolved`,
    scope: "thread",
    thread_id: request.thread_id,
    request_id: request.request_id
  } as NormalizedCodexEvent;
}

function itemCompletedEvent(request: CodexApprovalRequest): NormalizedCodexEvent {
  return {
    sequence: 2,
    method: "item/completed",
    captured_at: timestamp,
    upstream_at: timestamp,
    codex_event_id: `item:${request.item_id}:completed`,
    scope: "thread",
    thread_id: request.thread_id,
    turn_id: request.turn_id,
    item: {
      id: request.item_id,
      category: "command",
      state: "completed",
      title: "Command execution",
      text: null,
      content_state: "redacted",
      content_notice: "Sensitive content omitted."
    }
  } as NormalizedCodexEvent;
}

function activeState(session: string, thread: string, name: string) {
  const mapping = selectedSessionMappingRecordSchema.parse({
    id: session,
    name,
    codex_thread_id: thread,
    cwd: `/tmp/hostdeck-${name}`,
    runtime_source: "codex_app_server",
    runtime_version: runtimeVersion,
    disposition: "selected",
    created_at: timestamp,
    updated_at: timestamp,
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
      turn_state: "idle",
      attention: "needs_approval",
      freshness: "current",
      freshness_reason: null,
      updated_at: timestamp,
      last_activity_at: timestamp,
      branch: "main",
      model: "gpt-5.5-codex",
      goal: null,
      recent_summary: "Managed Codex session awaiting approval.",
      last_event_cursor: null
    },
    retained_event_count: 0,
    retained_event_bytes: 0,
    earliest_retained_cursor: null,
    retention_boundary_cursor: null
  });
  return { mapping, projection };
}

function runtime() {
  return runtimeCompatibilitySchema.parse({
    source: "codex_app_server",
    state: "ready",
    mutation_policy: "allowed",
    observed_version: runtimeVersion,
    binding_id: "binding-approval-vertical-001",
    capabilities: runtimeCapabilities.map((name) => ({ name, state: "available", reason: null })),
    checked_at: timestamp,
    reason: null
  });
}

function settings() {
  return Object.freeze({
    locked: false,
    settings_updated_at: timestamp
  });
}

function availableLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close(() => reject(new Error("Loopback port allocation failed.")));
        return;
      }
      server.close((error) => {
        if (error !== undefined) reject(error);
        else resolve(address.port);
      });
    });
  });
}
