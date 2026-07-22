import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  remoteIngressPublicStateSchema,
  resolveResourceBudget,
  type SelectedProjectionEvent,
  type SelectedSessionListInput,
  type SelectedSessionListPage,
  type SelectedSessionReadItem,
  selectedProjectionEventSchema,
  selectedSessionListPageSchema,
  selectedSessionReadItemSchema
} from "../packages/contracts/src/index.js";
import type { OutputCursor } from "../packages/core/src/index.js";
import { selectedProjectionSseWireByteLength } from "../packages/server/src/fastify-sse-source.js";
import {
  createHostDeckCsrfPolicy,
  createHostDeckCsrfRouteRegistration,
  createHostDeckFastifyApp,
  createHostDeckHealthRouteRegistration,
  createHostDeckHostHealthService,
  createHostDeckHostLockPolicy,
  createHostDeckHostLockRouteRegistration,
  createHostDeckProjectionStreamRouteRegistration,
  createHostDeckRemoteIngressRequestAuthorityPolicy,
  createHostDeckRequestAuthenticationPolicy,
  createHostDeckRequestTrustPolicy,
  createHostDeckSessionReadRouteRegistration,
  createHostDeckTailscaleServeFastifyApp,
  createProjectionSubscriberStreamService,
  createSecurityMutationAuditExecutor,
  createTailscaleServeProxyTrustPolicy,
  type HostDeckFastifyInstance,
  HostDeckProjectionHandoffError,
  hostDeckDeviceCookieName,
  type OpenProjectionReplayLiveHandoffInput,
  type ProjectionHandoffFailure,
  type ProjectionReplayLiveHandoff,
  type ProjectionReplayLiveHandoffService
} from "../packages/server/src/index.js";
import {
  createAuthDeviceRepository,
  createDeviceRevocationRepository,
  createSelectedAuditRepository,
  createSelectedCsrfAuthorizationRepository,
  createSettingsRepository,
  openMigratedDatabase
} from "../packages/storage/src/index.js";
import {
  type BrowserConnectionStateCoordinator,
  createBrowserConnectionStateCoordinator
} from "../packages/web/src/connection-state.js";
import { createBrowserCsrfClient } from "../packages/web/src/csrf-client.js";
import {
  type BrowserHttpFetchPort,
  createBrowserHttpClient
} from "../packages/web/src/http-client.js";
import {
  type BrowserSseFetchPort,
  createBrowserSseClient
} from "../packages/web/src/sse-client.js";

const externalOrigin =
  "https://hostdeck-connection-state.fixture-tailnet.ts.net";
const sessionId = "sess_connection_integration";
const missingSessionId = "sess_connection_missing";
const writerDeviceId = "client_connection_writer";
const readerDeviceId = "client_connection_reader";
const writerToken = "W".repeat(43);
const readerToken = "R".repeat(43);
const initialWriterCsrf = "I".repeat(43);
const initialReaderCsrf = "J".repeat(43);
const timestamp = "2026-07-22T19:00:00.000Z";
const resourceBudget = resolveResourceBudget({
  sse_heartbeat_interval_ms: 1_000
});
const harnesses: ConnectionServerHarness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0).reverse()) await harness.close();
});

