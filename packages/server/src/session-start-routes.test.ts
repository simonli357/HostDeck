import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultResourceBudget,
  type RuntimeCompatibility,
  runtimeCompatibilitySchema,
  selectedSessionMappingRecordSchema,
  selectedSessionProjectionRecordSchema
} from "@hostdeck/contracts";
import { runtimeCapabilities } from "@hostdeck/core";
import {
  createSelectedAuditRepository,
  HostDeckSelectedAuditRepositoryError,
  openMigratedDatabase,
  type SelectedAuditRepository,
  type SelectedSessionState
} from "@hostdeck/storage";
import { afterEach, describe, expect, it } from "vitest";
import { createHostDeckCsrfPolicy } from "./csrf-routes.js";
import {
  createHostDeckFastifyApp,
  type HostDeckFastifyInstance,
  type HostDeckRoutePluginRegistration
} from "./fastify-app.js";
import { hostDeckLoopbackTestOrigin, injectHostDeckLoopback } from "./fastify-loopback-test-request.js";
import { createHostDeckRequestAuthenticationPolicy } from "./fastify-request-authentication.js";
import { createHostDeckRequestTrustPolicy } from "./fastify-request-trust.js";
import { createHostDeckHostLockPolicy } from "./host-lock-routes.js";
import {
  HostDeckManagedCodexThreadServiceError,
  type ManagedCodexThreadServiceOutcome
} from "./managed-thread-service.js";
import { createHostDeckSelectedWriteAdmissionPolicy } from "./selected-write-admission-policy.js";
import { createHostDeckSelectedWriteAuditExecutor } from "./selected-write-audit-executor.js";
import {
  createHostDeckSessionStartRouteRegistration,
  hostDeckSessionStartRouteRegistrationId
} from "./session-start-routes.js";

