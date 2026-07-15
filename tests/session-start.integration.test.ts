import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cliExitCodes, runCli } from "../packages/cli/src/index.js";
import {
  defaultResourceBudget,
  defaultRetentionPolicy,
  runtimeCompatibilitySchema,
  sessionIdSchema
} from "../packages/contracts/src/index.js";
import {
  createHostDeckCsrfPolicy,
  createHostDeckFastifyApp,
  createHostDeckHostLockPolicy,
  createHostDeckRequestAuthenticationPolicy,
  createHostDeckRequestTrustPolicy,
  createHostDeckSelectedWriteAuditExecutor,
  createHostDeckSessionStartRouteRegistration,
  createManagedCodexThreadService
} from "../packages/server/src/index.js";
import {
  createSelectedAuditRepository,
  createSelectedStateRepository,
  openMigratedDatabase
} from "../packages/storage/src/index.js";

const temporaryDirectories: string[] = [];
const at = "2026-07-15T19:00:00.000Z";
const runtimeVersion = "0.144.0";
const operationId = "op_session_start_vertical_001";
const name = "vertical-session";
const capabilities = [
  "thread_lifecycle",
  "turn_input",
  "turn_steer",
  "turn_interrupt",
  "model",
  "goal",
  "plan",
  "approvals",
  "usage",
  "compact",
  "skills",
  "multi_client"
] as const;

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("managed-session start vertical", () => {
  it("runs CLI to HTTP to audit to the recoverable service and durable mapping once", async () => {
    const directory = mkdtempSync(join(tmpdir(), "hostdeck-session-start-vertical-"));
    temporaryDirectories.push(directory);
    const projectDirectory = join(directory, "project");
    const open = openMigratedDatabase(join(directory, "hostdeck.sqlite"), {
      now: () => new Date(at)
    });
    const states = createSelectedStateRepository(open.db);
    const threadFixture = createThreadFixture(projectDirectory);
    const managed = createManagedCodexThreadService({
      threads: threadFixture.client,
      states,
      now: () => new Date(at),
      create_session_id: () => sessionIdSchema.parse("sess_start_vertical_001"),
      validate_cwd: async (cwd) => {
        if (cwd !== projectDirectory) throw new Error("unexpected cwd");
      },
      capture_branch: () => "main"
    });
    const audits = createSelectedAuditRepository(open.db);
    let auditId = 0;
    const audit = createHostDeckSelectedWriteAuditExecutor({
      repository: audits,
      now: () => at,
      create_record_id: () => `audit_session_start_vertical_${++auditId}`
    });
    const csrf = createHostDeckCsrfPolicy({
      csrf: {
        authorizeBrowserWrite() {
          throw new Error("Vertical loopback start must not authorize browser CSRF.");
        },
        rotateBootstrap() {
          throw new Error("Vertical loopback start must not rotate browser CSRF.");
        }
      },
      now: () => new Date(at)
    });
    const lock = createHostDeckHostLockPolicy({
      settings: {
        read: () => settings(),
        transition() {
          throw new Error("Vertical session start must not transition host lock.");
        }
      },
      now: () => new Date(at)
    });
    const route = createHostDeckSessionStartRouteRegistration({
      audit,
      csrf,
      lock,
      runtime: { read: () => runtimeCompatibility() },
      sessions: { start: (candidate) => managed.start(candidate) }
    });
    const authentication = createHostDeckRequestAuthenticationPolicy({
      authenticateDeviceToken: () => {
        throw new Error("Vertical loopback start must not authenticate a device.");
      },
      now: () => new Date(at)
    });
    const port = await availableLoopbackPort();
    const app = createHostDeckFastifyApp({
      observeInternalError: () => undefined,
      requestAuthenticationPolicy: authentication,
      requestTrustPolicy: createHostDeckRequestTrustPolicy({
        allowedOrigins: [`http://127.0.0.1:${port}`],
        mode: "loopback",
        transport: "http"
      }),
      resourceBudget: defaultResourceBudget,
      routePlugins: [route]
    });
    await app.listen({
      host: "127.0.0.1",
      port,
      listenTextResolver: () => ""
    });
    try {
      const address = app.server.address();
      if (address === null || typeof address === "string") {
        throw new Error("Vertical session-start listener is unavailable.");
      }
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const first = await runCli(
        [
          "--api-url",
          baseUrl,
          "start",
          "--name",
          name,
          "--cwd",
          projectDirectory,
          "--json"
        ],
        {
          env: {},
          createStartOperationId: () => operationId
        }
      );
      expect(first).toMatchObject({ exitCode: cliExitCodes.ok, stderr: "" });
      expect(JSON.parse(first.stdout)).toMatchObject({
        operation_id: operationId,
        session: {
          id: "sess_start_vertical_001",
          name,
          codex_thread_id: "thread-start-vertical-001",
          cwd: projectDirectory,
          runtime_source: "codex_app_server",
          runtime_version: runtimeVersion
        }
      });
      expect(threadFixture.startCalls()).toEqual([
        { operation_id: operationId, cwd: projectDirectory }
      ]);
      expect(states.require("sess_start_vertical_001")).toMatchObject({
        mapping: {
          name,
          codex_thread_id: "thread-start-vertical-001",
          disposition: "selected"
        },
        projection: { session: { name, freshness: "current" } }
      });
      expect(states.listRecoveries()).toEqual([]);
      expect(audits.require(operationId)).toMatchObject({
        state: "terminal",
        records: [
          { phase: "accepted", outcome: "accepted", action: "session_start" },
          { phase: "terminal", outcome: "succeeded", action: "session_start" }
        ]
      });

      const repeated = await runCli(
        ["--api-url", baseUrl, "start", "--name", name, "--cwd", projectDirectory],
        { env: {}, createStartOperationId: () => operationId }
      );
      expect(repeated).toMatchObject({
        exitCode: cliExitCodes.apiError,
        stdout: ""
      });
      expect(repeated.stderr).toContain("requires recovery before another attempt");
      expect(threadFixture.startCalls()).toHaveLength(1);
    } finally {
      await app.close();
      if (open.db.open) open.db.close();
    }
  });
});

