import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { type ClientRequest, request as httpRequest, type IncomingMessage } from "node:http";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CliFailure, createHostDeckCompactClient, createHostDeckUsageClient } from "../packages/cli/src/index.js";
import { createBoundedLoopbackFetch } from "../packages/cli/src/loopback-http.js";
import {
  type CodexAppServerConnection,
  type CodexProtocolIssue,
  type CodexRequestInput,
  codexResourceOptionsFromBudget,
  createCodexAppServerConnection,
  createCodexCompactClient,
  createCodexUsageClient,
  HostDeckCodexAdapterError,
  type NormalizedCodexEvent,
} from "../packages/codex-adapter/src/index.js";
import { ScriptedCodexTransport } from "../packages/codex-adapter/src/testing.js";
import {
  clientOperationIdSchema,
  codexThreadIdSchema,
  codexTurnIdSchema,
  type ResourceBudget,
  resolveResourceBudget,
  type SelectedProjectionEvent,
  type SelectedSessionEventStream,
  selectedAuditActorSchema,
  selectedProjectionEventSchema,
  selectedSessionEventStreamSchema,
  selectedSessionMappingRecordSchema,
  selectedSessionProjectionRecordSchema,
} from "../packages/contracts/src/index.js";
import {
  type CodexCompactControlService,
  type CodexPromptControlService,
  type CreateHostDeckSelectedApiRouteCompositionInput,
  createCodexCompactControlService,
  createCodexUsageControlService,
  createHostDeckCsrfPolicy,
  createHostDeckHostHealthService,
  createHostDeckHostLockPolicy,
  createHostDeckPairingPolicy,
  createHostDeckRequestAuthenticationPolicy,
  createHostDeckSelectedApiRouteComposition,
  createHostDeckSelectedWriteAdmissionPolicy,
  createHostDeckSelectedWriteAuditExecutor,
  createProjectionFanoutHub,
  createProjectionReplayLiveHandoffService,
  createProjectionSubscriberStreamService,
  createRemoteIngressControlService,
  createSecurityMutationAuditExecutor,
  type HostDeckFastifyLifecycle,
  type HostDeckSelectedWriteAdmissionPolicy,
  hostDeckFastifyResourceSnapshot,
  hostDeckFastifyRouteInventory,
  type ProjectionFanoutHub,
  type ProjectionSubscriberStreamService,
  selectedApiRouteManifest,
  startHostDeckFastifyLifecycle,
} from "../packages/server/src/index.js";
import {
  createRemoteIngressAdmissionProofRepository,
  createRemoteIngressStateRepository,
  createSelectedAuditRepository,
  HostDeckSelectedStateRepositoryError,
  openMigratedDatabase,
  type SelectedAuditRepository,
  type SelectedSessionState,
  selectedProjectedEventByteLength,
} from "../packages/storage/src/index.js";

const timestamp = "2026-07-20T20:00:00.000Z";
const runtimeVersion = "0.144.0";
const privatePrompt = ["RESOURCE", "STRESS", "PRIVATE", "PAYLOAD"].join("_");
const sessionIds = Object.freeze([
  "sess_resource_alpha_001",
  "sess_resource_beta_001",
  "sess_resource_gamma_001",
  "sess_resource_delta_001",
  "sess_resource_epsilon_001",
  "sess_resource_zeta_001",
  "sess_resource_eta_001",
  "sess_resource_theta_001",
]);
const threadIds = Object.freeze(sessionIds.map((sessionId) => `thread-${sessionId}`));
const harnesses: StressHarness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0).reverse()) await harness.close();
});

