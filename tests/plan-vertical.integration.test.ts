import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cliExitCodes, runCli } from "../packages/cli/src/index.js";
import type {
  CodexModelCatalog,
  CodexModelClient,
  CodexModelTurnStartInput,
  CodexPlanCatalog,
  CodexPlanClient,
  CodexPlanTurnStartInput,
  NormalizedCodexEvent
} from "../packages/codex-adapter/src/index.js";
import {
  defaultResourceBudget,
  defaultRetentionPolicy,
  managedSessionTargetSchema,
  runtimeCompatibilitySchema,
  type SelectedSessionProjectionRecord,
  selectedSessionMappingRecordSchema,
  selectedSessionProjectionRecordSchema
} from "../packages/contracts/src/index.js";
import {
  createCodexModelControlService,
  createCodexPlanControlService,
  createHostDeckCsrfPolicy,
  createHostDeckFastifyApp,
  createHostDeckHostLockPolicy,
  createHostDeckPlanRouteRegistration,
  createHostDeckRequestAuthenticationPolicy,
  createHostDeckRequestTrustPolicy,
  createHostDeckSelectedWriteAuditExecutor
} from "../packages/server/src/index.js";
import {
  createSelectedAuditRepository,
  createSelectedStateRepository,
  openMigratedDatabase
} from "../packages/storage/src/index.js";

