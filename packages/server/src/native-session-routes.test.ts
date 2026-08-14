import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultResourceBudget,
  nativeSessionDiscoveryResponseSchema,
  nativeSessionUnmanageResponseSchema,
  selectedSessionMappingRecordSchema,
  selectedSessionProjectionRecordSchema
} from "@hostdeck/contracts";
import {
  createSelectedAuditRepository,
  HostDeckSelectedStateRepositoryError,
  openMigratedDatabase
} from "@hostdeck/storage";
import { afterEach, describe, expect, it } from "vitest";
import { createHostDeckCsrfPolicy } from "./csrf-routes.js";
import { createHostDeckFastifyApp } from "./fastify-app.js";
import {
  createHostDeckRequestAuthenticationPolicy,
  hostDeckDeviceCookieName
} from "./fastify-request-authentication.js";
import {
  createHostDeckRequestTrustPolicy,
  hostDeckLocalAdminRequestHeaderName,
  hostDeckLocalAdminRequestHeaderValue
} from "./fastify-request-trust.js";
import {
  createHostDeckHostHealthService,
  hostDeckLocalHealthComponents
} from "./host-health.js";
import { createHostDeckHostLockPolicy } from "./host-lock-routes.js";
import {
  HostDeckNativeSessionAdministrationError
} from "./native-session-adoption-service.js";
import { createHostDeckNativeSessionRouteRegistration } from "./native-session-routes.js";
import { createHostDeckSelectedWriteAdmissionPolicy } from "./selected-write-admission-policy.js";
import { createHostDeckSelectedWriteAuditExecutor } from "./selected-write-audit-executor.js";

const roots: string[] = [];
const databases: Array<{ readonly close: () => unknown }> = [];
const origin = "http://127.0.0.1:48765";
const fixedTime = "2026-08-12T18:00:00.000Z";
const sessionId = "sess_native_route_001";
const threadId = "0198a100-native-route-thread";
const deviceToken = "N".repeat(43);

