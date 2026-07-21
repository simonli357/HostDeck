import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultResourceBudget,
  type GoalControlSnapshot,
  type GoalControlValue,
  goalControlSnapshotSchema,
  goalControlValueSchema,
  type RuntimeCompatibility,
  runtimeCompatibilitySchema,
  selectedSessionMappingRecordSchema,
  selectedSessionProjectionRecordSchema
} from "@hostdeck/contracts";
import { type OperationDeadline, runtimeCapabilities } from "@hostdeck/core";
import {
  createSelectedAuditRepository,
  openMigratedDatabase,
  type SelectedAuditRepository,
  type SelectedSessionState
} from "@hostdeck/storage";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CodexGoalControlErrorCode,
  type CodexGoalControlOutcome,
  HostDeckCodexGoalControlError
} from "./codex-goal-control-service.js";
import { createHostDeckCsrfPolicy } from "./csrf-routes.js";
import {
  createHostDeckFastifyApp,
  type HostDeckFastifyInstance,
  type HostDeckRoutePluginRegistration
} from "./fastify-app.js";
import {
  hostDeckLoopbackTestAuthority,
  hostDeckLoopbackTestOrigin,
  injectHostDeckLoopback
} from "./fastify-loopback-test-request.js";
import { createHostDeckRequestAuthenticationPolicy } from "./fastify-request-authentication.js";
import { createHostDeckRequestTrustPolicy } from "./fastify-request-trust.js";
import {
  type CreateHostDeckGoalRouteRegistrationInput,
  createHostDeckGoalRouteRegistration,
  hostDeckGoalRouteRegistrationId
} from "./goal-routes.js";
import { createHostDeckHostLockPolicy } from "./host-lock-routes.js";
import { createHostDeckSelectedWriteAdmissionPolicy } from "./selected-write-admission-policy.js";
import { createHostDeckSelectedWriteAuditExecutor } from "./selected-write-audit-executor.js";

