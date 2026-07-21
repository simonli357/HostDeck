import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cliExitCodes, runCli } from "../packages/cli/src/index.js";
import {
  absoluteCwdSchema,
  codexThreadIdSchema,
  defaultResourceBudget,
  isoTimestampSchema,
  runtimeCompatibilitySchema,
  selectedSessionMappingRecordSchema,
  selectedSessionProjectionRecordSchema
} from "../packages/contracts/src/index.js";
import {
  createHostDeckCsrfPolicy,
  createHostDeckFastifyApp,
  createHostDeckHostLockPolicy,
  createHostDeckRequestAuthenticationPolicy,
  createHostDeckRequestTrustPolicy,
  createHostDeckSelectedWriteAdmissionPolicy,
  createHostDeckSelectedWriteAuditExecutor,
  createHostDeckSessionArchiveRouteRegistration,
  createManagedCodexThreadService
} from "../packages/server/src/index.js";
import {
  createSelectedAuditRepository,
  createSelectedStateRepository,
  openMigratedDatabase
} from "../packages/storage/src/index.js";

const directories: string[] = [];
const timestamp = "2026-07-15T21:00:00.000Z";
const archiveTimestamp = "2026-07-15T21:00:01.000Z";
const runtimeVersion = "0.144.0";
const sessionId = "sess_archive_vertical_001";
const threadId = "thread-archive-vertical-001";
const operationId = "op_session_archive_vertical_001";
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

