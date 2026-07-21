import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultResourceBudget,
  type PlanControlSnapshot,
  planControlSnapshotSchema,
  type RuntimeCompatibility,
  runtimeCompatibilitySchema,
  selectedSessionMappingRecordSchema,
  selectedSessionProjectionRecordSchema
} from "@hostdeck/contracts";
import { runtimeCapabilities } from "@hostdeck/core";
import {
  createSelectedAuditRepository,
  openMigratedDatabase,
  type SelectedAuditRepository,
  type SelectedSessionState
} from "@hostdeck/storage";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CodexPlanControlErrorCode,
  type CodexPlanControlOutcome,
  HostDeckCodexPlanControlError
} from "./codex-plan-control-service.js";
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
import { createHostDeckHostLockPolicy } from "./host-lock-routes.js";
import {
  type CreateHostDeckPlanRouteRegistrationInput,
  createHostDeckPlanRouteRegistration,
  hostDeckPlanRouteRegistrationId
} from "./plan-routes.js";
import { createHostDeckSelectedWriteAdmissionPolicy } from "./selected-write-admission-policy.js";
import { createHostDeckSelectedWriteAuditExecutor } from "./selected-write-audit-executor.js";

const temporaryDirectories: string[] = [];
const timestamp = "2026-07-16T06:00:00.000Z";
const runtimeVersion = "0.144.0";
const sessionId = "sess_plan_route_001";
const threadId = "thread-plan-route-001";
const enterRequest = Object.freeze({
  operation_id: "op_plan_route_001",
  kind: "plan" as const,
  action: "enter" as const,
  expected_pending_revision: null
});

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("selected managed-session Plan routes", () => {
  it("requires exact composition and registers both manifest routes once", async () => {
    const harness = await createHarness();
    try {
      expect(harness.registration).toMatchObject({ id: hostDeckPlanRouteRegistrationId, surface: "api" });
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
          throw new Error("private-plan-accessor");
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
        { ...harness.routeInput, lock: {} },
        { ...harness.routeInput, plans: {} },
        { ...harness.routeInput, plans: { ...harness.routeInput.plans, extra: true } },
        { ...harness.routeInput, runtime: {} },
        { ...harness.routeInput, state: {} },
        accessor
      ]) {
        expect(() => createHostDeckPlanRouteRegistration(candidate as never)).toThrow();
      }
      expect(accessorCalls).toBe(0);
    } finally {
      await harness.close();
    }
  });

  it("reads once and stages one enter selection with exact target, signal, response, and audit truth", async () => {
    const harness = await createHarness();
    try {
      const read = await readPlan(harness);
      expect(read.statusCode, read.body).toBe(200);
      expect(read.headers["cache-control"]).toBe("no-store");
      expect(read.headers.pragma).toBe("no-cache");
      expect(read.json()).toEqual(planSnapshot());
      expect(harness.snapshotCalls()).toEqual([managedTarget()]);
      expect(harness.snapshotSignalObserved()).toBe(true);

      const response = await selectPlan(harness, enterRequest);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json()).toEqual(stagedSnapshot(enterRequest.operation_id, "enter", 1));
      expect(harness.selectCalls()).toEqual([
        {
          operation_id: enterRequest.operation_id,
          target: managedTarget(),
          kind: "plan",
          action: "enter",
          expected_pending_revision: null
        }
      ]);
      expect(harness.selectThis()).toBeUndefined();
      expect(harness.selectSignalObserved()).toBe(true);
      expect(harness.acceptedBeforeSelect()).toBe(true);
      expect(harness.auditRepository.require(enterRequest.operation_id)).toMatchObject({
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
      const raw = harness.rawAuditRecords(enterRequest.operation_id).join("\n");
      expect(raw).not.toMatch(/binding-plan|private-plan|runtime-plan-preset|\/plan|turn\/start/iu);
      expect(raw.match(/thread-plan-route-001/gu)).toHaveLength(2);
    } finally {
      await harness.close();
    }
  });

  it("distinguishes replacement, pending clear, and already-confirmed no-op without application claims", async () => {
    const replacementRequest = {
      ...enterRequest,
      operation_id: "op_plan_route_replace",
      action: "exit" as const,
      expected_pending_revision: 3
    };
    const replacement = await createHarness({
      selectResults: [stagedSnapshot(replacementRequest.operation_id, "exit", 4)]
    });
    try {
      const response = await selectPlan(replacement, replacementRequest);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ pending: { revision: 4, mode: "default", phase: "pending" } });
      expect(replacement.auditRepository.require(replacementRequest.operation_id).records[1]).toMatchObject({
        outcome: "succeeded",
        payload_summary: { schema_version: 1, changed: true }
      });
      expect(response.body).not.toMatch(/applied|running|completed|turn\/start/iu);
    } finally {
      await replacement.close();
    }

    const clearRequest = { ...replacementRequest, operation_id: "op_plan_route_clear" };
    const clear = await createHarness({ selectResults: [confirmedSnapshot("default")] });
    try {
      const response = await selectPlan(clear, clearRequest);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ current: { state: "confirmed", mode: "default" }, pending: null });
      expect(clear.auditRepository.require(clearRequest.operation_id).records[1]).toMatchObject({
        outcome: "succeeded",
        payload_summary: { schema_version: 1, changed: true }
      });
    } finally {
      await clear.close();
    }

    const noOpRequest = { ...enterRequest, operation_id: "op_plan_route_noop", action: "exit" as const };
    const noOp = await createHarness({ selectResults: [confirmedSnapshot("default")] });
    try {
      const response = await selectPlan(noOp, noOpRequest);
      expect(response.statusCode, response.body).toBe(200);
      expect(noOp.auditRepository.require(noOpRequest.operation_id).records[1]).toMatchObject({
        outcome: "succeeded",
        payload_summary: { schema_version: 1, changed: false }
      });
    } finally {
      await noOp.close();
    }
  });

  it("rejects malformed input, adjacent methods and paths, query, and lock before Plan access", async () => {
    const harness = await createHarness();
    try {
      for (const candidate of [
        { ...enterRequest, target: managedTarget() },
        { ...enterRequest, mode: "plan" },
        { ...enterRequest, text: "/plan" },
        { ...enterRequest, model: "private-model" },
        { ...enterRequest, expected_pending_revision: 0 },
        { ...enterRequest, action: "default" }
      ]) {
        expectStableError(await selectPlan(harness, candidate), 400, "validation_error");
      }
      expectStableError(
        await injectHostDeckLoopback(harness.app, { method: "GET", url: `/api/v1/sessions/${sessionId}/plan?target=other` }),
        400,
        "validation_error"
      );
      expectStableError(
        await injectHostDeckLoopback(harness.app, {
          method: "GET",
          url: `/api/v1/sessions/${sessionId}/plan`,
          headers: { "content-length": "19", "content-type": "application/json" },
          payload: '{"unexpected":true}'
        }),
        400,
        "validation_error"
      );
      expectStableError(
        await injectHostDeckLoopback(harness.app, { method: "POST", url: `/api/v1/sessions/${sessionId}/plan?x=1`, payload: enterRequest }),
        400,
        "validation_error"
      );
      expectStableError(
        await injectHostDeckLoopback(harness.app, { method: "HEAD", url: `/api/v1/sessions/${sessionId}/plan` }),
        405,
        "method_not_allowed"
      );
      expectStableError(
        await injectHostDeckLoopback(harness.app, { method: "PUT", url: `/api/v1/sessions/${sessionId}/plan` }),
        405,
        "method_not_allowed"
      );
      expectStableError(
        await injectHostDeckLoopback(harness.app, { method: "GET", url: `/api/v1/sessions/${sessionId}/plan/extra` }),
        404,
        "route_not_found"
      );
      expect(harness.stateReads()).toBe(0);
      expect(harness.snapshotCalls()).toEqual([]);
      expect(harness.selectCalls()).toEqual([]);
    } finally {
      await harness.close();
    }

    const locked = await createHarness({ locked: true });
    try {
      expectStableError(
        await selectPlan(locked, { ...enterRequest, operation_id: "op_plan_route_locked" }),
        423,
        "host_locked"
      );
      expect(locked.stateReads()).toBe(0);
      expect(locked.selectCalls()).toEqual([]);
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
      const operationId = `op_plan_route_state_${label}`;
      try {
        expectStableError(await selectPlan(harness, { ...enterRequest, operation_id: operationId }), status, code);
        expect(harness.runtimeReads()).toBe(0);
        expect(harness.selectCalls()).toEqual([]);
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
        runtimeCandidate({ state: "incompatible", unavailableCapability: "plan" }),
        409,
        "capability_unavailable"
      ],
      ["blocked", runtimeCandidate({ state: "degraded", mutationPolicy: "blocked" }), 409, "incompatible_runtime"]
    ];
    for (const [label, runtime, status, code] of runtimeCases) {
      const harness = await createHarness({ runtimeResults: [runtime] });
      const operationId = `op_plan_route_runtime_${label}`;
      try {
        expectStableError(
          await selectPlan(harness, { ...enterRequest, operation_id: operationId }),
          status,
          code,
          code === "runtime_unavailable"
        );
        expect(harness.selectCalls()).toEqual([]);
        expect(harness.auditRepository.get(operationId)).toBeNull();
      } finally {
        await harness.close();
      }
    }

    const readBlocked = await createHarness({
      runtimeResults: [runtimeCandidate({ state: "degraded", mutationPolicy: "blocked" })]
    });
    try {
      expect((await readPlan(readBlocked)).statusCode).toBe(200);
    } finally {
      await readBlocked.close();
    }
  });

  it("brackets read and selection identity plus runtime state around the service call", async () => {
    const readDrift = await createHarness({
      stateResults: [selectedState("active"), selectedState("contradictory")]
    });
    try {
      expectStableError(await readPlan(readDrift), 409, "stale_session");
      expect(readDrift.snapshotCalls()).toHaveLength(1);
    } finally {
      await readDrift.close();
    }

    const readRuntimeDrift = await createHarness({
      runtimeResults: [runtimeCandidate(), runtimeCandidate({ bindingId: "binding-plan-route-002" })]
    });
    try {
      expectStableError(await readPlan(readRuntimeDrift), 409, "incompatible_runtime");
    } finally {
      await readRuntimeDrift.close();
    }

    const preOperationId = "op_plan_route_preselect_drift";
    const pre = await createHarness({
      stateResults: [selectedState("active"), selectedState("contradictory")]
    });
    try {
      expectStableError(await selectPlan(pre, { ...enterRequest, operation_id: preOperationId }), 409, "stale_session");
      expect(pre.selectCalls()).toEqual([]);
      expect(pre.auditRepository.require(preOperationId).records[1]).toMatchObject({
        outcome: "failed",
        error_code: "stale_session"
      });
    } finally {
      await pre.close();
    }

    const postOperationId = "op_plan_route_postselect_drift";
    const post = await createHarness({
      runtimeResults: [
        runtimeCandidate(),
        runtimeCandidate(),
        runtimeCandidate({ bindingId: "binding-plan-route-002" })
      ]
    });
    try {
      expectStableError(
        await selectPlan(post, { ...enterRequest, operation_id: postOperationId }),
        409,
        "incompatible_runtime"
      );
      expect(post.selectCalls()).toHaveLength(1);
      expect(post.auditRepository.require(postOperationId).records[1]).toMatchObject({
        outcome: "incomplete",
        error_code: "incompatible_runtime"
      });
    } finally {
      await post.close();
    }
  });

  it("maps typed service failures, canonicalizes pending errors, and rejects contradictory results", async () => {
    const errorCases: readonly [string, HostDeckCodexPlanControlError, number, string, boolean][] = [
      ["capability", planServiceError("capability_unsupported", "capability_unavailable"), 409, "capability_unavailable", false],
      ["conflict", planServiceError("operation_conflict", "operation_conflict"), 409, "operation_conflict", true],
      ["protocol", planServiceError("runtime_protocol_error", "protocol_error"), 502, "protocol_error", false],
      ["unknown", planServiceError("unknown_outcome", "unknown_error", "unknown"), 409, "unknown_error", false]
    ];
    for (const [label, error, status, code, retryable] of errorCases) {
      const harness = await createHarness({ selectError: error });
      const operationId = `op_plan_route_error_${label}`;
      try {
        const response = await selectPlan(harness, { ...enterRequest, operation_id: operationId });
        expectStableError(response, status, code, retryable);
        expect(response.body).not.toContain("private-plan-service");
        expect(harness.auditRepository.require(operationId).records[1]).toMatchObject({
          outcome: "failed",
          error_code: code
        });
      } finally {
        await harness.close();
      }
    }

    const canonical = await createHarness({ snapshotResults: [conflictSnapshot()] });
    try {
      const response = await readPlan(canonical);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        pending: { error: { code: "operation_conflict", message: "Plan selection conflicts with observed runtime settings." } }
      });
      expect(response.body).not.toContain("private-plan-pending");
    } finally {
      await canonical.close();
    }

    const replacementRequest = { ...enterRequest, expected_pending_revision: 3 };
    const malformed: readonly [string, unknown][] = [
      ["extra", { ...stagedSnapshot(enterRequest.operation_id, "enter", 4), private: true }],
      ["operation", stagedSnapshot("op_plan_route_other", "enter", 4)],
      ["mode", stagedSnapshot(enterRequest.operation_id, "exit", 4)],
      ["rollback", stagedSnapshot(enterRequest.operation_id, "enter", 3)],
      ["wrong-current", confirmedSnapshot("default")],
      ["unknown-current", planSnapshot()],
      ["conflict", conflictSnapshot()],
      ["null", null]
    ];
    for (const [label, candidate] of malformed) {
      const operationId = `op_plan_route_malformed_${label}`;
      const harness = await createHarness({ selectResults: [candidate] });
      try {
        const response = await selectPlan(harness, { ...replacementRequest, operation_id: operationId });
        expectStableError(response, 500, "internal_error");
        expect(harness.auditRepository.require(operationId).records[1]).toMatchObject({
          outcome: "incomplete",
          error_code: "internal_error"
        });
      } finally {
        await harness.close();
      }
    }
  });

  it("replays duplicate operation results and keeps response-loss selection authoritative", async () => {
    const duplicate = await createHarness();
    try {
      const first = await selectPlan(duplicate, enterRequest);
      expect(first.statusCode, first.body).toBe(200);
      const replay = await selectPlan(duplicate, enterRequest);
      expect(replay.statusCode, replay.body).toBe(200);
      expect(replay.json()).toEqual(first.json());
      expect(duplicate.selectCalls()).toHaveLength(1);
      expect(duplicate.auditRepository.require(enterRequest.operation_id).records).toHaveLength(2);
    } finally {
      await duplicate.close();
    }

    let releaseSelect: (() => void) | undefined;
    const barrier = new Promise<void>((resolve) => {
      releaseSelect = resolve;
    });
    const operationId = "op_plan_route_response_loss";
    const loss = await createHarness({ selectBarrier: barrier });
    try {
      await loss.app.listen({ host: "127.0.0.1", port: 0, listenTextResolver: () => "" });
      const address = loss.app.server.address();
      if (address === null || typeof address === "string") throw new Error("Plan response-loss listener is unavailable.");
      const body = JSON.stringify({ ...enterRequest, operation_id: operationId });
      const outgoing = httpRequest({
        hostname: "127.0.0.1",
        port: address.port,
        method: "POST",
        path: `/api/v1/sessions/${sessionId}/plan`,
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
      await waitFor(() => loss.selectCalls().length === 1);
      outgoing.destroy();
      releaseSelect?.();
      await closed;
      await waitFor(() => loss.auditRepository.get(operationId)?.state === "terminal");
      const replay = await selectPlan(loss, { ...enterRequest, operation_id: operationId });
      expect(replay.statusCode, replay.body).toBe(200);
      expect(replay.json()).toMatchObject({
        pending: { selection_operation_id: operationId }
      });
      expect(loss.selectCalls()).toHaveLength(1);
      expect(loss.auditRepository.require(operationId).records[1]).toMatchObject({ outcome: "succeeded" });
    } finally {
      releaseSelect?.();
      await loss.close();
    }
  });

  it("suppresses success when terminal audit cannot be proven and keeps raw summaries bounded", async () => {
    const harness = await createHarness();
    const operationId = "op_plan_route_terminal_audit";
    try {
      harness.failTerminalAudit();
      expectStableError(
        await selectPlan(harness, { ...enterRequest, operation_id: operationId }),
        503,
        "audit_unavailable",
        false
      );
      expect(harness.selectCalls()).toHaveLength(1);
      expect(harness.auditRepository.require(operationId)).toMatchObject({
        state: "pending",
        records: [{ phase: "accepted", outcome: "accepted" }]
      });
      const raw = harness.rawAuditRecords(operationId).join("\n");
      expect(raw).not.toMatch(/binding-plan|private-plan|runtime-plan-preset|\/plan|turn\/start/iu);
    } finally {
      await harness.close();
    }
  });
});