const temporaryDirectories: string[] = [];
const timestamp = "2026-07-16T04:00:00.000Z";
const runtimeVersion = "0.144.0";
const sessionId = "sess_goal_route_001";
const threadId = "thread-goal-route-001";
const objective = "Deliver HostDeck V1.";
const originalRevision = "a".repeat(64);
const changedRevision = "b".repeat(64);
const setRequest = Object.freeze({
  operation_id: "op_goal_route_001",
  kind: "goal" as const,
  action: "set" as const,
  objective,
  expected_goal_revision: null
});

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("selected managed-session goal routes", () => {
  it("requires exact composition and registers both manifest routes once", async () => {
    const harness = await createHarness();
    try {
      expect(harness.registration).toMatchObject({
        id: hostDeckGoalRouteRegistrationId,
        surface: "api"
      });
      expect(Object.isFrozen(harness.registration)).toBe(true);
      expect(() =>
        harness.registration.register(harness.app, {
          resourceBudget: defaultResourceBudget,
          surface: "api"
        })
      ).toThrow("already registered");

      let accessorCalls = 0;
      const accessor = Object.defineProperty({}, "audit", {
        enumerable: true,
        get() {
          accessorCalls += 1;
          throw new Error("private-goal-accessor");
        }
      });
      for (const candidate of [
        null,
        {},
        { ...harness.routeInput, extra: true },
        { ...harness.routeInput, admission: undefined },
        {
          ...harness.routeInput,
          admission: Object.freeze({ ...harness.routeInput.admission })
        },
        { ...harness.routeInput, audit: {} },
        { ...harness.routeInput, csrf: {} },
        { ...harness.routeInput, goals: {} },
        { ...harness.routeInput, goals: { ...harness.routeInput.goals, extra: true } },
        { ...harness.routeInput, lock: {} },
        { ...harness.routeInput, runtime: {} },
        { ...harness.routeInput, state: {} },
        accessor
      ]) {
        expect(() => createHostDeckGoalRouteRegistration(candidate as never)).toThrow();
      }
      expect(accessorCalls).toBe(0);
    } finally {
      await harness.close();
    }
  });

  it("reads once and sets one paused goal with exact target, signal, response, and audit truth", async () => {
    const harness = await createHarness();
    try {
      const read = await readGoal(harness);
      expect(read.statusCode, read.body).toBe(200);
      expect(read.headers["cache-control"]).toBe("no-store");
      expect(read.headers.pragma).toBe("no-cache");
      expect(read.json()).toEqual(goalSnapshot());
      expect(harness.snapshotCalls()).toEqual([managedTarget()]);
      expect(harness.snapshotSignalObserved()).toBe(true);

      const response = await mutateGoal(harness, setRequest);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json()).toEqual(goalSnapshot(goalValue({ revision: changedRevision })));
      expect(harness.mutateCalls()).toEqual([
        {
          operation_id: setRequest.operation_id,
          target: managedTarget(),
          kind: "goal",
          action: "set",
          objective,
          expected_goal_revision: null
        }
      ]);
      expect(harness.mutateThis()).toBeUndefined();
      expect(harness.mutateSignalObserved()).toBe(true);
      expect(harness.acceptedBeforeMutate()).toBe(true);
      expect(harness.auditRepository.require(setRequest.operation_id)).toMatchObject({
        state: "terminal",
        records: [
          {
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
            phase: "terminal",
            outcome: "succeeded",
            payload_summary: { schema_version: 1, changed: true }
          }
        ]
      });
      const raw = harness.rawAuditRecords(setRequest.operation_id).join("\n");
      expect(raw).not.toContain(objective);
      expect(raw).not.toMatch(/binding-goal|private-goal/iu);
      expect(raw.match(/thread-goal-route-001/gu)).toHaveLength(2);
    } finally {
      await harness.close();
    }
  });

  it("materializes every lifecycle action and only the documented no-op cases", async () => {
    const actionCases = [
      {
        action: "set" as const,
        objective,
        result: goalResult("set", true),
        status: "paused" as const
      },
      {
        action: "pause" as const,
        objective: null,
        result: goalResult("pause", true),
        status: "paused" as const
      },
      {
        action: "resume" as const,
        objective: null,
        result: goalResult("resume", true),
        status: "active" as const
      },
      {
        action: "complete" as const,
        objective: null,
        result: goalResult("complete", true),
        status: "complete" as const
      },
      {
        action: "clear" as const,
        objective: null,
        result: goalResult("clear", true),
        status: null
      }
    ];
    for (const candidate of actionCases) {
      const operationId = `op_goal_route_action_${candidate.action}`;
      const harness = await createHarness({ mutateResults: [candidate.result] });
      try {
        const response = await mutateGoal(harness, {
          operation_id: operationId,
          kind: "goal",
          action: candidate.action,
          objective: candidate.objective,
          expected_goal_revision: candidate.action === "set" ? null : originalRevision
        });
        expect(response.statusCode, response.body).toBe(200);
        const parsed = goalControlSnapshotSchema.parse(response.json());
        expect(parsed.uncertain_mutation).toBeNull();
        expect(parsed.goal?.status ?? null).toBe(candidate.status);
        expect(harness.auditRepository.require(operationId).records[1]).toMatchObject({
          outcome: "succeeded",
          payload_summary: { schema_version: 1, changed: true }
        });
        if (candidate.action === "resume") {
          expect(response.body).not.toMatch(/running|completed/iu);
        }
      } finally {
        await harness.close();
      }
    }

    for (const action of ["set", "pause", "complete"] as const) {
      const operationId = `op_goal_route_noop_${action}`;
      const harness = await createHarness({ mutateResults: [goalResult(action, false)] });
      try {
        const response = await mutateGoal(harness, {
          operation_id: operationId,
          kind: "goal",
          action,
          objective: action === "set" ? objective : null,
          expected_goal_revision: originalRevision
        });
        expect(response.statusCode, response.body).toBe(200);
        expect(goalControlSnapshotSchema.parse(response.json()).goal?.revision).toBe(originalRevision);
        expect(harness.auditRepository.require(operationId).records[1]).toMatchObject({
          outcome: "succeeded",
          payload_summary: { schema_version: 1, changed: false }
        });
      } finally {
        await harness.close();
      }
    }
  });

  it("rejects malformed input, adjacent methods and paths, query, and lock before goal access", async () => {
    const harness = await createHarness();
    try {
      for (const candidate of [
        { ...setRequest, target: managedTarget() },
        { ...setRequest, token_budget: 1_000 },
        { ...setRequest, status: "active" },
        { ...setRequest, objective: null },
        { ...setRequest, expected_goal_revision: "A".repeat(64) },
        { ...setRequest, action: "pause", objective, expected_goal_revision: originalRevision },
        { ...setRequest, action: "pause", objective: null, expected_goal_revision: null }
      ]) {
        expectStableError(await mutateGoal(harness, candidate), 400, "validation_error");
      }
      expectStableError(
        await injectHostDeckLoopback(harness.app, { method: "GET", url: `/api/v1/sessions/${sessionId}/goal?target=other` }),
        400,
        "validation_error"
      );
      expectStableError(
        await injectHostDeckLoopback(harness.app, {
          method: "GET",
          url: `/api/v1/sessions/${sessionId}/goal`,
          headers: { "content-length": "19", "content-type": "application/json" },
          payload: '{"unexpected":true}'
        }),
        400,
        "validation_error"
      );
      expectStableError(
        await injectHostDeckLoopback(harness.app, {
          method: "POST",
          url: `/api/v1/sessions/${sessionId}/goal?target=other`,
          payload: setRequest
        }),
        400,
        "validation_error"
      );
      expectStableError(
        await injectHostDeckLoopback(harness.app, { method: "HEAD", url: `/api/v1/sessions/${sessionId}/goal` }),
        405,
        "method_not_allowed"
      );
      expectStableError(
        await injectHostDeckLoopback(harness.app, { method: "PUT", url: `/api/v1/sessions/${sessionId}/goal` }),
        405,
        "method_not_allowed"
      );
      expectStableError(
        await injectHostDeckLoopback(harness.app, { method: "GET", url: `/api/v1/sessions/${sessionId}/goal/extra` }),
        404,
        "route_not_found"
      );
      expect(harness.stateReads()).toBe(0);
      expect(harness.snapshotCalls()).toEqual([]);
      expect(harness.mutateCalls()).toEqual([]);
    } finally {
      await harness.close();
    }

    const locked = await createHarness({ locked: true });
    try {
      expectStableError(
        await mutateGoal(locked, { ...setRequest, operation_id: "op_goal_route_locked" }),
        423,
        "host_locked"
      );
      expect(locked.stateReads()).toBe(0);
      expect(locked.mutateCalls()).toEqual([]);
    } finally {
      await locked.close();
    }
  });

  it("fails closed for invalid selected state and runtime admission while allowing degraded reads", async () => {
    const stateCases: readonly [string, readonly unknown[], number, string][] = [
      ["missing", [null], 404, "session_not_found"],
      ["archived", [selectedState("archived")], 409, "session_not_writable"],
      ["stale", [selectedState("stale")], 409, "stale_session"],
      ["recovery", [selectedState("recovery")], 409, "stale_session"],
      ["contradictory", [selectedState("contradictory")], 409, "stale_session"]
    ];
    for (const [label, states, status, code] of stateCases) {
      const harness = await createHarness({ stateResults: states });
      const operationId = `op_goal_route_state_${label}`;
      try {
        expectStableError(await mutateGoal(harness, { ...setRequest, operation_id: operationId }), status, code);
        expect(harness.runtimeReads()).toBe(0);
        expect(harness.mutateCalls()).toEqual([]);
        expect(harness.auditRepository.get(operationId)).toBeNull();
      } finally {
        await harness.close();
      }
    }

    const runtimeCases: readonly [string, unknown, number, string][] = [
      ["drift", runtimeCandidate({ version: "0.145.0" }), 409, "stale_session"],
      ["disconnected", runtimeCandidate({ state: "disconnected" }), 503, "runtime_unavailable"],
      [
        "incompatible",
        runtimeCandidate({ state: "incompatible", unavailableCapability: "turn_input" }),
        409,
        "incompatible_runtime"
      ],
      [
        "capability",
        runtimeCandidate({ state: "incompatible", unavailableCapability: "goal" }),
        409,
        "capability_unavailable"
      ],
      ["blocked", runtimeCandidate({ state: "degraded", mutationPolicy: "blocked" }), 409, "incompatible_runtime"]
    ];
    for (const [label, runtime, status, code] of runtimeCases) {
      const harness = await createHarness({ runtimeResults: [runtime] });
      const operationId = `op_goal_route_runtime_${label}`;
      try {
        expectStableError(
          await mutateGoal(harness, { ...setRequest, operation_id: operationId }),
          status,
          code,
          code === "runtime_unavailable"
        );
        expect(harness.mutateCalls()).toEqual([]);
        expect(harness.auditRepository.get(operationId)).toBeNull();
      } finally {
        await harness.close();
      }
    }

    const readBlocked = await createHarness({
      runtimeResults: [runtimeCandidate({ state: "degraded", mutationPolicy: "blocked" })]
    });
    try {
      expect((await readGoal(readBlocked)).statusCode).toBe(200);
    } finally {
      await readBlocked.close();
    }
  });

  it("brackets read and mutation identity plus runtime state around the service call", async () => {
    const readDrift = await createHarness({
      stateResults: [selectedState("active"), selectedState("contradictory")]
    });
    try {
      expectStableError(await readGoal(readDrift), 409, "stale_session");
      expect(readDrift.snapshotCalls()).toHaveLength(1);
    } finally {
      await readDrift.close();
    }

    const readRuntimeDrift = await createHarness({
      runtimeResults: [runtimeCandidate(), runtimeCandidate({ bindingId: "binding-goal-route-002" })]
    });
    try {
      expectStableError(await readGoal(readRuntimeDrift), 409, "incompatible_runtime");
    } finally {
      await readRuntimeDrift.close();
    }

    const preOperationId = "op_goal_route_premutate_drift";
    const pre = await createHarness({
      stateResults: [selectedState("active"), selectedState("contradictory")]
    });
    try {
      expectStableError(await mutateGoal(pre, { ...setRequest, operation_id: preOperationId }), 409, "stale_session");
      expect(pre.mutateCalls()).toEqual([]);
      expect(pre.auditRepository.require(preOperationId).records[1]).toMatchObject({
        outcome: "failed",
        error_code: "stale_session"
      });
    } finally {
      await pre.close();
    }

    const postOperationId = "op_goal_route_postmutate_drift";
    const post = await createHarness({
      runtimeResults: [
        runtimeCandidate(),
        runtimeCandidate(),
        runtimeCandidate({ bindingId: "binding-goal-route-002" })
      ]
    });
    try {
      expectStableError(
        await mutateGoal(post, { ...setRequest, operation_id: postOperationId }),
        409,
        "incompatible_runtime"
      );
      expect(post.mutateCalls()).toHaveLength(1);
      expect(post.auditRepository.require(postOperationId).records[1]).toMatchObject({
        outcome: "incomplete",
        error_code: "incompatible_runtime"
      });
    } finally {
      await post.close();
    }
  });

  it("maps typed service outcomes and rejects contradictory post-mutation state as incomplete", async () => {
    const errorCases: readonly [
      string,
      HostDeckCodexGoalControlError,
      number,
      string,
      "failed" | "incomplete",
      boolean
    ][] = [
      ["missing", goalServiceError("goal_missing", "validation_error"), 400, "validation_error", "failed", true],
      [
        "conflict",
        goalServiceError("operation_conflict", "operation_conflict", "remote_rejected"),
        409,
        "operation_conflict",
        "failed",
        true
      ],
      [
        "protocol",
        goalServiceError("runtime_protocol_error", "protocol_error"),
        502,
        "protocol_error",
        "failed",
        false
      ],
      [
        "timeout-not-sent",
        goalServiceError("operation_timeout", "operation_timeout"),
        504,
        "operation_timeout",
        "failed",
        false
      ],
      [
        "timeout-unknown",
        goalServiceError("operation_timeout", "operation_timeout", "unknown"),
        504,
        "operation_timeout",
        "incomplete",
        false
      ],
      [
        "unknown",
        goalServiceError("unknown_outcome", "unknown_error", "unknown"),
        409,
        "unknown_error",
        "incomplete",
        false
      ]
    ];
    for (const [label, error, status, code, auditOutcome, retryable] of errorCases) {
      const harness = await createHarness({ mutateError: error });
      const operationId = `op_goal_route_error_${label}`;
      try {
        const response = await mutateGoal(harness, { ...setRequest, operation_id: operationId });
        expectStableError(response, status, code, retryable);
        expect(response.body).not.toContain("private-goal-service");
        expect(harness.auditRepository.require(operationId).records[1]).toMatchObject({
          outcome: auditOutcome,
          error_code: code
        });
      } finally {
        await harness.close();
      }
    }

    const malformedCases: readonly [string, Readonly<Record<string, unknown>>, Readonly<Record<string, unknown>>][] = [
      ["extra", setRequest, { ...goalResult("set", true), private: "private-goal-result" }],
      ["action", setRequest, goalResult("pause", true)],
      ["state", setRequest, { ...goalResult("set", true), state: "accepted" }],
      ["objective", setRequest, goalResult("set", true, { objective: "Wrong objective." })],
      [
        "status",
        { ...setRequest, action: "pause", objective: null, expected_goal_revision: originalRevision },
        goalResult("pause", true, { status: "active" })
      ],
      [
        "same-revision",
        { ...setRequest, expected_goal_revision: originalRevision },
        goalResult("set", true, { revision: originalRevision })
      ],
      [
        "changed-noop",
        { ...setRequest, expected_goal_revision: originalRevision },
        goalResult("set", false, { revision: changedRevision })
      ],
      [
        "resume-noop",
        { ...setRequest, action: "resume", objective: null, expected_goal_revision: originalRevision },
        goalResult("resume", false)
      ],
      [
        "clear-noop",
        { ...setRequest, action: "clear", objective: null, expected_goal_revision: originalRevision },
        goalResult("clear", false)
      ]
    ];
    for (const [label, request, result] of malformedCases) {
      const operationId = `op_goal_route_malformed_${label}`;
      const harness = await createHarness({ mutateResults: [result] });
      try {
        const response = await mutateGoal(harness, { ...request, operation_id: operationId });
        expectStableError(response, 500, "internal_error");
        expect(response.body).not.toContain("private-goal-result");
        expect(harness.auditRepository.require(operationId).records[1]).toMatchObject({
          outcome: "incomplete",
          error_code: "internal_error"
        });
      } finally {
        await harness.close();
      }
    }
  });

  it("replays duplicate operation results and keeps response-loss mutation authoritative", async () => {
    const duplicate = await createHarness();
    try {
      const first = await mutateGoal(duplicate, setRequest);
      expect(first.statusCode, first.body).toBe(200);
      const replay = await mutateGoal(duplicate, setRequest);
      expect(replay.statusCode, replay.body).toBe(200);
      expect(replay.json()).toEqual(first.json());
      expect(duplicate.mutateCalls()).toHaveLength(1);
      expect(duplicate.auditRepository.require(setRequest.operation_id).records).toHaveLength(2);
    } finally {
      await duplicate.close();
    }

    let releaseMutate: (() => void) | undefined;
    const barrier = new Promise<void>((resolve) => {
      releaseMutate = resolve;
    });
    const operationId = "op_goal_route_response_loss";
    const loss = await createHarness({ mutateBarrier: barrier });
    try {
      await loss.app.listen({ host: "127.0.0.1", port: 0, listenTextResolver: () => "" });
      const address = loss.app.server.address();
      if (address === null || typeof address === "string") throw new Error("Goal response-loss listener is unavailable.");
      const body = JSON.stringify({ ...setRequest, operation_id: operationId });
      const outgoing = httpRequest({
        hostname: "127.0.0.1",
        port: address.port,
        method: "POST",
        path: `/api/v1/sessions/${sessionId}/goal`,
        headers: {
          host: hostDeckLoopbackTestAuthority,
          accept: "application/json",
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          connection: "close"
        }
      });
      const closed = new Promise<void>((resolve) => {
        outgoing.once("error", () => resolve());
        outgoing.once("close", () => resolve());
      });
      outgoing.end(body);
      await waitFor(() => loss.mutateCalls().length === 1);
      outgoing.destroy();
      releaseMutate?.();
      await closed;
      await waitFor(() => loss.auditRepository.get(operationId)?.state === "terminal");
      const replay = await mutateGoal(loss, { ...setRequest, operation_id: operationId });
      expect(replay.statusCode, replay.body).toBe(200);
      expect(replay.json()).toMatchObject({ goal: { objective: setRequest.objective } });
      expect(loss.mutateCalls()).toHaveLength(1);
      expect(loss.auditRepository.require(operationId).records[1]).toMatchObject({ outcome: "succeeded" });
    } finally {
      releaseMutate?.();
      await loss.close();
    }
  });

  it("suppresses success when terminal audit cannot be proven and keeps raw summaries bounded", async () => {
    const harness = await createHarness();
    const operationId = "op_goal_route_terminal_audit";
    try {
      harness.failTerminalAudit();
      expectStableError(
        await mutateGoal(harness, { ...setRequest, operation_id: operationId }),
        503,
        "audit_unavailable",
        false
      );
      expect(harness.mutateCalls()).toHaveLength(1);
      expect(harness.auditRepository.require(operationId)).toMatchObject({
        state: "pending",
        records: [{ phase: "accepted", outcome: "accepted" }]
      });
      const raw = harness.rawAuditRecords(operationId).join("\n");
      expect(raw).not.toMatch(/Deliver HostDeck|binding-goal|private-goal/iu);
      expect(raw.match(/thread-goal-route-001/gu)).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });
});