afterEach(() => {
  for (const database of databases.splice(0).reverse()) database.close();
  for (const root of roots.splice(0).reverse()) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("IFC-V1-110 local native-session routes", () => {
  it("discovers bounded unmanaged identity only for explicit local-admin authority", async () => {
    const harness = createHarness();
    try {
      const response = await harness.app.inject({
        headers: localHeaders(),
        method: "GET",
        url: "/api/v1/native-sessions?limit=1"
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual(discoveryResponse(1));
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(harness.calls()).toEqual(["discover:1"]);

      const malformed = await harness.app.inject({
        headers: localHeaders(),
        method: "GET",
        url: "/api/v1/native-sessions?limit=0"
      });
      expect(malformed.statusCode).toBe(400);
      expect(harness.calls()).toEqual(["discover:1"]);

      const paired = await harness.app.inject({
        headers: {
          cookie: `${hostDeckDeviceCookieName}=${deviceToken}`,
          host: "127.0.0.1:48765"
        },
        method: "GET",
        url: "/api/v1/native-sessions"
      });
      expect(paired.statusCode).toBe(403);
      expect(paired.json()).toMatchObject({ error: { code: "permission_denied" } });
      expect(harness.calls()).toEqual(["discover:1"]);
    } finally {
      await harness.app.close();
    }
  });

  it("adopts once, writes exact lifecycle audit, and replays the same operation without redispatch", async () => {
    const harness = createHarness();
    const request = adoptRequest("op_native_route_adopt_001", "adopted-work");
    try {
      const first = await harness.app.inject({
        headers: localHeaders(),
        method: "POST",
        payload: request,
        url: "/api/v1/native-sessions"
      });
      expect(first.statusCode, first.body).toBe(201);
      expect(first.json()).toMatchObject({
        operation_id: request.operation_id,
        session: {
          id: sessionId,
          name: request.name,
          codex_thread_id: threadId
        }
      });
      expect(harness.calls()).toEqual([`adopt:${threadId}`]);
      expect(harness.audit(request.operation_id)).toMatchObject({
        state: "terminal",
        records: [
          {
            actor: { type: "cli" },
            action: "session_adopt",
            target: { type: "native_codex_thread", codex_thread_id: threadId },
            phase: "accepted",
            payload_summary: {
              schema_version: 1,
              handoff_confirmed: true,
              name_length: request.name.length
            }
          },
          {
            action: "session_adopt",
            phase: "terminal",
            outcome: "succeeded",
            payload_summary: {
              schema_version: 1,
              history_turn_count: 2,
              adopted: true
            }
          }
        ]
      });

      const replay = await harness.app.inject({
        headers: localHeaders(),
        method: "POST",
        payload: request,
        url: "/api/v1/native-sessions"
      });
      expect(replay.statusCode, replay.body).toBe(201);
      expect(replay.json()).toEqual(first.json());
      expect(harness.calls()).toEqual([`adopt:${threadId}`]);

      const conflict = await harness.app.inject({
        headers: localHeaders(),
        method: "POST",
        payload: { ...request, name: "different-name" },
        url: "/api/v1/native-sessions"
      });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json()).toMatchObject({ error: { code: "operation_conflict" } });
      expect(harness.calls()).toEqual([`adopt:${threadId}`]);
    } finally {
      await harness.app.close();
    }
  });

  it("rejects paired mutation authority before dispatch or audit", async () => {
    const harness = createHarness();
    const request = adoptRequest("op_native_route_paired_001", "paired-rejected");
    try {
      const response = await harness.app.inject({
        headers: {
          cookie: `${hostDeckDeviceCookieName}=${deviceToken}`,
          host: "127.0.0.1:48765"
        },
        method: "POST",
        payload: request,
        url: "/api/v1/native-sessions"
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: "permission_denied" } });
      expect(harness.calls()).toEqual([]);
      expect(harness.auditOrNull(request.operation_id)).toBeNull();
    } finally {
      await harness.app.close();
    }
  });

  it("records post-commit activation failure as incomplete and explicitly forbids retry", async () => {
    const harness = createHarness({
      adoptError: new HostDeckNativeSessionAdministrationError(
        "recovery_required",
        "private activation details",
        "committed",
        false,
        sessionId,
        threadId
      )
    });
    const request = adoptRequest("op_native_route_recovery_001", "recovery-work");
    try {
      const response = await harness.app.inject({
        headers: localHeaders(),
        method: "POST",
        payload: request,
        url: "/api/v1/native-sessions"
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        error: { code: "stale_session", retryable: false }
      });
      expect(response.body).toContain("Do not retry adoption");
      expect(response.body).not.toContain("private activation");
      expect(harness.audit(request.operation_id).records[1]).toMatchObject({
        action: "session_adopt",
        outcome: "incomplete",
        error_code: "stale_session",
        payload_summary: { schema_version: 1, activation_pending: true }
      });
    } finally {
      await harness.app.close();
    }
  });

  it("unmanages one quiet adopted target and replays after HostDeck state is gone", async () => {
    const harness = createHarness();
    const request = { operation_id: "op_native_route_unmanage_001", confirm: true } as const;
    try {
      const first = await harness.app.inject({
        headers: localHeaders(),
        method: "POST",
        payload: request,
        url: `/api/v1/sessions/${sessionId}/unmanage`
      });
      expect(first.statusCode, first.body).toBe(200);
      expect(first.json()).toEqual({
        operation_id: request.operation_id,
        session_id: sessionId,
        codex_thread_id: threadId,
        unmanaged_at: fixedTime
      });
      expect(harness.calls()).toEqual([`state:${sessionId}`, `unmanage:${sessionId}`]);
      expect(harness.audit(request.operation_id).records).toMatchObject([
        {
          action: "session_unmanage",
          phase: "accepted",
          payload_summary: { schema_version: 1, confirm: true }
        },
        {
          action: "session_unmanage",
          phase: "terminal",
          outcome: "succeeded",
          payload_summary: { schema_version: 1, unmanaged: true }
        }
      ]);

      harness.removeState();
      const replay = await harness.app.inject({
        headers: localHeaders(),
        method: "POST",
        payload: request,
        url: `/api/v1/sessions/${sessionId}/unmanage`
      });
      expect(replay.statusCode, replay.body).toBe(200);
      expect(replay.json()).toEqual(first.json());
      expect(harness.calls()).toEqual([`state:${sessionId}`, `unmanage:${sessionId}`]);
    } finally {
      await harness.app.close();
    }
  });

  it("enforces ready and unlocked host state before native service access", async () => {
    const locked = createHarness({ locked: true });
    try {
      const response = await locked.app.inject({
        headers: localHeaders(),
        method: "GET",
        url: "/api/v1/native-sessions"
      });
      expect(response.statusCode).toBe(423);
      expect(response.json()).toMatchObject({ error: { code: "host_locked" } });
      expect(locked.calls()).toEqual([]);
    } finally {
      await locked.app.close();
    }

    const unready = createHarness({ ready: false });
    try {
      const response = await unready.app.inject({
        headers: localHeaders(),
        method: "GET",
        url: "/api/v1/native-sessions"
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ error: { code: "runtime_unavailable" } });
      expect(unready.calls()).toEqual([]);
    } finally {
      await unready.app.close();
    }
  });

  it("distinguishes a missing unmanage target from unavailable state storage", async () => {
    const missing = createHarness({ stateError: "session_not_found" });
    const unavailable = createHarness({ stateError: "invalid_projection" });
    const request = {
      operation_id: "op_native_route_state_error_001",
      confirm: true
    } as const;
    try {
      const missingResponse = await missing.app.inject({
        headers: localHeaders(),
        method: "POST",
        payload: request,
        url: `/api/v1/sessions/${sessionId}/unmanage`
      });
      expect(missingResponse.statusCode).toBe(404);
      expect(missingResponse.json()).toMatchObject({
        error: { code: "session_not_found" }
      });
      expect(missing.calls()).toEqual([`state:${sessionId}`]);

      const unavailableResponse = await unavailable.app.inject({
        headers: localHeaders(),
        method: "POST",
        payload: {
          ...request,
          operation_id: "op_native_route_state_error_002"
        },
        url: `/api/v1/sessions/${sessionId}/unmanage`
      });
      expect(unavailableResponse.statusCode).toBe(500);
      expect(unavailableResponse.json()).toMatchObject({
        error: { code: "storage_error" }
      });
      expect(unavailable.calls()).toEqual([`state:${sessionId}`]);
    } finally {
      await Promise.all([missing.app.close(), unavailable.app.close()]);
    }
  });
});

interface HarnessOptions {
  readonly adoptError?: Error;
  readonly locked?: boolean;
  readonly ready?: boolean;
  readonly stateError?: "invalid_projection" | "session_not_found";
}

function createHarness(options: HarnessOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "hostdeck-native-routes-"));
  roots.push(root);
  const opened = openMigratedDatabase(join(root, "hostdeck.sqlite"), {
    now: () => new Date(fixedTime)
  });
  databases.push(opened.db);
  const auditRepository = createSelectedAuditRepository(opened.db);
  let auditRecord = 0;
  const audit = createHostDeckSelectedWriteAuditExecutor({
    repository: auditRepository,
    now: () => fixedTime,
    create_record_id: () => `audit:native-route:${++auditRecord}`
  });
  const calls: string[] = [];
  const now = () => new Date(fixedTime);
  const health = createHostDeckHostHealthService({ now });
  if (options.ready !== false) {
    for (const component of hostDeckLocalHealthComponents) {
      health.updateLocal({
        component,
        state: "ready",
        reasons: [],
        source_generation: 1
      });
    }
  }
  const admission = createHostDeckSelectedWriteAdmissionPolicy({
    resourceBudget: defaultResourceBudget,
    now: () => 1,
    health
  });
  const lock = createHostDeckHostLockPolicy({
    now,
    settings: {
      read: () => Object.freeze({
        locked: options.locked === true,
        settings_updated_at: fixedTime
      }),
      transition: () => {
        throw new Error("unused");
      }
    }
  });
  const authentication = createHostDeckRequestAuthenticationPolicy({
    now,
    authenticateDeviceToken: ({ rawDeviceToken }) => ({
      trusted: rawDeviceToken === deviceToken,
      readOnly: false,
      device: rawDeviceToken === deviceToken ? writerDevice() : null
    })
  });
  const csrf = createHostDeckCsrfPolicy({
    csrf: {
      authorizeBrowserWrite: () => {
        throw new Error("Native local-admin routes must not authorize browser CSRF.");
      },
      rotateBootstrap: () => {
        throw new Error("unused");
      }
    },
    now
  });
  let selectedState: ReturnType<typeof managedState> | null = managedState("adopted-work");
  const native = {
    async discover(input: unknown) {
      const limit =
        input !== null &&
        typeof input === "object" &&
        "limit" in input &&
        typeof input.limit === "number"
          ? input.limit
          : 50;
      calls.push(`discover:${limit}`);
      return discoveryResponse(limit);
    },
    async adopt(input: unknown) {
      if (
        input === null ||
        typeof input !== "object" ||
        !("thread_id" in input) ||
        typeof input.thread_id !== "string" ||
        !("name" in input) ||
        typeof input.name !== "string"
      ) {
        throw new TypeError("invalid test adoption input");
      }
      calls.push(`adopt:${input.thread_id}`);
      if (options.adoptError !== undefined) throw options.adoptError;
      const state = managedState(input.name);
      selectedState = state;
      return { history_turn_count: 2, state };
    },
    async unmanage(targetSessionId: string, input: unknown) {
      if (
        input === null ||
        typeof input !== "object" ||
        !("operation_id" in input) ||
        typeof input.operation_id !== "string"
      ) {
        throw new TypeError("invalid test unmanage input");
      }
      calls.push(`unmanage:${targetSessionId}`);
      return nativeSessionUnmanageResponseSchema.parse({
        operation_id: input.operation_id,
        session_id: targetSessionId,
        codex_thread_id: threadId,
        unmanaged_at: fixedTime
      });
    }
  };
  const state = {
    require(targetSessionId: string) {
      calls.push(`state:${targetSessionId}`);
      if (options.stateError !== undefined) {
        throw new HostDeckSelectedStateRepositoryError(
          options.stateError,
          "private state repository detail"
        );
      }
      if (selectedState === null || targetSessionId !== sessionId) {
        throw new HostDeckSelectedStateRepositoryError(
          "session_not_found",
          "missing"
        );
      }
      return selectedState;
    }
  };
  const registration = createHostDeckNativeSessionRouteRegistration({
    admission,
    audit,
    csrf,
    health,
    lock,
    native,
    state
  });
  const app = createHostDeckFastifyApp({
    observeInternalError: () => undefined,
    requestAuthenticationPolicy: authentication,
    requestTrustPolicy: createHostDeckRequestTrustPolicy({ allowedOrigin: origin }),
    resourceBudget: defaultResourceBudget,
    routePlugins: [registration]
  });
  return {
    app,
    audit: (operationId: string) => auditRepository.require(operationId),
    auditOrNull: (operationId: string) => auditRepository.get(operationId),
    calls: () => [...calls],
    removeState: () => {
      selectedState = null;
    }
  };
}