interface HarnessOptions {
  readonly locked?: boolean;
  readonly runtimeResults?: readonly unknown[];
  readonly selectBarrier?: Promise<void>;
  readonly selectError?: Error;
  readonly selectResults?: readonly unknown[];
  readonly snapshotError?: Error;
  readonly snapshotResults?: readonly unknown[];
  readonly stateResults?: readonly unknown[];
}

interface RouteInputFixture {
  readonly admission: CreateHostDeckPlanRouteRegistrationInput["admission"];
  readonly audit: ReturnType<typeof createHostDeckSelectedWriteAuditExecutor>;
  readonly csrf: ReturnType<typeof createHostDeckCsrfPolicy>;
  readonly lock: ReturnType<typeof createHostDeckHostLockPolicy>;
  readonly plans: CreateHostDeckPlanRouteRegistrationInput["plans"];
  readonly runtime: CreateHostDeckPlanRouteRegistrationInput["runtime"];
  readonly state: CreateHostDeckPlanRouteRegistrationInput["state"];
}

interface Harness {
  readonly app: HostDeckFastifyInstance;
  readonly auditRepository: SelectedAuditRepository;
  readonly registration: HostDeckRoutePluginRegistration;
  readonly routeInput: RouteInputFixture;
  readonly acceptedBeforeSelect: () => boolean;
  readonly close: () => Promise<void>;
  readonly failTerminalAudit: () => void;
  readonly rawAuditRecords: (operationId: string) => readonly string[];
  readonly runtimeReads: () => number;
  readonly selectCalls: () => readonly Record<string, unknown>[];
  readonly selectSignalObserved: () => boolean;
  readonly selectThis: () => unknown;
  readonly snapshotCalls: () => readonly unknown[];
  readonly snapshotSignalObserved: () => boolean;
  readonly stateReads: () => number;
}