describe("FE-V1-025 real shell connection-state composition", () => {
  it("coordinates loopback access, health, list, detail, boundary, stream, and cleanup", async () => {
    const harness = await createHarness("loopback");
    const page = harness.createPage(null);

    const mission = await page.coordinator.setTarget({ kind: "mission_control" });
    expect(mission).toMatchObject({
      phase: "ready",
      access: {
        data: {
          authentication_state: "unpaired",
          network_mode: "loopback",
          can_read_sessions: true,
          can_write_sessions: false
        }
      },
      host: { data: { access: { mode: "loopback_read" } } },
      targetState: {
        data: {
          kind: "mission_control",
          access: { mode: "loopback_read" },
          pageCount: 1
        }
      },
      writeEligibility: { eligible: false, causes: ["read_only_access"] },
      csrf: { phase: "idle", invalidationReason: "not_bootstrapped" }
    });
    expect(mission.targetState.data?.kind === "mission_control"
      ? mission.targetState.data.sessions.map((item) => item.session.id)
      : []).toEqual([sessionId]);
    expect(harness.requestPaths).not.toContain("/api/v1/access/csrf");

    const detail = await page.coordinator.setTarget({
      kind: "session_detail",
      sessionId
    });
    expect(detail).toMatchObject({
      phase: "degraded",
      targetState: {
        data: {
          kind: "session_detail",
          response: { session: { session: { id: sessionId, last_event_cursor: 1 } } }
        }
      },
      stream: {
        state: "idle",
        continuity: "boundary",
        boundary: { after: 0, cursor: 1, reason: "retention" }
      }
    });

    const events: SelectedProjectionEvent[] = [];
    page.coordinator.connectSessionStream((event) => events.push(event));
    await waitUntil(() => harness.handoff.activeSinkCount === 1);
    harness.handoff.publish(projectionEvent(2, "loopback live"));
    await waitUntil(() => events.some((event) => event.cursor === 2));
    expect(page.coordinator.snapshot().stream).toMatchObject({
      state: "connected",
      continuity: "boundary"
    });

    page.coordinator.close();
    await waitUntil(() => harness.subscribers.snapshot().active_subscribers === 0);
    expect(harness.handoff.activeSinkCount).toBe(0);
    expect(harness.sessionPortCounts()).toEqual({ get: 1, list: 1 });
    expect(JSON.stringify(page.coordinator.snapshot())).not.toContain(writerToken);
  });

  it("keeps remote unpaired access private and paired-read access read-only", async () => {
    const harness = await createHarness("serve");
    const unpaired = harness.createPage(null);

    const denied = await unpaired.coordinator.setTarget({ kind: "mission_control" });
    expect(denied).toMatchObject({
      phase: "access_limited",
      access: { data: { authentication_state: "unpaired" } },
      host: { state: "blocked", data: null },
      targetState: { state: "blocked", data: null },
      writeEligibility: { eligible: false, causes: ["unpaired"] }
    });
    expect(harness.sessionPortCounts()).toEqual({ get: 0, list: 0 });
    expect(harness.requestPaths).toEqual(["/api/v1/access"]);
    unpaired.coordinator.close();

    const reader = harness.createPage(readerToken);
    const mission = await reader.coordinator.setTarget({ kind: "mission_control" });
    expect(mission).toMatchObject({
      phase: "ready",
      access: {
        data: {
          authentication_state: "paired_device",
          device_id: readerDeviceId,
          permission: "read"
        }
      },
      host: { data: { access: { mode: "paired_read" } } },
      targetState: { data: { access: { mode: "paired_read" } } },
      csrf: { phase: "idle", invalidationReason: "not_bootstrapped" },
      writeEligibility: { eligible: false, causes: ["read_only_access"] }
    });
    expect(harness.requestPaths.filter((path) => path === "/api/v1/access/csrf")).toHaveLength(0);

    const notFound = await reader.coordinator.setTarget({
      kind: "session_detail",
      sessionId: missingSessionId
    });
    expect(notFound).toMatchObject({
      phase: "not_found",
      targetState: {
        state: "not_found",
        data: null,
        failure: { source: "session_detail", status: 404 }
      }
    });
    reader.coordinator.close();
  });

  it("rotates writer authority, reconnects SSE, locks, follows remote generation, and purges on revoke", async () => {
    const harness = await createHarness("serve");
    const page = harness.createPage(writerToken);

    const ready = await page.coordinator.setTarget({ kind: "mission_control" });
    expect(ready).toMatchObject({
      phase: "ready",
      access: { data: { permission: "write", device_id: writerDeviceId } },
      host: {
        data: {
          remote: { availability: "ready", state_generation: 31 },
          access: { mode: "paired_write" }
        }
      },
      csrf: { phase: "ready", generation: 2 },
      writeEligibility: { eligible: true, causes: [] }
    });

    harness.setCompatibilityHealth("degraded");
    const degraded = await page.coordinator.refresh();
    expect(degraded).toMatchObject({
      phase: "degraded",
      host: {
        data: {
          local: {
            state: "degraded",
            mutation_admission: "closed",
            components: expect.arrayContaining([
              expect.objectContaining({
                component: "compatibility",
                state: "degraded",
                causes: ["compatibility_degraded"]
              })
            ])
          }
        }
      },
      writeEligibility: { eligible: false, causes: ["host_not_ready"] }
    });
    harness.setCompatibilityHealth("ready");
    const healthRecovered = await page.coordinator.refresh();
    expect(healthRecovered).toMatchObject({
      phase: "ready",
      writeEligibility: { eligible: true, causes: [] }
    });

    await page.coordinator.setTarget({ kind: "session_detail", sessionId });
    const events: SelectedProjectionEvent[] = [];
    page.coordinator.connectSessionStream((event) => events.push(event));
    await waitUntil(() => harness.handoff.activeSinkCount === 1);
    harness.handoff.publish(projectionEvent(2, "writer live"));
    await waitUntil(() => events.some((event) => event.cursor === 2));
    harness.handoff.disconnectAll();
    await waitUntil(() => harness.handoff.activeSinkCount === 0);
    harness.handoff.append(projectionEvent(3, "writer replay"));
    await waitUntil(() => events.some((event) => event.cursor === 3), 3_000);
    expect(harness.handoff.openInputs.map((input) => input.after)).toEqual([1, 2]);
    expect(page.coordinator.snapshot()).toMatchObject({
      stream: { state: "connected", continuity: "boundary", failure: null },
      lastFailure: { source: "session_stream", reason: "transport_unavailable" }
    });

    page.coordinator.disconnectSessionStream();
    await page.coordinator.setTarget({ kind: "mission_control" });
    const lockedResponse = await page.coordinator.requestProtected("host_lock", {
      body: {
        operation_id: "op_connection_integration_lock_0001",
        confirmed: true
      }
    });
    expect(lockedResponse.data).toMatchObject({ locked: true });
    const locked = await page.coordinator.refresh();
    expect(locked).toMatchObject({
      access: { data: { locked: true, can_write_sessions: false } },
      writeEligibility: { eligible: false, causes: ["host_locked"] }
    });

    harness.setRemoteGeneration(32);
    const rotated = await page.coordinator.refresh();
    expect(rotated).toMatchObject({
      host: { data: { remote: { state_generation: 32 } } },
      csrf: {
        phase: "idle",
        generation: null,
        invalidationReason: "remote_authority_changed"
      },
      writeEligibility: {
        eligible: false,
        causes: ["host_locked", "csrf_not_ready"]
      }
    });
    const reauthorized = await page.coordinator.bootstrapCsrf();
    expect(reauthorized).toMatchObject({
      csrf: { phase: "ready", generation: 3 },
      writeEligibility: { eligible: false, causes: ["host_locked"] }
    });

    harness.revokeWriter();
    const revoked = await page.coordinator.refresh();
    expect(revoked).toMatchObject({
      phase: "access_limited",
      access: { data: { authentication_state: "revoked_device" } },
      host: { state: "blocked", data: null },
      targetState: { state: "blocked", data: null },
      csrf: { phase: "idle", invalidationReason: "device_revoked" },
      writeEligibility: { eligible: false, causes: ["revoked_device"] }
    });
    const publicState = JSON.stringify(revoked);
    for (const secret of harness.secrets) expect(publicState).not.toContain(secret);

    page.coordinator.close();
    await waitUntil(() => harness.subscribers.snapshot().active_subscribers === 0);
    expect(harness.handoff.activeSinkCount).toBe(0);
    expect(harness.audit.require("op_connection_integration_lock_0001").records).toHaveLength(2);
  });
});

