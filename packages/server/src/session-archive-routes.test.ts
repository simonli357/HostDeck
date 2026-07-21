import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
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
import {
  hostDeckLoopbackTestAuthority,
  hostDeckLoopbackTestOrigin,
  injectHostDeckLoopback
} from "./fastify-loopback-test-request.js";
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
  createHostDeckSessionArchiveRouteRegistration,
  hostDeckSessionArchiveRouteRegistrationId
} from "./session-archive-routes.js";

const temporaryDirectories: string[] = [];
const timestamp = "2026-07-15T20:00:00.000Z";
const archivedAt = "2026-07-15T20:00:01.000Z";
const runtimeVersion = "0.144.0";
const sessionId = "sess_archive_route_001";
const threadId = "thread-archive-route-001";
const archiveRequest = Object.freeze({
  operation_id: "op_session_archive_route_001",
  kind: "archive" as const,
  confirm: true as const
});

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("selected managed-session archive route", () => {
  it("requires exact branded composition and registers the selected route once", async () => {
    const harness = await createHarness();
    try {
      expect(harness.registration.id).toBe(hostDeckSessionArchiveRouteRegistrationId);
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
        {
          ...harness.routeInput,
          sessions: {
            archive: harness.routeInput.sessions.archive,
            read: harness.routeInput.sessions.read,
            extra: true
          }
        },
        { ...harness.routeInput, subscribers: {} },
        {
          ...harness.routeInput,
          subscribers: {
            archive_session: harness.routeInput.subscribers.archive_session,
            extra: true
          }
        },
        accessor
      ]) {
        expect(() =>
          createHostDeckSessionArchiveRouteRegistration(candidate as never)
        ).toThrow();
      }
      expect(accessorCalls).toBe(0);
    } finally {
      await harness.close();
    }
  });

  it("archives once over loopback and returns a receipt from the durable accepted audit row", async () => {
    const harness = await createHarness();
    try {
      const response = await archive(harness, archiveRequest);
      expect(response.statusCode, response.body).toBe(202);
      const trail = harness.auditRepository.require(archiveRequest.operation_id);
      const accepted = trail.records[0];
      expect(accepted).toBeDefined();
      expect(response.json()).toEqual({
        operation_id: archiveRequest.operation_id,
        kind: "archive",
        target: {
          type: "managed_session",
          session_id: sessionId,
          codex_thread_id: threadId
        },
        state: "accepted",
        accepted_at: accepted?.at,
        audit_record_id: accepted?.id
      });
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers.pragma).toBe("no-cache");
      expect(harness.readCalls()).toEqual([sessionId]);
      expect(harness.runtimeReads()).toBe(1);
      expect(harness.archiveCalls()).toEqual([sessionId]);
      expect(harness.subscriberArchiveCalls()).toEqual([sessionId]);
      expect(trail).toMatchObject({
        state: "terminal",
        records: [
          {
            phase: "accepted",
            outcome: "accepted",
            action: "archive",
            target: {
              type: "managed_session",
              session_id: sessionId,
              codex_thread_id: threadId
            },
            payload_summary: { schema_version: 1, confirmed: true },
            error_code: null
          },
          {
            phase: "terminal",
            outcome: "succeeded",
            action: "archive",
            payload_summary: { schema_version: 1, archived: true },
            error_code: null
          }
        ]
      });
    } finally {
      await harness.close();
    }
  });

  it("rejects malformed requests, query injection, and already archived or stale state before audit", async () => {
    const malformed = await createHarness();
    try {
      const extraBody = await archive(malformed, {
        ...archiveRequest,
        target: { session_id: sessionId, codex_thread_id: "thread-injected" }
      });
      expectStableError(extraBody, 400, "validation_error");
      const query = await injectHostDeckLoopback(malformed.app, {
        method: "POST",
        url: `/api/v1/sessions/${sessionId}/archive?target=other`,
        payload: archiveRequest
      });
      expectStableError(query, 400, "validation_error");
      for (const method of ["GET", "HEAD"] as const) {
        const wrongMethod = await injectHostDeckLoopback(malformed.app, {
          method,
          url: `/api/v1/sessions/${sessionId}/archive`
        });
        expectStableError(wrongMethod, 405, "method_not_allowed");
      }
      const invalidPath = await injectHostDeckLoopback(malformed.app, {
        method: "POST",
        url: "/api/v1/sessions/session%20with%20spaces/archive",
        payload: archiveRequest
      });
      expectStableError(invalidPath, 400, "validation_error");
      const adjacentPath = await injectHostDeckLoopback(malformed.app, {
        method: "POST",
        url: `/api/v1/sessions/${sessionId}/archive/extra`,
        payload: archiveRequest
      });
      expectStableError(adjacentPath, 404, "route_not_found");
      expect(malformed.readCalls()).toEqual([]);
      expect(malformed.runtimeReads()).toBe(0);
      expect(malformed.archiveCalls()).toEqual([]);
      expect(malformed.auditRepository.get(archiveRequest.operation_id)).toBeNull();
    } finally {
      await malformed.close();
    }

    for (const [label, state, code] of [
      ["archived", selectedState("archived"), "session_not_writable"],
      ["stale", selectedState("stale"), "stale_session"],
      ["busy", selectedState("busy"), "session_not_writable"],
      ["unknown", selectedState("unknown"), "stale_session"]
    ] as const) {
      const harness = await createHarness({ readResult: state });
      const operationId = `op_session_archive_${label}`;
      try {
        const response = await archive(harness, {
          ...archiveRequest,
          operation_id: operationId
        });
        expectStableError(response, 409, code);
        expect(harness.runtimeReads()).toBe(0);
        expect(harness.archiveCalls()).toEqual([]);
        expect(harness.auditRepository.get(operationId)).toBeNull();
      } finally {
        await harness.close();
      }
    }
  });

  it("rejects runtime drift, host lock, and missing session before audit or dispatch", async () => {
    const cases: readonly [string, HarnessOptions, number, string][] = [
      [
        "runtime-drift",
        { runtime: runtimeCandidate({ version: "0.145.0" }) },
        409,
        "incompatible_runtime"
      ],
      [
        "runtime-disconnected",
        { runtime: runtimeCandidate({ state: "disconnected" }) },
        503,
        "runtime_unavailable"
      ],
      [
        "runtime-incompatible",
        { runtime: runtimeCandidate({ state: "incompatible" }) },
        409,
        "incompatible_runtime"
      ],
      [
        "runtime-blocked",
        {
          runtime: runtimeCandidate({
            state: "degraded",
            mutationPolicy: "blocked"
          })
        },
        409,
        "incompatible_runtime"
      ],
      ["locked", { locked: true }, 423, "host_locked"],
      [
        "missing",
        { readError: serviceError("thread_not_found", "not_sent") },
        404,
        "session_not_found"
      ]
    ];
    for (const [label, options, status, code] of cases) {
      const harness = await createHarness(options);
      const operationId = `op_session_archive_preflight_${label}`;
      try {
        const response = await archive(harness, {
          ...archiveRequest,
          operation_id: operationId
        });
        expectStableError(
          response,
          status,
          code,
          code === "runtime_unavailable"
        );
        expect(harness.archiveCalls()).toEqual([]);
        expect(harness.auditRepository.get(operationId)).toBeNull();
        expect(harness.readCalls()).toEqual(label === "locked" ? [] : [sessionId]);
        expect(harness.runtimeReads()).toBe(
          label === "locked" || label === "missing" ? 0 : 1
        );
      } finally {
        await harness.close();
      }
    }
  });

  it("records remote uncertainty and malformed post-dispatch state as incomplete", async () => {
    const cases: readonly [
      string,
      HarnessOptions,
      string
    ][] = [
      [
        "unknown",
        { archiveError: serviceError("unknown_outcome", "unknown") },
        "runtime_unavailable"
      ],
      ["malformed-state", { archiveResult: { private: "sentinel" } }, "internal_error"]
    ];
    for (const [label, options, code] of cases) {
      const harness = await createHarness(options);
      const operationId = `op_session_archive_incomplete_${label}`;
      try {
        const response = await archive(harness, {
          ...archiveRequest,
          operation_id: operationId
        });
        expect(response.statusCode, response.body).toBe(code === "runtime_unavailable" ? 503 : 500);
        expect(response.json()).toMatchObject({ error: { code } });
        expect(response.body).not.toContain("sentinel");
        expect(harness.archiveCalls()).toEqual([sessionId]);
        expect(harness.auditRepository.require(operationId)).toMatchObject({
          state: "terminal",
          records: [
            { phase: "accepted", outcome: "accepted" },
            { phase: "terminal", outcome: "incomplete", error_code: code }
          ]
        });
      } finally {
        await harness.close();
      }
    }
  });

  it("records post-commit subscriber cleanup failure as incomplete without redispatch", async () => {
    for (const [label, options] of [
      [
        "throw",
        { subscriberArchiveError: new Error("private subscriber cleanup failure") }
      ],
      ["malformed", { subscriberArchiveResult: -1 }]
    ] as const) {
      const operationId = `op_session_archive_subscribers_${label}`;
      const harness = await createHarness(options);
      try {
        const response = await archive(harness, {
          ...archiveRequest,
          operation_id: operationId
        });
        expectStableError(response, 500, "internal_error");
        expect(response.body).not.toContain("private subscriber");
        expect(harness.archiveCalls()).toEqual([sessionId]);
        expect(harness.subscriberArchiveCalls()).toEqual([sessionId]);
        expect(harness.auditRepository.require(operationId)).toMatchObject({
          state: "terminal",
          records: [
            { phase: "accepted", outcome: "accepted" },
            {
              phase: "terminal",
              outcome: "incomplete",
              error_code: "internal_error"
            }
          ]
        });
      } finally {
        await harness.close();
      }
    }
  });

  it("records a proven not-sent timeout as failed without retry", async () => {
    const operationId = "op_session_archive_known_timeout";
    const harness = await createHarness({
      archiveError: serviceError("operation_timeout", "not_sent")
    });
    try {
      const response = await archive(harness, {
        ...archiveRequest,
        operation_id: operationId
      });
      expectStableError(response, 504, "operation_timeout");
      expect(harness.archiveCalls()).toEqual([sessionId]);
      expect(harness.auditRepository.require(operationId)).toMatchObject({
        state: "terminal",
        records: [
          { phase: "accepted", outcome: "accepted" },
          {
            phase: "terminal",
            outcome: "failed",
            error_code: "operation_timeout"
          }
        ]
      });
    } finally {
      await harness.close();
    }
  });

  it("replays a duplicate operation result after one successful dispatch", async () => {
    const harness = await createHarness();
    try {
      const first = await archive(harness, archiveRequest);
      expect(first.statusCode, first.body).toBe(202);
      const duplicate = await archive(harness, archiveRequest);
      expect(duplicate.statusCode, duplicate.body).toBe(202);
      expect(duplicate.json()).toEqual(first.json());
      expect(harness.archiveCalls()).toEqual([sessionId]);
      expect(
        harness.auditRepository.require(archiveRequest.operation_id).records
      ).toHaveLength(2);
    } finally {
      await harness.close();
    }
  });

  it("keeps successful archive and terminal audit authoritative after HTTP response loss", async () => {
    let releaseArchive: (() => void) | undefined;
    const archiveBarrier = new Promise<void>((resolve) => {
      releaseArchive = resolve;
    });
    const harness = await createHarness({ archiveBarrier });
    const operationId = "op_session_archive_response_loss";
    try {
      await harness.app.listen({
        host: "127.0.0.1",
        port: 0,
        listenTextResolver: () => ""
      });
      const address = harness.app.server.address();
      if (address === null || typeof address === "string") {
        throw new Error("Session-archive response-loss listener is unavailable.");
      }
      const body = JSON.stringify({ ...archiveRequest, operation_id: operationId });
      const outgoing = httpRequest({
        hostname: "127.0.0.1",
        port: address.port,
        method: "POST",
        path: `/api/v1/sessions/${sessionId}/archive`,
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
      await waitFor(() => harness.archiveCalls().length === 1);
      outgoing.destroy();
      releaseArchive?.();
      await closed;
      await waitFor(
        () => harness.auditRepository.get(operationId)?.state === "terminal"
      );

      expect(harness.auditRepository.require(operationId)).toMatchObject({
        state: "terminal",
        records: [
          { phase: "accepted", outcome: "accepted" },
          { phase: "terminal", outcome: "succeeded" }
        ]
      });
      const retry = await archive(harness, {
        ...archiveRequest,
        operation_id: operationId
      });
      expect(retry.statusCode, retry.body).toBe(202);
      expect(retry.json()).toMatchObject({ operation_id: operationId, state: "accepted" });
      expect(harness.archiveCalls()).toEqual([sessionId]);
    } finally {
      releaseArchive?.();
      await harness.close();
    }
  });
});

