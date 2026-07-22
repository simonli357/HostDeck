import { request as httpRequest } from "node:http";
import { type AddressInfo, createServer } from "node:net";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveResourceBudget,
  type SelectedProjectionEvent,
  selectedProjectionEventSchema
} from "../packages/contracts/src/index.js";
import type { OutputCursor } from "../packages/core/src/index.js";
import { selectedProjectionSseWireByteLength } from "../packages/server/src/fastify-sse-source.js";
import {
  createHostDeckFastifyApp,
  createHostDeckProjectionStreamRouteRegistration,
  createHostDeckRemoteIngressRequestAuthorityPolicy,
  createHostDeckRequestAuthenticationPolicy,
  createHostDeckRequestTrustPolicy,
  createHostDeckTailscaleServeFastifyApp,
  createProjectionSubscriberStreamService,
  createTailscaleServeProxyTrustPolicy,
  type HostDeckFastifyInstance,
  HostDeckProjectionHandoffError,
  hostDeckDeviceCookieName,
  type OpenProjectionReplayLiveHandoffInput,
  type ProjectionHandoffFailure,
  type ProjectionReplayLiveHandoff,
  type ProjectionReplayLiveHandoffService,
  tailscaleServeProxyTrustSnapshot
} from "../packages/server/src/index.js";
import {
  type BrowserSseFetchPort,
  createBrowserSseClient
} from "../packages/web/src/sse-client.js";

const sessionId = "sess_browser_sse_integration";
const timestamp = "2026-07-22T16:00:00.000Z";
const externalOrigin =
  "https://hostdeck-browser-sse.fixture-tailnet.ts.net";
const deviceToken = "S".repeat(43);
const deviceId = "client_browser_sse_reader";
const resourceBudget = resolveResourceBudget({
  sse_heartbeat_interval_ms: 1_000
});
const apps: HostDeckFastifyInstance[] = [];

afterEach(async () => {
  for (const app of apps.splice(0).reverse()) await app.close();
});