interface HarnessOptions {
  readonly locked?: boolean;
  readonly mutateBarrier?: Promise<void>;
  readonly mutateError?: Error;
  readonly mutateResults?: readonly unknown[];
  readonly runtimeResults?: readonly unknown[];
  readonly snapshotError?: Error;
  readonly snapshotResults?: readonly unknown[];
  readonly stateResults?: readonly unknown[];
}

interface RouteInputFixture {
  readonly admission: CreateHostDeckGoalRouteRegistrationInput["admission"];
  readonly audit: ReturnType<typeof createHostDeckSelectedWriteAuditExecutor>;
  readonly csrf: ReturnType<typeof createHostDeckCsrfPolicy>;
  readonly goals: CreateHostDeckGoalRouteRegistrationInput["goals"];
  readonly lock: ReturnType<typeof createHostDeckHostLockPolicy>;
  readonly runtime: CreateHostDeckGoalRouteRegistrationInput["runtime"];
  readonly state: CreateHostDeckGoalRouteRegistrationInput["state"];
}

interface Harness {
  readonly app: HostDeckFastifyInstance;
  readonly auditRepository: SelectedAuditRepository;
  readonly registration: HostDeckRoutePluginRegistration;
  readonly routeInput: RouteInputFixture;
  readonly acceptedBeforeMutate: () => boolean;
  readonly close: () => Promise<void>;
  readonly failTerminalAudit: () => void;
  readonly mutateCalls: () => readonly Record<string, unknown>[];
  readonly mutateSignalObserved: () => boolean;
  readonly mutateThis: () => unknown;
  readonly rawAuditRecords: (operationId: string) => readonly string[];
  readonly runtimeReads: () => number;
  readonly snapshotCalls: () => readonly unknown[];
  readonly snapshotSignalObserved: () => boolean;
  readonly stateReads: () => number;
}