describe("IFC-V1-052 selected production resource stress", () => {
  it("shares one exact budget across the full selected graph", async () => {
    const harness = await createStressHarness();
    expect(Object.isFrozen(harness.budget)).toBe(true);
    expect(harness.startedBudget).toBe(harness.budget);
    expect(harness.service.context.budget).toBe(harness.budget);
    expect(harness.service.context.registrations).toHaveLength(22);
    expect(harness.service.context.input.admission).toBe(harness.admission);
    expect(harness.service.context.input.sessions.subscribers).toBe(harness.subscribers);
    expect(harness.budget).toMatchObject({
      cli_connect_timeout_ms: 500,
      cli_max_in_flight_requests: 2,
      cli_request_body_max_bytes: 4_096,
      cli_response_max_bytes: 65_536,
      browser_request_body_max_bytes: 4_096,
      browser_response_max_bytes: 65_536,
      browser_max_in_flight_requests: 4,
      http_body_max_bytes: 4_096,
      http_response_max_bytes: 65_536,
      http_max_connections: 6,
      http_max_in_flight_requests: 4,
      lifecycle_cleanup_step_timeout_ms: 100,
      lifecycle_shutdown_timeout_ms: 1_000,
      mutation_max_in_flight_global: 2,
      mutation_max_in_flight_per_device: 2,
      mutation_max_in_flight_per_target: 1,
      protocol_max_in_flight_requests: 2,
      protocol_mutation_timeout_ms: 1_000,
      protocol_read_timeout_ms: 1_000,
      sse_max_subscribers: 2,
      sse_max_subscribers_per_device: 1,
      sse_max_subscribers_per_session: 1,
      sse_queue_max_events: 8,
    });
    expect(harness.service.snapshot()).toMatchObject({
      configured: {
        host: "127.0.0.1",
        port: harness.port,
        transport: "http",
      },
      listening: true,
      node_limits: {
        headers_max_bytes: 4_096,
        headers_max_count: 16,
        max_connections: 6,
        max_requests_per_socket: 8,
        request_receive_timeout_ms: 1_000,
      },
      phase: "ready",
    });

    const inventory = hostDeckFastifyRouteInventory(harness.service.app);
    expect(inventory).toHaveLength(35);
    expect(inventory.map((entry) => `${entry.method} ${entry.path}`).sort()).toEqual(
      selectedApiRouteManifest.map((entry) => `${entry.method} ${entry.path}`).sort(),
    );
    expect(
      inventory.some((entry) => /\/(?:acceptance|certificates?|lan|network|raw|tmux)(?:\/|$)/iu.test(entry.path)),
    ).toBe(false);

    const response = await rawJsonExchange(harness.port, "GET", "/api/v1/health/live");
    expect(response.status).toBe(200);
    expect(response.json).toEqual({ status: "alive" });
    expect(harness.internalErrors).toEqual([]);
  });

  it("cleans a full-graph listener bind failure before same-port restart", async () => {
    const resourcesBefore = activeResources();
    const rootsBefore = stressTemporaryRoots();
    const port = await reservePort();
    const blocker = createServer();
    await listen(blocker, port);

    let startupFailure: unknown;
    try {
      await createStressHarness({ port });
    } catch (error) {
      startupFailure = error;
    } finally {
      await closeServer(blocker);
    }
    expect(startupFailure).toBeInstanceOf(Error);

    const restarted = await createStressHarness({ port });
    const response = await rawJsonExchange(port, "GET", "/api/v1/health/live");
    expect(response.status).toBe(200);
    await restarted.close();
    await waitFor(() => {
      const resources = activeResources();
      return (
        resources.TCPSocketWrap <= resourcesBefore.TCPSocketWrap &&
        resources.Timeout <= resourcesBefore.Timeout
      );
    });
    expect(stressTemporaryRoots()).toEqual(rootsBefore);
  });

  it("enforces the selected body bound and isolates an aborted partial upload", async () => {
    const harness = await createStressHarness();
    const exactOperation = selectedOperationId("op_resource_exact_body_prompt_001");
    const exactPayload = promptPayloadOfSize(exactOperation, 4_096);
    harness.prompt.arm(exactOperation);
    const exactRequest = startJsonRequest(
      harness.port,
      "POST",
      `/api/v1/sessions/${sessionIds[0]}/prompts`,
      exactPayload,
    );
    await harness.prompt.started(exactOperation);
    harness.prompt.release(exactOperation);
    const exactResponse = await exactRequest.response;
    expect(exactResponse.status).toBe(202);
    expect(harness.audit.require(exactOperation).records).toHaveLength(2);

    const overOperation = selectedOperationId("op_resource_over_body_prompt_001");
    const overResponse = await rawJsonExchange(
      harness.port,
      "POST",
      `/api/v1/sessions/${sessionIds[1]}/prompts`,
      promptPayloadOfSize(overOperation, 4_097),
    );
    expect(overResponse.status).toBe(413);
    expect(overResponse.json).toMatchObject({
      error: { code: "request_too_large" },
    });
    expect(harness.audit.get(overOperation)).toBeNull();
    expect(harness.prompt.dispatches).toBe(1);

    const streamSession = sessionIds[3] as string;
    const sse = openSse(harness.port, streamSession);
    await waitFor(() => harness.subscribers.snapshot().active_subscribers === 1);
    const partial = startPartialPromptUpload(harness.port, sessionIds[2] as string);
    await waitFor(() => hostDeckFastifyResourceSnapshot(harness.service.app).in_flight_requests === 2);

    const usageFramesBefore = harness.transport.frames("account/usage/read").length;
    harness.transport.arm("account/usage/read", { type: "hold" });
    const usage = harness.usageCli().read(sessionIds[0] as string);
    await waitFor(() => harness.transport.frames("account/usage/read").length === usageFramesBefore + 1);
    harness.transport.respond(harness.transport.heldRequestId("account/usage/read"), rawUsage());
    await expect(usage).resolves.toMatchObject({
      target: { session_id: sessionIds[0] },
    });
    harness.publish(activityEvent(streamSession, 1));
    await sse.waitFor("id: 1");

    partial.close();
    await partial.closed;
    await waitFor(() => hostDeckFastifyResourceSnapshot(harness.service.app).in_flight_requests === 1);
    expect(hostDeckFastifyResourceSnapshot(harness.service.app)).toMatchObject({
      aborted_requests: 1,
      in_flight_requests: 1,
    });
    sse.close();
    await sse.closed;
    await waitFor(() => hostDeckFastifyResourceSnapshot(harness.service.app).in_flight_requests === 0);
    expect(hostDeckFastifyResourceSnapshot(harness.service.app)).toMatchObject({
      aborted_requests: 2,
      in_flight_requests: 0,
    });
    expect(harness.auditRows()).toHaveLength(2);
    expect(harness.internalErrors).toHaveLength(1);
    expect(harness.internalErrors[0]).toMatchObject({
      error: { code: "ECONNRESET", statusCode: 400 },
      framework_code: "ECONNRESET",
      request_id: expect.stringMatching(/^req_/u),
    });
    expect(JSON.stringify(harness.internalErrors)).not.toMatch(
      /exact_body|over_body|sess_resource|thread-sess|\/prompts|x{16}/iu,
    );
  });

  it("keeps CLI, HTTP, SSE, admission, and protocol contention within exact owner limits", async () => {
    const harness = await createStressHarness();
    const cycleResults: StressCycleResult[] = [];
    for (let cycle = 0; cycle < 2; cycle += 1) {
      cycleResults.push(await runContentionCycle(harness, cycle));
      expect(hostDeckFastifyResourceSnapshot(harness.service.app).in_flight_requests).toBe(0);
      expect(harness.subscribers.snapshot()).toMatchObject({
        active_device_buckets: 0,
        active_session_buckets: 0,
        active_subscribers: 0,
        queued_events: 0,
        queued_wire_bytes: 0,
        replay_events: 0,
        replay_wire_bytes: 0,
        retained_events: 0,
        retained_wire_bytes: 0,
      });
      expect(harness.admission.snapshot()).toMatchObject({
        active_owners: 0,
        active_targets: 0,
        active_waiters: 0,
      });
      expect(harness.connection.pending_request_count).toBe(0);
    }

    expect(cycleResults).toEqual([
      {
        cliCapacityCode: "service_overloaded",
        httpCapacityStatus: 503,
        mutationCapacityStatus: 503,
        targetCapacityStatus: 503,
        compactFrames: 1,
        usageFrames: 1,
      },
      {
        cliCapacityCode: "service_overloaded",
        httpCapacityStatus: 503,
        mutationCapacityStatus: 503,
        targetCapacityStatus: 503,
        compactFrames: 1,
        usageFrames: 1,
      },
    ]);
    const httpSnapshot = hostDeckFastifyResourceSnapshot(harness.service.app);
    expect(httpSnapshot).toMatchObject({
      in_flight_requests: 0,
      max_in_flight_requests: 4,
      rejected_overload_requests: 2,
    });
    const subscriberSnapshot = harness.subscribers.snapshot();
    expect(subscriberSnapshot).toMatchObject({
      admission_rejections: 2,
      opened_subscribers: 4,
      overflowed_subscribers: 2,
      peak_retained_events: 8,
    });
    const admissionSnapshot = harness.admission.snapshot();
    expect(admissionSnapshot).toMatchObject({
      device_rejections: 2,
      global_rejections: 2,
      peak_active_owners: 2,
      peak_active_targets: 2,
      target_rejections: 2,
      value_settlements: 4,
    });
    expect(
      admissionSnapshot.device_rejections + admissionSnapshot.global_rejections + admissionSnapshot.target_rejections,
    ).toBe(6);
    expectFrozenSafeIntegerSnapshot(httpSnapshot);
    expectFrozenSafeIntegerSnapshot(subscriberSnapshot);
    expectFrozenSafeIntegerSnapshot(admissionSnapshot);
    expect(harness.prompt.dispatches).toBe(2);
    expect(harness.compact.active_count).toBe(0);
    expect(harness.subscriberFailures).toEqual([
      { code: "queue_overflow", cursor: 9 },
      { code: "queue_overflow", cursor: 9 },
    ]);
    expect(harness.hub.failure).toBeNull();
    expect(harness.auditRows()).toHaveLength(8);
    expect(harness.rawAudit()).not.toContain(privatePrompt);
    expect(harness.internalErrors).toEqual([]);
    const diagnostics = JSON.stringify({
      admission: harness.admission.snapshot(),
      subscribers: harness.subscribers.snapshot(),
    });
    expect(diagnostics).not.toContain(privatePrompt);
    expect(diagnostics).not.toMatch(/sess_resource|thread-sess|op_resource/iu);
  }, 10_000);

  it("preserves no-send and possible-send response-loss truth without redispatch", async () => {
    const harness = await createStressHarness();
    const noSendOperation = selectedOperationId("op_resource_no_send_compact_001");
    harness.transport.arm("thread/compact/start", { type: "not_sent" });
    const noSendClient = harness.compactCli();
    await expectCliFailure(
      noSendClient.start({
        session_id: sessionIds[0] as string,
        operation_id: noSendOperation,
        kind: "compact",
        confirm: true,
      }),
      { code: "operation_timeout", status: 504 },
    );
    expect(harness.transport.frames("thread/compact/start")).toHaveLength(0);
    expect(harness.audit.require(noSendOperation)).toMatchObject({
      state: "terminal",
      records: [
        { phase: "accepted", outcome: "accepted" },
        {
          phase: "terminal",
          outcome: "failed",
          error_code: "operation_timeout",
        },
      ],
    });

    const lostOperation = selectedOperationId("op_resource_response_loss_compact_001");
    harness.transport.arm("thread/compact/start", { type: "hold" });
    const outgoing = startJsonRequest(harness.port, "POST", `/api/v1/sessions/${sessionIds[1]}/compact`, {
      operation_id: lostOperation,
      kind: "compact",
      confirm: true,
    });
    await waitFor(() => harness.transport.frames("thread/compact/start").length === 1);
    const replay = harness.compactCli().start({
      session_id: sessionIds[1] as string,
      operation_id: lostOperation,
      kind: "compact",
      confirm: true,
    });
    await waitFor(() => harness.admission.snapshot().in_flight_replays === 1);
    outgoing.request.destroy();
    await outgoing.closed;

    await expectCliFailure(replay, { code: "operation_timeout", status: 504 });
    await waitFor(() => harness.audit.require(lostOperation).state === "terminal");
    const immutableAudit = JSON.stringify(harness.audit.require(lostOperation));
    expect(harness.audit.require(lostOperation).records[1]).toMatchObject({
      phase: "terminal",
      outcome: "incomplete",
      error_code: "operation_timeout",
    });
    expect(harness.transport.frames("thread/compact/start")).toHaveLength(1);

    const lateId = harness.transport.heldRequestId("thread/compact/start");
    harness.transport.respond(lateId, {});
    await waitFor(() => harness.issues.some((issue) => issue.code === "late_response"));
    for (const event of completedCompactEvents(sessionIds[1] as string, threadIds[1] as string, 20)) {
      await harness.compact.observe(event, harness.connection.generation);
    }
    expect(await harness.compact.snapshot(managedTarget(1))).toMatchObject({
      operation_id: lostOperation,
      state: "completed",
      error: null,
    });
    expect(JSON.stringify(harness.audit.require(lostOperation))).toBe(immutableAudit);

    await expectCliFailure(
      harness.compactCli().start({
        session_id: sessionIds[1] as string,
        operation_id: lostOperation,
        kind: "compact",
        confirm: true,
      }),
      { code: "operation_timeout", status: 504 },
    );
    expect(harness.transport.frames("thread/compact/start")).toHaveLength(1);
    expect(harness.connection.pending_request_count).toBe(0);
    expect(harness.admission.snapshot()).toMatchObject({
      active_owners: 0,
      active_targets: 0,
      active_waiters: 0,
      in_flight_replays: 1,
      terminal_replays: 1,
    });
  }, 8_000);

  it("closes active selected work, leaves exact zero owners, and restarts on the same port", async () => {
    const resourcesBefore = activeResources();
    const signalListenersBefore = process.listenerCount("SIGINT") + process.listenerCount("SIGTERM");
    const port = await reservePort();
    const harness = await createStressHarness({ port });
    const idle = await openIdleConnection(harness.port);
    const sse = openSse(harness.port, sessionIds[3] as string);
    await waitFor(() => harness.subscribers.snapshot().active_subscribers === 1);

    const partial = startPartialPromptUpload(harness.port, sessionIds[2] as string);
    await waitFor(() => hostDeckFastifyResourceSnapshot(harness.service.app).in_flight_requests >= 2);

    const operationId = selectedOperationId("op_resource_shutdown_compact_001");
    harness.transport.arm("account/usage/read", { type: "hold" });
    harness.transport.arm("thread/compact/start", { type: "hold" });
    const sharedFetch = createBoundedLoopbackFetch({ budget: harness.budget });
    const usage = createHostDeckUsageClient({
      baseUrl: harness.service.baseUrl,
      fetch: sharedFetch,
    }).read(sessionIds[1] as string);
    const compact = createHostDeckCompactClient({
      baseUrl: harness.service.baseUrl,
      fetch: sharedFetch,
    }).start({
      session_id: sessionIds[0] as string,
      operation_id: operationId,
      kind: "compact",
      confirm: true,
    });
    const usageFailure = captureCliFailure(usage);
    const compactFailure = captureCliFailure(compact);
    await waitFor(() => harness.connection.pending_request_count === 2);
    expect(hostDeckFastifyResourceSnapshot(harness.service.app).in_flight_requests).toBe(4);

    const startedAt = performance.now();
    await harness.service.close();
    const elapsedMs = performance.now() - startedAt;
    expect(await usageFailure).toBeInstanceOf(CliFailure);
    expect(await compactFailure).toBeInstanceOf(CliFailure);
    await Promise.all([sse.closed, partial.closed, idle.closed]);

    expect(elapsedMs).toBeLessThan(1_500);
    expect(harness.service.snapshot()).toMatchObject({
      connections: { active_connections: 0 },
      listening: false,
      phase: "closed",
    });
    expect(hostDeckFastifyResourceSnapshot(harness.service.app)).toMatchObject({
      in_flight_requests: 0,
    });
    expect(harness.subscribers.snapshot()).toMatchObject({
      active_device_buckets: 0,
      active_session_buckets: 0,
      active_subscribers: 0,
      retained_events: 0,
      retained_wire_bytes: 0,
    });
    expect(harness.admission.snapshot()).toMatchObject({
      phase: "closed",
      active_owners: 0,
      active_targets: 0,
      active_waiters: 0,
      active_drain_waiters: 0,
    });
    expect(harness.connection.pending_request_count).toBe(0);
    expect(harness.finalAuditStates).toContain("incomplete");
    expect(harness.events).toEqual(["begin-drain", "close-sse", "close-runtime", "close-startup"]);

    const restarted = await createStressHarness({ port });
    const response = await rawJsonExchange(port, "GET", "/api/v1/health/live");
    expect(response.status).toBe(200);
    await restarted.service.close();
    await waitFor(() => activeResources().TCPSocketWrap <= resourcesBefore.TCPSocketWrap);
    const resourcesAfter = activeResources();
    expect(resourcesAfter.TCPSocketWrap).toBeLessThanOrEqual(resourcesBefore.TCPSocketWrap);
    expect(resourcesAfter.Timeout).toBeLessThanOrEqual(resourcesBefore.Timeout);
    expect(process.listenerCount("SIGINT") + process.listenerCount("SIGTERM")).toBe(signalListenersBefore);
  }, 8_000);
});

