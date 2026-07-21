import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CodexAppServerConnection,
  type CodexProtocolIssue,
  type CodexRequestInput,
  createCodexAppServerConnection,
  createCodexCompactClient,
  createCodexUsageClient,
  HostDeckCodexAdapterError,
  type NormalizedCodexEvent
} from "@hostdeck/codex-adapter";
import { ScriptedCodexTransport } from "@hostdeck/codex-adapter/testing";
import {
  defaultResourceBudget,
  selectedSessionMappingRecordSchema,
  selectedSessionProjectionRecordSchema
} from "@hostdeck/contracts";
import type { OperationDeadline } from "@hostdeck/core";
import {
  createSelectedAuditRepository,
  HostDeckAuthRepositoryError,
  openMigratedDatabase,
  type SelectedAuditRepository,
  type SelectedSessionState
} from "@hostdeck/storage";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CodexCompactControlService,
  createCodexCompactControlService
} from "./codex-compact-control-service.js";
import { createCodexUsageControlService } from "./codex-usage-control-service.js";
import { createHostDeckCompactRouteRegistration } from "./compact-routes.js";
import { createHostDeckCsrfPolicy } from "./csrf-routes.js";
import {
  createHostDeckFastifyApp,
  createHostDeckTailscaleServeFastifyApp,
  type HostDeckFastifyInstance
} from "./fastify-app.js";
import {
  hostDeckLoopbackTestOrigin,
  injectHostDeckLoopback
} from "./fastify-loopback-test-request.js";
import {
  createHostDeckRequestAuthenticationPolicy,
  hostDeckDeviceCookieName
} from "./fastify-request-authentication.js";
import { createHostDeckRequestTrustPolicy } from "./fastify-request-trust.js";
import { createHostDeckHostLockPolicy } from "./host-lock-routes.js";
import { createHostDeckRemoteIngressRequestAuthorityPolicy } from "./remote-ingress-request-authority.js";
import { createHostDeckSelectedWriteAdmissionPolicy } from "./selected-write-admission-policy.js";
import { createHostDeckSelectedWriteAuditExecutor } from "./selected-write-audit-executor.js";
import { createTailscaleServeProxyTrustPolicy } from "./tailscale-serve-proxy-trust.js";
import { createHostDeckUsageRouteRegistration } from "./usage-routes.js";

const timestamp = "2026-07-20T16:00:00.000Z";
const acceptedAt = "2026-07-20T16:00:01.000Z";
const runtimeVersion = "0.144.0";
const sessionId = "sess_deadline_aggregate_001";
const threadId = "thread-deadline-aggregate-001";
const remoteToken = "R".repeat(43);
const remoteOrigin = "https://hostdeck-deadline.fixture-tailnet.ts.net";
const remoteLocalOrigin = "http://127.0.0.1:3777";
const remoteSource = "100.91.82.73";
const cleanup: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