function managedState(name: string) {
  const mapping = selectedSessionMappingRecordSchema.parse({
    id: sessionId,
    name,
    codex_thread_id: threadId,
    cwd: "/tmp/native-route-project",
    runtime_source: "codex_app_server",
    runtime_version: "0.147.0",
    disposition: "selected",
    created_at: fixedTime,
    updated_at: fixedTime,
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
      updated_at: fixedTime,
      last_activity_at: fixedTime,
      branch: "main",
      model: null,
      settings: null,
      goal: null,
      recent_summary: "Adopted native Codex session ready.",
      last_event_cursor: 1
    },
    retained_event_count: 1,
    retained_event_bytes: 100,
    earliest_retained_cursor: 1,
    retention_boundary_cursor: null
  });
  return Object.freeze({ mapping, projection });
}

function discoveryResponse(limit: number) {
  return nativeSessionDiscoveryResponseSchema.parse({
    limit,
    threads: [
      {
        thread_id: threadId,
        cwd: "/tmp/native-route-project",
        source: "cli",
        runtime_version: "0.147.0",
        created_at: fixedTime,
        updated_at: fixedTime,
        status: "idle",
        archived: false,
        ephemeral: false,
        parent_thread_id: null,
        forked_from_id: null,
        history_mode: "paginated"
      }
    ].slice(0, limit),
    truncated: false
  });
}

function adoptRequest(operationId: string, name: string) {
  return {
    operation_id: operationId,
    thread_id: threadId,
    name,
    confirm_handoff: true
  } as const;
}

function localHeaders() {
  return {
    host: "127.0.0.1:48765",
    [hostDeckLocalAdminRequestHeaderName]: hostDeckLocalAdminRequestHeaderValue
  };
}

function writerDevice() {
  return {
    id: "client_native_route_writer",
    token_hash: `sha256:${"a".repeat(64)}`,
    csrf_token_hash: `sha256:${"b".repeat(64)}`,
    csrf_generation: 1,
    csrf_rotated_at: fixedTime,
    client_label: "Native route phone",
    permission: "write" as const,
    created_at: fixedTime,
    last_used_at: fixedTime,
    expires_at: null,
    revoked_at: null
  };
}
