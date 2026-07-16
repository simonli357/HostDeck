import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cliExitCodes, runCli } from "../packages/cli/src/index.js";
import type {
  CodexGoalClient,
  CodexGoalMutationStatus,
  CodexThreadGoal
} from "../packages/codex-adapter/src/index.js";
import {
  codexThreadIdSchema,
  defaultResourceBudget,
  defaultRetentionPolicy,
  managedSessionTargetSchema,
  runtimeCompatibilitySchema,
  type SelectedSessionProjectionRecord,
  selectedSessionMappingRecordSchema,
  selectedSessionProjectionRecordSchema
} from "../packages/contracts/src/index.js";
import {
  createCodexGoalControlService,
  createHostDeckCsrfPolicy,
  createHostDeckFastifyApp,
  createHostDeckGoalRouteRegistration,
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
const timestamp = "2026-07-16T05:00:00.000Z";
const mutationTimestamp = "2026-07-16T05:00:02.000Z";
const auditTimestamp = "2026-07-16T05:00:01.000Z";
const runtimeVersion = "0.144.0";
const sessionId = "sess_goal_vertical_001";
const threadId = "thread-goal-vertical-001";
const secondSessionId = "sess_goal_vertical_002";
const secondThreadId = "thread-goal-vertical-002";
const objective = "Deliver HostDeck V1.";
const setOperationId = "op_goal_vertical_set";
const noOpOperationId = "op_goal_vertical_noop";
const resumeOperationId = "op_goal_vertical_resume";
const initialRevision = "a".repeat(64);
const resumedRevision = "b".repeat(64);
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

describe("managed-session goal selected vertical", () => {
  it("reads, sets, proves no-op, and accepts resume through CLI, API, audit, service, and SQLite", async () => {
    const directory = mkdtempSync(join(tmpdir(), "hostdeck-goal-vertical-"));
    directories.push(directory);
    const open = openMigratedDatabase(join(directory, "hostdeck.sqlite"), {
      now: () => new Date(timestamp)
    });
    const states = createSelectedStateRepository(open.db);
    states.create(activeState(sessionId, threadId, "goal-vertical-one"));
    states.create(activeState(secondSessionId, secondThreadId, "goal-vertical-two"));
    const runtimeGoals = new VerticalGoalClient();
    const pendingReads: unknown[] = [];
    const goalService = createCodexGoalControlService({
      goals: runtimeGoals,
      states,
      pending_settings: {
        readPendingSettings(target) {
          pendingReads.push(target);
          return [];
        }
      },
      now: () => mutationTimestamp
    });
    const auditRepository = createSelectedAuditRepository(open.db);
    let auditRecord = 0;
    const audit = createHostDeckSelectedWriteAuditExecutor({
      repository: auditRepository,
      now: () => auditTimestamp,
      create_record_id: () => `audit_goal_vertical_${++auditRecord}`
    });
    const csrf = createHostDeckCsrfPolicy({
      csrf: {
        authorizeBrowserWrite() {
          throw new Error("Loopback goal vertical must not authorize browser CSRF.");
        },
        rotateBootstrap() {
          throw new Error("Loopback goal vertical must not rotate browser CSRF.");
        }
      },
      now: () => new Date(auditTimestamp)
    });
    const lock = createHostDeckHostLockPolicy({
      settings: {
        read: () => settings(),
        transition() {
          throw new Error("Goal vertical must not transition host lock.");
        }
      },
      now: () => new Date(auditTimestamp)
    });
    const registration = createHostDeckGoalRouteRegistration({
      admission: createHostDeckSelectedWriteAdmissionPolicy({
        resourceBudget: defaultResourceBudget,
        now: () => performance.now()
      }),
      audit,
      csrf,
      goals: {
        mutate: goalService.mutate,
        snapshot: goalService.snapshot
      },
      lock,
      runtime: { read: () => runtime() },
      state: { get: (candidate) => states.get(candidate) }
    });
    const port = await availableLoopbackPort();
    const app = createHostDeckFastifyApp({
      observeInternalError: () => undefined,
      requestAuthenticationPolicy: createHostDeckRequestAuthenticationPolicy({
        authenticateDeviceToken: () => {
          throw new Error("Loopback goal vertical must not authenticate a device.");
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
        throw new Error("Goal vertical listener is unavailable.");
      }
      const api = ["--api-url", `http://127.0.0.1:${address.port}`] as const;
      const baseArgs = [...api, "goal", sessionId] as const;
      const read = await runCli([...baseArgs, "--json"], { env: {} });
      expect(read).toMatchObject({ exitCode: cliExitCodes.ok, stderr: "" });
      expect(JSON.parse(read.stdout)).toEqual({ goal: null, uncertain_mutation: null });

      const setArgs = [...baseArgs, "set", "--objective", objective, "--json"] as const;
      const set = await runCli(setArgs, {
        env: {},
        createGoalOperationId: () => setOperationId
      });
      expect(set).toMatchObject({ exitCode: cliExitCodes.ok, stderr: "" });
      expect(JSON.parse(set.stdout)).toMatchObject({
        goal: {
          revision: initialRevision,
          objective,
          status: "paused"
        },
        uncertain_mutation: null
      });
      expect(runtimeGoals.setPausedCalls).toEqual([{ thread_id: threadId, objective }]);
      expect(runtimeGoals.setStatusCalls).toEqual([]);

      const noOp = await runCli(
        [...baseArgs, "set", "--objective", objective, "--expected-revision", initialRevision],
        {
          env: {},
          createGoalOperationId: () => noOpOperationId
        }
      );
      expect(noOp).toMatchObject({ exitCode: cliExitCodes.ok, stderr: "" });
      expect(noOp.stdout).toContain("already matches the requested paused objective");
      expect(runtimeGoals.setPausedCalls).toHaveLength(1);

      const resume = await runCli(
        [...baseArgs, "resume", "--expected-revision", initialRevision],
        {
          env: {},
          createGoalOperationId: () => resumeOperationId
        }
      );
      expect(resume).toMatchObject({ exitCode: cliExitCodes.ok, stderr: "" });
      expect(resume.stdout).toContain("Goal resume accepted.");
      expect(resume.stdout).not.toMatch(/running|completed/iu);
      expect(runtimeGoals.setStatusCalls).toEqual([{ thread_id: threadId, status: "active" }]);
      expect(pendingReads).toEqual([selectedTarget]);

      const secondRead = await runCli([...api, "goal", secondSessionId, "--json"], { env: {} });
      expect(secondRead).toMatchObject({ exitCode: cliExitCodes.ok, stderr: "" });
      expect(JSON.parse(secondRead.stdout)).toEqual({ goal: null, uncertain_mutation: null });
      expect(runtimeGoals.current(secondThreadId)).toBeNull();
      expect(await goalService.snapshot(secondTarget)).toEqual({ goal: null, uncertain_mutation: null });
      expect(states.require(sessionId).projection.session.turn_state).toBe("idle");
      expect(states.require(secondSessionId).projection.session.turn_state).toBe("idle");

      expect(auditRepository.require(setOperationId)).toMatchObject({
        state: "terminal",
        records: [
          {
            id: "audit_goal_vertical_1",
            phase: "accepted",
            outcome: "accepted",
            action: "goal",
            payload_summary: {
              schema_version: 1,
              goal_action: "set",
              objective_length: objective.length,
              expected_revision_present: false
            }
          },
          {
            id: "audit_goal_vertical_2",
            phase: "terminal",
            outcome: "succeeded",
            payload_summary: { schema_version: 1, changed: true }
          }
        ]
      });
      expect(auditRepository.require(noOpOperationId).records[1]).toMatchObject({
        outcome: "succeeded",
        payload_summary: { schema_version: 1, changed: false }
      });
      expect(auditRepository.require(resumeOperationId).records[1]).toMatchObject({
        outcome: "succeeded",
        payload_summary: { schema_version: 1, changed: true }
      });
      const rawAudit = open.db
        .prepare("SELECT record_json FROM selected_audit_events WHERE action = 'goal' ORDER BY rowid")
        .all() as readonly { readonly record_json: string }[];
      const raw = rawAudit.map((row) => row.record_json).join("\n");
      expect(raw).not.toContain(objective);
      expect(raw).not.toMatch(/binding-goal|private-goal|\/goal|thread\/goal|turn\/start/iu);
      expect(raw.match(/thread-goal-vertical-001/gu)).toHaveLength(6);

      const duplicate = await runCli(setArgs, {
        env: {},
        createGoalOperationId: () => setOperationId
      });
      expect(duplicate).toMatchObject({ exitCode: cliExitCodes.ok, stderr: "" });
      expect(duplicate.stdout).toBe(set.stdout);
      expect(runtimeGoals.setPausedCalls).toHaveLength(1);
      expect(runtimeGoals.setStatusCalls).toHaveLength(1);
      expect(auditRepository.require(setOperationId).records).toHaveLength(2);
      expect(goalService.uncertain_count).toBe(0);
      expect(runtimeGoals.current(threadId)).toMatchObject({
        revision: resumedRevision,
        objective,
        status: "active"
      });
    } finally {
      await app.close();
      if (open.db.open) open.db.close();
    }
  });
});

class VerticalGoalClient implements CodexGoalClient {
  readonly runtime_version = runtimeVersion;
  readonly readCalls: string[] = [];
  readonly setPausedCalls: Array<{ readonly objective: string; readonly thread_id: string }> = [];
  readonly setStatusCalls: Array<{ readonly status: CodexGoalMutationStatus; readonly thread_id: string }> = [];
  readonly clearCalls: string[] = [];
  private readonly goals = new Map<string, CodexThreadGoal>();

  current(thread: string): CodexThreadGoal | null {
    const goal = this.goals.get(thread);
    return goal === undefined ? null : { ...goal };
  }

  async read(thread: string): Promise<CodexThreadGoal | null> {
    this.readCalls.push(thread);
    return this.current(thread);
  }

  async setPaused(thread: string, nextObjective: string): Promise<CodexThreadGoal> {
    this.setPausedCalls.push({ thread_id: thread, objective: nextObjective });
    const next = this.nextGoal(thread, { objective: nextObjective, status: "paused" });
    this.goals.set(thread, next);
    return { ...next };
  }

  async setStatus(thread: string, status: CodexGoalMutationStatus): Promise<CodexThreadGoal> {
    this.setStatusCalls.push({ thread_id: thread, status });
    const current = this.goals.get(thread);
    if (current === undefined) throw new Error("Vertical goal is missing.");
    const next = this.nextGoal(thread, { objective: current.objective, status });
    this.goals.set(thread, next);
    return { ...next };
  }

  async clear(thread: string): Promise<boolean> {
    this.clearCalls.push(thread);
    return this.goals.delete(thread);
  }

  private nextGoal(
    thread: string,
    input: { readonly objective: string; readonly status: CodexGoalMutationStatus }
  ): CodexThreadGoal {
    const current = this.goals.get(thread);
    return {
      thread_id: codexThreadIdSchema.parse(thread),
      revision: current === undefined ? initialRevision : resumedRevision,
      objective: input.objective,
      status: input.status,
      token_budget: null,
      tokens_used: current?.tokens_used ?? 0,
      time_used_seconds: current?.time_used_seconds ?? 0,
      created_at: current?.created_at ?? (timestamp as never),
      updated_at: mutationTimestamp as never
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
    binding_id: "binding-goal-vertical-001",
    capabilities: runtimeCapabilities.map((name) => ({ name, state: "available", reason: null })),
    checked_at: timestamp,
    reason: null
  });
}

function settings() {
  return {
    id: "hostdeck_settings" as const,
    schema_version: 1,
    state_dir: "/tmp/hostdeck-goal-vertical-state",
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