async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const directory = mkdtempSync(join(tmpdir(), "hostdeck-goal-route-"));
  temporaryDirectories.push(directory);
  const open = openMigratedDatabase(join(directory, "hostdeck.sqlite"), { now: () => new Date(timestamp) });
  let clock = new Date(timestamp).getTime();
  const nextDate = () => new Date(clock++);
  const auditRepository = createSelectedAuditRepository(open.db);
  let auditId = 0;
  const audit = createHostDeckSelectedWriteAuditExecutor({
    repository: auditRepository,
    now: () => nextDate().toISOString(),
    create_record_id: () => `audit_goal_route_${++auditId}`
  });
  const csrf = createHostDeckCsrfPolicy({
    csrf: {
      authorizeBrowserWrite() {
        throw new Error("Loopback goal route must not authorize browser CSRF.");
      },
      rotateBootstrap() {
        throw new Error("Loopback goal route must not rotate browser CSRF.");
      }
    },
    now: nextDate
  });
  const lock = createHostDeckHostLockPolicy({
    settings: {
      read: () => settings(options.locked === true),
      transition() {
        throw new Error("Goal route must not transition host lock.");
      }
    },
    now: nextDate
  });
  const snapshotCalls: unknown[] = [];
  const mutateCalls: Record<string, unknown>[] = [];
  let snapshotSignalObserved = false;
  let mutateSignalObserved = false;
  let mutateThis: unknown = "not-called";
  let acceptedBeforeMutate = false;
  let stateReads = 0;
  let runtimeReads = 0;
  let stateIndex = 0;
  let runtimeIndex = 0;
  let snapshotIndex = 0;
  let mutateIndex = 0;
  const routeInput: RouteInputFixture = {
    admission: createHostDeckSelectedWriteAdmissionPolicy({ resourceBudget: defaultResourceBudget, now: () => performance.now() }),
    audit,
    csrf,
    goals: {
      async snapshot(target: unknown, deadline: OperationDeadline) {
        snapshotCalls.push(target);
        snapshotSignalObserved = deadline.signal instanceof AbortSignal;
        if (options.snapshotError !== undefined) throw options.snapshotError;
        return sequenceValue(options.snapshotResults ?? [goalSnapshot()], snapshotIndex++);
      },
      async mutate(this: void, intent: unknown, deadline: OperationDeadline) {
        mutateThis = this;
        const captured = { ...(intent as Record<string, unknown>) };
        mutateCalls.push(captured);
        mutateSignalObserved = deadline.signal instanceof AbortSignal;
        acceptedBeforeMutate = auditRepository.get(String(captured.operation_id ?? ""))?.records[0]?.phase === "accepted";
        await options.mutateBarrier;
        if (options.mutateError !== undefined) throw options.mutateError;
        if (options.mutateResults !== undefined) return sequenceValue(options.mutateResults, mutateIndex++);
        return goalResult(String(captured.action ?? "set") as GoalAction, true);
      }
    } as unknown as RouteInputFixture["goals"],
    lock,
    runtime: {
      read() {
        runtimeReads += 1;
        return sequenceValue(options.runtimeResults ?? [runtimeCandidate()], runtimeIndex++);
      }
    },
    state: {
      get() {
        stateReads += 1;
        return sequenceValue(options.stateResults ?? [selectedState("active")], stateIndex++) as SelectedSessionState | null;
      }
    }
  };
  const registration = createHostDeckGoalRouteRegistration(routeInput);
  const app = createHostDeckFastifyApp({
    observeInternalError: () => undefined,
    requestAuthenticationPolicy: createHostDeckRequestAuthenticationPolicy({
      authenticateDeviceToken: () => {
        throw new Error("Loopback goal route must not authenticate a device.");
      },
      now: nextDate
    }),
    requestTrustPolicy: createHostDeckRequestTrustPolicy({
      allowedOrigin: hostDeckLoopbackTestOrigin
    }),
    resourceBudget: defaultResourceBudget,
    routePlugins: [registration]
  });
  await app.ready();
  let closed = false;
  return {
    app,
    auditRepository,
    registration,
    routeInput,
    acceptedBeforeMutate: () => acceptedBeforeMutate,
    mutateCalls: () => [...mutateCalls],
    mutateSignalObserved: () => mutateSignalObserved,
    mutateThis: () => mutateThis,
    snapshotCalls: () => [...snapshotCalls],
    snapshotSignalObserved: () => snapshotSignalObserved,
    stateReads: () => stateReads,
    runtimeReads: () => runtimeReads,
    rawAuditRecords(operationId) {
      return (open.db
        .prepare("SELECT record_json FROM selected_audit_events WHERE operation_id = ? ORDER BY phase")
        .all(operationId) as readonly { readonly record_json: string }[]).map((row) => row.record_json);
    },
    failTerminalAudit() {
      open.db.exec(`
        CREATE TRIGGER fail_goal_terminal_audit
        BEFORE INSERT ON selected_audit_events
        WHEN NEW.phase = 'terminal'
        BEGIN
          SELECT RAISE(ABORT, 'forced goal terminal audit failure');
        END;
      `);
    },
    async close() {
      if (closed) return;
      closed = true;
      await app.close();
      if (open.db.open) open.db.close();
    }
  };
}

