import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cliExitCodes, runCli } from "../packages/cli/src/index.js";
import type {
  CodexTurnInterruptAccepted,
  CodexTurnInterruptInput,
  NormalizedCodexEvent
} from "../packages/codex-adapter/src/index.js";
import {
  codexThreadIdSchema,
  codexTurnIdSchema,
  defaultResourceBudget,
  runtimeCompatibilitySchema,
  type SelectedSessionProjectionRecord,
  selectedSessionMappingRecordSchema,
  selectedSessionProjectionRecordSchema
} from "../packages/contracts/src/index.js";
import {
  createCodexInterruptControlService,
  createHostDeckCsrfPolicy,
  createHostDeckFastifyApp,
  createHostDeckHostLockPolicy,
  createHostDeckInterruptRouteRegistration,
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
const timestamp = "2026-07-16T21:00:00.000Z";
const terminalTimestamp = "2026-07-16T21:00:01.000Z";
const auditTimestamp = "2026-07-16T21:00:02.000Z";
const runtimeVersion = "0.144.0";
const sessionId = "sess_interrupt_vertical_001";
const threadId = codexThreadIdSchema.parse("thread-interrupt-vertical-001");
const turnId = codexTurnIdSchema.parse("turn-interrupt-vertical-001");
const secondSessionId = "sess_interrupt_vertical_002";
const secondThreadId = codexThreadIdSchema.parse("thread-interrupt-vertical-002");
const secondTurnId = codexTurnIdSchema.parse("turn-interrupt-vertical-002");
const operationId = "op_interrupt_vertical_001";
const secondOperationId = "op_interrupt_vertical_002";
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
  for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

describe("managed-session interrupt selected vertical", () => {
  it("interrupts one exact turn through the real CLI, API, gate, production service, and SQLite", async () => {
    const directory = mkdtempSync(join(tmpdir(), "hostdeck-interrupt-vertical-"));
    directories.push(directory);
    const open = openMigratedDatabase(join(directory, "hostdeck.sqlite"), { now: () => new Date(timestamp) });
    const states = createSelectedStateRepository(open.db);
    states.create(activeState(sessionId, threadId, turnId, "interrupt-vertical-one"));
    states.create(activeState(secondSessionId, secondThreadId, secondTurnId, "interrupt-vertical-two"));

    const adapter = createVerticalTurnClient();
    const interruptService = createCodexInterruptControlService({
      turns: adapter.client,
      states: {
        get: (candidate) => states.get(candidate),
        getByThreadId: (candidate) => states.getByThreadId(candidate)
      },
      now: () => timestamp
    });
    await interruptService.observeEvent(turnStartedEvent(sessionId, threadId, turnId, 1));
    await interruptService.observeEvent(turnStartedEvent(secondSessionId, secondThreadId, secondTurnId, 2));

    const auditRepository = createSelectedAuditRepository(open.db);
    let auditRecord = 0;
    const audit = createHostDeckSelectedWriteAuditExecutor({
      repository: auditRepository,
      now: () => auditTimestamp,
      create_record_id: () => `audit_interrupt_vertical_${++auditRecord}`
    });
    const csrf = createHostDeckCsrfPolicy({
      csrf: {
        authorizeBrowserWrite() {
          throw new Error("Loopback interrupt vertical must not authorize browser CSRF.");
        },
        rotateBootstrap() {
          throw new Error("Loopback interrupt vertical must not rotate browser CSRF.");
        }
      },
      now: () => new Date(auditTimestamp)
    });
    const lock = createHostDeckHostLockPolicy({
      settings: {
        read: () => settings(),
        transition() {
          throw new Error("Interrupt vertical must not transition host lock.");
        }
      },
      now: () => new Date(auditTimestamp)
    });
    const registration = createHostDeckInterruptRouteRegistration({
      admission: createHostDeckSelectedWriteAdmissionPolicy({
        resourceBudget: defaultResourceBudget,
        now: () => performance.now()
      }),
      interrupts: {
        interrupt: interruptService.interrupt,
        requireInterruptible: interruptService.requireInterruptible,
        waitForTerminal: interruptService.waitForTerminal
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
          throw new Error("Loopback interrupt vertical must not authenticate a device.");
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
      if (address === null || typeof address === "string") throw new Error("Interrupt vertical listener is unavailable.");
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const args = ["--api-url", baseUrl, "interrupt", sessionId, turnId, "--confirm", "--json"] as const;
      let responseSettled = false;
      const responsePromise = runCli(args, {
        env: {},
        createInterruptOperationId: () => operationId
      }).finally(() => {
        responseSettled = true;
      });

      await adapter.interruptStarted;
      await waitFor(async () => (await interruptService.snapshot(turnTarget(sessionId, threadId, turnId)))?.state === "accepted");
      expect(responseSettled).toBe(false);
      expect(adapter.calls).toEqual([
        {
          operation_id: operationId,
          thread_id: threadId,
          turn_id: turnId,
          deadline: expect.objectContaining({ signal: expect.any(AbortSignal) })
        }
      ]);
      expect(await interruptService.snapshot(turnTarget(sessionId, threadId, turnId))).toMatchObject({
        operation_id: operationId,
        state: "accepted",
        error: null
      });
      expect(await interruptService.snapshot(turnTarget(secondSessionId, secondThreadId, secondTurnId))).toBeNull();
      expect(interruptService.active_count).toBe(2);
      expect(states.require(sessionId).mapping.archived_at).toBeNull();

      await interruptService.observeEvent(turnCompletedEvent(threadId, turnId, "interrupted", 3));
      const response = await responsePromise;
      expect(response).toMatchObject({ exitCode: cliExitCodes.ok, stderr: "" });
      expect(JSON.parse(response.stdout)).toEqual({
        operation_id: operationId,
        kind: "interrupt",
        target: turnTarget(sessionId, threadId, turnId),
        state: "interrupted",
        updated_at: terminalTimestamp,
        turn_id: turnId,
        error: null
      });
      expect(adapter.calls).toHaveLength(1);
      expect(await interruptService.snapshot(turnTarget(sessionId, threadId, turnId))).toMatchObject({
        state: "interrupted",
        error: null
      });
      expect(interruptService.active_count).toBe(1);
      expect(await interruptService.requireInterruptible(turnTarget(secondSessionId, secondThreadId, secondTurnId))).toBeUndefined();
      expect(states.require(sessionId).mapping.archived_at).toBeNull();
      expect(states.require(secondSessionId).mapping.archived_at).toBeNull();

      const replay = await runCli(args, {
        env: {},
        createInterruptOperationId: () => operationId
      });
      expect(replay).toMatchObject({ exitCode: cliExitCodes.ok, stderr: "" });
      expect(replay.stdout).toBe(response.stdout);
      expect(adapter.calls).toHaveLength(1);

      const duplicate = await runCli(args, {
        env: {},
        createInterruptOperationId: () => secondOperationId
      });
      expect(duplicate).toMatchObject({ exitCode: cliExitCodes.apiError, stdout: "" });
      expect(duplicate.stderr).toContain("operation_conflict");
      expect(adapter.calls).toHaveLength(1);

      expect(auditRepository.require(operationId)).toMatchObject({
        state: "terminal",
        records: [
          {
            id: "audit_interrupt_vertical_1",
            phase: "accepted",
            outcome: "accepted",
            action: "interrupt",
            target: turnTarget(sessionId, threadId, turnId),
            payload_summary: { schema_version: 1, confirmed: true }
          },
          {
            id: "audit_interrupt_vertical_2",
            phase: "terminal",
            outcome: "succeeded",
            payload_summary: { schema_version: 1, interrupted: true }
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
      expect(rawAuditText).toContain(turnId);
      expect(rawAuditText).not.toContain("/tmp/hostdeck-interrupt-vertical-private");
      expect(rawAuditText).not.toContain(secondSessionId);
      expect(auditRepository.get(secondOperationId)).toBeNull();
    } finally {
      await app.close();
      if (open.db.open) open.db.close();
    }
  });
});

function createVerticalTurnClient(): {
  readonly calls: CodexTurnInterruptInput[];
  readonly client: {
    readonly runtime_version: string;
    readonly interruptTurn: (input: CodexTurnInterruptInput) => Promise<CodexTurnInterruptAccepted>;
  };
  readonly interruptStarted: Promise<void>;
} {
  const calls: CodexTurnInterruptInput[] = [];
  let notifyStarted: () => void = () => undefined;
  const interruptStarted = new Promise<void>((resolve) => {
    notifyStarted = resolve;
  });
  return {
    calls,
    interruptStarted,
    client: {
      runtime_version: runtimeVersion,
      async interruptTurn(input) {
        calls.push(input);
        notifyStarted();
        return {
          thread_id: codexThreadIdSchema.parse(input.thread_id),
          turn_id: codexTurnIdSchema.parse(input.turn_id),
          state: "accepted"
        };
      }
    }
  };
}

function turnTarget(session: string, thread: string, turn: string) {
  return { type: "turn" as const, session_id: session, codex_thread_id: thread, turn_id: turn };
}

function turnStartedEvent(
  session: string,
  thread: string,
  turn: string,
  sequence: number
): NormalizedCodexEvent {
  return {
    sequence,
    method: "turn/started",
    captured_at: timestamp,
    upstream_at: null,
    codex_event_id: `${session}:${turn}:started`,
    scope: "thread",
    thread_id: thread,
    turn_id: turn,
    status: "in_progress"
  } as NormalizedCodexEvent;
}

function turnCompletedEvent(
  thread: string,
  turn: string,
  status: "completed" | "failed" | "interrupted",
  sequence: number
): NormalizedCodexEvent {
  return {
    sequence,
    method: "turn/completed",
    captured_at: terminalTimestamp,
    upstream_at: null,
    codex_event_id: `${turn}:${status}`,
    scope: "thread",
    thread_id: thread,
    turn_id: turn,
    status,
    error_message: null
  } as NormalizedCodexEvent;
}

function activeState(session: string, thread: string, _turn: string, name: string) {
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
      turn_state: "in_progress",
      attention: "none",
      freshness: "current",
      freshness_reason: null,
      updated_at: timestamp,
      last_activity_at: timestamp,
      branch: "main",
      model: "gpt-5.5-codex",
      goal: null,
      recent_summary: "Managed Codex session with one active turn.",
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
    binding_id: "binding-interrupt-vertical-001",
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

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Timed out waiting for interrupt vertical state.");
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
