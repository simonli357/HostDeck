import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultResourceBudget,
  defaultRetentionPolicy,
  type RuntimeCompatibility,
  runtimeCompatibilitySchema,
  type SelectedOperationProgress,
  selectedOperationProgressSchema,
  selectedSessionMappingRecordSchema,
  selectedSessionProjectionRecordSchema
} from "@hostdeck/contracts";
import { runtimeCapabilities } from "@hostdeck/core";
import {
  createAuthDeviceRepository,
  createSelectedAuditRepository,
  createSelectedCsrfAuthorizationRepository,
  openMigratedDatabase,
  type SelectedAuditRepository,
  type SelectedSessionState
} from "@hostdeck/storage";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CodexCompactControlErrorCode,
  type CodexCompactControlOutcome,
  HostDeckCodexCompactControlError
} from "./codex-compact-control-service.js";
import {
  type CreateHostDeckCompactRouteRegistrationInput,
  createHostDeckCompactRouteRegistration,
  hostDeckCompactRouteRegistrationId
} from "./compact-routes.js";
import { createHostDeckCsrfPolicy } from "./csrf-routes.js";
import {
  createHostDeckFastifyApp,
  type HostDeckFastifyInstance,
  type HostDeckRoutePluginRegistration
} from "./fastify-app.js";
import {
  createHostDeckRequestAuthenticationPolicy,
  hostDeckDeviceCookieName
} from "./fastify-request-authentication.js";
import { createHostDeckRequestTrustPolicy } from "./fastify-request-trust.js";
import { createHostDeckHostLockPolicy } from "./host-lock-routes.js";
import { createHostDeckLanCertificatePolicy } from "./lan-certificate-policy.js";
import { createHostDeckSelectedWriteAdmissionPolicy } from "./selected-write-admission-policy.js";
import { createHostDeckSelectedWriteAuditExecutor } from "./selected-write-audit-executor.js";