interface StressCycleResult {
  readonly cliCapacityCode: string;
  readonly compactFrames: number;
  readonly httpCapacityStatus: number;
  readonly mutationCapacityStatus: number;
  readonly targetCapacityStatus: number;
  readonly usageFrames: number;
}

async function runContentionCycle(harness: StressHarness, cycle: number): Promise<StressCycleResult> {
  const compactSessionIndex = cycle;
  const promptSessionIndex = cycle + 2;
  const rejectedSessionIndex = cycle + 4;
  const streamSessionIndex = cycle + 3;
  const stalledSessionIndex = cycle + 5;
  const compactOperation = selectedOperationId(`op_resource_compact_cycle_${cycle + 1}_001`);
  const promptOperation = selectedOperationId(`op_resource_prompt_cycle_${cycle + 1}_001`);
  const rejectedOperation = selectedOperationId(`op_resource_rejected_cycle_${cycle + 1}_001`);

  const sse = openSse(harness.port, sessionIds[streamSessionIndex] as string);
  await waitFor(() => harness.subscribers.snapshot().active_subscribers === 1);
  const stalledController = new AbortController();
  const stalled = harness.subscribers.open({
    after: null,
    authorization: Object.freeze({ state: "loopback_local" }),
    device_id: `client_resource_${cycle}`,
    session_id: sessionIds[stalledSessionIndex],
    signal: stalledController.signal,
    subscriber_id: `resource:stalled:${cycle}`,
  });
  expect(harness.subscribers.snapshot().active_subscribers).toBe(2);
  expect(() =>
    harness.subscribers.open({
      after: null,
      authorization: Object.freeze({ state: "loopback_local" }),
      device_id: `client_resource_extra_${cycle}`,
      session_id: sessionIds[7],
      signal: new AbortController().signal,
      subscriber_id: `resource:rejected:${cycle}`,
    }),
  ).toThrowError(expect.objectContaining({ code: "subscriber_global_limit" }));

  harness.prompt.arm(promptOperation);
  const prompt = startJsonRequest(harness.port, "POST", `/api/v1/sessions/${sessionIds[promptSessionIndex]}/prompts`, {
    operation_id: promptOperation,
    kind: "prompt",
    text: privatePrompt,
  });
  await harness.prompt.started(promptOperation);

  const targetProbeOperation = selectedOperationId(`op_resource_target_probe_cycle_${cycle + 1}_001`);
  const dispatchesBeforeTargetProbe = harness.prompt.dispatches;
  const targetCapacity = await rawJsonExchange(
    harness.port,
    "POST",
    `/api/v1/sessions/${sessionIds[promptSessionIndex]}/prompts`,
    {
      operation_id: targetProbeOperation,
      kind: "prompt",
      text: "bounded same-target contender",
    },
  );
  expect(targetCapacity.status).toBe(503);
  expect(targetCapacity.json).toMatchObject({
    error: { code: "service_overloaded" },
  });
  expect(harness.prompt.dispatches).toBe(dispatchesBeforeTargetProbe);
  expect(harness.audit.get(targetProbeOperation)).toBeNull();

  const compactFramesBefore = harness.transport.frames("thread/compact/start").length;
  const usageFramesBefore = harness.transport.frames("account/usage/read").length;
  harness.transport.arm("account/usage/read", { type: "hold" });
  harness.transport.arm("thread/compact/start", { type: "hold" });
  const sharedFetch = createBoundedLoopbackFetch({ budget: harness.budget });
  const usageClient = createHostDeckUsageClient({
    baseUrl: harness.service.baseUrl,
    fetch: sharedFetch,
  });
  const compactClient = createHostDeckCompactClient({
    baseUrl: harness.service.baseUrl,
    fetch: sharedFetch,
  });
  const usage = usageClient.read(sessionIds[compactSessionIndex] as string);
  const compact = compactClient.start({
    session_id: sessionIds[compactSessionIndex] as string,
    operation_id: compactOperation,
    kind: "compact",
    confirm: true,
  });
  await waitFor(
    () =>
      harness.transport.frames("account/usage/read").length === usageFramesBefore + 1 &&
      harness.transport.frames("thread/compact/start").length === compactFramesBefore + 1,
  );
  expect(hostDeckFastifyResourceSnapshot(harness.service.app).in_flight_requests).toBe(4);
  expect(harness.connection.pending_request_count).toBe(2);
  expect(harness.admission.snapshot()).toMatchObject({
    active_owners: 2,
    active_targets: 2,
  });

  expect(() =>
    harness.admission.begin({
      actor: stressDashboardActor(cycle + 10),
      intent: Object.freeze({ action: "global-capacity-probe" }),
      operation_id: selectedOperationId(`op_resource_global_probe_cycle_${cycle + 1}_001`),
      route_id: "prompt_dispatch",
      signal: new AbortController().signal,
    }),
  ).toThrowError(expect.objectContaining({ reason: "global_limit" }));

  const cliCapacity = await captureCliFailure(usageClient.read(sessionIds[1] as string));
  expect(cliCapacity).toMatchObject({
    code: "service_overloaded",
    kind: "api_error",
    status: undefined,
  });
  const httpCapacity = await rawJsonExchange(harness.port, "GET", "/api/v1/health/live");
  expect(httpCapacity.status).toBe(503);
  expect(httpCapacity.json).toMatchObject({
    error: { code: "service_overloaded" },
  });

  const usageId = harness.transport.heldRequestId("account/usage/read");
  harness.transport.respond(usageId, rawUsage());
  await expect(usage).resolves.toMatchObject({
    target: { session_id: sessionIds[compactSessionIndex] },
  });
  await waitFor(() => hostDeckFastifyResourceSnapshot(harness.service.app).in_flight_requests === 3);

  const mutationCapacity = await rawJsonExchange(
    harness.port,
    "POST",
    `/api/v1/sessions/${sessionIds[rejectedSessionIndex]}/prompts`,
    {
      operation_id: rejectedOperation,
      kind: "prompt",
      text: "bounded rejected prompt",
    },
  );
  expect(mutationCapacity.status).toBe(503);
  expect(mutationCapacity.json).toMatchObject({
    error: { code: "service_overloaded" },
  });
  expect(harness.audit.get(rejectedOperation)).toBeNull();

  for (let cursor = 1; cursor <= 9; cursor += 1) {
    harness.publish(activityEvent(sessionIds[stalledSessionIndex] as string, cursor));
  }
  expect(stalled.state).toBe("failed");
  expect(stalled.failure).toMatchObject({ code: "queue_overflow" });
  for (let cursor = 1; cursor <= 3; cursor += 1) {
    harness.publish(activityEvent(sessionIds[streamSessionIndex] as string, cursor));
  }
  await sse.waitFor(`id: ${3}`);

  harness.prompt.release(promptOperation);
  const compactId = harness.transport.heldRequestId("thread/compact/start");
  harness.transport.respond(compactId, {});
  const [promptResponse, compactResponse] = await Promise.all([prompt.response, compact]);
  expect(promptResponse.status).toBe(202);
  expect(compactResponse).toMatchObject({
    progress: {
      operation_id: compactOperation,
      state: "accepted",
    },
  });
  for (const event of completedCompactEvents(
    sessionIds[compactSessionIndex] as string,
    threadIds[compactSessionIndex] as string,
    cycle * 10,
  )) {
    await harness.compact.observe(event, harness.connection.generation);
  }
  expect(harness.audit.require(promptOperation).records).toHaveLength(2);
  expect(harness.audit.require(compactOperation).records).toHaveLength(2);

  stalledController.abort();
  sse.close();
  await sse.closed;
  await waitFor(() => harness.subscribers.snapshot().active_subscribers === 0);
  return {
    cliCapacityCode: cliCapacity.code,
    compactFrames: harness.transport.frames("thread/compact/start").length - compactFramesBefore,
    httpCapacityStatus: httpCapacity.status,
    mutationCapacityStatus: mutationCapacity.status,
    targetCapacityStatus: targetCapacity.status,
    usageFrames: harness.transport.frames("account/usage/read").length - usageFramesBefore,
  };
}

