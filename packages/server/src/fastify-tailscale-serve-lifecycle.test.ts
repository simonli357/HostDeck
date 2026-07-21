import { mkdtempSync, rmSync } from "node:fs";
import { request as createHttpRequest } from "node:http";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultResourceBudget,
  type RemoteIngressObservationSnapshot,
  type ResourceBudget,
  remoteEnableRequestSchema,
  remoteIngressObservationSnapshotSchema,
  resolveResourceBudget
} from "@hostdeck/contracts";
import { createOperationDeadline } from "@hostdeck/core";
import {
  createRemoteIngressAdmissionProofRepository,
  createRemoteIngressStateRepository,
  createSelectedAuditRepository,
  openMigratedDatabase
} from "@hostdeck/storage";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { HostDeckRoutePluginRegistration } from "./fastify-app.js";
import {
  type HostDeckFastifyRuntimeOwner,
  startHostDeckTailscaleServeFastifyLifecycle
} from "./fastify-host-lifecycle.js";
import {
  createHostDeckRequestAuthenticationPolicy,
  hostDeckDeviceCookieName,
  hostDeckRequestDeviceAuthoritySignal,
  requireHostDeckRequestAuthentication
} from "./fastify-request-authentication.js";
import {
  hostDeckLocalAdminRequestHeaderName,
  hostDeckLocalAdminRequestHeaderValue
} from "./fastify-request-trust.js";
import {
  createHostDeckSseTransportRegistration,
  type HostDeckSseSourceInput
} from "./fastify-sse-transport.js";
import { createHostDeckHostHealthService } from "./host-health.js";
import { createRemoteIngressControlService } from "./remote-ingress-control-service.js";
import {
  createHostDeckRemoteIngressLifecycle,
  type HostDeckRemoteIngressLifecycle
} from "./remote-ingress-lifecycle.js";
import { createHostDeckRemoteIngressRouteRegistration } from "./remote-ingress-routes.js";
import { createSecurityMutationAuditExecutor } from "./security-mutation-audit-executor.js";
import type { TailscaleObserver } from "./tailscale-observer.js";
import type {
  TailscaleServeManager,
  TailscaleServeManagerResult,
  TailscaleServeMutationInput
} from "./tailscale-serve-manager.js";

const roots: string[] = [];
const openDatabases: ReturnType<typeof openMigratedDatabase>["db"][] = [];
const origin = "https://hostdeck-lifecycle.fixture-tailnet.ts.net";
const profileKey = `sha256:${"1".repeat(64)}`;
const otherProfileKey = `sha256:${"2".repeat(64)}`;
const observedAt = "2026-07-16T08:00:00.000Z";
const baseWallTime = Date.parse("2026-07-16T09:00:00.000Z");
const rawDeviceToken = "D".repeat(43);
const remoteSource = "100.96.84.72";

