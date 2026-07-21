import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultResourceBudget,
  type ModelControlSnapshot,
  modelControlSnapshotSchema,
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
  type CodexModelControlErrorCode,
  type CodexModelControlOutcome,
  HostDeckCodexModelControlError
} from "./codex-model-control-service.js";
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
  type CreateHostDeckModelRouteRegistrationInput,
  createHostDeckModelRouteRegistration,
  hostDeckModelRouteRegistrationId
} from "./model-routes.js";
import { createHostDeckSelectedWriteAdmissionPolicy } from "./selected-write-admission-policy.js";
import { createHostDeckSelectedWriteAuditExecutor } from "./selected-write-audit-executor.js";

const temporaryDirectories: string[] = [];
const timestamp = "2026-07-16T04:00:00.000Z";
const runtimeVersion = "0.144.0";
const sessionId = "sess_model_route_001";
const threadId = "thread-model-route-001";
const modelRequest = Object.freeze({
  operation_id: "op_model_route_001",
  kind: "model" as const,
  model_id: "model-b",
  reasoning_effort: null,
  expected_pending_revision: null
});

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("selected managed-session model routes", () => {
  it("requires exact composition and registers both manifest routes once", async () => {
    const harness = await createHarness();
    try {
      expect(harness.registration).toMatchObject({
        id: hostDeckModelRouteRegistrationId,
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
          throw new Error("private-model-accessor");
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
        { ...harness.routeInput, models: {} },
        { ...harness.routeInput, models: { ...harness.routeInput.models, extra: true } },
        { ...harness.routeInput, runtime: {} },
        { ...harness.routeInput, state: {} },
        accessor
      ]) {
        expect(() => createHostDeckModelRouteRegistration(candidate as never)).toThrow();
      }
      expect(accessorCalls).toBe(0);
    } finally {
      await harness.close();
    }
  });

  it("reads once and stages one default-effort selection with exact audit truth", async () => {
    const harness = await createHarness();
    try {
      const read = await readModel(harness);
      expect(read.statusCode, read.body).toBe(200);
      expect(read.headers["cache-control"]).toBe("no-store");
      expect(read.headers.pragma).toBe("no-cache");
      expect(read.json()).toEqual(modelSnapshot());
      expect(harness.snapshotCalls()).toEqual([
        {
          type: "managed_session",
          session_id: sessionId,
          codex_thread_id: threadId
        }
      ]);
      expect(harness.snapshotSignalObserved()).toBe(true);

      const response = await selectModel(harness, modelRequest);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json()).toEqual(stagedSnapshot(modelRequest.operation_id));
      expect(harness.selectCalls()).toEqual([
        {
          operation_id: modelRequest.operation_id,
          target: {
            type: "managed_session",
            session_id: sessionId,
            codex_thread_id: threadId
          },
          kind: "model",
          model_id: "model-b",
          reasoning_effort: null,
          expected_pending_revision: null
        }
      ]);
      expect(harness.selectThis()).toBeUndefined();
      expect(harness.selectSignalObserved()).toBe(true);
      expect(harness.acceptedBeforeSelect()).toBe(true);
      const trail = harness.auditRepository.require(modelRequest.operation_id);
      expect(trail).toMatchObject({
        state: "terminal",
        records: [
          {
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
            phase: "terminal",
            outcome: "succeeded",
            payload_summary: { schema_version: 1, changed: true }
          }
        ]
      });
      expect(harness.rawAuditRecords(modelRequest.operation_id).join("\n")).not.toMatch(/runtime-b|Model B|Thorough/u);
    } finally {
      await harness.close();
    }
  });

  it("records already-current no-op and exact pending clear without claiming settings application", async () => {
    const noOpRequest = {
      ...modelRequest,
      operation_id: "op_model_route_noop",
      model_id: "model-a",
      reasoning_effort: "high"
    };
    const noOp = await createHarness({ selectResults: [modelSnapshot()] });
    try {
      const response = await selectModel(noOp, noOpRequest);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual(modelSnapshot());
      expect(noOp.auditRepository.require(noOpRequest.operation_id).records[1]).toMatchObject({
        outcome: "succeeded",
        payload_summary: { schema_version: 1, changed: false }
      });
    } finally {
      await noOp.close();
    }

    const clearRequest = {
      ...noOpRequest,
      operation_id: "op_model_route_clear",
      expected_pending_revision: 4
    };
    const clear = await createHarness({ selectResults: [modelSnapshot()] });
    try {
      const response = await selectModel(clear, clearRequest);
      expect(response.statusCode, response.body).toBe(200);
      expect(clear.auditRepository.require(clearRequest.operation_id).records[1]).toMatchObject({
        outcome: "succeeded",
        payload_summary: { schema_version: 1, changed: true }
      });
      expect(response.body).not.toMatch(/applied|running|completed/iu);
    } finally {
      await clear.close();
    }
  });

  it("rejects malformed input, adjacent methods and paths, query, and lock before model access", async () => {
    const harness = await createHarness();
    try {
      for (const candidate of [
        { ...modelRequest, target: { session_id: sessionId, codex_thread_id: "thread-injected" } },
        { ...modelRequest, runtime_model: "runtime-b" },
        { ...modelRequest, expected_pending_revision: 0 },
        { ...modelRequest, reasoning_effort: "" }
      ]) {
        expectStableError(await selectModel(harness, candidate), 400, "validation_error");
      }
      expectStableError(
        await injectHostDeckLoopback(harness.app, { method: "GET", url: `/api/v1/sessions/${sessionId}/model?target=other` }),
        400,
        "validation_error"
      );
      expectStableError(
        await injectHostDeckLoopback(harness.app, {
          method: "GET",
          url: `/api/v1/sessions/${sessionId}/model`,
          headers: {
            "content-length": "19",
            "content-type": "application/json"
          },
          payload: '{"unexpected":true}'
        }),
        400,
        "validation_error"
      );
      expectStableError(
        await injectHostDeckLoopback(harness.app, {
          method: "POST",
          url: `/api/v1/sessions/${sessionId}/model?target=other`,
          payload: modelRequest
        }),
        400,
        "validation_error"
      );
      expectStableError(
        await injectHostDeckLoopback(harness.app, { method: "HEAD", url: `/api/v1/sessions/${sessionId}/model` }),
        405,
        "method_not_allowed"
      );
      expectStableError(
        await injectHostDeckLoopback(harness.app, { method: "PUT", url: `/api/v1/sessions/${sessionId}/model` }),
        405,
        "method_not_allowed"
      );
      expectStableError(
        await injectHostDeckLoopback(harness.app, { method: "GET", url: `/api/v1/sessions/${sessionId}/model/extra` }),
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
        await selectModel(locked, { ...modelRequest, operation_id: "op_model_route_locked" }),
        423,
        "host_locked"
      );
      expect(locked.stateReads()).toBe(0);
      expect(locked.selectCalls()).toEqual([]);
    } finally {
      await locked.close();
    }
  });

  it("fails closed for missing, archived, stale, recovery, contradictory, and unavailable runtime state", async () => {
    const stateCases: readonly [string, readonly unknown[], number, string][] = [
      ["missing", [null], 404, "session_not_found"],
      ["archived", [selectedState("archived")], 409, "session_not_writable"],
      ["stale", [selectedState("stale")], 409, "stale_session"],
      ["recovery", [selectedState("recovery")], 409, "stale_session"],
      ["contradictory", [selectedState("contradictory")], 409, "stale_session"]
    ];
    for (const [label, states, status, code] of stateCases) {
      const harness = await createHarness({ stateResults: states });
      const operationId = `op_model_route_state_${label}`;
      try {
        expectStableError(await selectModel(harness, { ...modelRequest, operation_id: operationId }), status, code);
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
      ["incompatible", runtimeCandidate({ state: "incompatible", unavailableCapability: "turn_input" }), 409, "incompatible_runtime"],
      ["capability", runtimeCandidate({ state: "incompatible", unavailableCapability: "model" }), 409, "capability_unavailable"],
      ["blocked", runtimeCandidate({ state: "degraded", mutationPolicy: "blocked" }), 409, "incompatible_runtime"]
    ];
    for (const [label, runtime, status, code] of runtimeCases) {
      const harness = await createHarness({ runtimeResults: [runtime] });
      const operationId = `op_model_route_runtime_${label}`;
      try {
        expectStableError(await selectModel(harness, { ...modelRequest, operation_id: operationId }), status, code, code === "runtime_unavailable");
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
      expect((await readModel(readBlocked)).statusCode).toBe(200);
    } finally {
      await readBlocked.close();
    }
  });

  it("brackets GET identity and distinguishes pre-select from post-select drift", async () => {
    const readDrift = await createHarness({
      stateResults: [selectedState("active"), selectedState("contradictory")]
    });
    try {
      expectStableError(await readModel(readDrift), 409, "stale_session");
      expect(readDrift.snapshotCalls()).toHaveLength(1);
    } finally {
      await readDrift.close();
    }

    const preOperationId = "op_model_route_preselect_drift";
    const pre = await createHarness({
      stateResults: [selectedState("active"), selectedState("contradictory")]
    });
    try {
      expectStableError(await selectModel(pre, { ...modelRequest, operation_id: preOperationId }), 409, "stale_session");
      expect(pre.selectCalls()).toEqual([]);
      expect(pre.auditRepository.require(preOperationId).records[1]).toMatchObject({
        outcome: "failed",
        error_code: "stale_session"
      });
    } finally {
      await pre.close();
    }

    const postOperationId = "op_model_route_postselect_drift";
    const post = await createHarness({
      stateResults: [selectedState("active"), selectedState("active"), selectedState("contradictory")]
    });
    try {
      expectStableError(await selectModel(post, { ...modelRequest, operation_id: postOperationId }), 409, "stale_session");
      expect(post.selectCalls()).toHaveLength(1);
      expect(post.auditRepository.require(postOperationId).records[1]).toMatchObject({
        outcome: "incomplete",
        error_code: "stale_session"
      });
    } finally {
      await post.close();
    }
  });

  it("maps typed service failures and treats malformed post-selection state as incomplete", async () => {
    const cases: readonly [string, HostDeckCodexModelControlError, number, string, boolean][] = [
      ["unknown-model", modelServiceError("model_unknown", "validation_error"), 400, "validation_error", true],
      ["effort", modelServiceError("effort_unsupported", "capability_unavailable"), 409, "capability_unavailable", false],
      ["conflict", modelServiceError("operation_conflict", "operation_conflict"), 409, "operation_conflict", true],
      ["timeout", modelServiceError("operation_timeout", "operation_timeout", "unknown"), 504, "operation_timeout", false],
      ["protocol", modelServiceError("runtime_protocol_error", "protocol_error"), 502, "protocol_error", false]
    ];
    for (const [label, error, status, code, retryable] of cases) {
      const harness = await createHarness({ selectError: error });
      const operationId = `op_model_route_error_${label}`;
      try {
        const response = await selectModel(harness, { ...modelRequest, operation_id: operationId });
        expectStableError(response, status, code, retryable);
        expect(response.body).not.toContain("private-model-service");
        expect(harness.auditRepository.require(operationId).records[1]).toMatchObject({
          outcome: "failed",
          error_code: code
        });
      } finally {
        await harness.close();
      }
    }

    const malformed = await createHarness({ selectResults: [{ private: "private-model-result" }] });
    try {
      const operationId = "op_model_route_malformed";
      const response = await selectModel(malformed, { ...modelRequest, operation_id: operationId });
      expectStableError(response, 500, "internal_error");
      expect(response.body).not.toContain("private-model-result");
      expect(malformed.auditRepository.require(operationId).records[1]).toMatchObject({
        outcome: "incomplete",
        error_code: "internal_error"
      });
    } finally {
      await malformed.close();
    }

    const rollbackOperationId = "op_model_route_revision_rollback";
    const staged = stagedSnapshot(rollbackOperationId);
    const rollback = await createHarness({
      selectResults: [
        {
          ...staged,
          pending: { ...staged.pending, revision: 2 }
        }
      ]
    });
    try {
      const response = await selectModel(rollback, {
        ...modelRequest,
        operation_id: rollbackOperationId,
        expected_pending_revision: 3
      });
      expectStableError(response, 500, "internal_error");
      expect(rollback.auditRepository.require(rollbackOperationId).records[1]).toMatchObject({
        outcome: "incomplete",
        error_code: "internal_error"
      });
    } finally {
      await rollback.close();
    }
  });

  it("replays duplicate operation results and keeps response-loss selection authoritative", async () => {
    const duplicate = await createHarness();
    try {
      const first = await selectModel(duplicate, modelRequest);
      expect(first.statusCode, first.body).toBe(200);
      const replay = await selectModel(duplicate, modelRequest);
      expect(replay.statusCode, replay.body).toBe(200);
      expect(replay.json()).toEqual(first.json());
      expect(duplicate.selectCalls()).toHaveLength(1);
      expect(duplicate.auditRepository.require(modelRequest.operation_id).records).toHaveLength(2);
    } finally {
      await duplicate.close();
    }

    let releaseSelect: (() => void) | undefined;
    const barrier = new Promise<void>((resolve) => {
      releaseSelect = resolve;
    });
    const operationId = "op_model_route_response_loss";
    const loss = await createHarness({ selectBarrier: barrier });
    try {
      await loss.app.listen({ host: "127.0.0.1", port: 0, listenTextResolver: () => "" });
      const address = loss.app.server.address();
      if (address === null || typeof address === "string") throw new Error("Model response-loss listener is unavailable.");
      const body = JSON.stringify({ ...modelRequest, operation_id: operationId });
      const outgoing = httpRequest({
        hostname: "127.0.0.1",
        port: address.port,
        method: "POST",
        path: `/api/v1/sessions/${sessionId}/model`,
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
      const replay = await selectModel(loss, { ...modelRequest, operation_id: operationId });
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

  it("suppresses success when terminal audit cannot be proven and preserves bounded raw rows", async () => {
    const harness = await createHarness();
    const operationId = "op_model_route_terminal_audit";
    try {
      harness.failTerminalAudit();
      expectStableError(
        await selectModel(harness, { ...modelRequest, operation_id: operationId }),
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
      expect(raw).toContain("model-b");
      expect(raw).not.toMatch(/runtime-b|Model B|Thorough|private-model/iu);
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
  readonly admission: CreateHostDeckModelRouteRegistrationInput["admission"];
  readonly audit: ReturnType<typeof createHostDeckSelectedWriteAuditExecutor>;
  readonly csrf: ReturnType<typeof createHostDeckCsrfPolicy>;
  readonly lock: ReturnType<typeof createHostDeckHostLockPolicy>;
  readonly models: CreateHostDeckModelRouteRegistrationInput["models"];
  readonly runtime: CreateHostDeckModelRouteRegistrationInput["runtime"];
  readonly state: CreateHostDeckModelRouteRegistrationInput["state"];
}

interface Harness {
  readonly app: HostDeckFastifyInstance;
  readonly auditRepository: SelectedAuditRepository;
  readonly registration: HostDeckRoutePluginRegistration;
  readonly routeInput: RouteInputFixture;
  readonly acceptedBeforeSelect: () => boolean;
  readonly selectCalls: () => readonly Record<string, unknown>[];
  readonly selectSignalObserved: () => boolean;
  readonly selectThis: () => unknown;
  readonly snapshotCalls: () => readonly unknown[];
  readonly snapshotSignalObserved: () => boolean;
  readonly stateReads: () => number;
  readonly runtimeReads: () => number;
  readonly rawAuditRecords: (operationId: string) => readonly string[];
  readonly failTerminalAudit: () => void;
  readonly close: () => Promise<void>;
}

async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const directory = mkdtempSync(join(tmpdir(), "hostdeck-model-route-"));
  temporaryDirectories.push(directory);
  const open = openMigratedDatabase(join(directory, "hostdeck.sqlite"), { now: () => new Date(timestamp) });
  let clock = new Date(timestamp).getTime();
  const nextDate = () => new Date(clock++);
  const auditRepository = createSelectedAuditRepository(open.db);
  let auditId = 0;
  const audit = createHostDeckSelectedWriteAuditExecutor({
    repository: auditRepository,
    now: () => nextDate().toISOString(),
    create_record_id: () => `audit_model_route_${++auditId}`
  });
  const csrf = createHostDeckCsrfPolicy({
    csrf: {
      authorizeBrowserWrite() {
        throw new Error("Loopback model route must not authorize browser CSRF.");
      },
      rotateBootstrap() {
        throw new Error("Loopback model route must not rotate browser CSRF.");
      }
    },
    now: nextDate
  });
  const lock = createHostDeckHostLockPolicy({
    settings: {
      read: () => settings(options.locked === true),
      transition() {
        throw new Error("Model route must not transition host lock.");
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
    models: {
      async snapshot(target: unknown, deadline: OperationDeadline) {
        snapshotCalls.push(target);
        snapshotSignalObserved = deadline.signal instanceof AbortSignal;
        if (options.snapshotError !== undefined) throw options.snapshotError;
        return sequenceValue(options.snapshotResults ?? [modelSnapshot()], snapshotIndex++);
      },
      async select(this: void, intent: unknown, deadline: OperationDeadline) {
        selectThis = this;
        const captured = { ...(intent as Record<string, unknown>) };
        selectCalls.push(captured);
        selectSignalObserved = deadline.signal instanceof AbortSignal;
        acceptedBeforeSelect = auditRepository.get(String(captured.operation_id ?? ""))?.records[0]?.phase === "accepted";
        await options.selectBarrier;
        if (options.selectError !== undefined) throw options.selectError;
        if (options.selectResults !== undefined) return sequenceValue(options.selectResults, selectIndex++);
        return stagedSnapshot(String(captured.operation_id ?? ""));
      }
    } as unknown as RouteInputFixture["models"],
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
  const registration = createHostDeckModelRouteRegistration(routeInput);
  const app = createHostDeckFastifyApp({
    observeInternalError: () => undefined,
    requestAuthenticationPolicy: createHostDeckRequestAuthenticationPolicy({
      authenticateDeviceToken: () => {
        throw new Error("Loopback model route must not authenticate a device.");
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
        CREATE TRIGGER fail_model_terminal_audit
        BEFORE INSERT ON selected_audit_events
        WHEN NEW.phase = 'terminal'
        BEGIN
          SELECT RAISE(ABORT, 'forced model terminal audit failure');
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

function selectedState(state: "active" | "archived" | "contradictory" | "recovery" | "stale"): SelectedSessionState {
  const archivedAt = state === "archived" ? timestamp : null;
  const mapping = selectedSessionMappingRecordSchema.parse({
    id: sessionId,
    name: "model-route-session",
    codex_thread_id: threadId,
    cwd: "/tmp/hostdeck-model-route",
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
      cwd: state === "contradictory" ? "/tmp/hostdeck-model-route-other" : mapping.cwd,
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
      recent_summary: "Managed model route test session.",
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
    binding_id: connected ? "binding-model-route-001" : null,
    capabilities: runtimeCapabilities.map((name) =>
      name === input.unavailableCapability ||
      (state === "incompatible" && input.unavailableCapability === undefined && name === "model")
        ? { name, state: "unavailable", reason: "Capability is unavailable." }
        : { name, state: "available", reason: null }
    ),
    checked_at: timestamp,
    reason: state === "ready" ? null : "Runtime is not ready."
  });
}

function modelSnapshot(): ModelControlSnapshot {
  return modelControlSnapshotSchema.parse({
    catalog_revision: "a".repeat(64),
    catalog_observed_at: timestamp,
    current: {
      model_id: "model-a",
      runtime_model: "runtime-a",
      reasoning_effort: "high",
      catalog_state: "available",
      observed_at: timestamp
    },
    pending: null,
    models: modelCatalog()
  });
}

function stagedSnapshot(operationId: string): ModelControlSnapshot {
  return modelControlSnapshotSchema.parse({
    ...modelSnapshot(),
    pending: {
      revision: 4,
      selection_operation_id: operationId,
      model_id: "model-b",
      runtime_model: "runtime-b",
      reasoning_effort: "high",
      catalog_state: "available",
      phase: "pending",
      selected_at: timestamp,
      turn_id: null,
      error: null
    }
  });
}

function modelCatalog(): ModelControlSnapshot["models"] {
  return [
    {
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
    },
    {
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
    }
  ];
}

function settings(locked: boolean) {
  return Object.freeze({
    locked,
    settings_updated_at: timestamp
  });
}

function modelServiceError(
  code: CodexModelControlErrorCode,
  apiCode: ConstructorParameters<typeof HostDeckCodexModelControlError>[1],
  outcome: CodexModelControlOutcome = "not_sent"
): HostDeckCodexModelControlError {
  return new HostDeckCodexModelControlError(code, apiCode, "private-model-service-error", outcome, true);
}

function sequenceValue(values: readonly unknown[], index: number): unknown {
  const value = values[Math.min(index, values.length - 1)];
  if (value === undefined) throw new Error("Model route test sequence is empty.");
  return value;
}

async function readModel(harness: Pick<Harness, "app">) {
  return await injectHostDeckLoopback(harness.app, { method: "GET", url: `/api/v1/sessions/${sessionId}/model` });
}

async function selectModel(harness: Pick<Harness, "app">, payload: Readonly<Record<string, unknown>>) {
  return await injectHostDeckLoopback(harness.app, { method: "POST", url: `/api/v1/sessions/${sessionId}/model`, payload });
}

function expectStableError(
  response: { readonly statusCode: number; readonly body: string; readonly json: () => unknown },
  status: number,
  code: string,
  retryable = false
): void {
  expect(response.statusCode, response.body).toBe(status);
  expect(response.json()).toMatchObject({ error: { code, retryable } });
  expect(response.body).not.toContain("private-model");
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for model route condition.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