const temporaryDirectories: string[] = [];
const timestamp = "2026-07-15T18:00:00.000Z";
const runtimeVersion = "0.144.0";
const request = Object.freeze({
  operation_id: "op_session_start_route_001",
  name: "route-session",
  cwd: "/tmp/hostdeck-route-session"
});

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("selected managed-session start route", () => {
  it("requires strict branded composition and registers the exact selected route once", async () => {
    const harness = await createHarness();
    try {
      expect(harness.registration.id).toBe(hostDeckSessionStartRouteRegistrationId);
      expect(harness.registration.surface).toBe("api");
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
          throw new Error("private-accessor-sentinel");
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
        { ...harness.routeInput, runtime: {} },
        { ...harness.routeInput, runtime: { read: harness.routeInput.runtime.read, extra: true } },
        { ...harness.routeInput, sessions: {} },
        { ...harness.routeInput, sessions: { start: harness.routeInput.sessions.start, extra: true } },
        accessor
      ]) {
        expect(() =>
          createHostDeckSessionStartRouteRegistration(candidate as never)
        ).toThrow();
      }
      expect(accessorCalls).toBe(0);
    } finally {
      await harness.close();
    }
  });

  it("starts once through loopback, returns only the selected projection, and persists an exact audit trail", async () => {
    const harness = await createHarness();
    try {
      const response = await start(harness, request);
      expect(response.statusCode, response.body).toBe(201);
      expect(response.json()).toEqual({
        operation_id: request.operation_id,
        session: selectedState().projection.session
      });
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers.pragma).toBe("no-cache");
      expect(harness.runtimeReads()).toBe(1);
      expect(harness.startCalls()).toEqual([request]);
      expect(harness.auditRepository.require(request.operation_id)).toMatchObject({
        state: "terminal",
        records: [
          {
            phase: "accepted",
            outcome: "accepted",
            actor: {
              type: "cli",
              device_id: null,
              permission: "local_admin",
              origin: null
            },
            action: "session_start",
            target: { type: "host", host_id: "local_host" },
            payload_summary: {
              schema_version: 1,
              name_length: request.name.length,
              cwd_present: true
            },
            error_code: null
          },
          {
            phase: "terminal",
            outcome: "succeeded",
            action: "session_start",
            target: { type: "host", host_id: "local_host" },
            payload_summary: { schema_version: 1, created: true },
            error_code: null
          }
        ]
      });
    } finally {
      await harness.close();
    }
  });

  it("rejects unavailable, incompatible, and malformed runtime state before audit or service dispatch", async () => {
    const cases: readonly [string, unknown, number, string][] = [
      ["missing", null, 503, "runtime_unavailable"],
      ["disconnected", runtimeCandidate({ state: "disconnected" }), 503, "runtime_unavailable"],
      ["incompatible", runtimeCandidate({ state: "incompatible" }), 409, "incompatible_runtime"],
      [
        "unknown-lifecycle-capability",
        incompatibleUnknownLifecycleRuntime(),
        409,
        "incompatible_runtime"
      ],
      [
        "mutation-blocked",
        runtimeCandidate({ state: "degraded", mutationPolicy: "blocked" }),
        409,
        "incompatible_runtime"
      ],
      ["malformed", { ...runtimeCandidate(), extra: true }, 500, "internal_error"]
    ];
    for (const [label, runtime, status, code] of cases) {
      const harness = await createHarness({ runtime });
      const operationId = `op_session_start_runtime_${label}`;
      try {
        const response = await start(harness, { ...request, operation_id: operationId });
        expectStableError(response, status, code, code === "runtime_unavailable");
        expect(harness.startCalls()).toEqual([]);
        expect(harness.auditRepository.get(operationId)).toBeNull();
      } finally {
        await harness.close();
      }
    }
  });

  it("admits a capability-complete degraded runtime and maps runtime read failure to unavailable", async () => {
    const degraded = await createHarness({
      runtime: runtimeCandidate({ state: "degraded" })
    });
    try {
      const response = await start(degraded, request);
      expect(response.statusCode, response.body).toBe(201);
      expect(degraded.startCalls()).toHaveLength(1);
    } finally {
      await degraded.close();
    }

    const unavailable = await createHarness({ runtimeReadError: true });
    try {
      const response = await start(unavailable, {
        ...request,
        operation_id: "op_session_start_runtime_read_failure"
      });
      expectStableError(response, 503, "runtime_unavailable", true);
      expect(unavailable.startCalls()).toEqual([]);
      expect(
        unavailable.auditRepository.get(
          "op_session_start_runtime_read_failure"
        )
      ).toBeNull();
    } finally {
      await unavailable.close();
    }
  });

  it("rejects a durable host lock before audit or service dispatch", async () => {
    const harness = await createHarness({ locked: true });
    try {
      const response = await start(harness, request);
      expectStableError(response, 423, "host_locked");
      expect(harness.runtimeReads()).toBe(0);
      expect(harness.startCalls()).toEqual([]);
      expect(harness.auditRepository.get(request.operation_id)).toBeNull();
    } finally {
      await harness.close();
    }
  });

  it("records known no-thread failures as failed and post-thread failures as incomplete", async () => {
    const cases: readonly [
      string,
      HostDeckManagedCodexThreadServiceError,
      number,
      string,
      "failed" | "incomplete"
    ][] = [
      [
        "duplicate",
        serviceError("duplicate_session_name", "not_sent"),
        409,
        "duplicate_session_name",
        "failed"
      ],
      [
        "invalid-cwd",
        serviceError("invalid_cwd", "not_sent"),
        400,
        "invalid_cwd",
        "failed"
      ],
      [
        "remote-rejected",
        serviceError("runtime_unavailable", "remote_rejected"),
        503,
        "runtime_unavailable",
        "failed"
      ],
      [
        "timeout-not-sent",
        serviceError("operation_timeout", "not_sent"),
        504,
        "operation_timeout",
        "failed"
      ],
      [
        "timeout-unknown",
        serviceError("operation_timeout", "unknown"),
        504,
        "operation_timeout",
        "incomplete"
      ],
      [
        "post-thread-storage",
        serviceError("storage_error", "remote_succeeded", "thread-route-start-001"),
        500,
        "storage_error",
        "incomplete"
      ],
      [
        "unknown-outcome",
        serviceError("unknown_outcome", "unknown"),
        503,
        "runtime_unavailable",
        "incomplete"
      ]
    ];
    for (const [label, error, status, code, auditOutcome] of cases) {
      const harness = await createHarness({ startError: error });
      const operationId = `op_session_start_failure_${label}`;
      try {
        const response = await start(harness, { ...request, operation_id: operationId });
        expectStableError(response, status, code);
        expect(harness.startCalls()).toHaveLength(1);
        expect(harness.auditRepository.require(operationId)).toMatchObject({
          state: "terminal",
          records: [
            { phase: "accepted", outcome: "accepted" },
            {
              phase: "terminal",
              outcome: auditOutcome,
              error_code: code,
              payload_summary: { schema_version: 1 }
            }
          ]
        });
        expect(response.body).not.toMatch(
          /private-service-error-sentinel|thread-route-start-001/iu
        );
      } finally {
        await harness.close();
      }
    }
  });

  it("records malformed post-dispatch state as incomplete and never serializes it", async () => {
    const harness = await createHarness({
      startResult: {
        ...selectedState(),
        projection: {
          ...selectedState().projection,
          session: { ...selectedState().projection.session, cwd: "/tmp/wrong" }
        }
      }
    });
    try {
      const response = await start(harness, request);
      expectStableError(response, 500, "internal_error");
      expect(harness.startCalls()).toHaveLength(1);
      expect(harness.auditRepository.require(request.operation_id)).toMatchObject({
        state: "terminal",
        records: [
          { phase: "accepted", outcome: "accepted" },
          { phase: "terminal", outcome: "incomplete", error_code: "internal_error" }
        ]
      });
      expect(response.body).not.toContain("/tmp/wrong");
    } finally {
      await harness.close();
    }
  });

  it("records an untyped service throw as fixed incomplete without leaking its cause", async () => {
    const harness = await createHarness({
      startError: new Error("private-foreign-service-sentinel")
    });
    try {
      const response = await start(harness, request);
      expectStableError(response, 500, "internal_error");
      expect(response.body).not.toContain("private-foreign-service-sentinel");
      expect(harness.startCalls()).toHaveLength(1);
      expect(harness.auditRepository.require(request.operation_id)).toMatchObject({
        state: "terminal",
        records: [
          { phase: "accepted" },
          {
            phase: "terminal",
            outcome: "incomplete",
            error_code: "internal_error",
            payload_summary: { schema_version: 1 }
          }
        ]
      });
    } finally {
      await harness.close();
    }
  });

  it("records runtime-version drift after dispatch as incomplete", async () => {
    const current = selectedState();
    const harness = await createHarness({
      startResult: {
        mapping: {
          ...current.mapping,
          runtime_version: "0.145.0"
        },
        projection: {
          ...current.projection,
          session: {
            ...current.projection.session,
            runtime_version: "0.145.0"
          }
        }
      }
    });
    try {
      const response = await start(harness, request);
      expectStableError(response, 500, "internal_error");
      expect(harness.startCalls()).toHaveLength(1);
      expect(harness.auditRepository.require(request.operation_id)).toMatchObject({
        state: "terminal",
        records: [
          { phase: "accepted" },
          { phase: "terminal", outcome: "incomplete", error_code: "internal_error" }
        ]
      });
    } finally {
      await harness.close();
    }
  });

  it("replays one operation-id result without a second start", async () => {
    const harness = await createHarness();
    try {
      const first = await start(harness, request);
      const second = await start(harness, request);
      expect(first.statusCode, first.body).toBe(201);
      expect(second.statusCode, second.body).toBe(201);
      expect(second.json()).toEqual(first.json());
      expect(harness.startCalls()).toHaveLength(1);
      expect(harness.auditRepository.require(request.operation_id)).toMatchObject({
        state: "terminal",
        records: [{ phase: "accepted" }, { phase: "terminal", outcome: "succeeded" }]
      });
    } finally {
      await harness.close();
    }
  });

  it("suppresses a known successful response when terminal audit cannot be persisted", async () => {
    const harness = await createHarness({ failTerminalAudit: true });
    try {
      const response = await start(harness, request);
      expectStableError(response, 503, "audit_unavailable");
      expect(harness.startCalls()).toHaveLength(1);
      expect(response.body).not.toContain("sess_route_start_001");
      expect(harness.auditRepository.require(request.operation_id)).toMatchObject({
        state: "pending",
        records: [{ phase: "accepted", outcome: "accepted" }]
      });
      const replay = await start(harness, request);
      expectStableError(replay, 503, "audit_unavailable");
      expect(harness.startCalls()).toHaveLength(1);
      expect(harness.auditRepository.require(request.operation_id).records).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });

  it("fails closed on accepted-audit unavailability without dispatching start", async () => {
    const harness = await createHarness({ failAcceptedAudit: true });
    try {
      const response = await start(harness, request);
      expectStableError(response, 503, "audit_unavailable", true);
      expect(harness.startCalls()).toEqual([]);
      expect(harness.auditRepository.get(request.operation_id)).toBeNull();
      const retry = await start(harness, request);
      expect(retry.statusCode, retry.body).toBe(201);
      expect(harness.startCalls()).toHaveLength(1);
      expect(harness.auditRepository.require(request.operation_id)).toMatchObject({
        state: "terminal",
        records: [
          { phase: "accepted", outcome: "accepted" },
          { phase: "terminal", outcome: "succeeded" }
        ]
      });
    } finally {
      await harness.close();
    }
  });

  it("rejects extra body fields before runtime proof, audit, or dispatch", async () => {
    const harness = await createHarness();
    try {
      const response = await start(harness, { ...request, codex_thread_id: "thread-injected" });
      expectStableError(response, 400, "validation_error");
      expect(harness.runtimeReads()).toBe(0);
      expect(harness.startCalls()).toEqual([]);
      expect(harness.auditRepository.get(request.operation_id)).toBeNull();
    } finally {
      await harness.close();
    }
  });
});