interface StressContext {
  readonly budget: ResourceBudget;
  readonly input: CreateHostDeckSelectedApiRouteCompositionInput;
  readonly registrations: ReturnType<typeof createHostDeckSelectedApiRouteComposition>;
}

interface StressHarness {
  readonly admission: HostDeckSelectedWriteAdmissionPolicy;
  readonly audit: SelectedAuditRepository;
  readonly auditRows: () => readonly string[];
  readonly budget: ResourceBudget;
  readonly close: () => Promise<void>;
  readonly compact: CodexCompactControlService;
  readonly compactCli: () => ReturnType<typeof createHostDeckCompactClient>;
  readonly connection: CodexAppServerConnection;
  readonly events: string[];
  readonly finalAuditStates: string[];
  readonly hub: ProjectionFanoutHub;
  readonly internalErrors: unknown[];
  readonly issues: CodexProtocolIssue[];
  readonly port: number;
  readonly prompt: StressPromptController;
  readonly publish: (event: SelectedProjectionEvent) => void;
  readonly rawAudit: () => string;
  readonly service: HostDeckFastifyLifecycle<StressContext>;
  readonly startedBudget: ResourceBudget;
  readonly subscriberFailures: readonly Readonly<{
    code: string;
    cursor: number | null;
  }>[];
  readonly subscribers: ProjectionSubscriberStreamService;
  readonly transport: ControlledCodexTransport;
  readonly usageCli: () => ReturnType<typeof createHostDeckUsageClient>;
}