type GoalAction = "clear" | "complete" | "pause" | "resume" | "set";

function managedTarget() {
  return {
    type: "managed_session" as const,
    session_id: sessionId,
    codex_thread_id: threadId
  };
}

function goalValue(
  overrides: Partial<Pick<GoalControlValue, "objective" | "revision" | "status">> = {}
): GoalControlValue {
  return goalControlValueSchema.parse({
    revision: originalRevision,
    objective,
    status: "paused",
    token_budget: 10_000,
    tokens_used: 500,
    time_used_seconds: 12.5,
    created_at: timestamp,
    updated_at: timestamp,
    ...overrides
  });
}

function goalSnapshot(goal: GoalControlValue | null = goalValue()): GoalControlSnapshot {
  return goalControlSnapshotSchema.parse({ goal, uncertain_mutation: null });
}

function goalResult(
  action: GoalAction,
  dispatched: boolean,
  goalOverrides: Partial<Pick<GoalControlValue, "objective" | "revision" | "status">> = {}
): Readonly<Record<string, unknown>> {
  const status = action === "resume" ? "active" : action === "complete" ? "complete" : "paused";
  return Object.freeze({
    action,
    state: action === "resume" ? "accepted" : "succeeded",
    dispatched,
    goal:
      action === "clear"
        ? null
        : goalValue({
            revision: dispatched ? changedRevision : originalRevision,
            status,
            ...goalOverrides
          })
  });
}