interface HarnessOptions {
  readonly failAcceptedAudit?: boolean;
  readonly failTerminalAudit?: boolean;
  readonly locked?: boolean;
  readonly runtime?: unknown;
  readonly runtimeReadError?: boolean;
  readonly startError?: Error;
  readonly startResult?: unknown;
}

interface RouteInputFixture {
  readonly admission: ReturnType<typeof createHostDeckSelectedWriteAdmissionPolicy>;
  readonly audit: ReturnType<typeof createHostDeckSelectedWriteAuditExecutor>;
  readonly csrf: ReturnType<typeof createHostDeckCsrfPolicy>;
  readonly lock: ReturnType<typeof createHostDeckHostLockPolicy>;
  readonly runtime: { readonly read: () => unknown };
  readonly sessions: {
    readonly start: (candidate: unknown) => Promise<SelectedSessionState>;
  };
}

interface Harness {
  readonly app: HostDeckFastifyInstance;
  readonly auditRepository: SelectedAuditRepository;
  readonly registration: HostDeckRoutePluginRegistration;
  readonly routeInput: RouteInputFixture;
  readonly runtimeReads: () => number;
  readonly startCalls: () => readonly unknown[];
  readonly close: () => Promise<void>;
}

async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const directory = mkdtempSync(join(tmpdir(), "hostdeck-session-start-route-"));
  temporaryDirectories.push(directory);
  const open = openMigratedDatabase(join(directory, "hostdeck.sqlite"), {
    now: () => new Date(timestamp)
  });
  const baseAuditRepository = createSelectedAuditRepository(open.db);
  let acceptedAuditFailuresRemaining = options.failAcceptedAudit ? 1 : 0;
  const executorRepository: SelectedAuditRepository = options.failAcceptedAudit
    ? {
        ...baseAuditRepository,
        recordAccepted(record) {
          if (acceptedAuditFailuresRemaining > 0) {
            acceptedAuditFailuresRemaining -= 1;
            throw new HostDeckSelectedAuditRepositoryError(
              "audit_unavailable",
              "private-audit-unavailable-sentinel"
            );
          }
          return baseAuditRepository.recordAccepted(record);
        }
      }
    : options.failTerminalAudit
      ? {
          ...baseAuditRepository,
          recordTerminal() {
            throw new HostDeckSelectedAuditRepositoryError(
              "audit_write_failed",
              "private-terminal-audit-sentinel"
            );
          }
        }
      : baseAuditRepository;
  let clock = new Date(timestamp).getTime();
  let auditRecord = 0;
  const audit = createHostDeckSelectedWriteAuditExecutor({
    repository: executorRepository,
    now: () => new Date(clock++).toISOString(),
    create_record_id: () => `audit_session_start_route_${++auditRecord}`
  });
  const csrf = createHostDeckCsrfPolicy({
    csrf: {
      authorizeBrowserWrite() {
        throw new Error("Loopback session start must not authorize browser CSRF.");
      },
      rotateBootstrap() {
        throw new Error("Loopback session start must not rotate browser CSRF.");
      }
    },
    now: () => new Date(clock++)
  });
  const lock = createHostDeckHostLockPolicy({
    settings: {
      read: () => settings(options.locked === true),
      transition() {
        throw new Error("Session-start route must not transition host lock.");
      }
    },
    now: () => new Date(clock++)
  });
  let runtimeReadCount = 0;
  const runtimeValue = Object.hasOwn(options, "runtime")
    ? options.runtime
    : runtimeCandidate();
  const calls: unknown[] = [];
  const routeInput: RouteInputFixture = {
    admission: createHostDeckSelectedWriteAdmissionPolicy({ resourceBudget: defaultResourceBudget, now: () => performance.now() }),
    audit,
    csrf,
    lock,
    runtime: {
      read() {
        runtimeReadCount += 1;
        if (options.runtimeReadError) {
          throw new Error("private-runtime-read-sentinel");
        }
        return runtimeValue;
      }
    },
    sessions: {
      async start(candidate) {
        calls.push(candidate);
        if (options.startError !== undefined) throw options.startError;
        return (options.startResult ?? selectedState()) as SelectedSessionState;
      }
    }
  };
  const registration = createHostDeckSessionStartRouteRegistration(routeInput);
  const authenticationPolicy = createHostDeckRequestAuthenticationPolicy({
    authenticateDeviceToken: () => {
      throw new Error("Loopback session start must not authenticate a device.");
    },
    now: () => new Date(clock++)
  });
  const app = createHostDeckFastifyApp({
    observeInternalError: () => undefined,
    requestAuthenticationPolicy: authenticationPolicy,
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
    auditRepository: baseAuditRepository,
    registration,
    routeInput,
    runtimeReads: () => runtimeReadCount,
    startCalls: () => [...calls],
    async close() {
      if (closed) return;
      closed = true;
      await app.close();
      if (open.db.open) open.db.close();
    }
  };
}