describe("selected request deadline aggregate", () => {
  it("maps real broker read timeouts to 504 through loopback and admitted remote composition", async () => {
    const issues: CodexProtocolIssue[] = [];
    const transport = createReadyTransport("account/usage/read", "possible_send");
    const connection = await connect(transport, issues);
    const requests: CodexRequestInput[] = [];
    const client = createCodexUsageClient(observedConnectionPort(connection, requests), {
      read_timeout_ms: 1_000,
      now: () => timestamp
    });
    const state = selectedState();
    const states = selectedStatePort(state);
    const service = createCodexUsageControlService({ states, usage: client });
    const deadlines: OperationDeadline[] = [];
    const registration = createHostDeckUsageRouteRegistration({
      state: { get: states.get },
      usage: {
        async read(intent, deadline) {
          deadlines.push(deadline);
          return service.read(intent, deadline);
        }
      }
    });
    const loopback = createUsageLoopbackApp(registration);
    const remote = createUsageRemoteApp(registration);
    await loopback.ready();
    await remote.ready();

    const loopbackResponse = await injectHostDeckLoopback(loopback, {
      method: "GET",
      url: `/api/v1/sessions/${sessionId}/usage`
    });
    const remoteResponse = await injectHostDeckLoopback(remote, {
      method: "GET",
      url: `/api/v1/sessions/${sessionId}/usage`,
      headers: remoteHeaders(remoteToken)
    });

    expectStableError(loopbackResponse, 504, "operation_timeout");
    expectStableError(remoteResponse, 504, "operation_timeout");
    expect(deadlines).toHaveLength(2);
    expect(requests).toHaveLength(2);
    requests.forEach((request, index) => {
      expect(request).toMatchObject({
        method: "account/usage/read",
        kind: "read",
        timeout_ms: 1_000
      });
      expect(request.signal).toBe(deadlines[index]?.signal);
    });
    expect(targetFrames(transport, "account/usage/read")).toHaveLength(2);
    expect(connection.pending_request_count).toBe(0);
    expect(issues).toEqual([]);
  });

  it("keeps a transport-proven no-submit compact timeout failed and retryable only by a new operation", async () => {
    const harness = await createCompactHarness("not_sent");
    const operationId = "op_compact_deadline_no_send_0001";
    const response = await startCompact(harness.app, operationId);

    expectStableError(response, 504, "operation_timeout");
    const retryOperationId = "op_compact_deadline_no_send_0002";
    const retry = await startCompact(harness.app, retryOperationId);
    expectStableError(retry, 504, "operation_timeout");
    expect(targetFrames(harness.transport, "thread/compact/start")).toEqual([]);
    expect(harness.requests).toHaveLength(2);
    harness.requests.forEach((request, index) => {
      expect(request).toMatchObject({
        method: "thread/compact/start",
        kind: "mutation",
        timeout_ms: 1_000
      });
      expect(request.signal).toBe(harness.deadlines[index]?.signal);
    });
    expect(harness.audit.require(operationId)).toMatchObject({
      state: "terminal",
      records: [
        { phase: "accepted", outcome: "accepted" },
        { phase: "terminal", outcome: "failed", error_code: "operation_timeout" }
      ]
    });
    expect(harness.audit.require(retryOperationId).records[1]).toMatchObject({
      phase: "terminal",
      outcome: "failed",
      error_code: "operation_timeout"
    });
    expect(harness.service.tracked_count).toBe(0);
    expect(harness.connection.pending_request_count).toBe(0);
  });

  it("keeps a possible-send compact timeout incomplete while late proof reconciles only service state", async () => {
    const harness = await createCompactHarness("possible_send");
    const operationId = "op_compact_deadline_unknown_0001";
    const response = await startCompact(harness.app, operationId);

    expectStableError(response, 504, "operation_timeout");
    expect(targetFrames(harness.transport, "thread/compact/start")).toHaveLength(1);
    expect(harness.requests).toHaveLength(1);
    expect(harness.requests[0]?.signal).toBe(harness.deadlines[0]?.signal);
    expect(await harness.service.snapshot(managedTarget())).toMatchObject({
      operation_id: operationId,
      state: "incomplete",
      error: { code: "operation_timeout" }
    });
    const immutableAudit = JSON.stringify(harness.audit.require(operationId));
    expect(harness.audit.require(operationId).records[1]).toMatchObject({
      outcome: "incomplete",
      error_code: "operation_timeout"
    });

    const replay = await startCompact(harness.app, operationId);
    expectStableError(replay, 504, "operation_timeout");
    const guarded = await startCompact(harness.app, "op_compact_deadline_guarded_0001");
    expectStableError(guarded, 409, "operation_conflict", true);
    expect(targetFrames(harness.transport, "thread/compact/start")).toHaveLength(1);

    const requestId = targetRequestIds(harness.transport, "thread/compact/start")[0];
    if (requestId === undefined) throw new Error("Missing compact aggregate request id.");
    harness.transport.receive(JSON.stringify({ id: requestId, result: {} }));
    expect(harness.issues).toEqual([
      expect.objectContaining({ code: "late_response", severity: "degraded" })
    ]);

    for (const event of completedCompactEvents()) {
      await harness.service.observe(event, harness.connection.generation);
    }
    expect(await harness.service.snapshot(managedTarget())).toMatchObject({
      operation_id: operationId,
      state: "completed",
      error: null
    });
    expect(JSON.stringify(harness.audit.require(operationId))).toBe(immutableAudit);
    expect(response.statusCode).toBe(504);
    expect(harness.service.active_count).toBe(0);
    expect(harness.connection.pending_request_count).toBe(0);
    expect(targetFrames(harness.transport, "thread/compact/start")).toHaveLength(1);
  });
});

type DispatchMode = "not_sent" | "possible_send";

interface CompactHarness {
  readonly app: HostDeckFastifyInstance;
  readonly audit: SelectedAuditRepository;
  readonly connection: CodexAppServerConnection;
  readonly deadlines: OperationDeadline[];
  readonly issues: CodexProtocolIssue[];
  readonly requests: CodexRequestInput[];
  readonly service: CodexCompactControlService;
  readonly transport: ScriptedCodexTransport;
}