function selectedState(state: "active" | "archived" | "contradictory" | "recovery" | "stale"): SelectedSessionState {
  const archivedAt = state === "archived" ? timestamp : null;
  const mapping = selectedSessionMappingRecordSchema.parse({
    id: sessionId,
    name: "goal-route-session",
    codex_thread_id: threadId,
    cwd: "/tmp/hostdeck-goal-route",
    runtime_source: "codex_app_server",
    runtime_version: runtimeVersion,
    disposition: state === "recovery" ? "recovery_required" : "selected",
    created_at: timestamp,
    updated_at: timestamp,
    archived_at: archivedAt
  });
  const stale = state === "stale";
  const projection = selectedSessionProjectionRecordSchema.parse({
    session: {
      id: mapping.id,
      name: mapping.name,
      codex_thread_id: mapping.codex_thread_id,
      cwd: state === "contradictory" ? "/tmp/hostdeck-goal-route-other" : mapping.cwd,
      runtime_source: mapping.runtime_source,
      runtime_version: mapping.runtime_version,
      created_at: mapping.created_at,
      archived_at: archivedAt,
      session_state: state === "archived" ? "archived" : stale ? "stale" : "active",
      turn_state: stale ? "unknown" : "idle",
      attention: stale ? "unknown" : "none",
      freshness: stale ? "stale" : "current",
      freshness_reason: stale ? "Projection requires reconciliation." : null,
      updated_at: timestamp,
      last_activity_at: timestamp,
      branch: "main",
      model: "model-a",
      goal: null,
      recent_summary: "Managed goal route test session.",
      last_event_cursor: null
    },
    retained_event_count: 0,
    retained_event_bytes: 0,
    earliest_retained_cursor: null,
    retention_boundary_cursor: null
  });
  return { mapping, projection };
}