function runtimeCandidate(
  input: {
    readonly mutationPolicy?: RuntimeCompatibility["mutation_policy"];
    readonly state?: RuntimeCompatibility["state"];
  } = {}
): RuntimeCompatibility {
  const state = input.state ?? "ready";
  const connected = state === "ready" || state === "degraded";
  const incompatible = state === "incompatible";
  return runtimeCompatibilitySchema.parse({
    source: "codex_app_server",
    state,
    mutation_policy: input.mutationPolicy ?? (connected ? "allowed" : "blocked"),
    observed_version: state === "disconnected" ? null : runtimeVersion,
    binding_id: state === "disconnected" ? null : "binding-session-start-route-001",
    capabilities: runtimeCapabilities.map((name) =>
      incompatible && name === "thread_lifecycle"
        ? { name, state: "unavailable", reason: "Capability is unavailable." }
        : { name, state: "available", reason: null }
    ),
    checked_at: timestamp,
    reason: state === "ready" ? null : "Runtime is not ready."
  });
}

function incompatibleUnknownLifecycleRuntime(): RuntimeCompatibility {
  return runtimeCompatibilitySchema.parse({
    source: "codex_app_server",
    state: "incompatible",
    mutation_policy: "blocked",
    observed_version: runtimeVersion,
    binding_id: "binding-session-start-route-unknown",
    capabilities: runtimeCapabilities.map((name) =>
      name === "thread_lifecycle"
        ? { name, state: "unknown", reason: "Capability probe is incomplete." }
        : name === "turn_input"
          ? { name, state: "unavailable", reason: "Required capability is unavailable." }
          : { name, state: "available", reason: null }
    ),
    checked_at: timestamp,
    reason: "Runtime capability proof is incomplete."
  });
}

function selectedState() {
  const mapping = selectedSessionMappingRecordSchema.parse({
    id: "sess_route_start_001",
    name: request.name,
    codex_thread_id: "thread-route-start-001",
    cwd: request.cwd,
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

function settings(locked: boolean) {
  return Object.freeze({
    locked,
    settings_updated_at: timestamp
  });
}

function serviceError(
  code: HostDeckManagedCodexThreadServiceError["code"],
  outcome: ManagedCodexThreadServiceOutcome,
  threadId: string | null = null
): HostDeckManagedCodexThreadServiceError {
  return new HostDeckManagedCodexThreadServiceError(
    code,
    "private-service-error-sentinel",
    outcome,
    false,
    threadId
  );
}

async function start(
  harness: Harness,
  payload: Readonly<Record<string, unknown>>
) {
  return await injectHostDeckLoopback(harness.app, {
    method: "POST",
    url: "/api/v1/sessions",
    payload
  });
}

function expectStableError(
  response: { readonly statusCode: number; readonly body: string; readonly json: () => unknown },
  status: number,
  code: string,
  retryable = false
): void {
  expect(response.statusCode, response.body).toBe(status);
  expect(response.json()).toMatchObject({
    error: { code, retryable }
  });
}