type HarnessMode = "loopback" | "serve";

interface ConnectionServerHarness {
  readonly app: HostDeckFastifyInstance;
  readonly audit: ReturnType<typeof createSelectedAuditRepository>;
  readonly handoff: MemoryHandoffService;
  readonly requestPaths: string[];
  readonly secrets: ReadonlySet<string>;
  readonly subscribers: ReturnType<typeof createProjectionSubscriberStreamService>;
  readonly close: () => Promise<void>;
  readonly createPage: (token: string | null) => {
    readonly coordinator: BrowserConnectionStateCoordinator;
  };
  readonly revokeWriter: () => void;
  readonly sessionPortCounts: () => { readonly get: number; readonly list: number };
  readonly setCompatibilityHealth: (state: "degraded" | "ready") => void;
  readonly setRemoteGeneration: (generation: number) => void;
}

async function createHarness(mode: HarnessMode): Promise<ConnectionServerHarness> {
  const root = mkdtempSync(join(tmpdir(), "hostdeck-connection-state-"));
  const opened = openMigratedDatabase(join(root, "hostdeck.sqlite"), {
    now: () => new Date(timestamp)
  });
  let wallTime = Date.parse(timestamp);
  const now = () => new Date(++wallTime);
  const port = await reservePort();
  const localOrigin = `http://127.0.0.1:${port}`;
  const settings = createSettingsRepository(opened.db);
  settings.getOrCreateDefault({ stateDir: root, bindPort: port, now });

  const auth = createAuthDeviceRepository(opened.db);
  auth.create({
    id: writerDeviceId,
    rawDeviceToken: writerToken,
    rawCsrfToken: initialWriterCsrf,
    permission: "write",
    clientLabel: "Connection-state writer",
    createdAt: now()
  });
  auth.create({
    id: readerDeviceId,
    rawDeviceToken: readerToken,
    rawCsrfToken: initialReaderCsrf,
    permission: "read",
    clientLabel: "Connection-state reader",
    createdAt: now()
  });
  const rotatedTokens = ["A", "B", "C", "D"].map((value) => value.repeat(43));
  const secrets = new Set([
    writerToken,
    readerToken,
    initialWriterCsrf,
    initialReaderCsrf,
    ...rotatedTokens
  ]);
  let tokenIndex = 0;
  const csrfRepository = createSelectedCsrfAuthorizationRepository(opened.db, {
    generateCsrfToken() {
      const token = rotatedTokens[tokenIndex++];
      if (token === undefined) throw new Error("Connection-state CSRF entropy exhausted.");
      return token;
    }
  });
  const csrf = createHostDeckCsrfPolicy({
    csrf: {
      authorizeBrowserWrite: (input) => csrfRepository.authorizeBrowserWrite(input),
      rotateBootstrap: (input) => csrfRepository.rotateBootstrap(input)
    },
    now
  });
  const lock = createHostDeckHostLockPolicy({
    settings: {
      read: () => settings.readHostLock(),
      transition: (input) => settings.transitionHostLock(input)
    },
    now
  });
  const audit = createSelectedAuditRepository(opened.db);
  let auditSequence = 0;
  const securityAudit = createSecurityMutationAuditExecutor({
    repository: audit,
    now: () => now().toISOString(),
    create_record_id: () => `audit:connection-state:${++auditSequence}`
  });
  const authentication = createHostDeckRequestAuthenticationPolicy({
    authenticateDeviceToken: (input) => auth.authenticateDeviceToken(input),
    now
  });

  const health = createHostDeckHostHealthService({ now });
  for (const component of [
    "storage",
    "runtime",
    "compatibility",
    "projector",
    "fanout",
    "listener",
    "lease"
  ] as const) {
    health.updateLocal({
      component,
      source_generation: 1,
      state: "ready",
      reasons: []
    });
  }
  let remoteGeneration = 31;
  let remoteSourceGeneration = 0;
  let compatibilitySourceGeneration = 1;
  const updateRemoteHealth = () => {
    health.updateRemote({
      source_generation: ++remoteSourceGeneration,
      state: remoteIngressPublicStateSchema.parse({
        generation: remoteGeneration,
        availability: "ready",
        reason: null,
        external_origin: externalOrigin,
        laptop_action_required: false,
        observed_at: now().toISOString()
      })
    });
  };
  updateRemoteHealth();

  const item = sessionReadItem();
  let getCalls = 0;
  let listCalls = 0;
  const sessions = Object.freeze({
    get(candidate: string) {
      getCalls += 1;
      return candidate === sessionId ? item : null;
    },
    list(_input: SelectedSessionListInput): SelectedSessionListPage {
      listCalls += 1;
      return selectedSessionListPageSchema.parse({
        sessions: [item],
        order_snapshot: "a".repeat(64),
        next_after: null,
        has_more: false
      });
    }
  });

  const handoff = new MemoryHandoffService([projectionEvent(1, "retained")]);
  const streamFailures: unknown[] = [];
  const subscribers = createProjectionSubscriberStreamService({
    handoff: Object.freeze({ open: (candidate: unknown) => handoff.open(candidate) }),
    observe_failure: (failure) => streamFailures.push(failure),
    resource_budget: resourceBudget
  });
  const routePlugins = [
    createHostDeckHostLockRouteRegistration({ audit: securityAudit, csrf, lock }),
    createHostDeckCsrfRouteRegistration({ audit: securityAudit, csrf }),
    createHostDeckHealthRouteRegistration({ health }),
    createHostDeckSessionReadRouteRegistration({ sessions }),
    createHostDeckProjectionStreamRouteRegistration({
      observe_error: (failure) => streamFailures.push(failure),
      subscribers
    })
  ];

  const app = mode === "loopback"
    ? createHostDeckFastifyApp({
        observeInternalError: () => undefined,
        requestAuthenticationPolicy: authentication,
        requestTrustPolicy: createHostDeckRequestTrustPolicy({
          allowedOrigin: localOrigin
        }),
        resourceBudget,
        routePlugins
      })
    : (() => {
        const authority = createHostDeckRemoteIngressRequestAuthorityPolicy();
        return createHostDeckTailscaleServeFastifyApp({
          observeInternalError: () => undefined,
          requestAuthenticationPolicy: authentication,
          resourceBudget,
          routePlugins,
          remoteIngressRequestAuthority: authority,
          tailscaleServeProxyTrustPolicy: createTailscaleServeProxyTrustPolicy({
            localOrigin,
            readRemoteAdmission: () =>
              authority.synchronize({
                admission: "open",
                external_origin: externalOrigin,
                generation: remoteGeneration
              })
          })
        });
      })();
  await app.listen({ host: "127.0.0.1", port });

  const requestPaths: string[] = [];
  let operationSequence = 0;
  let closed = false;
  const pages = new Set<BrowserConnectionStateCoordinator>();
  const harness: ConnectionServerHarness = {
    app,
    audit,
    handoff,
    requestPaths,
    secrets,
    subscribers,
    async close() {
      if (closed) return;
      closed = true;
      for (const page of pages) page.close();
      pages.clear();
      await app.close();
      opened.db.close();
      rmSync(root, { force: true, recursive: true });
    },
    createPage(token) {
      const origin = mode === "loopback" ? localOrigin : externalOrigin;
      const httpFetch = mode === "loopback"
        ? loopbackHttpFetch(localOrigin, token, requestPaths)
        : serveHttpFetch(localOrigin, token, requestPaths);
      const httpClient = createBrowserHttpClient({ origin, fetch: httpFetch });
      const csrfClient = createBrowserCsrfClient({
        httpClient,
        createOperationId: () =>
          `op_connection_integration_csrf_${String(++operationSequence).padStart(4, "0")}`
      });
      const sseFetch = mode === "loopback"
        ? loopbackSseFetch(localOrigin, token)
        : serveSseFetch(localOrigin, token);
      const sseClient = createBrowserSseClient({
        origin,
        fetch: sseFetch,
        limits: {
          connectTimeoutMs: 35_000,
          idleTimeoutMs: 45_000,
          errorResponseMaxBytes: 65_536,
          eventMaxBytes: 65_536,
          reconnectInitialDelayMs: 500,
          reconnectMaxDelayMs: 1_000,
          maxReconnectAttempts: 3,
          maxConcurrentStreams: 2
        }
      });
      const coordinator = createBrowserConnectionStateCoordinator({
        httpClient,
        sseClient,
        csrfClient,
        origin
      });
      pages.add(coordinator);
      return Object.freeze({ coordinator });
    },
    revokeWriter() {
      createDeviceRevocationRepository(opened.db).revoke({
        deviceId: writerDeviceId,
        now: now()
      });
    },
    sessionPortCounts: () => Object.freeze({ get: getCalls, list: listCalls }),
    setCompatibilityHealth(state) {
      health.updateLocal({
        component: "compatibility",
        source_generation: ++compatibilitySourceGeneration,
        state,
        reasons: state === "degraded" ? ["compatibility_degraded"] : []
      });
    },
    setRemoteGeneration(generation) {
      remoteGeneration = generation;
      updateRemoteHealth();
    }
  };
  harnesses.push(harness);
  return harness;
}

