import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cliExitCodes, runCli } from "../packages/cli/src/index.js";
import type {
  CodexTurnClient,
  CodexTurnInterruptInput,
  CodexTurnStartInput,
  CodexTurnSteerInput,
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
  type CodexPromptModelPort,
  type CodexPromptPlanPort,
  createCodexPromptControlService,
  createHostDeckCsrfPolicy,
  createHostDeckFastifyApp,
  createHostDeckHostLockPolicy,
  createHostDeckPromptRouteRegistration,
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
const timestamp = "2026-07-15T21:00:00.000Z";
const eventTimestamp = "2026-07-15T21:00:01.000Z";
const runtimeVersion = "0.144.0";
const sessionId = "sess_prompt_vertical_001";
const threadId = "thread-prompt-vertical-001";
const secondSessionId = "sess_prompt_vertical_002";
const secondThreadId = "thread-prompt-vertical-002";
const operationId = "op_prompt_vertical_001";
const privatePrompt = "PROMPT_VERTICAL_PRIVATE_SENTINEL continue the selected task";
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

describe("managed-session prompt selected vertical", () => {
  it("dispatches one CLI prompt through the selected API, audit gate, and exact prompt service", async () => {
    const directory = mkdtempSync(join(tmpdir(), "hostdeck-prompt-vertical-"));
    directories.push(directory);
    const open = openMigratedDatabase(join(directory, "hostdeck.sqlite"), {
      now: () => new Date(timestamp)
    });
    const states = createSelectedStateRepository(open.db);
    states.create(activeState(sessionId, threadId, "prompt-vertical-one"));
    states.create(activeState(secondSessionId, secondThreadId, "prompt-vertical-two"));
    const turns = new VerticalTurnClient();
    const promptService = createCodexPromptControlService({
      turns,
      models: noPendingModels(),
      plans: noPendingPlans(),
      states,
      now: () => timestamp
    });
    const auditRepository = createSelectedAuditRepository(open.db);
    let auditRecord = 0;
    const audit = createHostDeckSelectedWriteAuditExecutor({
      repository: auditRepository,
      now: () => eventTimestamp,
      create_record_id: () => `audit_prompt_vertical_${++auditRecord}`
    });
    const csrf = createHostDeckCsrfPolicy({
      csrf: {
        authorizeBrowserWrite() {
          throw new Error("Loopback vertical must not authorize browser CSRF.");
        },
        rotateBootstrap() {
          throw new Error("Loopback vertical must not rotate browser CSRF.");
        }
      },
      now: () => new Date(eventTimestamp)
    });
    const lock = createHostDeckHostLockPolicy({
      settings: {
        read: () => settings(),
        transition() {
          throw new Error("Prompt vertical must not transition host lock.");
        }
      },
      now: () => new Date(eventTimestamp)
    });
    const registration = createHostDeckPromptRouteRegistration({
      admission: createHostDeckSelectedWriteAdmissionPolicy({
        resourceBudget: defaultResourceBudget,
        now: () => performance.now()
      }),
      audit,
      csrf,
      lock,
      prompts: {
        dispatch: promptService.dispatch,
        snapshot: promptService.snapshot
      },
      runtime: { read: () => runtime() },
      sessions: { read: (candidate) => states.require(candidate) }
    });
    const port = await availableLoopbackPort();
    const app = createHostDeckFastifyApp({
      observeInternalError: () => undefined,
      requestAuthenticationPolicy: createHostDeckRequestAuthenticationPolicy({
        authenticateDeviceToken: () => {
          throw new Error("Loopback vertical must not authenticate a device.");
        },
        now: () => new Date(eventTimestamp)
      }),
      requestTrustPolicy: createHostDeckRequestTrustPolicy({
        allowedOrigin: `http://127.0.0.1:${port}`
      }),
      resourceBudget: defaultResourceBudget,
      routePlugins: [registration]
    });
    await app.listen({
      host: "127.0.0.1",
      port,
      listenTextResolver: () => ""
    });

    try {
      const address = app.server.address();
      if (address === null || typeof address === "string") {
        throw new Error("Prompt vertical listener is unavailable.");
      }
      const args = [
        "--api-url",
        `http://127.0.0.1:${address.port}`,
        "send",
        sessionId,
        privatePrompt,
        "--json"
      ] as const;
      const result = await runCli(args, {
        env: {},
        createPromptOperationId: () => operationId
      });

      expect(result).toMatchObject({ exitCode: cliExitCodes.ok, stderr: "" });
      expect(JSON.parse(result.stdout)).toEqual({
        operation_id: operationId,
        kind: "prompt",
        target: {
          type: "managed_session",
          session_id: sessionId,
          codex_thread_id: threadId
        },
        state: "accepted",
        accepted_at: eventTimestamp,
        audit_record_id: "audit_prompt_vertical_1",
        turn_id: "turn-prompt-vertical-001",
        action: "start"
      });
      expect(result.stdout).not.toContain(privatePrompt);
      expect(turns.startCalls).toEqual([
        {
          operation_id: operationId,
          thread_id: threadId,
          text: privatePrompt,
          settings: { kind: "inherit" },
          deadline: expect.objectContaining({ signal: expect.any(AbortSignal) })
        }
      ]);
      expect(turns.steerCalls).toEqual([]);
      expect(turns.interruptCalls).toEqual([]);
      expect(states.require(sessionId).projection.session.turn_state).toBe("idle");
      expect(states.require(secondSessionId).projection.session.turn_state).toBe("idle");
      expect(await promptService.snapshot({
        type: "managed_session",
        session_id: sessionId,
        codex_thread_id: threadId
      })).toMatchObject({
        phase: "accepted",
        operation_id: operationId,
        turn_id: "turn-prompt-vertical-001"
      });
      expect(await promptService.snapshot({
        type: "managed_session",
        session_id: secondSessionId,
        codex_thread_id: secondThreadId
      })).toMatchObject({ phase: "idle", operation_id: null, turn_id: null });
      expect(auditRepository.require(operationId)).toMatchObject({
        state: "terminal",
        records: [
          {
            id: "audit_prompt_vertical_1",
            phase: "accepted",
            outcome: "accepted",
            payload_summary: {
              schema_version: 1,
              text_length: privatePrompt.length
            }
          },
          {
            id: "audit_prompt_vertical_2",
            phase: "terminal",
            outcome: "succeeded",
            payload_summary: { schema_version: 1, accepted: true }
          }
        ]
      });
      const rawAudit = open.db
        .prepare("SELECT record_json FROM selected_audit_events WHERE operation_id = ? ORDER BY phase")
        .all(operationId) as readonly { readonly record_json: string }[];
      expect(rawAudit.map((row) => row.record_json).join("\n")).not.toContain(privatePrompt);

      const current = states.require(sessionId);
      const inProgress = {
        mapping: {
          ...current.mapping,
          updated_at: eventTimestamp
        },
        projection: {
          ...current.projection,
          session: {
            ...current.projection.session,
            turn_state: "in_progress",
            updated_at: eventTimestamp,
            last_activity_at: eventTimestamp
          }
        }
      };
      states.replace(inProgress, {
        mapping_updated_at: current.mapping.updated_at,
        projection_updated_at: current.projection.session.updated_at,
        last_event_cursor: current.projection.session.last_event_cursor
      });
      await promptService.observeEvent(turnStartedEvent());
      expect(await promptService.snapshot({
        type: "managed_session",
        session_id: sessionId,
        codex_thread_id: threadId
      })).toMatchObject({
        phase: "steerable",
        turn_id: "turn-prompt-vertical-001"
      });

      const duplicate = await runCli(args, {
        env: {},
        createPromptOperationId: () => operationId
      });
      expect(duplicate).toMatchObject({
        exitCode: cliExitCodes.ok,
        stderr: ""
      });
      expect(duplicate.stdout).toBe(result.stdout);
      expect(duplicate.stderr).not.toContain(privatePrompt);
      expect(turns.startCalls).toHaveLength(1);
      expect(turns.steerCalls).toHaveLength(0);
      expect(auditRepository.require(operationId).records).toHaveLength(2);
    } finally {
      await app.close();
      if (open.db.open) open.db.close();
    }
  });
});

class VerticalTurnClient implements CodexTurnClient {
  readonly runtime_version = runtimeVersion;
  readonly startCalls: CodexTurnStartInput[] = [];
  readonly steerCalls: CodexTurnSteerInput[] = [];
  readonly interruptCalls: CodexTurnInterruptInput[] = [];

  async startTurn(
    input: CodexTurnStartInput
  ): ReturnType<CodexTurnClient["startTurn"]> {
    this.startCalls.push(input);
    return {
      thread_id: codexThreadIdSchema.parse(input.thread_id),
      turn_id: codexTurnIdSchema.parse("turn-prompt-vertical-001"),
      state: "accepted" as const
    };
  }

  async steerTurn(
    input: CodexTurnSteerInput
  ): ReturnType<CodexTurnClient["steerTurn"]> {
    this.steerCalls.push(input);
    throw new Error("Prompt vertical must not steer during initial dispatch.");
  }

  async interruptTurn(
    input: CodexTurnInterruptInput
  ): ReturnType<CodexTurnClient["interruptTurn"]> {
    this.interruptCalls.push(input);
    throw new Error("Prompt vertical must not interrupt a turn.");
  }
}

function noPendingModels(): CodexPromptModelPort {
  return {
    readPendingSettings: () => [],
    async dispatchPendingTurn() {
      throw new Error("Prompt vertical has no pending model selection.");
    }
  };
}

function noPendingPlans(): CodexPromptPlanPort {
  return {
    readPendingSettings: () => [],
    async dispatchPendingTurn() {
      throw new Error("Prompt vertical has no pending Plan selection.");
    }
  };
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
  const projection: SelectedSessionProjectionRecord =
    selectedSessionProjectionRecordSchema.parse({
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
        attention: "none",
        freshness: "current",
        freshness_reason: null,
        updated_at: timestamp,
        last_activity_at: timestamp,
        branch: "main",
        model: "gpt-5.5-codex",
        goal: null,
        recent_summary: "Managed Codex session ready.",
        last_event_cursor: null
      },
      retained_event_count: 0,
      retained_event_bytes: 0,
      earliest_retained_cursor: null,
      retention_boundary_cursor: null
    });
  return { mapping, projection };
}

function turnStartedEvent(): NormalizedCodexEvent {
  return {
    sequence: 1,
    method: "turn/started",
    captured_at: eventTimestamp,
    upstream_at: null,
    codex_event_id: null,
    scope: "thread",
    thread_id: threadId,
    turn_id: "turn-prompt-vertical-001",
    status: "in_progress"
  } as NormalizedCodexEvent;
}

function runtime() {
  return runtimeCompatibilitySchema.parse({
    source: "codex_app_server",
    state: "ready",
    mutation_policy: "allowed",
    observed_version: runtimeVersion,
    binding_id: "binding-prompt-vertical-001",
    capabilities: runtimeCapabilities.map((name) => ({
      name,
      state: "available",
      reason: null
    })),
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