async function createStressHarness(options: { readonly port?: number } = {}): Promise<StressHarness> {
  const budget = stressBudget();
  const port = options.port ?? (await reservePort());
  const root = mkdtempSync(join(tmpdir(), "hostdeck-resource-stress-"));
  let rootRemoved = false;
  const failureCleanups: Array<() => Promise<void> | void> = [
    () => {
      if (rootRemoved) return;
      rootRemoved = true;
      rmSync(root, { force: true, recursive: true });
    },
  ];
  try {
    const opened = openMigratedDatabase(join(root, "hostdeck.sqlite"), {
      now: () => new Date(timestamp),
    });
    failureCleanups.push(() => {
      if (opened.db.open) opened.db.close();
    });
    const audit = createSelectedAuditRepository(opened.db);
    const state = new StressProjectionState();
    for (let index = 0; index < sessionIds.length; index += 1) {
      state.add(selectedState(index));
    }
    const hub = createProjectionFanoutHub({
      max_subscribers: budget.sse_max_subscribers,
      max_subscribers_per_session: budget.sse_max_subscribers_per_session,
    });
    failureCleanups.push(() => {
      hub.close();
    });
    const handoff = createProjectionReplayLiveHandoffService({
      authorize: () => ({ ok: true }),
      fanout: hub,
      resource_budget: budget,
      state,
    });
    const subscriberFailures: Array<
      Readonly<{ code: string; cursor: number | null }>
    > = [];
    const subscribers = createProjectionSubscriberStreamService({
      handoff,
      observe_failure: (failure) => subscriberFailures.push(failure),
      resource_budget: budget,
    });
    failureCleanups.push(() => {
      subscribers.close();
    });
    const admission = createHostDeckSelectedWriteAdmissionPolicy({
      resourceBudget: budget,
      now: () => performance.now(),
    });

    let auditRecordId = 0;
    let wallTime = Date.parse(timestamp);
    const nextDate = () => new Date(wallTime++);
    const nextTimestamp = () => nextDate().toISOString();
    const selectedAudit = createHostDeckSelectedWriteAuditExecutor({
      repository: audit,
      now: nextTimestamp,
      create_record_id: () => `audit_resource_selected_${++auditRecordId}`,
    });
    const securityAudit = createSecurityMutationAuditExecutor({
      repository: audit,
      now: nextTimestamp,
      create_record_id: () => `audit_resource_security_${++auditRecordId}`,
    });
    const transport = new ControlledCodexTransport(budget.protocol_max_frame_bytes);
    const issues: CodexProtocolIssue[] = [];
    const codexOptions = codexResourceOptionsFromBudget(budget);
    const connection = createCodexAppServerConnection({
      transport,
      observed_version: runtimeVersion,
      ...codexOptions.connection,
      now: () => timestamp,
      on_protocol_issue: (issue) => issues.push(issue),
    });
    failureCleanups.push(() => connection.close("Resource stress construction failure cleanup."));
    await connection.connect();
    const connectionPort = observedConnectionPort(connection);
    const compactAdapter = createCodexCompactClient(connectionPort, {
      ...codexOptions.compact,
      now: nextTimestamp,
    });
    const compact = createCodexCompactControlService({
      compact: compactAdapter,
      states: state,
      max_tracked_operations: budget.control_compact_max_tracked_operations,
      now: nextTimestamp,
    });
    const usageAdapter = createCodexUsageClient(connectionPort, {
      ...codexOptions.usage,
      now: nextTimestamp,
    });
    const usage = createCodexUsageControlService({
      usage: usageAdapter,
      states: state,
      max_tracked_threads: budget.control_usage_max_tracked_threads,
    });
    const prompt = new StressPromptController();
    const authentication = createHostDeckRequestAuthenticationPolicy({
      authenticateDeviceToken() {
        throw new Error("Resource stress loopback path must not authenticate a device token.");
      },
      now: nextDate,
    });
    const csrf = createHostDeckCsrfPolicy({
      csrf: {
        authorizeBrowserWrite() {
          throw new Error("Resource stress loopback path must not authorize browser CSRF.");
        },
        rotateBootstrap() {
          throw new Error("Resource stress loopback path must not rotate browser CSRF.");
        },
      },
      now: nextDate,
    });
    const lock = createHostDeckHostLockPolicy({
      settings: {
        read: () => Object.freeze({ locked: false, settings_updated_at: timestamp }),
        transition: failUnused,
      },
      now: nextDate,
    });
    const pairing = createHostDeckPairingPolicy({
      createPairingId: () => "pair_resource_stress_000001",
      now: nextDate,
      pairing: { claim: failUnused, issue: failUnused },
    });
    const remote = createRemoteIngressControlService({
      admissionProofs: createRemoteIngressAdmissionProofRepository(opened.db),
      audit: securityAudit,
      localOrigin: `http://127.0.0.1:${port}`,
      manager: Object.freeze({
        disable: failUnused,
        enable: failUnused,
        snapshot: failUnused,
      }),
      monotonicNow: () => performance.now(),
      now: nextDate,
      observer: Object.freeze({
        observeCandidate: failUnused,
        observeConfigured: failUnused,
        poll_interval_ms: budget.remote_observer_poll_interval_ms,
      }),
      states: createRemoteIngressStateRepository(opened.db),
    });
    const health = createHostDeckHostHealthService({ now: nextDate });
    const runtime = Object.freeze({ read: () => connection.compatibility });
    const input = {
      admission,
      audit: selectedAudit,
      authentication,
      controls: {
        approvals: {
          list: failUnused,
          respond: failUnused,
          snapshot: failUnused,
          waitForTerminal: failUnused,
        },
        compact: {
          compact: compact.compact,
          snapshot: compact.snapshot,
        },
        goals: { mutate: failUnused, snapshot: failUnused },
        interrupts: {
          interrupt: failUnused,
          requireInterruptible: failUnused,
          waitForTerminal: failUnused,
        },
        models: { select: failUnused, snapshot: failUnused },
        plans: { select: failUnused, snapshot: failUnused },
        prompts: {
          dispatch: prompt.dispatch,
          snapshot: prompt.snapshot,
        },
        skills: { list: failUnused },
        usage: { read: usage.read },
      },
      csrf,
      devices: { list: failUnused, revoke: failUnused },
      health,
      lock,
      now: nextDate,
      observeSseError: () => undefined,
      pairing,
      remote,
      runtimes: {
        approvals: runtime,
        compact: runtime,
        goals: runtime,
        interrupts: runtime,
        models: runtime,
        plans: runtime,
        prompts: runtime,
        sessionArchive: runtime,
        sessionStart: runtime,
      },
      securityAudit,
      sessions: {
        managed: {
          archive: failUnused,
          read: state.require,
          start: failUnused,
        },
        read: { get: failUnused, list: failUnused },
        resume: { read: failUnused },
        subscribers,
      },
      state: {
        get: state.get,
        listEvents: state.listEvents,
        require: state.require,
      },
    } satisfies CreateHostDeckSelectedApiRouteCompositionInput;
    const registrations = createHostDeckSelectedApiRouteComposition(input);
    const context: StressContext = Object.freeze({
      budget,
      input,
      registrations,
    });
    const internalErrors: unknown[] = [];
    const events: string[] = [];
    const finalAuditStates: string[] = [];
    let startedBudget: ResourceBudget | null = null;
    const captureAuditStates = (): void => {
      if (!opened.db.open) return;
      finalAuditStates.length = 0;
      const rows = opened.db.prepare("SELECT record_json FROM selected_audit_events ORDER BY rowid").all() as readonly {
        readonly record_json: string;
      }[];
      for (const row of rows) {
        const parsed = JSON.parse(row.record_json) as {
          readonly outcome?: unknown;
        };
        if (typeof parsed.outcome === "string") finalAuditStates.push(parsed.outcome);
      }
    };

    const service = await startHostDeckFastifyLifecycle({
      createRequestAuthenticationPolicy: () => authentication,
      createRoutePlugins: () => registrations,
      observeInternalError: (error) => internalErrors.push(error),
      resourceBudget: budget,
      runtime: {
        beginDrain() {
          events.push("begin-drain");
          admission.beginDrain();
        },
        async closeRuntime(deadline) {
          events.push("close-runtime");
          await connection.close("Resource stress lifecycle shutdown.");
          await admission.drain(deadline.signal);
          captureAuditStates();
        },
        closeSse() {
          events.push("close-sse");
          subscribers.close();
          hub.close();
        },
        closeStartup() {
          events.push("close-startup");
          captureAuditStates();
          if (opened.db.open) opened.db.close();
          if (!rootRemoved) {
            rootRemoved = true;
            rmSync(root, { force: true, recursive: true });
          }
        },
        start({ resourceBudget }) {
          if (resourceBudget !== budget) {
            throw new TypeError("Resource stress lifecycle received a different budget.");
          }
          startedBudget = resourceBudget;
          return Object.freeze({
            bind: Object.freeze({ host: "127.0.0.1", port, transport: "http" }),
            context,
          });
        },
      },
    });
    if (startedBudget === null) throw new Error("Resource stress budget was not observed at startup.");

    let closed = false;
    const auditRows = (): readonly string[] => {
      if (!opened.db.open) return Object.freeze([]);
      return Object.freeze(
        (
          opened.db.prepare("SELECT record_json FROM selected_audit_events ORDER BY rowid").all() as readonly {
            readonly record_json: string;
          }[]
        ).map((row) => row.record_json),
      );
    };
    const harness: StressHarness = {
      admission,
      audit,
      auditRows,
      budget,
      async close() {
        if (closed) return;
        closed = true;
        let failure: unknown;
        try {
          if (!["closed", "failed"].includes(service.snapshot().phase)) {
            await service.close();
          }
        } catch (error) {
          failure = error;
        }
        subscribers.close();
        hub.close();
        await connection.close("Resource stress fallback cleanup.");
        if (opened.db.open) opened.db.close();
        if (!rootRemoved) rmSync(root, { force: true, recursive: true });
        if (failure !== undefined) throw failure;
      },
      compact,
      compactCli: () =>
        createHostDeckCompactClient({
          baseUrl: service.baseUrl,
          fetch: createBoundedLoopbackFetch({ budget }),
        }),
      connection,
      events,
      finalAuditStates,
      hub,
      internalErrors,
      issues,
      port,
      prompt,
      publish(event) {
        state.append(event);
        hub.publish(committedCandidate(event, state.require(event.session_id)));
      },
      rawAudit: () => auditRows().join("\n"),
      service,
      startedBudget,
      subscriberFailures,
      subscribers,
      transport,
      usageCli: () =>
        createHostDeckUsageClient({
          baseUrl: service.baseUrl,
          fetch: createBoundedLoopbackFetch({ budget }),
        }),
    };
    harnesses.push(harness);
    return harness;
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    for (const cleanup of failureCleanups.reverse()) {
      try {
        await cleanup();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError([error, ...cleanupErrors], "Resource stress construction and cleanup failed.");
    }
    throw error;
  }
}

function stressBudget(): ResourceBudget {
  return resolveResourceBudget({
    admission_state_ttl_ms: 60_000,
    cli_connect_timeout_ms: 500,
    cli_max_in_flight_requests: 2,
    cli_request_body_max_bytes: 4_096,
    cli_request_timeout_ms: 3_000,
    cli_response_max_bytes: 65_536,
    cli_stream_idle_timeout_ms: 5_000,
    browser_request_body_max_bytes: 4_096,
    browser_response_max_bytes: 65_536,
    browser_max_in_flight_requests: 4,
    http_body_max_bytes: 4_096,
    http_response_max_bytes: 65_536,
    http_connection_idle_timeout_ms: 5_000,
    http_headers_max_bytes: 4_096,
    http_headers_max_count: 16,
    http_headers_timeout_ms: 1_000,
    http_keep_alive_timeout_ms: 1_000,
    http_max_connections: 6,
    http_max_in_flight_requests: 4,
    http_max_requests_per_socket: 8,
    http_request_deadline_ms: 2_500,
    http_request_receive_timeout_ms: 1_000,
    http_route_param_max_bytes: 64,
    http_url_max_bytes: 256,
    lifecycle_cleanup_step_timeout_ms: 100,
    lifecycle_shutdown_timeout_ms: 1_000,
    mutation_max_in_flight_global: 2,
    mutation_max_in_flight_per_device: 2,
    mutation_max_in_flight_per_target: 1,
    mutation_max_requests_per_device: 100,
    mutation_window_ms: 1_000,
    pair_claim_window_ms: 1_000,
    pairing_code_lifetime_ms: 60_000,
    protocol_close_timeout_ms: 100,
    protocol_connect_timeout_ms: 500,
    protocol_handshake_timeout_ms: 1_000,
    protocol_heartbeat_interval_ms: 1_000,
    protocol_heartbeat_timeout_ms: 100,
    protocol_max_buffered_bytes: 8_192,
    protocol_max_frame_bytes: 8_192,
    protocol_max_in_flight_requests: 2,
    protocol_mutation_timeout_ms: 1_000,
    protocol_read_timeout_ms: 1_000,
    protocol_start_timeout_ms: 1_000,
    sse_disconnect_cleanup_timeout_ms: 100,
    sse_event_max_bytes: 1_024,
    sse_heartbeat_interval_ms: 1_000,
    sse_max_subscribers: 2,
    sse_max_subscribers_per_device: 1,
    sse_max_subscribers_per_session: 1,
    sse_queue_max_bytes: 65_536,
    sse_queue_max_events: 8,
    sse_replay_max_bytes: 65_536,
    sse_replay_max_events: 8,
    sse_shutdown_timeout_ms: 200,
  });
}

interface PromptBarrier {
  readonly released: Deferred<void>;
  readonly started: Deferred<void>;
}

class StressPromptController {
  private readonly barriers = new Map<string, PromptBarrier>();
  private dispatchCount = 0;

  get dispatches(): number {
    return this.dispatchCount;
  }

  arm(operationId: string): void {
    if (this.barriers.has(operationId)) {
      throw new Error(`Prompt operation ${operationId} is already armed.`);
    }
    this.barriers.set(operationId, {
      released: deferred<void>(),
      started: deferred<void>(),
    });
  }

  started(operationId: string): Promise<void> {
    return this.requireBarrier(operationId).started.promise;
  }

  release(operationId: string): void {
    this.requireBarrier(operationId).released.resolve(undefined);
  }

  readonly dispatch: CodexPromptControlService["dispatch"] = async (intent, deadline) => {
    const values = requireRecord(intent, "Prompt stress intent");
    const operationId = clientOperationIdSchema.parse(values.operation_id);
    const target = requireRecord(values.target, "Prompt stress target");
    if (typeof target.codex_thread_id !== "string") {
      throw new TypeError("Prompt stress target has no Codex thread id.");
    }
    const barrier = this.requireBarrier(operationId);
    this.dispatchCount += 1;
    barrier.started.resolve(undefined);

    const aborted = deferred<void>();
    const abort = () => aborted.resolve(undefined);
    deadline.signal.addEventListener("abort", abort, { once: true });
    try {
      await Promise.race([barrier.released.promise, aborted.promise]);
      if (deadline.signal.aborted) {
        throw new Error("Prompt stress dispatch was aborted before release.");
      }
    } finally {
      deadline.signal.removeEventListener("abort", abort);
      this.barriers.delete(operationId);
    }

    return Object.freeze({
      action: "start" as const,
      model_revision: null,
      plan_revision: null,
      state: "accepted" as const,
      steerable: false,
      thread_id: codexThreadIdSchema.parse(target.codex_thread_id),
      turn_id: codexTurnIdSchema.parse(`turn-resource-stress-${this.dispatchCount}`),
    });
  };

  readonly snapshot: CodexPromptControlService["snapshot"] = async () =>
    Object.freeze({
      accepted_at: null,
      error: null,
      last_action: null,
      model_revision: null,
      operation_id: null,
      phase: "idle" as const,
      plan_revision: null,
      requested_at: null,
      started_at: null,
      turn_id: null,
    });

  private requireBarrier(operationId: string): PromptBarrier {
    const barrier = this.barriers.get(operationId);
    if (barrier === undefined) {
      throw new Error(`Prompt operation ${operationId} was not armed.`);
    }
    return barrier;
  }
}

type ControlledTransportAction = Readonly<{ type: "hold" }> | Readonly<{ type: "not_sent" }>;

interface ControlledOutboundFrame {
  readonly id?: number;
  readonly method: string;
}

class ControlledCodexTransport extends ScriptedCodexTransport {
  private readonly actions = new Map<string, ControlledTransportAction>();
  private readonly held = new Map<string, number>();

  constructor(maxFrameBytes: number) {
    super({
      max_frame_bytes: maxFrameBytes,
      on_send: respondToControlledHandshake,
    });
  }

  arm(method: string, action: ControlledTransportAction): void {
    if (this.actions.has(method) || this.held.has(method)) {
      throw new Error(`Codex method ${method} already has controlled work.`);
    }
    this.actions.set(method, action);
  }

  frames(method: string): readonly ControlledOutboundFrame[] {
    return this.sent_frames.map(parseOutboundFrame).filter((frame) => frame.method === method);
  }

  heldRequestId(method: string): number {
    const requestId = this.held.get(method);
    if (requestId === undefined) {
      throw new Error(`Codex method ${method} has no held request.`);
    }
    return requestId;
  }

  respond(requestId: number, result: unknown): void {
    const entry = [...this.held.entries()].find(([, id]) => id === requestId);
    if (entry === undefined) {
      throw new Error(`Codex request ${requestId} is not held.`);
    }
    this.held.delete(entry[0]);
    this.receive(JSON.stringify({ id: requestId, result }));
  }

  override async sendText(text: string): Promise<void> {
    const frame = parseOutboundFrame(text);
    if (!controlledCodexMethods.has(frame.method)) {
      await super.sendText(text);
      return;
    }
    const action = this.actions.get(frame.method);
    if (action === undefined) {
      throw new HostDeckCodexAdapterError(
        "transport_send_failed",
        `Controlled Codex method ${frame.method} was not armed.`,
        { outcome: "not_sent", retry_safe: false },
      );
    }
    this.actions.delete(frame.method);
    if (action.type === "not_sent") {
      throw new HostDeckCodexAdapterError(
        "request_timeout",
        "Controlled transport timed out before submitting the protocol frame.",
        { outcome: "not_sent", retry_safe: true },
      );
    }
    if (frame.id === undefined) {
      throw new TypeError(`Controlled Codex method ${frame.method} has no request id.`);
    }
    await super.sendText(text);
    this.held.set(frame.method, frame.id);
  }
}

const controlledCodexMethods = new Set(["account/usage/read", "thread/compact/start"]);

function respondToControlledHandshake(text: string, transport: ScriptedCodexTransport): void {
  const frame = parseOutboundFrame(text);
  if (frame.method === "initialize") {
    transport.receive(
      JSON.stringify({
        id: frame.id,
        result: {
          codexHome: "/tmp/hostdeck-resource-stress-codex-home",
          platformFamily: "unix",
          platformOs: "linux",
          userAgent: `hostdeck/${runtimeVersion} (Ubuntu 24.04; x86_64)`,
        },
      }),
    );
  } else if (frame.method === "collaborationMode/list") {
    transport.receive(
      JSON.stringify({
        id: frame.id,
        result: { data: [{ name: "Plan" }, { name: "Default" }] },
      }),
    );
  }
}

function parseOutboundFrame(text: string): ControlledOutboundFrame {
  const values = requireRecord(JSON.parse(text), "Controlled Codex frame");
  if (typeof values.method !== "string") {
    throw new TypeError("Controlled Codex frame has no method.");
  }
  if (values.id !== undefined && typeof values.id !== "number") {
    throw new TypeError("Controlled Codex frame has a non-numeric request id.");
  }
  return Object.freeze({
    ...(values.id === undefined ? {} : { id: values.id }),
    method: values.method,
  });
}

function observedConnectionPort(connection: CodexAppServerConnection) {
  return {
    get compatibility() {
      return connection.compatibility;
    },
    get generation() {
      return connection.generation;
    },
    request(input: CodexRequestInput) {
      return connection.request(input);
    },
  };
}

class StressProjectionState {
  private readonly events = new Map<string, SelectedProjectionEvent[]>();
  private readonly states = new Map<string, SelectedSessionState>();

  add(state: SelectedSessionState): void {
    const sessionId = state.mapping.id;
    if (this.states.has(sessionId)) {
      throw new Error(`Selected stress session ${sessionId} already exists.`);
    }
    this.states.set(sessionId, state);
    this.events.set(sessionId, []);
  }

  append(event: SelectedProjectionEvent): void {
    const state = this.require(event.session_id);
    const events = this.requireEvents(event.session_id);
    const expectedCursor = (events.at(-1)?.cursor ?? 0) + 1;
    if (event.cursor !== expectedCursor) {
      throw new Error(`Selected stress cursor ${event.cursor} does not follow ${expectedCursor - 1}.`);
    }
    events.push(event);
    const retainedBytes = events.reduce((total, candidate) => total + selectedProjectedEventByteLength(candidate), 0);
    const projection = selectedSessionProjectionRecordSchema.parse({
      ...state.projection,
      earliest_retained_cursor: events[0]?.cursor ?? null,
      retained_event_bytes: retainedBytes,
      retained_event_count: events.length,
      session: {
        ...state.projection.session,
        last_activity_at: event.captured_at,
        last_event_cursor: event.cursor,
        updated_at: event.captured_at,
      },
    });
    this.states.set(event.session_id, deepFreeze({ mapping: state.mapping, projection }));
  }

  readonly get = (sessionId: string): SelectedSessionState | null => this.states.get(sessionId) ?? null;

  readonly getByThreadId = (threadId: string): SelectedSessionState | null =>
    [...this.states.values()].find((state) => state.mapping.codex_thread_id === threadId) ?? null;

  readonly require = (sessionId: string): SelectedSessionState => {
    const state = this.states.get(sessionId);
    if (state === undefined) {
      throw new HostDeckSelectedStateRepositoryError(
        "session_not_found",
        "Selected resource-stress session was not found.",
      );
    }
    return state;
  };

  readonly listEvents = (
    sessionId: string,
    input: { readonly after?: number | null; readonly limit?: number } = {},
  ): SelectedSessionEventStream => {
    const state = this.require(sessionId);
    const events = this.requireEvents(sessionId);
    const after = input.after ?? null;
    const highWater = state.projection.session.last_event_cursor ?? 0;
    if (after !== null && after > highWater) {
      throw new HostDeckSelectedStateRepositoryError(
        "invalid_replay",
        "Selected resource-stress replay cursor is ahead of committed state.",
      );
    }
    const page = events.filter((event) => after === null || event.cursor > after).slice(0, input.limit ?? 500);
    return selectedSessionEventStreamSchema.parse({
      events: page,
      next_cursor: page.at(-1)?.cursor ?? highWater,
      session_id: sessionId,
      truncated: false,
    });
  };

  private requireEvents(sessionId: string): SelectedProjectionEvent[] {
    const events = this.events.get(sessionId);
    if (events === undefined) {
      throw new HostDeckSelectedStateRepositoryError(
        "session_not_found",
        "Selected resource-stress event stream was not found.",
      );
    }
    return events;
  }
}

function selectedState(index: number): SelectedSessionState {
  const sessionId = requireIndexed(sessionIds, index, "session id");
  const threadId = requireIndexed(threadIds, index, "thread id");
  const mapping = selectedSessionMappingRecordSchema.parse({
    archived_at: null,
    codex_thread_id: threadId,
    created_at: timestamp,
    cwd: `/tmp/hostdeck-resource-stress/${sessionId}`,
    disposition: "selected",
    id: sessionId,
    name: `resource-stress-${index + 1}`,
    runtime_source: "codex_app_server",
    runtime_version: runtimeVersion,
    updated_at: timestamp,
  });
  const projection = selectedSessionProjectionRecordSchema.parse({
    earliest_retained_cursor: null,
    retained_event_bytes: 0,
    retained_event_count: 0,
    retention_boundary_cursor: null,
    session: {
      archived_at: null,
      attention: "none",
      branch: "main",
      codex_thread_id: threadId,
      created_at: timestamp,
      cwd: mapping.cwd,
      freshness: "current",
      freshness_reason: null,
      goal: null,
      id: sessionId,
      last_activity_at: null,
      last_event_cursor: null,
      model: "gpt-5.5-codex",
      name: mapping.name,
      recent_summary: "Selected resource stress projection.",
      runtime_source: "codex_app_server",
      runtime_version: runtimeVersion,
      session_state: "active",
      turn_state: "idle",
      updated_at: timestamp,
    },
  });
  return deepFreeze({ mapping, projection });
}

function managedTarget(index: number) {
  return Object.freeze({
    codex_thread_id: requireIndexed(threadIds, index, "thread id"),
    session_id: requireIndexed(sessionIds, index, "session id"),
    type: "managed_session" as const,
  });
}

function stressDashboardActor(index: number) {
  return selectedAuditActorSchema.parse({
    device_id: `dev_resource_stress_${index}`,
    origin: "https://resource-stress.example.test",
    permission: "write",
    type: "dashboard",
  });
}

function activityEvent(sessionId: string, cursor: number): SelectedProjectionEvent {
  return selectedProjectionEventSchema.parse({
    activity: "thread",
    captured_at: eventAt(cursor),
    codex_event_id: `event-${sessionId}-${cursor}`,
    codex_event_type: "thread/status/changed",
    content_notice: null,
    content_state: "complete",
    cursor,
    detail: null,
    item_id: null,
    session_id: sessionId,
    state: "updated",
    title: "Thread state updated",
    type: "activity",
    upstream_at: null,
  });
}

function completedCompactEvents(
  sessionId: string,
  threadId: string,
  sequenceOffset: number,
): readonly NormalizedCodexEvent[] {
  const turnId = codexTurnIdSchema.parse(`turn-${sessionId}-compact-${sequenceOffset + 1}`);
  const itemId = `item-${sessionId}-compact-${sequenceOffset + 1}`;
  const at = (sequence: number) => eventAt(sequenceOffset + sequence + 20);
  return Object.freeze([
    {
      captured_at: at(1),
      codex_event_id: `${turnId}:started`,
      method: "turn/started",
      scope: "thread",
      sequence: sequenceOffset + 1,
      status: "in_progress",
      thread_id: threadId,
      turn_id: turnId,
      upstream_at: null,
    } as NormalizedCodexEvent,
    {
      captured_at: at(2),
      codex_event_id: `${itemId}:started`,
      item: {
        category: "compaction",
        content_notice: null,
        content_state: "complete",
        id: itemId,
        state: "started",
        text: null,
        title: "Context compaction",
      },
      method: "item/started",
      scope: "thread",
      sequence: sequenceOffset + 2,
      thread_id: threadId,
      turn_id: turnId,
      upstream_at: null,
    } as NormalizedCodexEvent,
    {
      captured_at: at(3),
      codex_event_id: `${itemId}:completed`,
      item: {
        category: "compaction",
        content_notice: null,
        content_state: "complete",
        id: itemId,
        state: "completed",
        text: null,
        title: "Context compaction",
      },
      method: "item/completed",
      scope: "thread",
      sequence: sequenceOffset + 3,
      thread_id: threadId,
      turn_id: turnId,
      upstream_at: null,
    } as NormalizedCodexEvent,
    {
      captured_at: at(4),
      codex_event_id: `${turnId}:completed`,
      error_message: null,
      method: "turn/completed",
      scope: "thread",
      sequence: sequenceOffset + 4,
      status: "completed",
      thread_id: threadId,
      turn_id: turnId,
      upstream_at: null,
    } as NormalizedCodexEvent,
  ]);
}

function rawUsage(): Readonly<Record<string, unknown>> {
  return Object.freeze({
    dailyUsageBuckets: Object.freeze([
      Object.freeze({ startDate: "2026-07-19", tokens: 50 }),
      Object.freeze({ startDate: "2026-07-20", tokens: 100 }),
    ]),
    summary: Object.freeze({
      currentStreakDays: 2,
      lifetimeTokens: 1_000,
      longestRunningTurnSec: 30,
      longestStreakDays: 4,
      peakDailyTokens: 100,
    }),
  });
}

function committedCandidate(event: SelectedProjectionEvent, state: SelectedSessionState) {
  return deepFreeze({
    event: {
      byte_length: selectedProjectedEventByteLength(event),
      event,
    },
    projection: state.projection,
    revision: {
      last_event_cursor: event.cursor,
      mapping_updated_at: state.mapping.updated_at,
      projection_updated_at: state.projection.session.updated_at,
    },
  });
}

function eventAt(sequence: number): string {
  return new Date(Date.parse(timestamp) + sequence * 1_000).toISOString();
}

function selectedOperationId(candidate: string) {
  return clientOperationIdSchema.parse(candidate);
}

function promptPayloadOfSize(operationId: string, byteLength: number) {
  const empty = {
    operation_id: operationId,
    kind: "prompt" as const,
    text: "",
  };
  const fixedBytes = Buffer.byteLength(JSON.stringify(empty), "utf8");
  if (byteLength <= fixedBytes) {
    throw new RangeError("Prompt payload byte target cannot fit a nonempty text.");
  }
  const payload = Object.freeze({
    ...empty,
    text: "x".repeat(byteLength - fixedBytes),
  });
  if (Buffer.byteLength(JSON.stringify(payload), "utf8") !== byteLength) {
    throw new Error("Prompt payload did not reach its exact byte target.");
  }
  return payload;
}

function requireIndexed<T>(values: readonly T[], index: number, label: string): T {
  const value = values[index];
  if (value === undefined) {
    throw new RangeError(`Resource stress ${label} index ${index} is invalid.`);
  }
  return value;
}

function requireRecord(candidate: unknown, label: string): Record<string, unknown> {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return candidate as Record<string, unknown>;
}

function expectFrozenSafeIntegerSnapshot(snapshot: Readonly<object>): void {
  expect(Object.isFrozen(snapshot)).toBe(true);
  for (const value of Object.values(snapshot)) {
    if (typeof value !== "number") continue;
    expect(Number.isSafeInteger(value)).toBe(true);
    expect(value).toBeGreaterThanOrEqual(0);
  }
}

function failUnused(): never {
  throw new Error("Unselected resource-stress port was invoked.");
}

interface RawJsonResponse {
  readonly body: string;
  readonly json: unknown;
  readonly status: number;
}

interface StartedJsonRequest {
  readonly closed: Promise<void>;
  readonly request: ClientRequest;
  readonly response: Promise<RawJsonResponse>;
}

function startJsonRequest(port: number, method: string, path: string, payload?: unknown): StartedJsonRequest {
  const body = payload === undefined ? "" : JSON.stringify(payload);
  const responseOutcome = deferred<RawJsonResponse>();
  const closedOutcome = deferred<void>();
  const request = httpRequest(
    {
      headers: {
        accept: "application/json",
        connection: "close",
        host: `127.0.0.1:${port}`,
        ...(payload === undefined
          ? {}
          : {
              "content-length": Buffer.byteLength(body, "utf8"),
              "content-type": "application/json",
            }),
      },
      host: "127.0.0.1",
      method,
      path,
      port,
    },
    (response) => collectJsonResponse(response, responseOutcome),
  );
  request.once("error", responseOutcome.reject);
  request.once("close", () => closedOutcome.resolve(undefined));
  if (body.length > 0) request.write(body);
  request.end();
  void responseOutcome.promise.catch(() => undefined);
  return Object.freeze({
    closed: closedOutcome.promise,
    request,
    response: responseOutcome.promise,
  });
}

async function rawJsonExchange(
  port: number,
  method: string,
  path: string,
  payload?: unknown,
): Promise<RawJsonResponse> {
  return await startJsonRequest(port, method, path, payload).response;
}

function collectJsonResponse(response: IncomingMessage, outcome: Deferred<RawJsonResponse>): void {
  const chunks: Buffer[] = [];
  let bytes = 0;
  response.on("data", (chunk: Buffer | string) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > 65_536) {
      response.destroy(new Error("Resource stress response exceeded 65536 bytes."));
      return;
    }
    chunks.push(buffer);
  });
  response.once("error", outcome.reject);
  response.once("aborted", () => outcome.reject(new Error("Resource stress response was aborted.")));
  response.once("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    let json: unknown = null;
    try {
      if (body.length > 0) json = JSON.parse(body) as unknown;
    } catch (error) {
      outcome.reject(
        new Error("Resource stress response was not valid JSON.", {
          cause: error,
        }),
      );
      return;
    }
    outcome.resolve(Object.freeze({ body, json, status: response.statusCode ?? 0 }));
  });
}