class MemoryHandoffService implements ProjectionReplayLiveHandoffService {
  readonly openInputs: OpenProjectionReplayLiveHandoffInput[] = [];
  private readonly events: SelectedProjectionEvent[];
  private readonly live = new Map<
    string,
    {
      readonly sink: (event: SelectedProjectionEvent) => void;
      readonly controller: AbortController;
    }
  >();

  constructor(events: readonly SelectedProjectionEvent[]) {
    this.events = [...events];
  }

  get activeSinkCount(): number {
    return this.live.size;
  }

  append(event: SelectedProjectionEvent): void {
    this.events.push(event);
  }

  publish(event: SelectedProjectionEvent): void {
    this.append(event);
    for (const entry of [...this.live.values()]) entry.sink(event);
  }

  disconnectAll(): void {
    for (const entry of [...this.live.values()]) entry.controller.abort();
  }

  open(candidate: unknown): ProjectionReplayLiveHandoff {
    const input = candidate as OpenProjectionReplayLiveHandoffInput;
    this.openInputs.push(input);
    if (input.session_id !== sessionId) {
      throw new HostDeckProjectionHandoffError(
        "session_not_found",
        "Connection-state integration session was not found."
      );
    }
    const replay = Object.freeze(
      this.events.filter(
        (event) => input.after === null || event.cursor > input.after
      )
    );
    const highWater = (this.events.at(-1)?.cursor ?? input.after) as
      | OutputCursor
      | null;
    const controller = new AbortController();
    let claimed = false;
    let closed = false;
    let activated = false;
    const service = this;
    const replayBytes = replay.reduce(
      (total, event) => total + selectedProjectionSseWireByteLength(event),
      0
    );
    return Object.freeze({
      activate(candidateActivation: unknown) {
        const activation = candidateActivation as {
          readonly on_event: (event: SelectedProjectionEvent) => void;
        };
        service.live.set(input.subscriber_id, {
          sink: activation.on_event,
          controller
        });
        activated = true;
        return Object.freeze({
          drained_event_count: 0,
          live_after_cursor: highWater
        });
      },
      after: input.after as OutputCursor | null,
      claim_replay() {
        if (claimed) throw new Error("Connection-state replay was already claimed.");
        claimed = true;
        return Object.freeze({
          event_count: replay.length,
          events: replay,
          wire_bytes: replayBytes
        });
      },
      close() {
        if (closed) return false;
        closed = true;
        service.live.delete(input.subscriber_id);
        controller.abort();
        return true;
      },
      get failure(): ProjectionHandoffFailure | null {
        return null;
      },
      high_water_cursor: highWater,
      observed_fanout_cursor: null,
      get paused_event_count() {
        return 0;
      },
      get paused_wire_bytes() {
        return 0;
      },
      replay_event_count: replay.length,
      replay_wire_bytes: replayBytes,
      session_id: input.session_id,
      signal: controller.signal,
      get state() {
        return closed ? "closed" : activated ? "live" : "paused";
      },
      subscriber_id: input.subscriber_id,
      truncated: false
    });
  }
}