afterEach(() => {
  for (const db of openDatabases.splice(0).reverse()) {
    if (db.open) db.close();
  }
  for (const root of roots.splice(0).reverse()) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("selected Tailscale Serve Fastify lifecycle", () => {
  it("binds and returns local ready before a delayed first remote observation", async () => {
    const harness = await createHarness();
    const observationStarted = createDeferred<void>();
    let listenerReachable = false;
    harness.setConfiguredHandler(async () => {
      listenerReachable = await canConnect(harness.port);
      observationStarted.resolve();
      return abortOnSignal(harness.rootSignal);
    });

    const service = await startHostDeckTailscaleServeFastifyLifecycle({
      ...harness.lifecycleInput,
      createRoutePlugins: () => [pingRegistration()],
      selectRemoteIngressLifecycle: (context) => context.remote
    });
    await observationStarted.promise;

    expect(listenerReachable).toBe(true);
    expect(service.snapshot()).toMatchObject({
      listening: true,
      phase: "ready"
    });
    expect(harness.remote.snapshot()).toMatchObject({
      active_control_operations: 1,
      phase: "running",
      poll_cycles: 1
    });
    expect(harness.remote.readAdmission()).toMatchObject({
      admission: "closed",
      generation: 2
    });
    expect(harness.health.remoteSnapshot()).toMatchObject({
      availability: "unknown",
      reason: "not_observed"
    });

    const response = await fetch(new URL("/ping", service.baseUrl));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });

    await service.close();
    expect(harness.events).toEqual([
      "remote_abort",
      "runtime_drain",
      "sse_close",
      "runtime_close",
      "remote_settled",
      "storage_close"
    ]);
    expect(harness.managerMutations).toBe(0);
    expect(harness.remote.snapshot()).toMatchObject({
      active_control_operations: 0,
      guard_armed: false,
      phase: "closed"
    });
  });

  it("cancels active remote HTTP and SSE on profile generation change without canceling local work", async () => {
    const harness = await createHarness();
    const localStarted = createDeferred<void>();
    const releaseLocal = createDeferred<void>();
    const remoteStarted = createDeferred<void>();
    const sseStarted = createDeferred<void>();
    let localSignal: AbortSignal | null = null;
    let remoteSignal: AbortSignal | null = null;
    let sseSignal: AbortSignal | null = null;
    const routes = [
      ...lifecycleRoutes({
        localStarted,
        releaseLocal,
        remoteStarted,
        sseStarted,
        setLocalSignal: (signal) => {
          localSignal = signal;
        },
        setRemoteSignal: (signal) => {
          remoteSignal = signal;
        },
        setSseSignal: (signal) => {
          sseSignal = signal;
        }
      }),
      createHostDeckRemoteIngressRouteRegistration({
        service: harness.remote.control
      })
    ];
    const service = await startHostDeckTailscaleServeFastifyLifecycle({
      ...harness.lifecycleInput,
      createRoutePlugins: () => routes,
      selectRemoteIngressLifecycle: (context) => context.remote
    });
    await eventually(() => {
      expect(harness.remote.readAdmission()).toMatchObject({
        admission: "open",
        generation: 2
      });
    });
    const localRemoteStatus = await service.app.inject({
      headers: {
        host: `127.0.0.1:${harness.port}`,
        [hostDeckLocalAdminRequestHeaderName]:
          hostDeckLocalAdminRequestHeaderValue
      },
      method: "GET",
      url: "/api/v1/remote/status"
    });
    expect(localRemoteStatus.statusCode, localRemoteStatus.body).toBe(200);
    expect(localRemoteStatus.json()).toMatchObject({
      availability: "ready",
      generation: 2
    });

    const localResponse = service.app.inject({
      headers: { host: `127.0.0.1:${harness.port}` },
      method: "GET",
      url: "/local-hold"
    });
    const remoteResponse = service.app.inject({
      headers: remoteHeaders({ cookie: rawDeviceToken }),
      method: "GET",
      url: "/remote-hold"
    });
    const sseResponse = service.app.inject({
      headers: {
        ...remoteHeaders({ cookie: rawDeviceToken }),
        accept: "text/event-stream"
      },
      method: "GET",
      url: "/events"
    });
    await Promise.all([
      withTimeout(localStarted.promise, "Local request did not start."),
      withTimeout(remoteStarted.promise, "Remote HTTP request did not start."),
      withTimeout(sseStarted.promise, "Remote SSE request did not start.")
    ]);
    expect(harness.remote.requestAuthority.snapshot()).toMatchObject({
      active_leases: 2,
      phase: "open"
    });

    harness.queueConfigured(snapshot({ profile: "other", serve: null }));
    await expect(harness.remote.control.readStatus()).resolves.toMatchObject({
      availability: "unavailable",
      generation: 3,
      reason: "profile_other"
    });
    await eventually(() => {
      expect((remoteSignal as unknown as AbortSignal).aborted).toBe(true);
      expect((sseSignal as unknown as AbortSignal).aborted).toBe(true);
    });
    expect((localSignal as unknown as AbortSignal).aborted).toBe(false);
    expect(harness.health.remoteSnapshot()).toMatchObject({
      availability: "unavailable",
      state_generation: 3
    });

    const remoteResult = await withTimeout(
      remoteResponse,
      "Remote HTTP request did not settle."
    );
    const sseResult = await withTimeout(
      sseResponse,
      "Remote SSE request did not settle."
    );
    expect(remoteResult.statusCode, remoteResult.body).toBe(403);
    expect(remoteResult.json()).toMatchObject({
      error: { code: "invalid_origin" }
    });
    expect(sseResult.statusCode).toBe(200);
    expect(harness.remote.requestAuthority.snapshot()).toMatchObject({
      active_leases: 0,
      signaled_leases: 2
    });

    releaseLocal.resolve();
    const localResult = await withTimeout(
      localResponse,
      "Local request did not settle."
    );
    expect(localResult.statusCode, localResult.body).toBe(200);
    expect(localResult.json()).toEqual({ ok: true });
    expect(harness.codexCancellations).toBe(0);
    expect(harness.managerMutations).toBe(0);

    harness.queueConfigured(snapshot({ serve: "exact" }));
    await expect(harness.remote.control.readStatus()).resolves.toMatchObject({
      availability: "ready",
      generation: 4
    });
    const recovered = await service.app.inject({
      headers: remoteHeaders({ cookie: rawDeviceToken }),
      method: "GET",
      url: "/protected"
    });
    expect(recovered.statusCode, recovered.body).toBe(200);
    expect(recovered.json()).toEqual({ ok: true });

    const healthBeforeDisconnect = harness.health.remoteSnapshot();
    const previousRemoteSignal = remoteSignal;
    const disconnectedRequest = createHttpRequest(
      new URL("/remote-hold", service.baseUrl),
      { headers: remoteHeaders({ cookie: rawDeviceToken }) },
      (response) => response.destroy()
    );
    disconnectedRequest.on("error", () => undefined);
    disconnectedRequest.end();
    await eventually(() => {
      expect(remoteSignal).not.toBe(previousRemoteSignal);
      expect(harness.remote.requestAuthority.snapshot().active_leases).toBe(1);
    });
    disconnectedRequest.destroy();
    await eventually(() => {
      expect((remoteSignal as unknown as AbortSignal).aborted).toBe(true);
      expect(harness.remote.requestAuthority.snapshot().active_leases).toBe(0);
    });
    expect(harness.health.remoteSnapshot()).toBe(healthBeforeDisconnect);

    await service.close();
    expect(harness.events.indexOf("remote_abort")).toBeLessThan(
      harness.events.indexOf("runtime_drain")
    );
    expect(harness.events.indexOf("remote_settled")).toBeLessThan(
      harness.events.indexOf("storage_close")
    );
  });

  it("installs remote cleanup ownership before selected-bind validation fails", async () => {
    const harness = await createHarness({ bindHost: "::1" });
    await expect(
      startHostDeckTailscaleServeFastifyLifecycle({
        ...harness.lifecycleInput,
        createRoutePlugins: () => [pingRegistration()],
        selectRemoteIngressLifecycle: (context) => context.remote
      })
    ).rejects.toMatchObject({
      code: "runtime_contract_invalid",
      stage: "runtime_contract"
    });

    expect(harness.rootSignal.aborted).toBe(true);
    expect(harness.events).toEqual([
      "remote_abort",
      "runtime_drain",
      "sse_close",
      "runtime_close",
      "remote_settled",
      "storage_close"
    ]);
    expect(harness.remote.snapshot()).toMatchObject({
      active_control_operations: 0,
      phase: "closed",
      poll_cycles: 0
    });
    expect(harness.managerMutations).toBe(0);
  });

  it("bounds a noncooperative observer and still closes listener and storage", async () => {
    const harness = await createHarness({
      resourceBudget: resolveResourceBudget({
        lifecycle_cleanup_step_timeout_ms: 50
      })
    });
    harness.setConfiguredHandler(
      () => new Promise<RemoteIngressObservationSnapshot>(() => undefined)
    );
    const service = await startHostDeckTailscaleServeFastifyLifecycle({
      ...harness.lifecycleInput,
      createRoutePlugins: () => [pingRegistration()],
      selectRemoteIngressLifecycle: (context) => context.remote
    });
    await eventually(() => {
      expect(harness.remote.snapshot().active_control_operations).toBe(1);
    });

    await expect(service.close()).rejects.toMatchObject({
      code: "shutdown_failed",
      stage: "shutdown"
    });
    expect(service.snapshot()).toMatchObject({
      listening: false,
      phase: "failed"
    });
    expect(harness.rootSignal.aborted).toBe(true);
    expect(harness.events).toContain("storage_close");
    expect(harness.events.indexOf("remote_abort")).toBeLessThan(
      harness.events.indexOf("runtime_drain")
    );
    expect(harness.events.indexOf("remote_settled")).toBeLessThan(
      harness.events.indexOf("storage_close")
    );
    expect(harness.remote.snapshot().phase).toBe("failed");
    expect(harness.managerMutations).toBe(0);
  });
});