async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const directory = mkdtempSync(join(tmpdir(), "hostdeck-plan-route-"));
  temporaryDirectories.push(directory);
  const open = openMigratedDatabase(join(directory, "hostdeck.sqlite"), { now: () => new Date(timestamp) });
  let clock = new Date(timestamp).getTime();
  const nextDate = () => new Date(clock++);
  const auditRepository = createSelectedAuditRepository(open.db);
  let auditId = 0;
  const audit = createHostDeckSelectedWriteAuditExecutor({
    repository: auditRepository,
    now: () => nextDate().toISOString(),
    create_record_id: () => `audit_plan_route_${++auditId}`
  });
  const csrf = createHostDeckCsrfPolicy({
    csrf: {
      authorizeBrowserWrite() {
        throw new Error("Loopback Plan route must not authorize browser CSRF.");
      },
      rotateBootstrap() {
        throw new Error("Loopback Plan route must not rotate browser CSRF.");
      }
    },
    now: nextDate
  });
  const lock = createHostDeckHostLockPolicy({
    settings: {
      read: () => settings(options.locked === true),
      transition() {
        throw new Error("Plan route must not transition host lock.");
      }
    },
    now: nextDate
  });
  const snapshotCalls: unknown[] = [];
  const selectCalls: Record<string, unknown>[] = [];
  let snapshotSignalObserved = false;
  let selectSignalObserved = false;
  let selectThis: unknown = "not-called";
  let acceptedBeforeSelect = false;
  let stateReads = 0;
  let runtimeReads = 0;
  let stateIndex = 0;
  let runtimeIndex = 0;
  let snapshotIndex = 0;
  let selectIndex = 0;
  const routeInput: RouteInputFixture = {
    admission: createHostDeckSelectedWriteAdmissionPolicy({ resourceBudget: defaultResourceBudget, now: () => performance.now() }),
    audit,
    csrf,
    lock,
    plans: {
      async snapshot(target: unknown, signal?: AbortSignal) {
        snapshotCalls.push(target);
        snapshotSignalObserved = signal instanceof AbortSignal;
        if (options.snapshotError !== undefined) throw options.snapshotError;
        return sequenceValue(options.snapshotResults ?? [planSnapshot()], snapshotIndex++);
      },
      async select(this: void, intent: unknown, signal?: AbortSignal) {
        selectThis = this;
        const captured = { ...(intent as Record<string, unknown>) };
        selectCalls.push(captured);
        selectSignalObserved = signal instanceof AbortSignal;
        acceptedBeforeSelect = auditRepository.get(String(captured.operation_id ?? ""))?.records[0]?.phase === "accepted";
        await options.selectBarrier;
        if (options.selectError !== undefined) throw options.selectError;
        if (options.selectResults !== undefined) return sequenceValue(options.selectResults, selectIndex++);
        return stagedSnapshot(
          String(captured.operation_id ?? ""),
          String(captured.action ?? "enter") as "enter" | "exit",
          1
        );
      }
    } as unknown as RouteInputFixture["plans"],
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
  const registration = createHostDeckPlanRouteRegistration(routeInput);
  const app = createHostDeckFastifyApp({
    observeInternalError: () => undefined,
    requestAuthenticationPolicy: createHostDeckRequestAuthenticationPolicy({
      authenticateDeviceToken: () => {
        throw new Error("Loopback Plan route must not authenticate a device.");
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
    acceptedBeforeSelect: () => acceptedBeforeSelect,
    selectCalls: () => [...selectCalls],
    selectSignalObserved: () => selectSignalObserved,
    selectThis: () => selectThis,
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
        CREATE TRIGGER fail_plan_terminal_audit
        BEFORE INSERT ON selected_audit_events
        WHEN NEW.phase = 'terminal'
        BEGIN
          SELECT RAISE(ABORT, 'forced Plan terminal audit failure');
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

function managedTarget() {
  return { type: "managed_session" as const, session_id: sessionId, codex_thread_id: threadId };
}

function planSnapshot(): PlanControlSnapshot {
  return planControlSnapshotSchema.parse({
    catalog_revision: "c".repeat(64),
    catalog_observed_at: timestamp,
    current: {
      state: "unknown",
      mode: null,
      runtime_model: null,
      reasoning_effort: null,
      observed_at: null
    },
    pending: null,
    execution: { turn_id: null, state: "idle", evidence: "none", summary: null, updated_at: null },
    modes: planModes()
  });
}

function stagedSnapshot(operationId: string, action: "enter" | "exit", revision: number): PlanControlSnapshot {
  return planControlSnapshotSchema.parse({
    ...planSnapshot(),
    pending: {
      revision,
      selection_operation_id: operationId,
      mode: action === "enter" ? "plan" : "default",
      catalog_state: "available",
      phase: "pending",
      selected_at: timestamp,
      turn_id: null,
      resolved_settings: null,
      error: null
    }
  });
}

function confirmedSnapshot(mode: "default" | "plan"): PlanControlSnapshot {
  return planControlSnapshotSchema.parse({
    ...planSnapshot(),
    current: {
      state: "confirmed",
      mode,
      runtime_model: "runtime-a",
      reasoning_effort: "high",
      observed_at: timestamp
    }
  });
}

function conflictSnapshot(): PlanControlSnapshot {
  return planControlSnapshotSchema.parse({
    ...planSnapshot(),
    pending: {
      revision: 3,
      selection_operation_id: "op_plan_route_conflict",
      mode: "plan",
      catalog_state: "unknown",
      phase: "conflict",
      selected_at: timestamp,
      turn_id: null,
      resolved_settings: null,
      error: {
        code: "operation_conflict",
        message: "private-plan-pending cwd token cookie thread",
        retryable: false
      }
    }
  });
}

function planModes() {
  return [
    { name: "Plan", mode: "plan", preset_model: "runtime-plan-preset", preset_reasoning_effort: "medium" },
    { name: "Default", mode: "default", preset_model: null, preset_reasoning_effort: null }
  ];
}

function selectedState(state: "active" | "archived" | "contradictory" | "recovery" | "stale"): SelectedSessionState {
  const archivedAt = state === "archived" ? timestamp : null;
  const mapping = selectedSessionMappingRecordSchema.parse({
    id: sessionId,
    name: "plan-route-session",
    codex_thread_id: threadId,
    cwd: "/tmp/hostdeck-plan-route",
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
      cwd: state === "contradictory" ? "/tmp/hostdeck-plan-route-other" : mapping.cwd,
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
      model: "runtime-a",
      goal: null,
      recent_summary: "Managed Plan route test session.",
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
    binding_id: connected ? (input.bindingId ?? "binding-plan-route-001") : null,
    capabilities: runtimeCapabilities.map((name) =>
      name === input.unavailableCapability ||
      (state === "incompatible" && input.unavailableCapability === undefined && name === "plan")
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

function planServiceError(
  code: CodexPlanControlErrorCode,
  apiCode: ConstructorParameters<typeof HostDeckCodexPlanControlError>[1],
  outcome: CodexPlanControlOutcome = "not_sent"
): HostDeckCodexPlanControlError {
  return new HostDeckCodexPlanControlError(code, apiCode, "private-plan-service-error", outcome, true);
}

function sequenceValue(values: readonly unknown[], index: number): unknown {
  const value = values[Math.min(index, values.length - 1)];
  if (value === undefined) throw new Error("Plan route test sequence is empty.");
  return value;
}

async function readPlan(harness: Pick<Harness, "app">) {
  return await injectHostDeckLoopback(harness.app, { method: "GET", url: `/api/v1/sessions/${sessionId}/plan` });
}

async function selectPlan(harness: Pick<Harness, "app">, payload: Readonly<Record<string, unknown>>) {
  return await injectHostDeckLoopback(harness.app, { method: "POST", url: `/api/v1/sessions/${sessionId}/plan`, payload });
}

function expectStableError(
  response: { readonly statusCode: number; readonly body: string; readonly json: () => unknown },
  status: number,
  code: string,
  retryable = false
): void {
  expect(response.statusCode, response.body).toBe(status);
  expect(response.json()).toMatchObject({ error: { code, retryable } });
  expect(response.body).not.toContain("private-plan");
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for Plan route condition.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