const temporaryDirectories: string[] = [];
const timestamp = "2026-07-16T12:00:00.000Z";
const acceptedAt = "2026-07-16T12:00:01.000Z";
const runtimeVersion = "0.144.0";
const sessionId = "sess_compact_route_001";
const threadId = "thread-compact-route-001";
const turnId = "turn-compact-route-001";
const secureOrigin = "https://192.168.0.29:3777";
const pairedDeviceId = "client_compact_route_writer";
const pairedDeviceToken = "W".repeat(43);
const pairedCsrfToken = "C".repeat(43);
const startRequest = Object.freeze({
  operation_id: "op_compact_route_001",
  kind: "compact" as const,
  confirm: true as const
});

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("selected managed-session compact routes", () => {
  it("requires exact composition and registers both manifest routes once", async () => {
    const harness = await createHarness();
    try {
      expect(harness.registration).toMatchObject({ id: hostDeckCompactRouteRegistrationId, surface: "api" });
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
          throw new Error("private-compact-accessor");
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
        { ...harness.routeInput, compact: {} },
        { ...harness.routeInput, compact: { ...harness.routeInput.compact, extra: true } },
        { ...harness.routeInput, csrf: {} },
        { ...harness.routeInput, lock: {} },
        { ...harness.routeInput, runtime: {} },
        { ...harness.routeInput, state: {} },
        accessor
      ]) {
        expect(() => createHostDeckCompactRouteRegistration(candidate as never)).toThrow();
      }
      expect(accessorCalls).toBe(0);
    } finally {
      await harness.close();
    }
  });

  it("reads explicit absence and dispatches one accepted-only compact with exact audit truth", async () => {
    const harness = await createHarness();
    try {
      const read = await readCompact(harness);
      expect(read.statusCode, read.body).toBe(200);
      expect(read.headers["cache-control"]).toBe("no-store");
      expect(read.headers.pragma).toBe("no-cache");
      expect(read.json()).toEqual({ progress: null });
      expect(harness.snapshotCalls()).toEqual([managedTarget()]);

      const response = await startCompact(harness, startRequest);
      expect(response.statusCode, response.body).toBe(202);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers.pragma).toBe("no-cache");
      expect(response.json()).toEqual({ progress: acceptedProgress(startRequest.operation_id) });
      expect(response.body).not.toMatch(/completed|compacted|token|saving/iu);
      expect(harness.startCalls()).toEqual([
        {
          operation_id: startRequest.operation_id,
          target: managedTarget(),
          kind: "compact",
          confirm: true
        }
      ]);
      expect(harness.startThis()).toBeUndefined();
      expect(harness.startSignalObserved()).toBe(true);
      expect(harness.acceptedBeforeStart()).toBe(true);
      expect(harness.auditRepository.require(startRequest.operation_id)).toMatchObject({
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
      const raw = harness.rawAuditRecords(startRequest.operation_id).join("\n");
      expect(raw).not.toMatch(/private-compact|contextCompaction|thread\/compact|token|\/compact/iu);
      expect(raw.match(/thread-compact-route-001/gu)).toHaveLength(2);
    } finally {
      await harness.close();
    }
  });

  it("returns every strict progress state and canonicalizes private failure details", async () => {
    for (const state of ["accepted", "running", "completed", "interrupted"] as const) {
      const harness = await createHarness({ snapshotResults: [progress(state)] });
      try {
        const response = await readCompact(harness);
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json()).toEqual({ progress: progress(state) });
      } finally {
        await harness.close();
      }
    }

    for (const state of ["failed", "incomplete"] as const) {
      const harness = await createHarness({ snapshotResults: [progress(state, "private-compact token cwd cookie")] });
      try {
        const response = await readCompact(harness);
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json()).toMatchObject({
          progress: {
            state,
            error: {
              code: "unknown_error",
              message: "Compact outcome is unknown and requires reconciliation.",
              retryable: false
            }
          }
        });
        expect(response.body).not.toContain("private-compact");
      } finally {
        await harness.close();
      }
    }
  });

  it("rejects malformed input, adjacent methods, query, lock, and active-turn start before compact access", async () => {
    const harness = await createHarness();
    try {
      for (const candidate of [
        { ...startRequest, confirm: false },
        { ...startRequest, target: managedTarget() },
        { ...startRequest, thread_id: threadId },
        { ...startRequest, text: "/compact" },
        { ...startRequest, force: true }
      ]) {
        expectStableError(await startCompact(harness, candidate), 400, "validation_error");
      }
      expectStableError(
        await harness.app.inject({ method: "GET", url: `/api/v1/sessions/${sessionId}/compact?x=1` }),
        400,
        "validation_error"
      );
      expectStableError(
        await harness.app.inject({
          method: "GET",
          url: `/api/v1/sessions/${sessionId}/compact`,
          headers: { "content-length": "19", "content-type": "application/json" },
          payload: '{"unexpected":true}'
        }),
        400,
        "validation_error"
      );
      expectStableError(
        await harness.app.inject({ method: "HEAD", url: `/api/v1/sessions/${sessionId}/compact` }),
        405,
        "method_not_allowed"
      );
      expectStableError(
        await harness.app.inject({ method: "PUT", url: `/api/v1/sessions/${sessionId}/compact` }),
        405,
        "method_not_allowed"
      );
      expectStableError(
        await harness.app.inject({ method: "GET", url: `/api/v1/sessions/${sessionId}/compact/extra` }),
        404,
        "route_not_found"
      );
      expect(harness.stateReads()).toBe(0);
      expect(harness.snapshotCalls()).toEqual([]);
      expect(harness.startCalls()).toEqual([]);
    } finally {
      await harness.close();
    }

    const locked = await createHarness({ locked: true });
    try {
      expectStableError(
        await startCompact(locked, { ...startRequest, operation_id: "op_compact_route_locked" }),
        423,
        "host_locked"
      );
      expect(locked.stateReads()).toBe(0);
      expect(locked.startCalls()).toEqual([]);
    } finally {
      await locked.close();
    }

    const active = await createHarness({ stateResults: [selectedState("active_turn")] });
    try {
      expect((await readCompact(active)).statusCode).toBe(200);
      expectStableError(
        await startCompact(active, { ...startRequest, operation_id: "op_compact_route_active" }),
        409,
        "operation_conflict",
        true
      );
      expect(active.startCalls()).toEqual([]);
      expect(active.auditRepository.get("op_compact_route_active")).toBeNull();
    } finally {
      await active.close();
    }
  });

  it("fails closed for selected-state and runtime admission while allowing blocked reads", async () => {
    const stateCases: readonly [string, unknown, number, string][] = [
      ["missing", null, 404, "session_not_found"],
      ["archived", selectedState("archived"), 409, "session_not_writable"],
      ["stale", selectedState("stale"), 409, "stale_session"],
      ["recovery", selectedState("recovery"), 409, "stale_session"],
      ["contradictory", selectedState("contradictory"), 409, "stale_session"]
    ];
    for (const [label, state, status, code] of stateCases) {
      const harness = await createHarness({ stateResults: [state] });
      const operationId = `op_compact_route_state_${label}`;
      try {
        expectStableError(await startCompact(harness, { ...startRequest, operation_id: operationId }), status, code);
        expect(harness.runtimeReads()).toBe(0);
        expect(harness.startCalls()).toEqual([]);
        expect(harness.auditRepository.get(operationId)).toBeNull();
      } finally {
        await harness.close();
      }
    }

    const runtimeCases: readonly [string, unknown, number, string, boolean][] = [
      ["drift", runtimeCandidate({ version: "0.145.0" }), 409, "stale_session", false],
      ["disconnected", runtimeCandidate({ state: "disconnected" }), 503, "runtime_unavailable", true],
      [
        "incompatible",
        runtimeCandidate({ state: "incompatible", unavailableCapability: "turn_input" }),
        409,
        "incompatible_runtime",
        false
      ],
      [
        "capability",
        runtimeCandidate({ state: "ready", unavailableCapability: "compact" }),
        409,
        "capability_unavailable",
        false
      ],
      ["blocked", runtimeCandidate({ state: "degraded", mutationPolicy: "blocked" }), 409, "incompatible_runtime", false]
    ];
    for (const [label, runtime, status, code, retryable] of runtimeCases) {
      const harness = await createHarness({ runtimeResults: [runtime] });
      const operationId = `op_compact_route_runtime_${label}`;
      try {
        expectStableError(
          await startCompact(harness, { ...startRequest, operation_id: operationId }),
          status,
          code,
          retryable
        );
        expect(harness.startCalls()).toEqual([]);
        expect(harness.auditRepository.get(operationId)).toBeNull();
      } finally {
        await harness.close();
      }
    }

    const readBlocked = await createHarness({
      runtimeResults: [runtimeCandidate({ state: "degraded", mutationPolicy: "blocked" })]
    });
    try {
      expect((await readCompact(readBlocked)).statusCode).toBe(200);
    } finally {
      await readBlocked.close();
    }
  });

  it("brackets read and dispatch continuity without rejecting the compact turn that starts after acceptance", async () => {
    const readDrift = await createHarness({
      stateResults: [selectedState("idle"), selectedState("contradictory")]
    });
    try {
      expectStableError(await readCompact(readDrift), 409, "stale_session");
      expect(readDrift.snapshotCalls()).toHaveLength(1);
    } finally {
      await readDrift.close();
    }

    const preOperationId = "op_compact_route_pre_drift";
    const pre = await createHarness({ stateResults: [selectedState("idle"), selectedState("contradictory")] });
    try {
      expectStableError(await startCompact(pre, { ...startRequest, operation_id: preOperationId }), 409, "stale_session");
      expect(pre.startCalls()).toEqual([]);
      expect(pre.auditRepository.require(preOperationId).records[1]).toMatchObject({
        outcome: "failed",
        error_code: "stale_session"
      });
    } finally {
      await pre.close();
    }

    const acceptedRaceId = "op_compact_route_turn_race";
    const acceptedRace = await createHarness({
      stateResults: [selectedState("idle"), selectedState("idle"), selectedState("active_turn")]
    });
    try {
      const response = await startCompact(acceptedRace, { ...startRequest, operation_id: acceptedRaceId });
      expect(response.statusCode, response.body).toBe(202);
      expect(acceptedRace.startCalls()).toHaveLength(1);
    } finally {
      await acceptedRace.close();
    }

    const postOperationId = "op_compact_route_post_drift";
    const post = await createHarness({
      runtimeResults: [
        runtimeCandidate(),
        runtimeCandidate(),
        runtimeCandidate({ bindingId: "binding-compact-route-002" })
      ]
    });
    try {
      expectStableError(await startCompact(post, { ...startRequest, operation_id: postOperationId }), 409, "incompatible_runtime");
      expect(post.startCalls()).toHaveLength(1);
      expect(post.auditRepository.require(postOperationId).records[1]).toMatchObject({
        outcome: "incomplete",
        error_code: "incompatible_runtime"
      });
    } finally {
      await post.close();
    }
  });

  it("maps known failures to failed, unknown delivery to incomplete, and malformed accepted data to incomplete", async () => {
    const cases: readonly [string, HostDeckCodexCompactControlError, number, string, string][] = [
      [
        "conflict",
        compactServiceError("operation_conflict", "operation_conflict", "not_sent"),
        409,
        "operation_conflict",
        "failed"
      ],
      [
        "protocol",
        compactServiceError("runtime_protocol_error", "protocol_error", "not_sent"),
        502,
        "protocol_error",
        "failed"
      ],
      [
        "unknown",
        compactServiceError("unknown_outcome", "unknown_error", "unknown"),
        409,
        "unknown_error",
        "incomplete"
      ]
    ];
    for (const [label, error, status, code, outcome] of cases) {
      const operationId = `op_compact_route_error_${label}`;
      const harness = await createHarness({ startError: error });
      try {
        const response = await startCompact(harness, { ...startRequest, operation_id: operationId });
        expectStableError(response, status, code, code === "operation_conflict");
        expect(response.body).not.toContain("private-compact");
        expect(harness.auditRepository.require(operationId).records[1]).toMatchObject({ outcome, error_code: code });
      } finally {
        await harness.close();
      }
    }

    const malformed: readonly [string, unknown][] = [
      ["null", null],
      ["extra", { ...acceptedProgress(startRequest.operation_id), private: true }],
      ["operation", acceptedProgress("op_compact_route_other")],
      ["target", { ...acceptedProgress(startRequest.operation_id), target: { ...managedTarget(), session_id: "sess_other" } }],
      ["running", progress("running")],
      ["completed", progress("completed")]
    ];
    for (const [label, candidate] of malformed) {
      const operationId = `op_compact_route_malformed_${label}`;
      const harness = await createHarness({ startResults: [candidate] });
      try {
        expectStableError(await startCompact(harness, { ...startRequest, operation_id: operationId }), 500, "internal_error");
        expect(harness.auditRepository.require(operationId).records[1]).toMatchObject({
          outcome: "incomplete",
          error_code: "internal_error"
        });
      } finally {
        await harness.close();
      }
    }
  });

  it("replays duplicate operation results, preserves response-loss truth, and suppresses unproven audit success", async () => {
    const duplicate = await createHarness();
    try {
      const first = await startCompact(duplicate, startRequest);
      expect(first.statusCode, first.body).toBe(202);
      const replay = await startCompact(duplicate, startRequest);
      expect(replay.statusCode, replay.body).toBe(202);
      expect(replay.json()).toEqual(first.json());
      expect(duplicate.startCalls()).toHaveLength(1);
    } finally {
      await duplicate.close();
    }

    let releaseStart: (() => void) | undefined;
    const barrier = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const operationId = "op_compact_route_response_loss";
    const loss = await createHarness({ startBarrier: barrier });
    try {
      await loss.app.listen({ host: "127.0.0.1", port: 0, listenTextResolver: () => "" });
      const address = loss.app.server.address();
      if (address === null || typeof address === "string") throw new Error("Compact response-loss listener is unavailable.");
      const body = JSON.stringify({ ...startRequest, operation_id: operationId });
      const outgoing = httpRequest({
        hostname: "127.0.0.1",
        port: address.port,
        method: "POST",
        path: `/api/v1/sessions/${sessionId}/compact`,
        headers: {
          host: "localhost",
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
      await waitFor(() => loss.startCalls().length === 1);
      outgoing.destroy();
      releaseStart?.();
      await closed;
      await waitFor(() => loss.auditRepository.get(operationId)?.state === "terminal");
      const replay = await startCompact(loss, { ...startRequest, operation_id: operationId });
      expect(replay.statusCode, replay.body).toBe(202);
      expect(replay.json()).toMatchObject({
        progress: { operation_id: operationId, state: "accepted" }
      });
      expect(loss.startCalls()).toHaveLength(1);
    } finally {
      releaseStart?.();
      await loss.close();
    }

    const terminalAudit = await createHarness();
    const terminalAuditId = "op_compact_route_terminal_audit";
    try {
      terminalAudit.failTerminalAudit();
      expectStableError(
        await startCompact(terminalAudit, { ...startRequest, operation_id: terminalAuditId }),
        503,
        "audit_unavailable"
      );
      expect(terminalAudit.startCalls()).toHaveLength(1);
      expect(terminalAudit.auditRepository.require(terminalAuditId)).toMatchObject({
        state: "pending",
        records: [{ phase: "accepted", outcome: "accepted" }]
      });
    } finally {
      await terminalAudit.close();
    }
  });

  it("supports paired HTTPS reads and writer starts while rejecting read-only mutation before state", async () => {
    const writer = await createPairedHarness("write");
    try {
      expect((await secureCompact(writer, "GET")).statusCode).toBe(200);
      const operationId = "op_compact_route_paired_writer";
      const response = await secureCompact(writer, "POST", { ...startRequest, operation_id: operationId });
      expect(response.statusCode, response.body).toBe(202);
      expect(writer.startCalls()).toHaveLength(1);
      expect(writer.auditRepository.require(operationId).records[0]).toMatchObject({
        actor: {
          type: "dashboard",
          device_id: pairedDeviceId,
          permission: "write",
          origin: secureOrigin
        }
      });
    } finally {
      await writer.close();
    }

    const reader = await createPairedHarness("read");
    try {
      expect((await secureCompact(reader, "GET")).statusCode).toBe(200);
      const operationId = "op_compact_route_paired_reader";
      expectStableError(
        await secureCompact(reader, "POST", { ...startRequest, operation_id: operationId }),
        403,
        "read_only"
      );
      expect(reader.startCalls()).toEqual([]);
      expect(reader.stateReads()).toBe(2);
      expect(reader.auditRepository.get(operationId)).toBeNull();
    } finally {
      await reader.close();
    }
  });
});

interface HarnessOptions {
  readonly locked?: boolean;
  readonly runtimeResults?: readonly unknown[];
  readonly snapshotError?: Error;
  readonly snapshotResults?: readonly unknown[];
  readonly startBarrier?: Promise<void>;
  readonly startError?: Error;
  readonly startResults?: readonly unknown[];
  readonly stateResults?: readonly unknown[];
}

interface RouteInputFixture {
  readonly admission: CreateHostDeckCompactRouteRegistrationInput["admission"];
  readonly audit: ReturnType<typeof createHostDeckSelectedWriteAuditExecutor>;
  readonly compact: CreateHostDeckCompactRouteRegistrationInput["compact"];
  readonly csrf: ReturnType<typeof createHostDeckCsrfPolicy>;
  readonly lock: ReturnType<typeof createHostDeckHostLockPolicy>;
  readonly runtime: CreateHostDeckCompactRouteRegistrationInput["runtime"];
  readonly state: CreateHostDeckCompactRouteRegistrationInput["state"];
}

interface Harness {
  readonly acceptedBeforeStart: () => boolean;
  readonly app: HostDeckFastifyInstance;
  readonly auditRepository: SelectedAuditRepository;
  readonly close: () => Promise<void>;
  readonly failTerminalAudit: () => void;
  readonly rawAuditRecords: (operationId: string) => readonly string[];
  readonly registration: HostDeckRoutePluginRegistration;
  readonly routeInput: RouteInputFixture;
  readonly runtimeReads: () => number;
  readonly snapshotCalls: () => readonly unknown[];
  readonly startCalls: () => readonly Record<string, unknown>[];
  readonly startSignalObserved: () => boolean;
  readonly startThis: () => unknown;
  readonly stateReads: () => number;
}

interface PairedHarness extends Pick<Harness, "app" | "auditRepository" | "close" | "startCalls" | "stateReads"> {}

async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const directory = mkdtempSync(join(tmpdir(), "hostdeck-compact-route-"));
  temporaryDirectories.push(directory);
  const open = openMigratedDatabase(join(directory, "hostdeck.sqlite"), { now: () => new Date(timestamp) });
  let clock = new Date(timestamp).getTime();
  const nextDate = () => new Date(clock++);
  const auditRepository = createSelectedAuditRepository(open.db);
  let auditId = 0;
  const audit = createHostDeckSelectedWriteAuditExecutor({
    repository: auditRepository,
    now: () => nextDate().toISOString(),
    create_record_id: () => `audit_compact_route_${++auditId}`
  });
  const csrf = createHostDeckCsrfPolicy({
    csrf: {
      authorizeBrowserWrite() {
        throw new Error("Loopback compact route must not authorize browser CSRF.");
      },
      rotateBootstrap() {
        throw new Error("Loopback compact route must not rotate browser CSRF.");
      }
    },
    now: nextDate
  });
  const lock = createHostDeckHostLockPolicy({
    settings: {
      read: () => settings(options.locked === true),
      transition() {
        throw new Error("Compact route must not transition host lock.");
      }
    },
    now: nextDate
  });
  const snapshotCalls: unknown[] = [];
  const startCalls: Record<string, unknown>[] = [];
  let startSignalObserved = false;
  let startThis: unknown = "not-called";
  let acceptedBeforeStart = false;
  let stateReads = 0;
  let runtimeReads = 0;
  let stateIndex = 0;
  let runtimeIndex = 0;
  let snapshotIndex = 0;
  let startIndex = 0;
  const routeInput: RouteInputFixture = {
    admission: createHostDeckSelectedWriteAdmissionPolicy({ resourceBudget: defaultResourceBudget, now: () => performance.now() }),
    audit,
    compact: {
      async snapshot(target: unknown) {
        snapshotCalls.push(target);
        if (options.snapshotError !== undefined) throw options.snapshotError;
        return sequenceValue(options.snapshotResults ?? [null], snapshotIndex++);
      },
      async compact(this: void, intent: unknown, signal?: AbortSignal) {
        startThis = this;
        const captured = { ...(intent as Record<string, unknown>) };
        startCalls.push(captured);
        startSignalObserved = signal instanceof AbortSignal;
        acceptedBeforeStart = auditRepository.get(String(captured.operation_id ?? ""))?.records[0]?.phase === "accepted";
        await options.startBarrier;
        if (options.startError !== undefined) throw options.startError;
        if (options.startResults !== undefined) return sequenceValue(options.startResults, startIndex++);
        return acceptedProgress(String(captured.operation_id ?? ""));
      }
    } as unknown as RouteInputFixture["compact"],
    csrf,
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
        return sequenceValue(options.stateResults ?? [selectedState("idle")], stateIndex++) as SelectedSessionState | null;
      }
    }
  };
  const registration = createHostDeckCompactRouteRegistration(routeInput);
  const app = createHostDeckFastifyApp({
    observeInternalError: () => undefined,
    requestAuthenticationPolicy: createHostDeckRequestAuthenticationPolicy({
      authenticateDeviceToken: () => {
        throw new Error("Loopback compact route must not authenticate a device.");
      },
      now: nextDate
    }),
    requestTrustPolicy: createHostDeckRequestTrustPolicy({
      allowedOrigins: ["http://localhost"],
      mode: "loopback",
      transport: "http"
    }),
    resourceBudget: defaultResourceBudget,
    routePlugins: [registration]
  });
  await app.ready();
  let closed = false;
  return {
    acceptedBeforeStart: () => acceptedBeforeStart,
    app,
    auditRepository,
    registration,
    routeInput,
    runtimeReads: () => runtimeReads,
    snapshotCalls: () => [...snapshotCalls],
    startCalls: () => [...startCalls],
    startSignalObserved: () => startSignalObserved,
    startThis: () => startThis,
    stateReads: () => stateReads,
    rawAuditRecords(operationId) {
      return (open.db
        .prepare("SELECT record_json FROM selected_audit_events WHERE operation_id = ? ORDER BY phase")
        .all(operationId) as readonly { readonly record_json: string }[]).map((row) => row.record_json);
    },
    failTerminalAudit() {
      open.db.exec(`
        CREATE TRIGGER fail_compact_terminal_audit
        BEFORE INSERT ON selected_audit_events
        WHEN NEW.phase = 'terminal'
        BEGIN
          SELECT RAISE(ABORT, 'forced compact terminal audit failure');
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

async function createPairedHarness(permission: "read" | "write"): Promise<PairedHarness> {
  const directory = mkdtempSync(join(tmpdir(), "hostdeck-compact-route-paired-"));
  temporaryDirectories.push(directory);
  const open = openMigratedDatabase(join(directory, "hostdeck.sqlite"), { now: () => new Date(timestamp) });
  let clock = new Date(timestamp).getTime();
  const nextDate = () => new Date(clock++);
  const auth = createAuthDeviceRepository(open.db);
  auth.create({
    id: pairedDeviceId,
    rawDeviceToken: pairedDeviceToken,
    rawCsrfToken: pairedCsrfToken,
    permission,
    clientLabel: "Compact route client",
    createdAt: new Date(timestamp)
  });
  const csrfRepository = createSelectedCsrfAuthorizationRepository(open.db, {
    generateCsrfToken: () => "N".repeat(43)
  });
  const csrf = createHostDeckCsrfPolicy({
    csrf: {
      authorizeBrowserWrite: (input) => csrfRepository.authorizeBrowserWrite(input),
      rotateBootstrap: (input) => csrfRepository.rotateBootstrap(input)
    },
    now: nextDate
  });
  const lock = createHostDeckHostLockPolicy({
    settings: {
      read: () => settings(false),
      transition() {
        throw new Error("Compact route must not transition host lock.");
      }
    },
    now: nextDate
  });
  const auditRepository = createSelectedAuditRepository(open.db);
  let auditId = 0;
  const audit = createHostDeckSelectedWriteAuditExecutor({
    repository: auditRepository,
    now: () => nextDate().toISOString(),
    create_record_id: () => `audit_compact_route_paired_${++auditId}`
  });
  const startCalls: Record<string, unknown>[] = [];
  let stateReads = 0;
  const registration = createHostDeckCompactRouteRegistration({
    admission: createHostDeckSelectedWriteAdmissionPolicy({ resourceBudget: defaultResourceBudget, now: () => performance.now() }),
    audit,
    compact: {
      async snapshot() {
        return null;
      },
      async compact(intent: unknown) {
        const captured = { ...(intent as Record<string, unknown>) };
        startCalls.push(captured);
        return acceptedProgress(String(captured.operation_id ?? ""));
      }
    } as unknown as CreateHostDeckCompactRouteRegistrationInput["compact"],
    csrf,
    lock,
    runtime: { read: () => runtimeCandidate() },
    state: {
      get() {
        stateReads += 1;
        return selectedState("idle");
      }
    }
  });
  const certificateDirectory = join(directory, "certificates");
  mkdirSync(certificateDirectory, { mode: 0o700 });
  const certificates = createHostDeckLanCertificatePolicy({
    assignedAddresses: () => ["192.168.0.29"],
    certificateDirectory,
    now: () => new Date(timestamp)
  });
  await certificates.configure({ bind_host: "192.168.0.29", bind_port: 3777, certificate_action: "issue_leaf" });
  const app = createHostDeckFastifyApp({
    observeInternalError: () => undefined,
    requestAuthenticationPolicy: createHostDeckRequestAuthenticationPolicy({
      authenticateDeviceToken: (input) => auth.authenticateDeviceToken(input),
      now: nextDate
    }),
    requestTrustPolicy: createHostDeckRequestTrustPolicy({
      allowedOrigins: [secureOrigin],
      mode: "lan",
      transport: "https"
    }),
    resourceBudget: defaultResourceBudget,
    routePlugins: [registration],
    tls: certificates.loadTls({ bind_host: "192.168.0.29", bind_port: 3777 })
  });
  await app.listen({ host: "127.0.0.1", port: 0, listenTextResolver: () => "" });
  let closed = false;
  return {
    app,
    auditRepository,
    startCalls: () => [...startCalls],
    stateReads: () => stateReads,
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

function acceptedProgress(operationId: string): SelectedOperationProgress {
  return selectedOperationProgressSchema.parse({
    operation_id: operationId,
    kind: "compact",
    target: managedTarget(),
    state: "accepted",
    updated_at: acceptedAt,
    turn_id: null,
    error: null
  });
}

function progress(
  state: "accepted" | "running" | "completed" | "interrupted" | "failed" | "incomplete",
  message = "Compact outcome is unresolved."
): SelectedOperationProgress {
  return selectedOperationProgressSchema.parse({
    operation_id: "op_compact_route_progress",
    kind: "compact",
    target: managedTarget(),
    state,
    updated_at: acceptedAt,
    turn_id: state === "accepted" || state === "incomplete" ? null : turnId,
    error: ["failed", "incomplete"].includes(state)
      ? { code: "unknown_error", message, retryable: false }
      : null
  });
}

function selectedState(
  state: "active_turn" | "archived" | "contradictory" | "idle" | "recovery" | "stale"
): SelectedSessionState {
  const archivedAt = state === "archived" ? timestamp : null;
  const mapping = selectedSessionMappingRecordSchema.parse({
    id: sessionId,
    name: "compact-route-session",
    codex_thread_id: threadId,
    cwd: "/tmp/hostdeck-compact-route",
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
      cwd: state === "contradictory" ? "/tmp/hostdeck-compact-route-other" : mapping.cwd,
      runtime_source: mapping.runtime_source,
      runtime_version: mapping.runtime_version,
      created_at: mapping.created_at,
      archived_at: archivedAt,
      session_state: state === "archived" ? "archived" : stale ? "stale" : "active",
      turn_state: stale ? "unknown" : state === "active_turn" ? "in_progress" : "idle",
      attention: state === "active_turn" ? "none" : stale ? "unknown" : "none",
      freshness: stale ? "stale" : "current",
      freshness_reason: stale ? "Projection requires reconciliation." : null,
      updated_at: timestamp,
      last_activity_at: timestamp,
      branch: "main",
      model: "runtime-a",
      goal: null,
      recent_summary: "Managed compact route test session.",
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
    binding_id: connected ? (input.bindingId ?? "binding-compact-route-001") : null,
    capabilities: runtimeCapabilities.map((name) =>
      name === input.unavailableCapability ||
      (state === "incompatible" && input.unavailableCapability === undefined && name === "turn_input")
        ? { name, state: "unavailable", reason: "Capability is unavailable." }
        : { name, state: "available", reason: null }
    ),
    checked_at: timestamp,
    reason: state === "ready" ? null : "Runtime is not ready."
  });
}

function settings(locked: boolean) {
  return {
    id: "hostdeck_settings" as const,
    schema_version: 1,
    state_dir: "/tmp/hostdeck-compact-route-state",
    bind_mode: "localhost" as const,
    bind_host: "127.0.0.1",
    bind_port: 3210,
    lan_enabled: false,
    locked,
    retention: { ...defaultRetentionPolicy },
    updated_at: timestamp
  };
}

function compactServiceError(
  code: CodexCompactControlErrorCode,
  apiCode: ConstructorParameters<typeof HostDeckCodexCompactControlError>[1],
  outcome: CodexCompactControlOutcome
): HostDeckCodexCompactControlError {
  return new HostDeckCodexCompactControlError(code, apiCode, "private-compact-service-error", outcome, true);
}

function sequenceValue(values: readonly unknown[], index: number): unknown {
  const value = values[Math.min(index, values.length - 1)];
  if (value === undefined) throw new Error("Compact route test sequence is empty.");
  return value;
}

async function readCompact(harness: Pick<Harness, "app">) {
  return await harness.app.inject({ method: "GET", url: `/api/v1/sessions/${sessionId}/compact` });
}

async function startCompact(harness: Pick<Harness, "app">, payload: Readonly<Record<string, unknown>>) {
  return await harness.app.inject({ method: "POST", url: `/api/v1/sessions/${sessionId}/compact`, payload });
}

async function secureCompact(
  harness: PairedHarness,
  method: "GET" | "POST",
  payload?: Readonly<Record<string, unknown>>
): Promise<HttpResult> {
  const body = payload === undefined ? "" : JSON.stringify(payload);
  return await httpsExchange(
    harness,
    {
      method,
      path: `/api/v1/sessions/${sessionId}/compact`,
      headers: {
        host: "192.168.0.29:3777",
        origin: secureOrigin,
        accept: "application/json",
        cookie: `${hostDeckDeviceCookieName}=${pairedDeviceToken}`,
        ...(payload === undefined
          ? {}
          : {
              "content-type": "application/json",
              "content-length": Buffer.byteLength(body),
              "x-hostdeck-csrf": pairedCsrfToken,
              "x-hostdeck-csrf-generation": "1"
            })
      }
    },
    body
  );
}

interface HttpResult {
  readonly statusCode: number;
  readonly body: string;
  readonly headers: import("node:http").IncomingHttpHeaders;
  readonly json: () => Record<string, unknown>;
}

function httpsExchange(harness: PairedHarness, options: RequestOptions, body: string): Promise<HttpResult> {
  const address = harness.app.server.address();
  if (address === null || typeof address === "string") throw new Error("Compact HTTPS listener is unavailable.");
  return new Promise((resolve, reject) => {
    const outgoing = httpsRequest(
      { host: "127.0.0.1", port: address.port, rejectUnauthorized: false, ...options },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const responseBody = Buffer.concat(chunks).toString("utf8");
          resolve({
            statusCode: response.statusCode ?? 0,
            body: responseBody,
            headers: response.headers,
            json: () => JSON.parse(responseBody) as Record<string, unknown>
          });
        });
      }
    );
    outgoing.once("error", reject);
    outgoing.end(body);
  });
}

function expectStableError(
  response: { readonly statusCode: number; readonly body: string; readonly json: () => unknown },
  status: number,
  code: string,
  retryable = false
): void {
  expect(response.statusCode, response.body).toBe(status);
  expect(response.json()).toMatchObject({ error: { code, retryable } });
  expect(response.body).not.toContain("private-compact");
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for compact route condition.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