interface RuntimeContext {
  readonly remote: HostDeckRemoteIngressLifecycle;
}

interface Harness {
  readonly codexCancellations: number;
  readonly events: string[];
  readonly health: ReturnType<typeof createHostDeckHostHealthService>;
  readonly lifecycleInput: Omit<
    Parameters<typeof startHostDeckTailscaleServeFastifyLifecycle<RuntimeContext>>[0],
    "createRoutePlugins" | "selectRemoteIngressLifecycle"
  >;
  readonly managerMutations: number;
  readonly port: number;
  readonly queueConfigured: (...values: RemoteIngressObservationSnapshot[]) => void;
  readonly remote: HostDeckRemoteIngressLifecycle;
  readonly rootSignal: AbortSignal;
  readonly setConfiguredHandler: (
    handler: () => Promise<RemoteIngressObservationSnapshot>
  ) => void;
}

async function createHarness(
  options: {
    readonly bindHost?: "127.0.0.1" | "::1";
    readonly resourceBudget?: ResourceBudget;
  } = {}
): Promise<Harness> {
  const port = await reservePort();
  const localOrigin = `http://127.0.0.1:${port}`;
  const root = mkdtempSync(join(tmpdir(), "hostdeck-fastify-remote-lifecycle-"));
  roots.push(root);
  const opened = openMigratedDatabase(join(root, "hostdeck.sqlite"), {
    now: () => new Date(baseWallTime)
  });
  openDatabases.push(opened.db);
  const states = createRemoteIngressStateRepository(opened.db);
  const proofs = createRemoteIngressAdmissionProofRepository(opened.db);
  const audit = createSelectedAuditRepository(opened.db);
  const configuredQueue: RemoteIngressObservationSnapshot[] = [];
  const events: string[] = [];
  let configuredHandler: (() => Promise<RemoteIngressObservationSnapshot>) | null = null;
  let wallTime = baseWallTime;
  let auditId = 0;
  let managerMutations = 0;
  const codexCancellations = 0;
  let rootSignal: AbortSignal | null = null;
  const nextDate = () => {
    wallTime += 1_000;
    return new Date(wallTime);
  };
  const executor = createSecurityMutationAuditExecutor({
    repository: audit,
    now: () => nextDate().toISOString(),
    create_record_id: () => `audit:fastify-remote-lifecycle:${++auditId}`
  });

  const bootstrapController = new AbortController();
  const bootstrap = createRemoteIngressControlService({
    admissionProofs: proofs,
    audit: executor,
    localOrigin,
    manager: manager(bootstrapController.signal, () => {
      managerMutations += 1;
    }),
    monotonicNow: () => performance.now(),
    now: nextDate,
    observer: observer(bootstrapController.signal, configuredQueue, () => configuredHandler),
    states
  });
  await bootstrap.enable(
    remoteEnableRequestSchema.parse({
      confirmed: true,
      operation_id: "op_fastify_remote_lifecycle_bootstrap_001"
    })
  );
  bootstrapController.abort();
  managerMutations = 0;

  const health = createHostDeckHostHealthService({ now: nextDate });
  const remote = createHostDeckRemoteIngressLifecycle({
    createControl(input) {
      rootSignal = input.signal;
      input.signal.addEventListener(
        "abort",
        () => events.push("remote_abort"),
        { once: true }
      );
      return createRemoteIngressControlService({
        admissionProofs: proofs,
        audit: executor,
        localOrigin,
        manager: manager(input.signal, () => {
          managerMutations += 1;
        }),
        monotonicNow: input.monotonicNow,
        now: nextDate,
        observer: observer(input.signal, configuredQueue, () => configuredHandler),
        states
      });
    },
    health
  });
  if (rootSignal === null) throw new Error("Remote lifecycle signal was not created.");

  const runtime: HostDeckFastifyRuntimeOwner<RuntimeContext> = {
    beginDrain() {
      if (options.bindHost === "::1") remote.beginDrain();
      events.push("runtime_drain");
    },
    async closeRuntime() {
      if (options.bindHost === "::1") {
        await remote.close(createOperationDeadline({ timeoutMs: 1_000 }));
      }
      events.push("runtime_close");
    },
    async closeSse() {
      events.push("sse_close");
    },
    async closeStartup() {
      events.push("remote_settled");
      events.push("storage_close");
      if (opened.db.open) opened.db.close();
    },
    start() {
      if (options.bindHost === "::1") {
        return Object.freeze({
          bind: Object.freeze({ host: "::1", port, transport: "http" as const }),
          context: Object.freeze({ remote })
        }) as never;
      }
      return Object.freeze({
        bind: Object.freeze({
          host: "127.0.0.1" as const,
          port,
          transport: "http" as const
        }),
        context: Object.freeze({ remote })
      });
    }
  };
  const lifecycleInput = {
    createRequestAuthenticationPolicy: () =>
      createHostDeckRequestAuthenticationPolicy({
        authenticateDeviceToken({ rawDeviceToken: candidate }) {
          if (candidate !== rawDeviceToken) throw new Error("Unknown device.");
          return authenticatedDevice();
        },
        now: nextDate
      }),
    observeInternalError: () => undefined,
    resourceBudget: options.resourceBudget ?? defaultResourceBudget,
    runtime
  } as const;

  return {
    get codexCancellations() {
      return codexCancellations;
    },
    events,
    health,
    lifecycleInput,
    get managerMutations() {
      return managerMutations;
    },
    port,
    queueConfigured(...values) {
      configuredQueue.push(...values);
    },
    remote,
    rootSignal,
    setConfiguredHandler(handler) {
      configuredHandler = handler;
    }
  };
}