async function createCompactHarness(mode: DispatchMode): Promise<CompactHarness> {
  const directory = mkdtempSync(join(tmpdir(), "hostdeck-deadline-aggregate-"));
  const open = openMigratedDatabase(join(directory, "hostdeck.sqlite"), {
    now: () => new Date(timestamp)
  });
  cleanup.push(() => {
    if (open.db.open) open.db.close();
    rmSync(directory, { force: true, recursive: true });
  });
  const issues: CodexProtocolIssue[] = [];
  const transport = createReadyTransport("thread/compact/start", mode);
  const connection = await connect(transport, issues);
  const requests: CodexRequestInput[] = [];
  const compact = createCodexCompactClient(observedConnectionPort(connection, requests), {
    mutation_timeout_ms: 1_000,
    now: () => acceptedAt
  });
  const state = selectedState();
  const states = selectedStatePort(state);
  const service = createCodexCompactControlService({
    compact,
    states,
    now: () => acceptedAt
  });
  const audit = createSelectedAuditRepository(open.db);
  let wallClock = Date.parse(timestamp);
  let auditId = 0;
  const nextDate = () => new Date(wallClock++);
  const deadlines: OperationDeadline[] = [];
  const registration = createHostDeckCompactRouteRegistration({
    admission: createHostDeckSelectedWriteAdmissionPolicy({
      resourceBudget: defaultResourceBudget,
      now: () => performance.now()
    }),
    audit: createHostDeckSelectedWriteAuditExecutor({
      repository: audit,
      now: () => nextDate().toISOString(),
      create_record_id: () => `audit_deadline_aggregate_${++auditId}`
    }),
    compact: {
      async compact(intent, deadline) {
        deadlines.push(deadline);
        return service.compact(intent, deadline);
      },
      snapshot: (target) => service.snapshot(target)
    },
    csrf: createHostDeckCsrfPolicy({
      csrf: {
        authorizeBrowserWrite() {
          throw new Error("Loopback deadline aggregate must not authorize browser CSRF.");
        },
        rotateBootstrap() {
          throw new Error("Loopback deadline aggregate must not rotate browser CSRF.");
        }
      },
      now: nextDate
    }),
    lock: createHostDeckHostLockPolicy({
      settings: {
        read: () => Object.freeze({ locked: false, settings_updated_at: timestamp }),
        transition() {
          throw new Error("Deadline aggregate must not transition host lock.");
        }
      },
      now: nextDate
    }),
    runtime: { read: () => connection.compatibility },
    state: { get: states.get }
  });
  const app = createHostDeckFastifyApp({
    observeInternalError: () => undefined,
    requestAuthenticationPolicy: loopbackAuthenticationPolicy(),
    requestTrustPolicy: createHostDeckRequestTrustPolicy({
      allowedOrigin: hostDeckLoopbackTestOrigin
    }),
    resourceBudget: defaultResourceBudget,
    routePlugins: [registration]
  });
  cleanup.push(() => app.close());
  await app.ready();
  return { app, audit, connection, deadlines, issues, requests, service, transport };
}

function createUsageLoopbackApp(
  registration: ReturnType<typeof createHostDeckUsageRouteRegistration>
): HostDeckFastifyInstance {
  const app = createHostDeckFastifyApp({
    observeInternalError: () => undefined,
    requestAuthenticationPolicy: loopbackAuthenticationPolicy(),
    requestTrustPolicy: createHostDeckRequestTrustPolicy({
      allowedOrigin: hostDeckLoopbackTestOrigin
    }),
    resourceBudget: defaultResourceBudget,
    routePlugins: [registration]
  });
  cleanup.push(() => app.close());
  return app;
}

function createUsageRemoteApp(
  registration: ReturnType<typeof createHostDeckUsageRouteRegistration>
): HostDeckFastifyInstance {
  const authority = createHostDeckRemoteIngressRequestAuthorityPolicy();
  const app = createHostDeckTailscaleServeFastifyApp({
    observeInternalError: () => undefined,
    requestAuthenticationPolicy: createHostDeckRequestAuthenticationPolicy({
      authenticateDeviceToken({ rawDeviceToken }) {
        if (rawDeviceToken !== remoteToken) {
          throw new HostDeckAuthRepositoryError(
            "device_not_found",
            "Deadline aggregate device authentication failed."
          );
        }
        return authenticatedRemoteDevice();
      },
      now: () => new Date(timestamp)
    }),
    resourceBudget: defaultResourceBudget,
    routePlugins: [registration],
    remoteIngressRequestAuthority: authority,
    tailscaleServeProxyTrustPolicy: createTailscaleServeProxyTrustPolicy({
      localOrigin: remoteLocalOrigin,
      readRemoteAdmission: () =>
        authority.synchronize({
          admission: "open",
          external_origin: remoteOrigin,
          generation: 1
        })
    })
  });
  cleanup.push(() => app.close());
  return app;
}

