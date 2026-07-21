import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cliExitCodes, runCli } from "../packages/cli/src/index.js";
import type {
  CodexCompactAccepted,
  CodexCompactClient,
  CodexCompactInput,
  NormalizedCodexEvent
} from "../packages/codex-adapter/src/index.js";
import {
  defaultResourceBudget,
  runtimeCompatibilitySchema,
  type SelectedSessionProjectionRecord,
  selectedSessionMappingRecordSchema,
  selectedSessionProjectionRecordSchema
} from "../packages/contracts/src/index.js";
import { runtimeCapabilities } from "../packages/core/src/index.js";
import {
  createCodexCompactControlService,
  createHostDeckCompactRouteRegistration,
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
const requestedAt = "2026-07-16T15:00:00.000Z";
const acceptedAt = "2026-07-16T15:00:01.000Z";
const auditTimestamp = "2026-07-16T15:00:02.000Z";
const runtimeVersion = "0.144.0";
const connectionGeneration = 7;
const sessionId = "sess_compact_vertical_001";
const threadId = "thread-compact-vertical-001";
const secondSessionId = "sess_compact_vertical_002";
const secondThreadId = "thread-compact-vertical-002";
const operationId = "op_compact_vertical_001";
const turnId = "turn-compact-vertical-001";
const itemId = "item-compact-vertical-001";

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

describe("managed-session compact selected vertical", () => {
  it("reads, starts once, observes authoritative progress, isolates, and deduplicates through production", async () => {
    const directory = mkdtempSync(join(tmpdir(), "hostdeck-compact-vertical-"));
    directories.push(directory);
    const open = openMigratedDatabase(join(directory, "hostdeck.sqlite"), {
      now: () => new Date(requestedAt)
    });
    const states = createSelectedStateRepository(open.db);
    states.create(activeState(sessionId, threadId, "compact-vertical-one"));
    states.create(activeState(secondSessionId, secondThreadId, "compact-vertical-two"));
    const runtimeCompact = new VerticalCompactClient();
    const compactService = createCodexCompactControlService({
      compact: runtimeCompact,
      states,
      now: () => requestedAt
    });
    const auditRepository = createSelectedAuditRepository(open.db);
    let auditRecord = 0;
    const audit = createHostDeckSelectedWriteAuditExecutor({
      repository: auditRepository,
      now: () => auditTimestamp,
      create_record_id: () => `audit_compact_vertical_${++auditRecord}`
    });
    const csrf = createHostDeckCsrfPolicy({
      csrf: {
        authorizeBrowserWrite() {
          throw new Error("Loopback compact vertical must not authorize browser CSRF.");
        },
        rotateBootstrap() {
          throw new Error("Loopback compact vertical must not rotate browser CSRF.");
        }
      },
      now: () => new Date(auditTimestamp)
    });
    const lock = createHostDeckHostLockPolicy({
      settings: {
        read: () => settings(),
        transition() {
          throw new Error("Compact vertical must not transition host lock.");
        }
      },
      now: () => new Date(auditTimestamp)
    });
    const registration = createHostDeckCompactRouteRegistration({
      admission: createHostDeckSelectedWriteAdmissionPolicy({
        resourceBudget: defaultResourceBudget,
        now: () => performance.now()
      }),
      audit,
      compact: { compact: compactService.compact, snapshot: compactService.snapshot },
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
          throw new Error("Loopback compact vertical must not authenticate a device.");
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
      if (address === null || typeof address === "string") throw new Error("Compact vertical listener is unavailable.");
      const apiUrl = `http://127.0.0.1:${address.port}`;
      const baseArgs = ["--api-url", apiUrl, "compact", sessionId] as const;

      const absent = await runCli([...baseArgs, "--json"], { env: {} });
      expect(absent).toMatchObject({ exitCode: cliExitCodes.ok, stderr: "" });
      expect(JSON.parse(absent.stdout)).toEqual({ progress: null });

      const accepted = await runCli([...baseArgs, "--confirm", "--json"], {
        env: {},
        createCompactOperationId: () => operationId
      });
      expect(accepted).toMatchObject({ exitCode: cliExitCodes.ok, stderr: "" });
      expect(JSON.parse(accepted.stdout)).toMatchObject({
        progress: {
          operation_id: operationId,
          kind: "compact",
          target: { session_id: sessionId, codex_thread_id: threadId },
          state: "accepted",
          turn_id: null,
          error: null
        }
      });
      expect(runtimeCompact.calls).toHaveLength(1);
      expect(runtimeCompact.calls[0]).toMatchObject({ operation_id: operationId, thread_id: threadId });
      expect(runtimeCompact.calls[0]?.signal).toBeInstanceOf(AbortSignal);

      const second = await runCli(["--api-url", apiUrl, "compact", secondSessionId, "--json"], { env: {} });
      expect(second).toMatchObject({ exitCode: cliExitCodes.ok, stderr: "" });
      expect(JSON.parse(second.stdout)).toEqual({ progress: null });

      await compactService.observe(turnStarted(1), connectionGeneration);
      await compactService.observe(compactionItem("started", 2), connectionGeneration);
      const running = await runCli([...baseArgs, "--json"], { env: {} });
      expect(running).toMatchObject({ exitCode: cliExitCodes.ok, stderr: "" });
      expect(JSON.parse(running.stdout)).toMatchObject({
        progress: { operation_id: operationId, state: "running", turn_id: turnId, error: null }
      });

      await compactService.observe(compactionItem("completed", 3), connectionGeneration);
      await compactService.observe(turnCompleted(4), connectionGeneration);
      const completed = await runCli([...baseArgs, "--json"], { env: {} });
      expect(completed).toMatchObject({ exitCode: cliExitCodes.ok, stderr: "" });
      expect(JSON.parse(completed.stdout)).toMatchObject({
        progress: { operation_id: operationId, state: "completed", turn_id: turnId, error: null }
      });
      expect(compactService.active_count).toBe(0);
      expect(compactService.tracked_count).toBe(1);

      expect(auditRepository.require(operationId)).toMatchObject({
        state: "terminal",
        records: [
          {
            phase: "accepted",
            outcome: "accepted",
            action: "compact",
            payload_summary: { schema_version: 1, confirmed: true }
          },
          {
            phase: "terminal",
            outcome: "succeeded",
            payload_summary: { schema_version: 1, accepted: true }
          }
        ]
      });

      const duplicate = await runCli([...baseArgs, "--confirm", "--json"], {
        env: {},
        createCompactOperationId: () => operationId
      });
      expect(duplicate).toMatchObject({ exitCode: cliExitCodes.ok, stderr: "" });
      expect(duplicate.stdout).toBe(accepted.stdout);
      expect(runtimeCompact.calls).toHaveLength(1);
      expect(auditRepository.require(operationId).records).toHaveLength(2);

      const afterDuplicate = await runCli([...baseArgs, "--json"], { env: {} });
      expect(JSON.parse(afterDuplicate.stdout)).toMatchObject({ progress: { state: "completed" } });
      expect(states.require(sessionId).projection.session.turn_state).toBe("idle");
      expect(states.require(secondSessionId).projection.session.turn_state).toBe("idle");

      const rawAudit = open.db
        .prepare("SELECT record_json FROM selected_audit_events ORDER BY operation_id, phase")
        .all() as readonly { readonly record_json: string }[];
      const raw = rawAudit.map((row) => row.record_json).join("\n");
      expect(raw).not.toMatch(/private-compact|contextCompaction|thread\/compact\/start|\/compact|token/iu);
      expect(raw.match(/thread-compact-vertical-001/gu)).toHaveLength(2);
    } finally {
      await app.close();
      if (open.db.open) open.db.close();
    }
  });
});

class VerticalCompactClient implements CodexCompactClient {
  readonly runtime_version = runtimeVersion;
  readonly connection_generation = connectionGeneration;
  readonly calls: CodexCompactInput[] = [];

  async compactThread(input: CodexCompactInput): Promise<CodexCompactAccepted> {
    this.calls.push({ ...input });
    return {
      runtime_version: runtimeVersion,
      connection_generation: connectionGeneration,
      thread_id: input.thread_id as CodexCompactAccepted["thread_id"],
      state: "accepted",
      accepted_at: acceptedAt as CodexCompactAccepted["accepted_at"]
    };
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
    created_at: requestedAt,
    updated_at: requestedAt,
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
      updated_at: requestedAt,
      last_activity_at: requestedAt,
      branch: "main",
      model: "runtime-a",
      goal: null,
      recent_summary: "Managed Codex compact session ready.",
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
    binding_id: "binding-compact-vertical-001",
    capabilities: runtimeCapabilities.map((name) => ({ name, state: "available", reason: null })),
    checked_at: requestedAt,
    reason: null
  });
}

function settings() {
  return Object.freeze({
    locked: false,
    settings_updated_at: requestedAt
  });
}

function turnStarted(sequence: number): NormalizedCodexEvent {
  return {
    sequence,
    method: "turn/started",
    captured_at: eventTime(sequence),
    upstream_at: null,
    codex_event_id: `${turnId}:started`,
    scope: "thread",
    thread_id: threadId,
    turn_id: turnId,
    status: "in_progress"
  } as NormalizedCodexEvent;
}

function compactionItem(lifecycle: "completed" | "started", sequence: number): NormalizedCodexEvent {
  return {
    sequence,
    method: lifecycle === "started" ? "item/started" : "item/completed",
    captured_at: eventTime(sequence),
    upstream_at: null,
    codex_event_id: `${itemId}:${lifecycle}`,
    scope: "thread",
    thread_id: threadId,
    turn_id: turnId,
    item: {
      id: itemId,
      category: "compaction",
      state: lifecycle,
      title: "Context compaction",
      text: null,
      content_state: "complete",
      content_notice: null
    }
  } as NormalizedCodexEvent;
}

function turnCompleted(sequence: number): NormalizedCodexEvent {
  return {
    sequence,
    method: "turn/completed",
    captured_at: eventTime(sequence),
    upstream_at: null,
    codex_event_id: `${turnId}:completed`,
    scope: "thread",
    thread_id: threadId,
    turn_id: turnId,
    status: "completed",
    error_message: null
  } as NormalizedCodexEvent;
}

function eventTime(sequence: number): string {
  return new Date(Date.parse(acceptedAt) + sequence * 1_000).toISOString();
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