const directories: string[] = [];
const timestamp = "2026-07-16T05:30:00.000Z";
const auditTimestamp = "2026-07-16T05:30:01.000Z";
const runtimeVersion = "0.144.0";
const sessionId = "sess_plan_vertical_001";
const threadId = "thread-plan-vertical-001";
const secondSessionId = "sess_plan_vertical_002";
const secondThreadId = "thread-plan-vertical-002";
const enterOperationId = "op_plan_vertical_enter_001";
const clearOperationId = "op_plan_vertical_clear_001";
const noOpOperationId = "op_plan_vertical_noop_001";
const selectedTarget = managedSessionTargetSchema.parse({
  type: "managed_session",
  session_id: sessionId,
  codex_thread_id: threadId
});
const secondTarget = managedSessionTargetSchema.parse({
  type: "managed_session",
  session_id: secondSessionId,
  codex_thread_id: secondThreadId
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
  for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

describe("managed-session Plan selected vertical", () => {
  it("reads, stages, clears, and deduplicates Plan state through the production selected path", async () => {
    const directory = mkdtempSync(join(tmpdir(), "hostdeck-plan-vertical-"));
    directories.push(directory);
    const open = openMigratedDatabase(join(directory, "hostdeck.sqlite"), {
      now: () => new Date(timestamp)
    });
    const states = createSelectedStateRepository(open.db);
    states.create(activeState(sessionId, threadId, "plan-vertical-one"));
    states.create(activeState(secondSessionId, secondThreadId, "plan-vertical-two"));
    const runtimeModels = new RejectingVerticalModelClient();
    const modelService = createCodexModelControlService({
      models: runtimeModels,
      states,
      now: () => timestamp
    });
    const runtimePlans = new VerticalPlanClient();
    const planService = createCodexPlanControlService({
      plans: runtimePlans,
      models: modelService,
      states,
      now: () => timestamp
    });
    await planService.observeEvent(settingsEvent());

    const auditRepository = createSelectedAuditRepository(open.db);
    let auditRecord = 0;
    const audit = createHostDeckSelectedWriteAuditExecutor({
      repository: auditRepository,
      now: () => auditTimestamp,
      create_record_id: () => `audit_plan_vertical_${++auditRecord}`
    });
    const csrf = createHostDeckCsrfPolicy({
      csrf: {
        authorizeBrowserWrite() {
          throw new Error("Loopback Plan vertical must not authorize browser CSRF.");
        },
        rotateBootstrap() {
          throw new Error("Loopback Plan vertical must not rotate browser CSRF.");
        }
      },
      now: () => new Date(auditTimestamp)
    });
    const lock = createHostDeckHostLockPolicy({
      settings: {
        read: () => settings(),
        transition() {
          throw new Error("Plan vertical must not transition host lock.");
        }
      },
      now: () => new Date(auditTimestamp)
    });
    const registration = createHostDeckPlanRouteRegistration({
      audit,
      csrf,
      lock,
      plans: { select: planService.select, snapshot: planService.snapshot },
      runtime: { read: () => runtime() },
      state: { get: (candidate) => states.get(candidate) }
    });
    const port = await availableLoopbackPort();
    const app = createHostDeckFastifyApp({
      observeInternalError: () => undefined,
      requestAuthenticationPolicy: createHostDeckRequestAuthenticationPolicy({
        authenticateDeviceToken: () => {
          throw new Error("Loopback Plan vertical must not authenticate a device.");
        },
        now: () => new Date(auditTimestamp)
      }),
      requestTrustPolicy: createHostDeckRequestTrustPolicy({
        allowedOrigins: [`http://127.0.0.1:${port}`],
        mode: "loopback",
        transport: "http"
      }),
      resourceBudget: defaultResourceBudget,
      routePlugins: [registration]
    });
    await app.listen({ host: "127.0.0.1", port, listenTextResolver: () => "" });

    try {
      const address = app.server.address();
      if (address === null || typeof address === "string") throw new Error("Plan vertical listener is unavailable.");
      const apiUrl = `http://127.0.0.1:${address.port}`;
      const baseArgs = ["--api-url", apiUrl, "plan", sessionId] as const;

      const read = await runCli([...baseArgs, "--json"], { env: {} });
      expect(read).toMatchObject({ exitCode: cliExitCodes.ok, stderr: "" });
      expect(JSON.parse(read.stdout)).toMatchObject({
        current: {
          state: "confirmed",
          mode: "default",
          runtime_model: "runtime-a",
          reasoning_effort: "high"
        },
        pending: null,
        execution: { state: "idle", turn_id: null },
        modes: [{ mode: "plan" }, { mode: "default" }]
      });

      const enterArgs = [...baseArgs, "enter", "--json"] as const;
      const entered = await runCli(enterArgs, {
        env: {},
        createPlanOperationId: () => enterOperationId
      });
      expect(entered).toMatchObject({ exitCode: cliExitCodes.ok, stderr: "" });
      expect(JSON.parse(entered.stdout)).toMatchObject({
        current: { state: "confirmed", mode: "default" },
        pending: {
          revision: 1,
          selection_operation_id: enterOperationId,
          mode: "plan",
          catalog_state: "available",
          phase: "pending",
          turn_id: null,
          resolved_settings: null,
          error: null
        },
        execution: { state: "idle", turn_id: null }
      });
      expect(planService.readPendingSettings(selectedTarget)).toEqual([
        { control: "plan", revision: 1, phase: "pending" }
      ]);

      const secondRead = await runCli(["--api-url", apiUrl, "plan", secondSessionId, "--json"], { env: {} });
      expect(secondRead).toMatchObject({ exitCode: cliExitCodes.ok, stderr: "" });
      expect(JSON.parse(secondRead.stdout)).toMatchObject({
        current: { state: "unknown", mode: null },
        pending: null,
        execution: { state: "idle", turn_id: null }
      });
      expect(planService.readPendingSettings(secondTarget)).toEqual([]);

      const cleared = await runCli([...baseArgs, "exit", "--expected-revision=1", "--json"], {
        env: {},
        createPlanOperationId: () => clearOperationId
      });
      expect(cleared).toMatchObject({ exitCode: cliExitCodes.ok, stderr: "" });
      expect(JSON.parse(cleared.stdout)).toMatchObject({
        current: { state: "confirmed", mode: "default" },
        pending: null,
        execution: { state: "idle", turn_id: null }
      });
      expect(planService.readPendingSettings(selectedTarget)).toEqual([]);

      const noOp = await runCli([...baseArgs, "exit", "--json"], {
        env: {},
        createPlanOperationId: () => noOpOperationId
      });
      expect(noOp).toMatchObject({ exitCode: cliExitCodes.ok, stderr: "" });
      expect(JSON.parse(noOp.stdout)).toMatchObject({
        current: { state: "confirmed", mode: "default" },
        pending: null
      });

      expect(runtimePlans.listCalls).toHaveLength(5);
      expect(runtimePlans.startCalls).toEqual([]);
      expect(runtimeModels.listCalls).toEqual([]);
      expect(runtimeModels.readCalls).toEqual([]);
      expect(runtimeModels.startCalls).toEqual([]);
      expect(planService.pending_count).toBe(0);
      expect(states.require(sessionId).projection.session.turn_state).toBe("idle");
      expect(states.require(secondSessionId).projection.session.turn_state).toBe("idle");

      expect(auditRepository.require(enterOperationId)).toMatchObject({
        state: "terminal",
        records: [
          {
            phase: "accepted",
            outcome: "accepted",
            action: "plan",
            payload_summary: {
              schema_version: 1,
              plan_action: "enter",
              expected_revision_present: false
            }
          },
          {
            phase: "terminal",
            outcome: "succeeded",
            payload_summary: { schema_version: 1, changed: true }
          }
        ]
      });
      expect(auditRepository.require(clearOperationId)).toMatchObject({
        state: "terminal",
        records: [
          {
            phase: "accepted",
            payload_summary: {
              schema_version: 1,
              plan_action: "exit",
              expected_revision_present: true
            }
          },
          { phase: "terminal", payload_summary: { schema_version: 1, changed: true } }
        ]
      });
      expect(auditRepository.require(noOpOperationId)).toMatchObject({
        state: "terminal",
        records: [
          {
            phase: "accepted",
            payload_summary: {
              schema_version: 1,
              plan_action: "exit",
              expected_revision_present: false
            }
          },
          { phase: "terminal", payload_summary: { schema_version: 1, changed: false } }
        ]
      });

      const catalogCallsBeforeDuplicate = runtimePlans.listCalls.length;
      const duplicate = await runCli(enterArgs, {
        env: {},
        createPlanOperationId: () => enterOperationId
      });
      expect(duplicate).toMatchObject({ exitCode: cliExitCodes.apiError, stdout: "" });
      expect(duplicate.stderr).toContain("operation_conflict");
      expect(runtimePlans.listCalls).toHaveLength(catalogCallsBeforeDuplicate);
      expect(runtimePlans.startCalls).toEqual([]);
      expect(auditRepository.require(enterOperationId).records).toHaveLength(2);

      const rawAudit = open.db
        .prepare("SELECT record_json FROM selected_audit_events ORDER BY operation_id, phase")
        .all() as readonly { readonly record_json: string }[];
      expect(rawAudit.map((row) => row.record_json).join("\n")).not.toMatch(
        /runtime-plan-private|Plan Private|\/plan|startTurn|Produce a plan/u
      );
    } finally {
      await app.close();
      if (open.db.open) open.db.close();
    }
  });
});

class VerticalPlanClient implements CodexPlanClient {
  readonly runtime_version = runtimeVersion;
  readonly listCalls: Array<AbortSignal | undefined> = [];
  readonly startCalls: CodexPlanTurnStartInput[] = [];

  async listCatalog(signal?: AbortSignal): Promise<CodexPlanCatalog> {
    this.listCalls.push(signal);
    return {
      revision: "c".repeat(64),
      observed_at: timestamp as never,
      modes: [
        {
          name: "Plan Private",
          mode: "plan",
          preset_model: "runtime-plan-private",
          preset_reasoning_effort: "medium"
        },
        { name: "Default", mode: "default", preset_model: null, preset_reasoning_effort: null }
      ]
    };
  }

  async startTurn(input: CodexPlanTurnStartInput): ReturnType<CodexPlanClient["startTurn"]> {
    this.startCalls.push(input);
    throw new Error("Plan selection must not dispatch a turn.");
  }
}

class RejectingVerticalModelClient implements CodexModelClient {
  readonly runtime_version = runtimeVersion;
  readonly listCalls: Array<AbortSignal | undefined> = [];
  readonly readCalls: string[] = [];
  readonly startCalls: CodexModelTurnStartInput[] = [];

  async listCatalog(signal?: AbortSignal): Promise<CodexModelCatalog> {
    this.listCalls.push(signal);
    throw new Error("Plan selection must not list model settings.");
  }

  async readCurrent(thread: string): ReturnType<CodexModelClient["readCurrent"]> {
    this.readCalls.push(thread);
    throw new Error("Plan selection must not read model settings.");
  }

  async startTurn(input: CodexModelTurnStartInput): ReturnType<CodexModelClient["startTurn"]> {
    this.startCalls.push(input);
    throw new Error("Plan selection must not dispatch through model control.");
  }
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
      attention: "none",
      freshness: "current",
      freshness_reason: null,
      updated_at: timestamp,
      last_activity_at: timestamp,
      branch: "main",
      model: "runtime-a",
      goal: null,
      recent_summary: "Managed Codex Plan session ready.",
      last_event_cursor: null
    },
    retained_event_count: 0,
    retained_event_bytes: 0,
    earliest_retained_cursor: null,
    retention_boundary_cursor: null
  });
  return { mapping, projection };
}

function settingsEvent(): NormalizedCodexEvent {
  return {
    sequence: 1,
    method: "thread/settings/updated",
    captured_at: timestamp,
    upstream_at: null,
    codex_event_id: null,
    scope: "thread",
    thread_id: threadId,
    model: "runtime-a",
    effort: "high",
    collaboration_mode: "default"
  } as NormalizedCodexEvent;
}

function runtime() {
  return runtimeCompatibilitySchema.parse({
    source: "codex_app_server",
    state: "ready",
    mutation_policy: "allowed",
    observed_version: runtimeVersion,
    binding_id: "binding-plan-vertical-001",
    capabilities: runtimeCapabilities.map((name) => ({ name, state: "available", reason: null })),
    checked_at: timestamp,
    reason: null
  });
}

function settings() {
  return {
    id: "hostdeck_settings" as const,
    schema_version: 1,
    state_dir: "/tmp/hostdeck-plan-vertical-state",
    bind_mode: "localhost" as const,
    bind_host: "127.0.0.1",
    bind_port: 3777,
    lan_enabled: false,
    locked: false,
    retention: { ...defaultRetentionPolicy },
    updated_at: timestamp
  };
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