interface OpenStressSse {
  readonly close: () => void;
  readonly closed: Promise<void>;
  readonly waitFor: (fragment: string) => Promise<void>;
}

function openSse(port: number, sessionId: string): OpenStressSse {
  const closed = deferred<void>();
  let body = "";
  let failure: unknown = null;
  let incoming: IncomingMessage | null = null;
  let finished = false;
  const finish = (error?: unknown) => {
    if (finished) return;
    finished = true;
    if (error !== undefined) failure = error;
    closed.resolve(undefined);
  };
  const request = httpRequest(
    {
      headers: {
        accept: "text/event-stream",
        connection: "close",
        host: `127.0.0.1:${port}`,
      },
      host: "127.0.0.1",
      method: "GET",
      path: `/api/v1/sessions/${sessionId}/events/stream`,
      port,
    },
    (response) => {
      incoming = response;
      if (response.statusCode !== 200) {
        finish(new Error(`Resource stress SSE returned ${response.statusCode ?? 0}.`));
        response.resume();
        return;
      }
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
        if (Buffer.byteLength(body, "utf8") > 131_072) {
          const error = new Error("Resource stress SSE exceeded 131072 bytes.");
          finish(error);
          response.destroy(error);
        }
      });
      response.once("end", () => finish());
      response.once("close", () => finish());
      response.once("error", finish);
    },
  );
  request.once("error", finish);
  request.end();
  return Object.freeze({
    close() {
      incoming?.destroy();
      request.destroy();
    },
    closed: closed.promise,
    async waitFor(fragment: string) {
      await waitFor(() => body.includes(fragment) || failure !== null);
      if (!body.includes(fragment)) {
        throw new Error(`Resource stress SSE failed before ${fragment}.`, {
          cause: failure,
        });
      }
    },
  });
}