type ManagedThreads = Parameters<typeof createManagedCodexThreadService>[0]["threads"];
type CodexThreadRecord = Awaited<ReturnType<ManagedThreads["read"]>>;

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("managed-session archive selected vertical", () => {
  it("persists one CLI-to-Codex archive with correlated accepted and terminal audit", async () => {
    const directory = mkdtempSync(join(tmpdir(), "hostdeck-archive-vertical-"));
    directories.push(directory);
    const open = openMigratedDatabase(join(directory, "hostdeck.sqlite"), {
      now: () => new Date(timestamp)
    });
    const states = createSelectedStateRepository(open.db);
    states.create(activeState());
    const threads = new VerticalThreadClient();
    const sessions = createManagedCodexThreadService({
      threads,
      states,
      now: () => new Date(archiveTimestamp)
    });
    const auditRepository = createSelectedAuditRepository(open.db);
    let auditRecord = 0;
    const audit = createHostDeckSelectedWriteAuditExecutor({
      repository: auditRepository,
      now: () => archiveTimestamp,
      create_record_id: () => `audit_archive_vertical_${++auditRecord}`
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
      now: () => new Date(archiveTimestamp)
    });
    const lock = createHostDeckHostLockPolicy({
      settings: {
        read: () => settings(),
        transition() {
          throw new Error("Archive vertical must not transition host lock.");
        }
      },
      now: () => new Date(archiveTimestamp)
    });
    const registration = createHostDeckSessionArchiveRouteRegistration({
      admission: createHostDeckSelectedWriteAdmissionPolicy({
        resourceBudget: defaultResourceBudget,
        now: () => performance.now()
      }),
      audit,
      csrf,
      lock,
      runtime: { read: () => runtime() },
      sessions: {
        read: (candidate) => sessions.read(candidate),
        archive: (candidate, deadline) => sessions.archive(candidate, deadline)
      },
      subscribers: {
        archive_session: () => 0
      }
    });
    const port = await availableLoopbackPort();
    const app = createHostDeckFastifyApp({
      observeInternalError: () => undefined,
      requestAuthenticationPolicy: createHostDeckRequestAuthenticationPolicy({
        authenticateDeviceToken: () => {
          throw new Error("Loopback vertical must not authenticate a device.");
        },
        now: () => new Date(archiveTimestamp)
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
        throw new Error("Archive vertical listener is unavailable.");
      }
      const result = await runCli(
        [
          "--api-url",
          `http://127.0.0.1:${address.port}`,
          "archive",
          sessionId,
          "--json"
        ],
        {
          env: {},
          createArchiveOperationId: () => operationId
        }
      );

      expect(result).toMatchObject({ exitCode: cliExitCodes.ok, stderr: "" });
      expect(JSON.parse(result.stdout)).toMatchObject({
        operation_id: operationId,
        kind: "archive",
        target: {
          type: "managed_session",
          session_id: sessionId,
          codex_thread_id: threadId
        },
        state: "accepted",
        audit_record_id: "audit_archive_vertical_1"
      });
      expect(threads.archiveCalls).toEqual([threadId]);
      expect(states.require(sessionId)).toMatchObject({
        mapping: { id: sessionId, codex_thread_id: threadId, archived_at: archiveTimestamp },
        projection: {
          session: {
            id: sessionId,
            codex_thread_id: threadId,
            session_state: "archived",
            turn_state: "idle",
            freshness: "current",
            archived_at: archiveTimestamp
          },
          retained_event_count: 0,
          retained_event_bytes: 0
        }
      });
      expect(auditRepository.require(operationId)).toMatchObject({
        state: "terminal",
        records: [
          {
            id: "audit_archive_vertical_1",
            phase: "accepted",
            outcome: "accepted",
            payload_summary: { schema_version: 1, confirmed: true }
          },
          {
            id: "audit_archive_vertical_2",
            phase: "terminal",
            outcome: "succeeded",
            payload_summary: { schema_version: 1, archived: true }
          }
        ]
      });
    } finally {
      await app.close();
      if (open.db.open) open.db.close();
    }
  });
});

class VerticalThreadClient implements ManagedThreads {
  readonly runtime_version = runtimeVersion;
  readonly archiveCalls: string[] = [];
  private thread: CodexThreadRecord = threadRecord(false);

  async start(
    _input: Parameters<ManagedThreads["start"]>[0]
  ): ReturnType<ManagedThreads["start"]> {
    throw new Error("Archive vertical must not start a thread.");
  }

  async ensureMaterialized(
    _input: Parameters<ManagedThreads["ensureMaterialized"]>[0]
  ): ReturnType<ManagedThreads["ensureMaterialized"]> {
    throw new Error("Archive vertical must not materialize a thread.");
  }

  async list(
    input: Parameters<ManagedThreads["list"]>[0]
  ): ReturnType<ManagedThreads["list"]> {
    return {
      data: this.thread.archived === input.archived ? [this.thread] : [],
      next_cursor: null
    };
  }

  async listAll(): Promise<readonly CodexThreadRecord[]> {
    return [this.thread];
  }

  async findByOperationId(_operationId: string): Promise<readonly CodexThreadRecord[]> {
    return [];
  }

  async read(candidate: string): Promise<CodexThreadRecord> {
    if (candidate !== this.thread.id) throw new Error("Unexpected archive thread read.");
    return this.thread;
  }

  async archive(candidate: string): Promise<void> {
    if (candidate !== this.thread.id) throw new Error("Unexpected archive target.");
    this.archiveCalls.push(candidate);
    this.thread = threadRecord(true);
  }
}

function activeState() {
  const mapping = selectedSessionMappingRecordSchema.parse({
    id: sessionId,
    name: "archive-vertical",
    codex_thread_id: threadId,
    cwd: "/tmp/hostdeck-archive-vertical",
    runtime_source: "codex_app_server",
    runtime_version: runtimeVersion,
    disposition: "selected",
    created_at: timestamp,
    updated_at: timestamp,
    archived_at: null
  });
  const projection = selectedSessionProjectionRecordSchema.parse({
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

function threadRecord(archived: boolean): CodexThreadRecord {
  return {
    id: codexThreadIdSchema.parse(threadId),
    cwd: absoluteCwdSchema.parse("/tmp/hostdeck-archive-vertical"),
    created_at: isoTimestampSchema.parse(timestamp),
    updated_at: isoTimestampSchema.parse(archived ? archiveTimestamp : timestamp),
    status: "idle",
    active_flags: [],
    source: "app_server",
    thread_source: null,
    model_provider: "openai",
    name: "archive-vertical",
    preview: "",
    archived
  };
}

function runtime() {
  return runtimeCompatibilitySchema.parse({
    source: "codex_app_server",
    state: "ready",
    mutation_policy: "allowed",
    observed_version: runtimeVersion,
    binding_id: "binding-archive-vertical-001",
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