describe("FE-V1-023 real browser SSE client", () => {
  it("streams replay, heartbeat, live events, and cursor reconnect through loopback", async () => {
    const port = await reservePort();
    const origin = `http://127.0.0.1:${port}`;
    const fixture = createFixture([projectionEvent(1, "replay")]);
    const app = createHostDeckFastifyApp({
      observeInternalError: () => undefined,
      requestAuthenticationPolicy: authenticationPolicy(),
      requestTrustPolicy: createHostDeckRequestTrustPolicy({
        allowedOrigin: origin
      }),
      resourceBudget,
      routePlugins: [projectionRoute(fixture)]
    });
    apps.push(app);
    await app.listen({ host: "127.0.0.1", port });

    const paths: string[] = [];
    const events: SelectedProjectionEvent[] = [];
    const client = createBrowserSseClient({
      origin,
      fetch: nativeStreamingFetch(origin, paths),
      limits: {
        ...defaultBrowserSseLimits(),
        reconnectInitialDelayMs: 500
      }
    });
    const connection = client.connect({
      sessionId,
      onEvent(event) {
        events.push(event);
      }
    });

    await waitUntil(
      () => connection.snapshot().cursor === 1,
      3_000,
      () =>
        JSON.stringify({
          snapshot: connection.snapshot(),
          subscribers: fixture.subscribers.snapshot(),
          failures: fixture.failures,
          paths
        })
    );
    await waitUntil(() => connection.snapshot().lastHeartbeatAt !== null, 2_500);
    fixture.handoff.publish(projectionEvent(2, "live"));
    await waitUntil(() => connection.snapshot().cursor === 2);
    expect(events.map((event) => [event.cursor, event.type])).toEqual([
      [1, "message"],
      [2, "message"]
    ]);

    fixture.handoff.disconnectAll();
    await waitUntil(
      () => fixture.subscribers.snapshot().active_subscribers === 0
    );
    fixture.handoff.append(projectionEvent(3, "reconnect replay"));
    await waitUntil(() => connection.snapshot().cursor === 3, 2_500);

    expect(paths).toEqual([
      `/api/v1/sessions/${sessionId}/events/stream`,
      `/api/v1/sessions/${sessionId}/events/stream?after=2`
    ]);
    expect(fixture.handoff.openInputs.map((input) => input.after)).toEqual([
      null,
      2
    ]);
    expect(connection.snapshot()).toMatchObject({
      phase: "connected",
      cursor: 3,
      continuity: "contiguous",
      retryCount: 0,
      failure: null
    });

    connection.close("unmounted");
    await waitUntil(
      () => fixture.subscribers.snapshot().active_subscribers === 0
    );
    expect(fixture.handoff.activeSinkCount).toBe(0);
    expect(fixture.failures).toEqual([
      { code: "source_failed", cursor: null }
    ]);
  });

  it("denies unpaired Serve access and streams for an authenticated paired device", async () => {
    const port = await reservePort();
    const proxyOrigin = `http://127.0.0.1:${port}`;
    const fixture = createFixture([projectionEvent(1, "paired replay")]);
    const authority = createHostDeckRemoteIngressRequestAuthorityPolicy();
    const app = createHostDeckTailscaleServeFastifyApp({
      observeInternalError: () => undefined,
      requestAuthenticationPolicy: authenticationPolicy(),
      resourceBudget,
      routePlugins: [projectionRoute(fixture)],
      remoteIngressRequestAuthority: authority,
      tailscaleServeProxyTrustPolicy: createTailscaleServeProxyTrustPolicy({
        localOrigin: proxyOrigin,
        readRemoteAdmission: () =>
          authority.synchronize({
            admission: "open",
            external_origin: externalOrigin,
            generation: 23
          })
      })
    });
    apps.push(app);
    await app.listen({ host: "127.0.0.1", port });

    const unpaired = createBrowserSseClient({
      origin: externalOrigin,
      fetch: admittedServeStreamingFetch(proxyOrigin, null)
    }).connect({ sessionId, onEvent() {} });
    await waitUntil(() => unpaired.snapshot().phase === "failed");
    expect(
      unpaired.snapshot(),
      JSON.stringify(tailscaleServeProxyTrustSnapshot(app))
    ).toMatchObject({
      transport: "https",
      failure: {
        reason: "api_error",
        status: 401,
        apiError: { code: "permission_denied", retryable: false }
      }
    });
    expect(fixture.handoff.openInputs).toHaveLength(0);

    const pairedEvents: SelectedProjectionEvent[] = [];
    const paired = createBrowserSseClient({
      origin: externalOrigin,
      fetch: admittedServeStreamingFetch(proxyOrigin, deviceToken)
    }).connect({
      sessionId,
      onEvent(event) {
        pairedEvents.push(event);
      }
    });
    await waitUntil(() => paired.snapshot().cursor === 1);
    expect(pairedEvents.map((event) => event.cursor)).toEqual([1]);
    expect(fixture.handoff.openInputs[0]?.authorization).toMatchObject({
      state: "paired_device",
      device_id: deviceId
    });
    expect(JSON.stringify(paired.snapshot())).not.toContain(deviceToken);
    expect(tailscaleServeProxyTrustSnapshot(app)).toMatchObject({
      accepted_remote_requests: 2,
      accepted_local_requests: 0,
      stale_remote_context_rejections: 0
    });

    paired.close();
    await waitUntil(
      () => fixture.subscribers.snapshot().active_subscribers === 0
    );
    expect(fixture.handoff.activeSinkCount).toBe(0);
    expect(fixture.failures).toEqual([]);
  });
});

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
        "Integration session was not found."
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
        if (claimed) throw new Error("Integration replay was already claimed.");
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

function createFixture(events: readonly SelectedProjectionEvent[]) {
  const handoff = new MemoryHandoffService(events);
  const failures: unknown[] = [];
  const subscribers = createProjectionSubscriberStreamService({
    handoff: Object.freeze({ open: (candidate: unknown) => handoff.open(candidate) }),
    observe_failure(failure) {
      failures.push(failure);
    },
    resource_budget: resourceBudget
  });
  return { failures, handoff, subscribers };
}