function sessionReadItem(): SelectedSessionReadItem {
  return selectedSessionReadItemSchema.parse({
    event_window: {
      state: "bounded",
      retained_event_count: 1,
      earliest_retained_cursor: 1,
      boundary_cursor: 0
    },
    session: {
      id: sessionId,
      name: "connection-integration",
      codex_thread_id: "thread-connection-integration",
      cwd: "/workspace/hostdeck",
      runtime_source: "codex_app_server",
      runtime_version: "0.144.0",
      created_at: timestamp,
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
      settings: {
        collaboration_mode: "default",
        runtime_model: "gpt-5.5-codex",
        reasoning_effort: "high",
        observed_at: timestamp
      },
      goal: { objective: "Complete connection-state integration.", state: "active" },
      recent_summary: "Real selected coordinator fixture.",
      last_event_cursor: 1
    }
  });
}

function projectionEvent(cursor: number, text: string): SelectedProjectionEvent {
  return Object.freeze(
    selectedProjectionEventSchema.parse({
      session_id: sessionId,
      cursor,
      captured_at: timestamp,
      upstream_at: null,
      codex_event_id: `connection-integration-event-${cursor}`,
      codex_event_type: "item/agentMessage/delta",
      content_state: "complete",
      content_notice: null,
      type: "message",
      role: "agent",
      phase: "delta",
      item_id: null,
      text
    })
  );
}