function loopbackAuthenticationPolicy() {
  return createHostDeckRequestAuthenticationPolicy({
    authenticateDeviceToken() {
      throw new Error("Loopback deadline aggregate must not authenticate a device.");
    },
    now: () => new Date(timestamp)
  });
}

async function connect(
  transport: ScriptedCodexTransport,
  issues: CodexProtocolIssue[]
): Promise<CodexAppServerConnection> {
  const connection = createCodexAppServerConnection({
    transport,
    observed_version: runtimeVersion,
    handshake_timeout_ms: 1_000,
    now: () => timestamp,
    on_protocol_issue: (issue) => issues.push(issue)
  });
  cleanup.push(() => connection.close("Deadline aggregate cleanup."));
  await connection.connect();
  return connection;
}

function observedConnectionPort(
  connection: CodexAppServerConnection,
  requests: CodexRequestInput[]
) {
  return {
    get compatibility() {
      return connection.compatibility;
    },
    get generation() {
      return connection.generation;
    },
    request(input: CodexRequestInput) {
      requests.push(input);
      return connection.request(input);
    }
  };
}

function createReadyTransport(targetMethod: string, mode: DispatchMode): ScriptedCodexTransport {
  return mode === "not_sent"
    ? new NoSubmitScriptedCodexTransport(targetMethod)
    : new ScriptedCodexTransport({ on_send: respondToHandshake });
}

class NoSubmitScriptedCodexTransport extends ScriptedCodexTransport {
  constructor(private readonly targetMethod: string) {
    super({ on_send: respondToHandshake });
  }

  override async sendText(text: string): Promise<void> {
    const frame = parseOutboundFrame(text);
    if (frame.method === this.targetMethod) {
      throw new HostDeckCodexAdapterError(
        "request_timeout",
        "Controlled transport timed out before submitting the protocol frame.",
        { outcome: "not_sent", retry_safe: true }
      );
    }
    await super.sendText(text);
  }
}

function respondToHandshake(text: string, transport: ScriptedCodexTransport): void {
  const frame = parseOutboundFrame(text);
  if (frame.method === "initialize") {
    transport.receive(
      JSON.stringify({
        id: frame.id,
        result: {
          userAgent: "hostdeck/0.144.0 (Ubuntu 24.04; x86_64)",
          codexHome: "/tmp/codex-home",
          platformFamily: "unix",
          platformOs: "linux"
        }
      })
    );
  } else if (frame.method === "collaborationMode/list") {
    transport.receive(
      JSON.stringify({
        id: frame.id,
        result: { data: [{ name: "Plan" }, { name: "Default" }] }
      })
    );
  }
}

function parseOutboundFrame(text: string): { readonly id?: number; readonly method: string } {
  return JSON.parse(text) as { readonly id?: number; readonly method: string };
}

function targetFrames(
  transport: ScriptedCodexTransport,
  method: string
): readonly string[] {
  return transport.sent_frames.filter(
    (frame) => parseOutboundFrame(frame).method === method
  );
}

function targetRequestIds(
  transport: ScriptedCodexTransport,
  method: string
): readonly number[] {
  return targetFrames(transport, method).map((frame) => {
    const id = parseOutboundFrame(frame).id;
    if (id === undefined) throw new Error("Target protocol frame has no request id.");
    return id;
  });
}

function selectedStatePort(state: SelectedSessionState) {
  return {
    get: (candidate: string) => candidate === sessionId ? state : null,
    getByThreadId: (candidate: string) => candidate === threadId ? state : null
  };
}

function selectedState(): SelectedSessionState {
  return {
    mapping: selectedSessionMappingRecordSchema.parse({
      id: sessionId,
      name: "deadline-aggregate",
      codex_thread_id: threadId,
      cwd: "/tmp/hostdeck-deadline-aggregate",
      runtime_source: "codex_app_server",
      runtime_version: runtimeVersion,
      disposition: "selected",
      created_at: timestamp,
      updated_at: timestamp,
      archived_at: null
    }),
    projection: selectedSessionProjectionRecordSchema.parse({
      session: {
        id: sessionId,
        name: "deadline-aggregate",
        codex_thread_id: threadId,
        cwd: "/tmp/hostdeck-deadline-aggregate",
        runtime_source: "codex_app_server",
        runtime_version: runtimeVersion,
        created_at: timestamp,
        archived_at: null,
        session_state: "active",
        turn_state: "idle",
        attention: "none",
        freshness: "current",
        freshness_reason: null,
        updated_at: timestamp,
        last_activity_at: null,
        branch: null,
        model: null,
        goal: null,
        recent_summary: "",
        last_event_cursor: null
      },
      retained_event_count: 0,
      retained_event_bytes: 0,
      earliest_retained_cursor: null,
      retention_boundary_cursor: null
    })
  };
}