interface HarnessOptions {
  readonly archiveBarrier?: Promise<void>;
  readonly archiveError?: Error;
  readonly archiveResult?: unknown;
  readonly locked?: boolean;
  readonly readError?: Error;
  readonly readResult?: unknown;
  readonly runtime?: unknown;
  readonly subscriberArchiveError?: Error;
  readonly subscriberArchiveResult?: unknown;
}

interface RouteInputFixture {
  readonly admission: ReturnType<typeof createHostDeckSelectedWriteAdmissionPolicy>;
  readonly audit: ReturnType<typeof createHostDeckSelectedWriteAuditExecutor>;
  readonly csrf: ReturnType<typeof createHostDeckCsrfPolicy>;
  readonly lock: ReturnType<typeof createHostDeckHostLockPolicy>;
  readonly runtime: { readonly read: () => unknown };
  readonly sessions: {
    readonly archive: (sessionId: string) => Promise<SelectedSessionState>;
    readonly read: (sessionId: string) => SelectedSessionState;
  };
  readonly subscribers: {
    readonly archive_session: (sessionId: string) => number;
  };
}

interface Harness {
  readonly app: HostDeckFastifyInstance;
  readonly auditRepository: SelectedAuditRepository;
  readonly registration: HostDeckRoutePluginRegistration;
  readonly routeInput: RouteInputFixture;
  readonly archiveCalls: () => readonly string[];
  readonly readCalls: () => readonly string[];
  readonly runtimeReads: () => number;
  readonly subscriberArchiveCalls: () => readonly string[];
  readonly close: () => Promise<void>;
}