function runtimeCandidate(
  input: {
    readonly bindingId?: string;
    readonly mutationPolicy?: RuntimeCompatibility["mutation_policy"];
    readonly state?: RuntimeCompatibility["state"];
    readonly unavailableCapability?: string;
    readonly version?: string;
  } = {}
): RuntimeCompatibility {
  const state = input.state ?? "ready";
  const connected = state !== "disconnected";
  return runtimeCompatibilitySchema.parse({
    source: "codex_app_server",
    state,
    mutation_policy: input.mutationPolicy ?? (state === "ready" || state === "degraded" ? "allowed" : "blocked"),
    observed_version: connected ? (input.version ?? runtimeVersion) : null,
    binding_id: connected ? (input.bindingId ?? "binding-goal-route-001") : null,
    capabilities: runtimeCapabilities.map((name) =>
      name === input.unavailableCapability ||
      (state === "incompatible" && input.unavailableCapability === undefined && name === "goal")
        ? { name, state: "unavailable", reason: "Capability is unavailable." }
        : { name, state: "available", reason: null }
    ),
    checked_at: timestamp,
    reason: state === "ready" ? null : "Runtime is not ready."
  });
}

function settings(locked: boolean) {
  return Object.freeze({
    locked,
    settings_updated_at: timestamp
  });
}