interface OpenIdleConnection {
  readonly close: () => void;
  readonly closed: Promise<void>;
  readonly socket: Socket;
}

async function openIdleConnection(port: number): Promise<OpenIdleConnection> {
  const connected = deferred<void>();
  const closed = deferred<void>();
  const socket = createConnection({ host: "127.0.0.1", port });
  socket.once("connect", () => connected.resolve(undefined));
  socket.once("error", connected.reject);
  socket.once("close", () => closed.resolve(undefined));
  await connected.promise;
  return Object.freeze({
    close: () => socket.destroy(),
    closed: closed.promise,
    socket,
  });
}

interface PartialPromptUpload {
  readonly close: () => void;
  readonly closed: Promise<void>;
}

function startPartialPromptUpload(port: number, sessionId: string): PartialPromptUpload {
  const closed = deferred<void>();
  const request = httpRequest(
    {
      headers: {
        accept: "application/json",
        connection: "keep-alive",
        "content-length": 512,
        "content-type": "application/json",
        host: `127.0.0.1:${port}`,
      },
      host: "127.0.0.1",
      method: "POST",
      path: `/api/v1/sessions/${sessionId}/prompts`,
      port,
    },
    (response) => response.resume(),
  );
  request.once("error", () => undefined);
  request.once("close", () => closed.resolve(undefined));
  request.write("{");
  return Object.freeze({
    close: () => request.destroy(),
    closed: closed.promise,
  });
}