function loopbackHttpFetch(
  origin: string,
  token: string | null,
  paths: string[]
): BrowserHttpFetchPort {
  return async (path, init) => {
    paths.push(path);
    const headers: Record<string, string> = { ...init.headers, origin };
    if (token !== null) headers.cookie = `${hostDeckDeviceCookieName}=${token}`;
    return (await fetch(new URL(path, origin), {
      ...init,
      headers
    } as RequestInit)) as never;
  };
}

function serveHttpFetch(
  proxyOrigin: string,
  token: string | null,
  paths: string[]
): BrowserHttpFetchPort {
  return async (path, init) => {
    paths.push(path);
    const authority = new URL(externalOrigin).host;
    const headers: Record<string, string> = {
      ...init.headers,
      host: authority,
      origin: externalOrigin,
      "x-forwarded-for": "100.91.82.75",
      "x-forwarded-host": authority,
      "x-forwarded-proto": "https"
    };
    if (token !== null) headers.cookie = `${hostDeckDeviceCookieName}=${token}`;
    if (init.body !== undefined) {
      headers["content-length"] = String(
        new TextEncoder().encode(init.body).byteLength
      );
    }
    return await bufferedHttpFetch(proxyOrigin, path, init, headers);
  };
}

function bufferedHttpFetch(
  targetOrigin: string,
  path: string,
  init: Parameters<BrowserHttpFetchPort>[1],
  headers: Readonly<Record<string, string>>
): ReturnType<BrowserHttpFetchPort> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      new URL(path, targetOrigin),
      { method: init.method, headers },
      (response) => {
        const chunks: Uint8Array[] = [];
        response.on("data", (chunk: Uint8Array) => chunks.push(chunk));
        response.once("error", reject);
        response.once("end", () => {
          const status = response.statusCode;
          if (status === undefined) {
            reject(new Error("Connection-state response has no status code."));
            return;
          }
          const responseHeaders = responseHeadersFrom(response.rawHeaders);
          resolve(
            new Response(Buffer.concat(chunks), {
              status,
              headers: responseHeaders
            }) as never
          );
        });
      }
    );
    const abort = () => request.destroy(new Error("Connection-state request aborted."));
    init.signal.addEventListener("abort", abort, { once: true });
    request.once("close", () => init.signal.removeEventListener("abort", abort));
    request.once("error", reject);
    if (init.body !== undefined) request.write(init.body);
    request.end();
  });
}