function managedTarget() {
  return {
    type: "managed_session" as const,
    session_id: sessionId,
    codex_thread_id: threadId
  };
}

async function startCompact(app: HostDeckFastifyInstance, operationId: string) {
  return injectHostDeckLoopback(app, {
    method: "POST",
    url: `/api/v1/sessions/${sessionId}/compact`,
    payload: { operation_id: operationId, kind: "compact", confirm: true }
  });
}

function completedCompactEvents(): readonly NormalizedCodexEvent[] {
  const turnId = "turn-deadline-aggregate-001";
  const itemId = "item-deadline-aggregate-001";
  const eventTime = (sequence: number) =>
    new Date(Date.parse(acceptedAt) + sequence * 1_000).toISOString();
  return [
    {
      sequence: 1,
      method: "turn/started",
      captured_at: eventTime(1),
      upstream_at: null,
      codex_event_id: `${turnId}:started`,
      scope: "thread",
      thread_id: threadId,
      turn_id: turnId,
      status: "in_progress"
    } as NormalizedCodexEvent,
    {
      sequence: 2,
      method: "item/started",
      captured_at: eventTime(2),
      upstream_at: null,
      codex_event_id: `${itemId}:started`,
      scope: "thread",
      thread_id: threadId,
      turn_id: turnId,
      item: {
        id: itemId,
        category: "compaction",
        state: "started",
        title: "Context compaction",
        text: null,
        content_state: "complete",
        content_notice: null
      }
    } as NormalizedCodexEvent,
    {
      sequence: 3,
      method: "item/completed",
      captured_at: eventTime(3),
      upstream_at: null,
      codex_event_id: `${itemId}:completed`,
      scope: "thread",
      thread_id: threadId,
      turn_id: turnId,
      item: {
        id: itemId,
        category: "compaction",
        state: "completed",
        title: "Context compaction",
        text: null,
        content_state: "complete",
        content_notice: null
      }
    } as NormalizedCodexEvent,
    {
      sequence: 4,
      method: "turn/completed",
      captured_at: eventTime(4),
      upstream_at: null,
      codex_event_id: `${turnId}:completed`,
      scope: "thread",
      thread_id: threadId,
      turn_id: turnId,
      status: "completed",
      error_message: null
    } as NormalizedCodexEvent
  ];
}

function authenticatedRemoteDevice() {
  return {
    trusted: true as const,
    readOnly: true,
    device: {
      id: "client_deadline_aggregate",
      token_hash: `sha256:${"a".repeat(64)}`,
      csrf_token_hash: `sha256:${"b".repeat(64)}`,
      csrf_generation: 1,
      csrf_rotated_at: timestamp,
      client_label: "Deadline aggregate phone",
      permission: "read" as const,
      created_at: timestamp,
      last_used_at: timestamp,
      expires_at: null,
      revoked_at: null
    }
  };
}

function remoteHeaders(rawToken: string): Record<string, string> {
  const authority = new URL(remoteOrigin).host;
  return {
    host: authority,
    origin: remoteOrigin,
    cookie: `${hostDeckDeviceCookieName}=${rawToken}`,
    "x-forwarded-for": remoteSource,
    "x-forwarded-host": authority,
    "x-forwarded-proto": "https",
    "tailscale-headers-info": "https://tailscale.com/s/serve-headers",
    "tailscale-user-login": "identity-does-not-authorize@example.test",
    "tailscale-user-name": "Identity Does Not Authorize",
    "tailscale-user-profile-pic": "https://example.test/avatar"
  };
}

function expectStableError(
  response: { readonly statusCode: number; readonly body: string; readonly json: () => unknown },
  status: number,
  code: string,
  retryable = false
): void {
  expect(response.statusCode, response.body).toBe(status);
  expect(response.json()).toMatchObject({ error: { code, retryable } });
  expect(response.body).not.toMatch(/cookie|prompt|goal|protocol frame|codex-home/iu);
}