async function captureCliFailure(operation: Promise<unknown>): Promise<CliFailure> {
  try {
    await operation;
  } catch (error) {
    if (error instanceof CliFailure) return error;
    throw error;
  }
  throw new Error("Expected bounded CLI operation to fail.");
}

async function expectCliFailure(
  operation: Promise<unknown>,
  expected: Readonly<{ code: string; status: number | undefined }>,
): Promise<void> {
  const failure = await captureCliFailure(operation);
  expect(failure).toMatchObject(expected);
}

interface ActiveResourceCounts {
  readonly TCPSocketWrap: number;
  readonly Timeout: number;
}

function activeResources(): ActiveResourceCounts {
  const resources = process.getActiveResourcesInfo();
  return Object.freeze({
    TCPSocketWrap: resources.filter((resource) => resource === "TCPSocketWrap").length,
    Timeout: resources.filter((resource) => resource === "Timeout").length,
  });
}

function stressTemporaryRoots(): readonly string[] {
  return Object.freeze(
    readdirSync(tmpdir(), { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() && entry.name.startsWith("hostdeck-resource-stress-"),
      )
      .map((entry) => entry.name)
      .sort(),
  );
}

async function listen(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

async function reservePort(): Promise<number> {
  const server: Server = createServer();
  return await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Unable to reserve a resource-stress port."));
        return;
      }
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) {
      throw new Error("Timed out waiting for resource-stress condition.");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly reject: (reason?: unknown) => void;
  readonly resolve: (value: T | PromiseLike<T>) => void;
}

function deferred<T>(): Deferred<T> {
  let reject!: (reason?: unknown) => void;
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    reject = rejectPromise;
    resolve = resolvePromise;
  });
  return Object.freeze({ promise, reject, resolve });
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}