function lifecycleRoutes(input: {
  readonly localStarted: ReturnType<typeof createDeferred<void>>;
  readonly releaseLocal: ReturnType<typeof createDeferred<void>>;
  readonly remoteStarted: ReturnType<typeof createDeferred<void>>;
  readonly setLocalSignal: (signal: AbortSignal) => void;
  readonly setRemoteSignal: (signal: AbortSignal) => void;
  readonly setSseSignal: (signal: AbortSignal) => void;
  readonly sseStarted: ReturnType<typeof createDeferred<void>>;
}): readonly HostDeckRoutePluginRegistration[] {
  const api: HostDeckRoutePluginRegistration = {
    id: "remote-lifecycle-http-fixture",
    surface: "api",
    register(app) {
      app.get(
        "/local-hold",
        { schema: { response: { 200: z.object({ ok: z.literal(true) }) } } },
        async (request) => {
          input.setLocalSignal(hostDeckRequestDeviceAuthoritySignal(request));
          input.localStarted.resolve();
          await input.releaseLocal.promise;
          return { ok: true as const };
        }
      );
      app.get(
        "/remote-hold",
        {
          async preHandler(request) {
            requireHostDeckRequestAuthentication(request, "device_cookie");
          },
          schema: { response: { 200: z.object({ ok: z.literal(true) }) } }
        },
        async (request) => {
          const signal = hostDeckRequestDeviceAuthoritySignal(request);
          input.setRemoteSignal(signal);
          input.remoteStarted.resolve();
          await waitForAbort(signal);
          return { ok: true as const };
        }
      );
      app.get(
        "/protected",
        {
          async preHandler(request) {
            requireHostDeckRequestAuthentication(request, "device_cookie");
          },
          schema: { response: { 200: z.object({ ok: z.literal(true) }) } }
        },
        async () => ({ ok: true as const })
      );
    }
  };
  const sse = createHostDeckSseTransportRegistration({
    id: "remote-lifecycle-sse-fixture",
    observeError: () => undefined,
    path: "/events",
    source: {
      open(source: HostDeckSseSourceInput) {
        requireHostDeckRequestAuthentication(source.request, "device_cookie");
        input.setSseSignal(source.signal);
        input.sseStarted.resolve();
        return emptyUntilAbort(source.signal);
      }
    }
  });
  return Object.freeze([api, sse]);
}