function projectionRoute(fixture: ReturnType<typeof createFixture>) {
  return createHostDeckProjectionStreamRouteRegistration({
    observe_error: (failure) => fixture.failures.push(failure),
    subscribers: fixture.subscribers
  });
}

function authenticationPolicy() {
  return createHostDeckRequestAuthenticationPolicy({
    authenticateDeviceToken({ rawDeviceToken }) {
      if (rawDeviceToken !== deviceToken) {
        throw new Error("Private SSE authentication failure.");
      }
      return {
        trusted: true as const,
        readOnly: true,
        device: {
          id: deviceId,
          token_hash: `sha256:${"a".repeat(64)}`,
          csrf_token_hash: `sha256:${"b".repeat(64)}`,
          csrf_generation: 1,
          csrf_rotated_at: timestamp,
          client_label: "Browser SSE phone",
          permission: "read" as const,
          created_at: timestamp,
          last_used_at: timestamp,
          expires_at: null,
          revoked_at: null
        }
      };
    },
    now: () => new Date(timestamp)
  });
}

function nativeStreamingFetch(
  targetOrigin: string,
  paths: string[] = []
): BrowserSseFetchPort {
  return (path, init) => {
    paths.push(path);
    return streamingHttpFetch(targetOrigin, path, init, {});
  };
}

function admittedServeStreamingFetch(
  proxyOrigin: string,
  rawDeviceToken: string | null
): BrowserSseFetchPort {
  const authority = new URL(externalOrigin).host;
  return (path, init) => {
    const headers: Record<string, string> = {
      host: authority,
      "x-forwarded-for": "100.91.82.73",
      "x-forwarded-host": authority,
      "x-forwarded-proto": "https"
    };
    if (rawDeviceToken !== null) {
      headers.cookie = `${hostDeckDeviceCookieName}=${rawDeviceToken}`;
    }
    return streamingHttpFetch(proxyOrigin, path, init, headers);
  };
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
      {
        method: init.method,
        headers: { ...init.headers, ...extraHeaders }
      },
      (response) => {
        const status = response.statusCode;
        if (status === undefined) {
          response.destroy();
          reject(new Error("SSE fixture response has no status code."));
          return;
        }
        const headers = new Headers();
        for (let index = 0; index < response.rawHeaders.length; index += 2) {
          const name = response.rawHeaders[index];
          const value = response.rawHeaders[index + 1];
          if (name !== undefined && value !== undefined) {
            headers.append(name, value);
          }
        }
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
    const abort = () => request.destroy(new Error("SSE fixture aborted."));
    init.signal.addEventListener("abort", abort, { once: true });
    request.once("close", () =>
      init.signal.removeEventListener("abort", abort)
    );
    request.once("error", reject);
    request.end();
  });
}

function projectionEvent(cursor: number, text: string): SelectedProjectionEvent {
  return Object.freeze(
    selectedProjectionEventSchema.parse({
      captured_at: timestamp,
      codex_event_id: `browser-sse-event-${cursor}`,
      codex_event_type: "item/agentMessage/delta",
      content_notice: null,
      content_state: "complete",
      cursor,
      item_id: null,
      phase: "delta",
      role: "agent",
      session_id: sessionId,
      text,
      type: "message",
      upstream_at: null
    })
  );
}

function defaultBrowserSseLimits() {
  return {
    connectTimeoutMs: 35_000,
    idleTimeoutMs: 45_000,
    errorResponseMaxBytes: 65_536,
    eventMaxBytes: 65_536,
    reconnectInitialDelayMs: 500,
    reconnectMaxDelayMs: 10_000,
    maxReconnectAttempts: 8,
    maxConcurrentStreams: 2
  };
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 1_500,
  diagnostic: (() => string) | null = null
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) {
      throw new Error(
        `Condition timed out.${diagnostic === null ? "" : ` ${diagnostic()}`}`
      );
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