async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const directory = mkdtempSync(join(tmpdir(), "hostdeck-session-archive-route-"));
  temporaryDirectories.push(directory);
  const open = openMigratedDatabase(join(directory, "hostdeck.sqlite"), {
    now: () => new Date(timestamp)
  });
  let clock = new Date(timestamp).getTime();
  const nextDate = () => new Date(clock++);
  const auditRepository = createSelectedAuditRepository(open.db);
  let auditId = 0;
  const audit = createHostDeckSelectedWriteAuditExecutor({
    repository: auditRepository,
    now: () => nextDate().toISOString(),
    create_record_id: () => `audit_session_archive_route_${++auditId}`
  });
  const csrf = createHostDeckCsrfPolicy({
    csrf: {
      authorizeBrowserWrite() {
        throw new Error("Loopback archive must not authorize browser CSRF.");
      },
      rotateBootstrap() {
        throw new Error("Loopback archive must not rotate browser CSRF.");
      }
    },
    now: nextDate
  });
  const lock = createHostDeckHostLockPolicy({
    settings: {
      read: () => settings(options.locked === true),
      transition() {
        throw new Error("Session-archive route must not transition host lock.");
      }
    },
    now: nextDate
  });
  const readCalls: string[] = [];
  const archiveCalls: string[] = [];
  const subscriberArchiveCalls: string[] = [];
  let runtimeReads = 0;
  const routeInput: RouteInputFixture = {
    admission: createHostDeckSelectedWriteAdmissionPolicy({ resourceBudget: defaultResourceBudget, now: () => performance.now() }),
    audit,
    csrf,
    lock,
    runtime: {
      read() {
        runtimeReads += 1;
        return Object.hasOwn(options, "runtime") ? options.runtime : runtimeCandidate();
      }
    },
    sessions: {
      read(candidate) {
        readCalls.push(candidate);
        if (options.readError !== undefined) throw options.readError;
        return (options.readResult ?? selectedState("active")) as SelectedSessionState;
      },
      async archive(candidate) {
        archiveCalls.push(candidate);
        await options.archiveBarrier;
        if (options.archiveError !== undefined) throw options.archiveError;
        return (options.archiveResult ?? selectedState("archived")) as SelectedSessionState;
      }
    },
    subscribers: {
      archive_session(candidate) {
        subscriberArchiveCalls.push(candidate);
        if (options.subscriberArchiveError !== undefined) {
          throw options.subscriberArchiveError;
        }
        return (options.subscriberArchiveResult ?? 0) as number;
      }
    }
  };
  const registration = createHostDeckSessionArchiveRouteRegistration(routeInput);
  const app = createHostDeckFastifyApp({
    observeInternalError: () => undefined,
    requestAuthenticationPolicy: createHostDeckRequestAuthenticationPolicy({
      authenticateDeviceToken: () => {
        throw new Error("Loopback archive must not authenticate a device.");
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
    archiveCalls: () => [...archiveCalls],
    readCalls: () => [...readCalls],
    runtimeReads: () => runtimeReads,
    subscriberArchiveCalls: () => [...subscriberArchiveCalls],
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
    readonly version?: string;
  } = {}
): RuntimeCompatibility {
  const state = input.state ?? "ready";
  const connected = state === "ready" || state === "degraded";
  return runtimeCompatibilitySchema.parse({
    source: "codex_app_server",
    state,
    mutation_policy: input.mutationPolicy ?? (connected ? "allowed" : "blocked"),
    observed_version:
      state === "disconnected" ? null : (input.version ?? runtimeVersion),
    binding_id:
      state === "disconnected" ? null : "binding-session-archive-route-001",
    capabilities: runtimeCapabilities.map((name) =>
      state === "incompatible" && name === "thread_lifecycle"
        ? { name, state: "unavailable", reason: "Capability is unavailable." }
        : { name, state: "available", reason: null }
    ),
    checked_at: timestamp,
    reason: state === "ready" ? null : "Runtime is not ready."
  });
}

function selectedState(
  state: "active" | "archived" | "busy" | "stale" | "unknown"
): SelectedSessionState {
  const archiveTimestamp = state === "archived" ? archivedAt : null;
  const mapping = selectedSessionMappingRecordSchema.parse({
    id: sessionId,
    name: "archive-route-session",
    codex_thread_id: threadId,
    cwd: "/tmp/hostdeck-archive-route",
    runtime_source: "codex_app_server",
    runtime_version: runtimeVersion,
    disposition: state === "stale" ? "recovery_required" : "selected",
    created_at: timestamp,
    updated_at: state === "archived" ? archivedAt : timestamp,
    archived_at: archiveTimestamp
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
      archived_at: archiveTimestamp,
      session_state:
        state === "archived"
          ? "archived"
          : state === "stale"
            ? "stale"
            : state === "unknown"
              ? "unknown"
              : "active",
      turn_state:
        state === "stale" || state === "unknown"
          ? "unknown"
          : state === "busy"
            ? "waiting_for_input"
            : "idle",
      attention:
        state === "stale" || state === "unknown"
          ? "unknown"
          : state === "busy"
            ? "needs_input"
            : "none",
      freshness: state === "stale" ? "stale" : "current",
      freshness_reason: state === "stale" ? "Reconciliation is required." : null,
      updated_at: state === "archived" ? archivedAt : timestamp,
      last_activity_at: state === "archived" ? archivedAt : timestamp,
      branch: "main",
      model: "gpt-5.5-codex",
      goal: null,
      recent_summary:
        state === "archived"
          ? "Managed Codex session archived."
          : "Managed Codex session ready.",
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
  outcome: ManagedCodexThreadServiceOutcome
): HostDeckManagedCodexThreadServiceError {
  return new HostDeckManagedCodexThreadServiceError(
    code,
    "private-service-error-sentinel",
    outcome,
    false,
    threadId
  );
}

async function archive(
  harness: Harness,
  payload: Readonly<Record<string, unknown>>
) {
  return await injectHostDeckLoopback(harness.app, {
    method: "POST",
    url: `/api/v1/sessions/${sessionId}/archive`,
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
  expect(response.json()).toMatchObject({ error: { code, retryable } });
  expect(response.body).not.toContain("private-");
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for session-archive route condition.");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
