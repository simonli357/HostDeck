import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cliExitCodes, runCli } from "../packages/cli/src/index.js";
import type {
  CodexModelCatalog,
  CodexModelClient,
  CodexModelTurnStartInput
} from "../packages/codex-adapter/src/index.js";
import {
  codexThreadIdSchema,
  defaultResourceBudget,
  defaultRetentionPolicy,
  isoTimestampSchema,
  type ModelCatalogEntry,
  managedSessionTargetSchema,
  modelCatalogEntrySchema,
  runtimeCompatibilitySchema,
  type SelectedSessionProjectionRecord,
  selectedSessionMappingRecordSchema,
  selectedSessionProjectionRecordSchema
} from "../packages/contracts/src/index.js";
import {
  createCodexModelControlService,
  createHostDeckCsrfPolicy,
  createHostDeckFastifyApp,
  createHostDeckHostLockPolicy,
  createHostDeckModelRouteRegistration,
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
const timestamp = "2026-07-16T05:00:00.000Z";
const auditTimestamp = "2026-07-16T05:00:01.000Z";
const runtimeVersion = "0.144.0";
const sessionId = "sess_model_vertical_001";
const threadId = "thread-model-vertical-001";
const secondSessionId = "sess_model_vertical_002";
const secondThreadId = "thread-model-vertical-002";
const operationId = "op_model_vertical_001";
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
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("managed-session model selected vertical", () => {
  it("reads and stages one model through the CLI, selected API, audit gate, and production service", async () => {
    const directory = mkdtempSync(join(tmpdir(), "hostdeck-model-vertical-"));
    directories.push(directory);
    const open = openMigratedDatabase(join(directory, "hostdeck.sqlite"), {
      now: () => new Date(timestamp)
    });
    const states = createSelectedStateRepository(open.db);
    states.create(activeState(sessionId, threadId, "model-vertical-one"));
    states.create(activeState(secondSessionId, secondThreadId, "model-vertical-two"));
    const runtimeModels = new VerticalModelClient();
    const modelService = createCodexModelControlService({
      models: runtimeModels,
      states,
      now: () => timestamp
    });
    const auditRepository = createSelectedAuditRepository(open.db);
    let auditRecord = 0;
    const audit = createHostDeckSelectedWriteAuditExecutor({
      repository: auditRepository,
      now: () => auditTimestamp,
      create_record_id: () => `audit_model_vertical_${++auditRecord}`
    });
    const csrf = createHostDeckCsrfPolicy({
      csrf: {
        authorizeBrowserWrite() {
          throw new Error("Loopback model vertical must not authorize browser CSRF.");
        },
        rotateBootstrap() {
          throw new Error("Loopback model vertical must not rotate browser CSRF.");
        }
      },
      now: () => new Date(auditTimestamp)
    });
    const lock = createHostDeckHostLockPolicy({
      settings: {
        read: () => settings(),
        transition() {
          throw new Error("Model vertical must not transition host lock.");
        }
      },
      now: () => new Date(auditTimestamp)
    });
    const registration = createHostDeckModelRouteRegistration({
      audit,
      csrf,
      lock,
      models: {
        select: modelService.select,
        snapshot: modelService.snapshot
      },
      runtime: { read: () => runtime() },
      state: { get: (candidate) => states.get(candidate) }
    });
    const port = await availableLoopbackPort();
    const app = createHostDeckFastifyApp({
      observeInternalError: () => undefined,
      requestAuthenticationPolicy: createHostDeckRequestAuthenticationPolicy({
        authenticateDeviceToken: () => {
          throw new Error("Loopback model vertical must not authenticate a device.");
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
      if (address === null || typeof address === "string") {
        throw new Error("Model vertical listener is unavailable.");
      }
      const baseArgs = ["--api-url", `http://127.0.0.1:${address.port}`, "model", sessionId] as const;
      const read = await runCli([...baseArgs, "--json"], { env: {} });
      expect(read).toMatchObject({ exitCode: cliExitCodes.ok, stderr: "" });
      expect(JSON.parse(read.stdout)).toMatchObject({
        current: {
          model_id: "model-a",
          runtime_model: "runtime-a",
          reasoning_effort: "high",
          catalog_state: "available"
        },
        pending: null,
        models: [{ id: "model-a" }, { id: "model-b" }]
      });

      const selectArgs = [...baseArgs, "model-b", "--json"] as const;
      const selected = await runCli(selectArgs, {
        env: {},
        createModelOperationId: () => operationId
      });
      expect(selected).toMatchObject({ exitCode: cliExitCodes.ok, stderr: "" });
      expect(JSON.parse(selected.stdout)).toMatchObject({
        current: { model_id: "model-a", runtime_model: "runtime-a" },
        pending: {
          revision: 1,
          selection_operation_id: operationId,
          model_id: "model-b",
          runtime_model: "runtime-b",
          reasoning_effort: "high",
          catalog_state: "available",
          phase: "pending",
          turn_id: null,
          error: null
        }
      });
      expect(runtimeModels.listCalls).toHaveLength(2);
      expect(runtimeModels.readCalls).toEqual([threadId, threadId]);
      expect(runtimeModels.startCalls).toEqual([]);
      expect(modelService.pending_count).toBe(1);
      expect(
        modelService.readPendingSettings(selectedTarget)
      ).toEqual([{ control: "model", revision: 1, phase: "pending" }]);
      expect(
        modelService.readPendingSettings(secondTarget)
      ).toEqual([]);
      expect(states.require(sessionId).projection.session.turn_state).toBe("idle");
      expect(states.require(secondSessionId).projection.session.turn_state).toBe("idle");
      expect(auditRepository.require(operationId)).toMatchObject({
        state: "terminal",
        records: [
          {
            id: "audit_model_vertical_1",
            phase: "accepted",
            outcome: "accepted",
            action: "model",
            payload_summary: {
              schema_version: 1,
              model_id: "model-b",
              reasoning_effort: null,
              expected_revision_present: false
            }
          },
          {
            id: "audit_model_vertical_2",
            phase: "terminal",
            outcome: "succeeded",
            payload_summary: { schema_version: 1, changed: true }
          }
        ]
      });
      const rawAudit = open.db
        .prepare("SELECT record_json FROM selected_audit_events WHERE operation_id = ? ORDER BY phase")
        .all(operationId) as readonly { readonly record_json: string }[];
      expect(rawAudit.map((row) => row.record_json).join("\n")).not.toMatch(
        /runtime-a|runtime-b|Model A|Model B|Thorough/u
      );

      const duplicate = await runCli(selectArgs, {
        env: {},
        createModelOperationId: () => operationId
      });
      expect(duplicate).toMatchObject({ exitCode: cliExitCodes.apiError, stdout: "" });
      expect(duplicate.stderr).toContain("operation_conflict");
      expect(runtimeModels.listCalls).toHaveLength(2);
      expect(runtimeModels.readCalls).toHaveLength(2);
      expect(runtimeModels.startCalls).toEqual([]);
      expect(modelService.pending_count).toBe(1);
      expect(auditRepository.require(operationId).records).toHaveLength(2);
    } finally {
      await app.close();
      if (open.db.open) open.db.close();
    }
  });
});

class VerticalModelClient implements CodexModelClient {
  readonly runtime_version = runtimeVersion;
  readonly listCalls: Array<AbortSignal | undefined> = [];
  readonly readCalls: string[] = [];
  readonly startCalls: CodexModelTurnStartInput[] = [];

  async listCatalog(signal?: AbortSignal): Promise<CodexModelCatalog> {
    this.listCalls.push(signal);
    return {
      revision: "a".repeat(64),
      observed_at: isoTimestampSchema.parse(timestamp),
      models: catalogModels
    };
  }

  async readCurrent(thread: string, _signal?: AbortSignal) {
    this.readCalls.push(thread);
    return {
      thread_id: codexThreadIdSchema.parse(thread),
      runtime_model: "runtime-a",
      reasoning_effort: "high"
    };
  }

  async startTurn(input: CodexModelTurnStartInput): ReturnType<CodexModelClient["startTurn"]> {
    this.startCalls.push(input);
    throw new Error("Model selection must not dispatch a turn.");
  }
}

const catalogModels: readonly ModelCatalogEntry[] = [
  modelCatalogEntrySchema.parse({
    id: "model-a",
    runtime_model: "runtime-a",
    label: "Model A",
    description: null,
    is_default: true,
    input_modalities: ["text", "image"],
    reasoning_efforts: [
      { id: "low", description: "Fast", is_default: false },
      { id: "high", description: "Thorough", is_default: true }
    ]
  }),
  modelCatalogEntrySchema.parse({
    id: "model-b",
    runtime_model: "runtime-b",
    label: "Model B",
    description: null,
    is_default: false,
    input_modalities: ["text"],
    reasoning_efforts: [
      { id: "low", description: "Fast", is_default: false },
      { id: "high", description: "Thorough", is_default: true }
    ]
  })
];

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

function runtime() {
  return runtimeCompatibilitySchema.parse({
    source: "codex_app_server",
    state: "ready",
    mutation_policy: "allowed",
    observed_version: runtimeVersion,
    binding_id: "binding-model-vertical-001",
    capabilities: runtimeCapabilities.map((name) => ({ name, state: "available", reason: null })),
    checked_at: timestamp,
    reason: null
  });
}

function settings() {
  return {
    id: "hostdeck_settings" as const,
    schema_version: 1,
    state_dir: "/tmp/hostdeck-model-vertical-state",
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