function pingRegistration(): HostDeckRoutePluginRegistration {
  return {
    id: "remote-lifecycle-ping-fixture",
    surface: "api",
    register(app) {
      app.get(
        "/ping",
        { schema: { response: { 200: z.object({ ok: z.literal(true) }) } } },
        async () => ({ ok: true as const })
      );
    }
  };
}

function observer(
  signal: AbortSignal,
  configuredQueue: RemoteIngressObservationSnapshot[],
  readConfiguredHandler: () =>
    | (() => Promise<RemoteIngressObservationSnapshot>)
    | null
): TailscaleObserver {
  return Object.freeze({
    poll_interval_ms: 5_000,
    async observeCandidate() {
      if (signal.aborted) throw signal.reason;
      return snapshot({ serve: "absent" });
    },
    async observeConfigured() {
      if (signal.aborted) throw signal.reason;
      const handler = readConfiguredHandler();
      if (handler !== null) return handler();
      return configuredQueue.shift() ?? snapshot({ serve: "exact" });
    }
  });
}

function manager(
  signal: AbortSignal,
  recordMutation: () => void
): TailscaleServeManager {
  return Object.freeze({
    async disable() {
      if (signal.aborted) throw signal.reason;
      recordMutation();
      return disableSuccess();
    },
    async enable(input: TailscaleServeMutationInput) {
      if (signal.aborted) throw signal.reason;
      recordMutation();
      return enableSuccess(input.expected_profile_key);
    },
    snapshot() {
      return Object.freeze({
        active: false,
        busy_rejections: 0,
        command_attempts: 0,
        failed_operations: 0,
        incomplete_operations: 0,
        rejected_operations: 0,
        started_operations: 0,
        succeeded_operations: 0
      });
    }
  });
}