function goalServiceError(
  code: CodexGoalControlErrorCode,
  apiCode: ConstructorParameters<typeof HostDeckCodexGoalControlError>[1],
  outcome: CodexGoalControlOutcome = "not_sent"
): HostDeckCodexGoalControlError {
  return new HostDeckCodexGoalControlError(code, apiCode, "private-goal-service-error", outcome, true);
}

function sequenceValue(values: readonly unknown[], index: number): unknown {
  const value = values[Math.min(index, values.length - 1)];
  if (value === undefined) throw new Error("Goal route test sequence is empty.");
  return value;
}

async function readGoal(harness: Pick<Harness, "app">) {
  return await injectHostDeckLoopback(harness.app, { method: "GET", url: `/api/v1/sessions/${sessionId}/goal` });
}

async function mutateGoal(harness: Pick<Harness, "app">, payload: Readonly<Record<string, unknown>>) {
  return await injectHostDeckLoopback(harness.app, { method: "POST", url: `/api/v1/sessions/${sessionId}/goal`, payload });
}

function expectStableError(
  response: { readonly statusCode: number; readonly body: string; readonly json: () => unknown },
  status: number,
  code: string,
  retryable = false
): void {
  expect(response.statusCode, response.body).toBe(status);
  expect(response.json()).toMatchObject({ error: { code, retryable } });
  expect(response.body).not.toContain("private-goal");
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for goal route condition.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