function loopbackSseFetch(
  origin: string,
  token: string | null
): BrowserSseFetchPort {
  const headers: Record<string, string> = { origin };
  if (token !== null) headers.cookie = `${hostDeckDeviceCookieName}=${token}`;
  return (path, init) => streamingHttpFetch(origin, path, init, headers);
}

function serveSseFetch(
  proxyOrigin: string,
  token: string | null
): BrowserSseFetchPort {
  const authority = new URL(externalOrigin).host;
  const headers: Record<string, string> = {
    host: authority,
    origin: externalOrigin,
    "x-forwarded-for": "100.91.82.75",
    "x-forwarded-host": authority,
    "x-forwarded-proto": "https"
  };
  if (token !== null) headers.cookie = `${hostDeckDeviceCookieName}=${token}`;
  return (path, init) => streamingHttpFetch(proxyOrigin, path, init, headers);
}

function streamingHttpFetch(
  targetOrigin: string,
  path: string,
  init: Parameters<BrowserSseFetchPort>[1],
  extraHeaders: Readonly<Record<string, string>>
): ReturnType<BrowserSseFetchPort> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      new URL(path, targetOrigin),
      { method: init.method, headers: { ...init.headers, ...extraHeaders } },
      (response) => {
        const status = response.statusCode;
        if (status === undefined) {
          response.destroy();
          reject(new Error("Connection-state SSE response has no status code."));
          return;
        }
        const headers = responseHeadersFrom(response.rawHeaders);
        const stream = Readable.toWeb(response) as ReadableStream<Uint8Array>;
        resolve({
          status,
          ok: status >= 200 && status < 300,
          headers: { get: (name: string) => headers.get(name) },
          body: {
            getReader: () => {
              const reader = stream.getReader();
              return {
                async read() {
                  const result = await reader.read();
                  return result.done
                    ? { done: true as const }
                    : { done: false as const, value: result.value };
                },
                async cancel() {
                  await reader.cancel();
                },
                releaseLock() {
                  reader.releaseLock();
                }
              };
            }
          }
        });
      }
    );
    const abort = () => request.destroy(new Error("Connection-state SSE aborted."));
    init.signal.addEventListener("abort", abort, { once: true });
    request.once("close", () => init.signal.removeEventListener("abort", abort));
    request.once("error", reject);
    request.end();
  });
}

function responseHeadersFrom(rawHeaders: string[]): Headers {
  const headers = new Headers();
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    const value = rawHeaders[index + 1];
    if (name !== undefined && value !== undefined) headers.append(name, value);
  }
  return headers;
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 1_500
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) {
      throw new Error("Connection-state integration condition timed out.");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  return address.port;
}