function enableSuccess(selectedProfileKey: string): TailscaleServeManagerResult {
  return Object.freeze({
    action: "enable",
    outcome: "succeeded",
    serve_result: "applied",
    reason: null,
    command_attempted: true,
    before: snapshot({ selectedProfileKey, serve: "absent" }),
    after: snapshot({ selectedProfileKey, serve: "exact" })
  });
}

function disableSuccess(): TailscaleServeManagerResult {
  return Object.freeze({
    action: "disable",
    outcome: "succeeded",
    serve_result: "removed",
    reason: null,
    command_attempted: true,
    before: snapshot({ serve: "exact" }),
    after: snapshot({ serve: "absent" })
  });
}

function snapshot(input: {
  readonly profile?: "dedicated" | "other";
  readonly selectedProfileKey?: string;
  readonly serve: RemoteIngressObservationSnapshot["serve"];
}): RemoteIngressObservationSnapshot {
  const other = input.profile === "other";
  const selectedProfileKey = input.selectedProfileKey ?? profileKey;
  return remoteIngressObservationSnapshotSchema.parse({
    schema_version: 1,
    client: "available",
    profile: {
      state: other ? "other" : "dedicated",
      comparison: {
        relation: other ? "different" : "match",
        expected_profile_key: selectedProfileKey,
        active_profile_key: other ? otherProfileKey : selectedProfileKey
      }
    },
    serve: other ? null : input.serve,
    external_origin: other ? null : origin,
    failure: null,
    observed_at: observedAt
  });
}

function authenticatedDevice() {
  return {
    trusted: true as const,
    readOnly: false,
    device: {
      id: "client_remote_lifecycle_phone",
      token_hash: `sha256:${"a".repeat(64)}`,
      csrf_token_hash: `sha256:${"b".repeat(64)}`,
      csrf_generation: 1,
      csrf_rotated_at: observedAt,
      client_label: "Remote phone",
      permission: "write" as const,
      created_at: observedAt,
      last_used_at: observedAt,
      expires_at: null,
      revoked_at: null
    }
  };
}

function remoteHeaders(options: { readonly cookie?: string } = {}): Record<string, string> {
  const host = new URL(origin).host;
  return {
    host,
    "x-forwarded-for": remoteSource,
    "x-forwarded-host": host,
    "x-forwarded-proto": "https",
    ...(options.cookie === undefined
      ? {}
      : { cookie: `${hostDeckDeviceCookieName}=${options.cookie}` })
  };
}

function emptyUntilAbort(signal: AbortSignal): AsyncIterable<never> {
  return {
    [Symbol.asyncIterator]() {
      let finished = false;
      return {
        async next() {
          if (!finished) {
            finished = true;
            await waitForAbort(signal);
          }
          return { done: true as const, value: undefined as never };
        }
      };
    }
  };
}

async function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function abortOnSignal(signal: AbortSignal): Promise<RemoteIngressObservationSnapshot> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true
    });
  });
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Port reservation did not return a TCP address.");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  return address.port;
}

async function canConnect(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

function createDeferred<Value>(): {
  readonly promise: Promise<Value>;
  readonly resolve: (value?: Value | PromiseLike<Value>) => void;
} {
  let resolve!: (value?: Value | PromiseLike<Value>) => void;
  const promise = new Promise<Value>((fulfill) => {
    resolve = fulfill as (value?: Value | PromiseLike<Value>) => void;
  });
  return { promise, resolve };
}

async function eventually(assertion: () => void): Promise<void> {
  let failure: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      failure = error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw failure;
}

async function withTimeout<Value>(
  promise: Promise<Value>,
  message: string
): Promise<Value> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), 1_000);
      })
    ]);
  } finally {
    if (timeout !== null) clearTimeout(timeout);
  }
}