type ThreadClient = Parameters<
  typeof createManagedCodexThreadService
>[0]["threads"];
type ThreadRecord = Awaited<ReturnType<ThreadClient["read"]>>;

function createThreadFixture(cwd: string): {
  readonly client: ThreadClient;
  readonly startCalls: () => readonly unknown[];
} {
  const records: ThreadRecord[] = [];
  const starts: unknown[] = [];
  const client: ThreadClient = {
    runtime_version: runtimeVersion,
    async start(input) {
      starts.push(input);
      const thread = threadRecord(cwd, {
        thread_source: `hostdeck:${input.operation_id}`
      });
      records.push(thread);
      return { thread, model: "gpt-5.5-codex" };
    },
    async ensureMaterialized(input) {
      const index = records.findIndex((record) => record.id === input.thread_id);
      const current = records[index];
      if (current === undefined) throw new Error("Vertical thread is missing.");
      const next: ThreadRecord = {
        ...current,
        name: input.name,
        thread_source: null,
        archived: false
      };
      records[index] = next;
      return next;
    },
    async list(input) {
      return {
        data: records.filter((record) => record.archived === input.archived),
        next_cursor: null
      };
    },
    async listAll() {
      return [...records];
    },
    async findByOperationId(candidate) {
      return records.filter(
        (record) => record.thread_source === `hostdeck:${candidate}`
      );
    },
    async read(threadId) {
      const record = records.find((candidate) => candidate.id === threadId);
      if (record === undefined) throw new Error("Vertical thread is missing.");
      return record;
    },
    async archive(threadId) {
      const index = records.findIndex((candidate) => candidate.id === threadId);
      const current = records[index];
      if (current === undefined) throw new Error("Vertical thread is missing.");
      records[index] = { ...current, archived: true };
    }
  };
  return { client, startCalls: () => [...starts] };
}

function threadRecord(
  cwd: string,
  overrides: Partial<ThreadRecord> = {}
): ThreadRecord {
  return {
    id: "thread-start-vertical-001",
    cwd,
    created_at: at,
    updated_at: at,
    status: "idle",
    active_flags: [],
    source: "app_server",
    thread_source: null,
    model_provider: "openai",
    name: null,
    preview: "",
    archived: false,
    ...overrides
  } as ThreadRecord;
}

function runtimeCompatibility() {
  return runtimeCompatibilitySchema.parse({
    source: "codex_app_server",
    state: "ready",
    mutation_policy: "allowed",
    observed_version: runtimeVersion,
    binding_id: "binding-session-start-vertical-001",
    capabilities: capabilities.map((capability) => ({
      name: capability,
      state: "available",
      reason: null
    })),
    checked_at: at,
    reason: null
  });
}

function settings() {
  return {
    id: "hostdeck_settings" as const,
    schema_version: 1,
    state_dir: "/tmp/hostdeck-vertical-state",
    bind_mode: "localhost" as const,
    bind_host: "127.0.0.1",
    bind_port: 3777,
    lan_enabled: false,
    locked: false,
    retention: { ...defaultRetentionPolicy },
    updated_at: at
  };
}

function availableLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close(() => reject(new Error("Could not reserve a loopback port.")));
        return;
      }
      server.close((error) => {
        if (error === undefined) resolve(address.port);
        else reject(error);
      });
    });
  });
}
