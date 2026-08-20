import {
  encodeSelectedSessionListCursor,
  formatSelectedResumeLaunchCommand,
  goalControlSnapshotSchema,
  isoTimestampSchema,
  managedSessionProjectionSchema,
  modelControlSnapshotSchema,
  promptDispatchResponseSchema,
  remoteIngressPublicStateSchema,
  type SelectedAccessStateResponse,
  type SelectedHostAccessMode,
  type SelectedHostLocalHealthCause,
  type SelectedHostLocalHealthComponent,
  type SelectedHostLocalHealthState,
  type SelectedHostStatusResponse,
  type SelectedProjectionEvent,
  type SelectedSessionReadAccess,
  type SelectedSessionReadItem,
  type SessionCatalogEvent,
  type SharedSessionCatalogEntry,
  selectedAccessStateResponseSchema,
  selectedHostLocalHealthComponents,
  selectedHostStatusResponseSchema,
  selectedProjectionEventSchema,
  selectedResumeMetadataResponseSchema,
  selectedSessionDetailResponseSchema,
  selectedSessionListResponseSchema,
  selectedSessionListSortKey,
  selectedSessionReadItemSchema,
  sessionCatalogEventSchema,
  sharedSessionCatalogEntrySchema
} from "@hostdeck/contracts";
import {
  type BrowserSseClientLimits,
  defaultBrowserSseClientLimits
} from "@hostdeck/contracts/browser-sse-resource-policy";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  type BrowserConnectionClockPort,
  type BrowserConnectionGenericProtectedRouteId,
  type BrowserConnectionStateCoordinator,
  createBrowserConnectionStateCoordinator,
  HostDeckBrowserConnectionError
} from "./connection-state.js";
import { createBrowserCsrfClient } from "./csrf-client.js";
import {
  type BrowserHttpClient,
  type BrowserHttpFetchPort,
  type BrowserHttpRequestInit,
  type BrowserHttpResponsePort,
  createBrowserHttpClient
} from "./http-client.js";
import {
  type BrowserSseBodyReaderPort,
  type BrowserSseClockPort,
  type BrowserSseRequestInit,
  type BrowserSseResponsePort,
  createBrowserSseClient
} from "./sse-client.js";

const loopbackOrigin = "http://127.0.0.1:3777";
const remoteOrigin = "https://hostdeck-connection.fixture-tailnet.ts.net";
const otherRemoteOrigin = "https://hostdeck-other.fixture-tailnet.ts.net";
const timestamp = "2026-07-22T18:00:00.000Z";
const resumeThreadId = "019fc8bd-25ef-74c3-a3bf-c6e59e4122a4";
const compatibilityTimestamp = isoTimestampSchema.parse(timestamp);
const laterTimestamp = "2026-07-22T18:01:00.000Z";
const rawCsrfToken = "C".repeat(43);
const firstSessionId = "sess_connection_001";
const secondSessionId = "sess_connection_002";
const catalogStreamA = "catalog_connection_stream_a";
const catalogStreamB = "catalog_connection_stream_b";

describe("browser shell connection-state coordinator", () => {
  it("accepts only exact same-authority client composition and starts inert", () => {
    const harness = createHarness(remoteOrigin);
    const initial = harness.coordinator.snapshot();

    expect(initial).toMatchObject({
      epoch: 0,
      target: null,
      phase: "idle",
      access: { state: "idle", data: null, failure: null },
      host: { state: "idle", data: null, failure: null },
      targetState: { state: "idle", data: null, failure: null },
      stream: { state: "not_applicable" },
      csrf: { phase: "idle", invalidationReason: "not_bootstrapped" },
      writeEligibility: {
        eligible: false,
        causes: ["connection_not_current"]
      }
    });
    expect(Object.isFrozen(harness.coordinator)).toBe(true);
    expect(Object.isFrozen(initial)).toBe(true);
    expect(harness.http.requests).toHaveLength(0);
    expect(harness.sse.requests).toHaveLength(0);

    expect(() =>
      createBrowserConnectionStateCoordinator({
        httpClient: Object.freeze({ request() {} }) as never,
        sseClient: harness.sseClient,
        csrfClient: harness.csrfClient,
        origin: remoteOrigin
      })
    ).toThrow(TypeError);

    const otherSse = createBrowserSseClient({
      origin: otherRemoteOrigin,
      fetch: async () => sseResponse(new ControlledReader())
    });
    expect(() =>
      createBrowserConnectionStateCoordinator({
        httpClient: harness.httpClient,
        sseClient: otherSse,
        csrfClient: harness.csrfClient,
        origin: remoteOrigin
      })
    ).toThrow("share one exact authority");

    const otherHttp = createBrowserHttpClient({
      origin: remoteOrigin,
      fetch: async () => jsonResponse(500, apiError("runtime_unavailable", true))
    });
    const otherCsrf = createBrowserCsrfClient({
      httpClient: otherHttp,
      createOperationId: () => "op_connection_other_csrf"
    });
    expect(() =>
      createBrowserConnectionStateCoordinator({
        httpClient: harness.httpClient,
        sseClient: harness.sseClient,
        csrfClient: otherCsrf,
        origin: remoteOrigin
      })
    ).toThrow("share one exact authority");

    let getterCalls = 0;
    const hostile = Object.defineProperty({}, "httpClient", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return harness.httpClient;
      }
    });
    expect(() => createBrowserConnectionStateCoordinator(hostile as never)).toThrow(
      TypeError
    );
    expect(getterCalls).toBe(0);
    expect(() =>
      createBrowserConnectionStateCoordinator({
        httpClient: harness.httpClient,
        sseClient: harness.sseClient,
        csrfClient: harness.csrfClient,
        origin: remoteOrigin,
        extra: true
      } as never)
    ).toThrow(TypeError);
    const inherited = Object.create({ inherited: true }) as Record<string, unknown>;
    Object.assign(inherited, {
      httpClient: harness.httpClient,
      sseClient: harness.sseClient,
      csrfClient: harness.csrfClient,
      origin: remoteOrigin
    });
    expect(() => createBrowserConnectionStateCoordinator(inherited as never)).toThrow(
      TypeError
    );

    harness.coordinator.close();
    otherSse.close();
    otherCsrf.close();
  });

  it("publishes and freezes one terminal close while cancelling owned work", async () => {
    const access = deferred<BrowserHttpResponsePort>();
    const harness = createHarness(remoteOrigin);
    harness.http.enqueue("access", async () => await access.promise);
    let notifications = 0;
    const unsubscribe = harness.coordinator.subscribe(() => {
      notifications += 1;
    });

    const pending = harness.coordinator.setTarget({
      kind: "session_detail",
      sessionId: firstSessionId
    });
    await waitFor(() => harness.http.requests.length === 1);
    const signal = harness.http.requests[0]?.init.signal;
    const closed = harness.coordinator.close();

    expect(closed).toMatchObject({
      phase: "closed",
      target: null,
      stream: { state: "closed" },
      csrf: { phase: "closed" }
    });
    expect(signal?.aborted).toBe(true);
    expect(notifications).toBe(2);
    expect(harness.coordinator.close()).toBe(closed);
    unsubscribe();
    unsubscribe();
    expect(() => harness.coordinator.subscribe(() => {})).toThrow(
      HostDeckBrowserConnectionError
    );

    access.resolve(jsonResponse(200, pairedAccess(remoteOrigin, "write")));
    await expect(pending).resolves.toBe(closed);
    expect(harness.coordinator.snapshot()).toBe(closed);
  });

  it("keeps no-op snapshots stable and publishes deeply frozen route data", async () => {
    const harness = createHarness(loopbackOrigin);
    enqueueLoopbackMission(harness, [sessionItem(firstSessionId)]);
    let notifications = 0;
    const unsubscribe = harness.coordinator.subscribe(() => {
      notifications += 1;
    });
    const ready = await harness.coordinator.setTarget({ kind: "mission_control" });
    const settledNotifications = notifications;

    expect(await harness.coordinator.setTarget({ kind: "mission_control" })).toBe(ready);
    expect(harness.coordinator.disconnectSessionStream()).toBe(ready);
    expect(notifications).toBe(settledNotifications);
    expect(Object.isFrozen(ready.access.data)).toBe(true);
    expect(Object.isFrozen(ready.host.data?.local.components)).toBe(true);
    expect(Object.isFrozen(ready.targetState.data)).toBe(true);
    expect(
      ready.targetState.data?.kind === "mission_control" &&
        Object.isFrozen(ready.targetState.data.sessions)
    ).toBe(true);
    expect(Object.isFrozen(ready.writeEligibility.causes)).toBe(true);

    unsubscribe();
    harness.coordinator.close();
  });

  it("reads remote access first and discloses nothing else to an unpaired browser", async () => {
    const harness = createHarness(remoteOrigin);
    harness.http.enqueue(
      "access",
      jsonResponse(200, deniedAccess(remoteOrigin, "unpaired"))
    );

    const snapshot = await harness.coordinator.setTarget({ kind: "mission_control" });

    expect(harness.http.routeIds()).toEqual(["access"]);
    expect(snapshot).toMatchObject({
      phase: "access_limited",
      access: {
        state: "current",
        data: { authentication_state: "unpaired", can_read_sessions: false }
      },
      host: { state: "blocked", data: null },
      targetState: { state: "blocked", data: null },
      writeEligibility: { eligible: false, causes: ["unpaired"] }
    });
    expect(snapshot.csrf).toMatchObject({
      phase: "idle",
      invalidationReason: "not_bootstrapped"
    });
    expect(JSON.stringify(snapshot)).not.toContain(rawCsrfToken);
    expect(harness.sse.requests).toHaveLength(0);
    harness.coordinator.close();
  });

  it("maps a safe loopback browser to read-only access without inventing remote failure", async () => {
    const harness = createHarness(loopbackOrigin);
    harness.http.enqueue("access", jsonResponse(200, loopbackAccess()));
    harness.http.enqueue(
      "host",
      jsonResponse(200, hostStatus({ mode: "loopback_read", origin: loopbackOrigin }))
    );
    harness.http.enqueue(
      "list",
      jsonResponse(200, sessionList("loopback_read", loopbackOrigin, []))
    );

    const snapshot = await harness.coordinator.setTarget({ kind: "mission_control" });

    expect(harness.http.routeIds()).toEqual(["access", "host", "list"]);
    expect(snapshot).toMatchObject({
      phase: "ready",
      access: { data: { authentication_state: "unpaired" } },
      host: {
        data: {
          remote: { availability: "unknown" },
          access: { mode: "loopback_read" }
        }
      },
      targetState: {
        data: { kind: "mission_control", access: { mode: "loopback_read" } }
      },
      writeEligibility: {
        eligible: false,
        causes: ["read_only_access"]
      }
    });
    expect(harness.http.routeIds()).not.toContain("csrf");
    harness.coordinator.close();
  });

  it("owns one exact paired remote-status read outside session write admission", async () => {
    const harness = createHarness(remoteOrigin);
    harness.http.enqueue("access", jsonResponse(200, pairedAccess(remoteOrigin, "read")));
    harness.http.enqueue(
      "host",
      jsonResponse(200, hostStatus({ mode: "paired_read", origin: remoteOrigin, remoteGeneration: 7 }))
    );
    harness.http.enqueue(
      "list",
      jsonResponse(200, sessionList("paired_read", remoteOrigin, []))
    );
    await harness.coordinator.setTarget({ kind: "mission_control" });
    harness.http.enqueue("remote", jsonResponse(200, remoteStatus(7)));

    const response = await harness.coordinator.requestRemoteStatus();

    expect(response).toEqual({ status: 200, data: remoteStatus(7) });
    expect(harness.coordinator.snapshot().writeEligibility).toMatchObject({
      eligible: false,
      causes: ["read_only_access"]
    });
    expect(harness.http.routeIds().at(-1)).toBe("remote");
    const request = harness.http.requests.at(-1);
    expect(request).toMatchObject({
      path: "/api/v1/remote/status",
      init: {
        method: "GET",
        cache: "no-store",
        credentials: "same-origin",
        mode: "same-origin",
        redirect: "error",
        referrerPolicy: "no-referrer"
      }
    });
    expect(Object.hasOwn(request?.init ?? {}, "body")).toBe(false);
    expect(Object.keys(request?.init.headers ?? {})).not.toContain("x-hostdeck-csrf-token");
    expect(Object.keys(request?.init.headers ?? {})).not.toContain("x-hostdeck-local-admin");
    harness.coordinator.close();
  });

  it("rejects unavailable and forged remote control paths before HTTP dispatch", async () => {
    expectTypeOf<
      Extract<
        BrowserConnectionGenericProtectedRouteId,
        "remote_status" | "remote_enable" | "remote_disable"
      >
    >().toEqualTypeOf<never>();

    const local = createHarness(loopbackOrigin);
    enqueueLoopbackMission(local, []);
    await local.coordinator.setTarget({ kind: "mission_control" });
    const requestCount = local.http.requests.length;

    await expect(local.coordinator.requestRemoteStatus()).rejects.toMatchObject({
      reason: "not_ready"
    });
    for (const routeId of ["remote_status", "remote_enable", "remote_disable"] as const) {
      await expect(
        local.coordinator.requestProtected(routeId as never, {} as never)
      ).rejects.toMatchObject({ reason: "client_contract" });
    }
    expect(local.http.requests).toHaveLength(requestCount);
    local.coordinator.close();

    const remote = createHarness(remoteOrigin);
    enqueueRemoteWriterMission(remote, [], 7, 1);
    await remote.coordinator.setTarget({ kind: "mission_control" });
    const pendingResponse = deferred<BrowserHttpResponsePort>();
    remote.http.enqueue("remote", () => pendingResponse.promise);
    const pending = remote.coordinator.requestRemoteStatus();
    await waitFor(() => remote.http.routeIds().at(-1) === "remote");
    remote.coordinator.close();
    pendingResponse.resolve(jsonResponse(200, remoteStatus(7)));
    await expect(pending).rejects.toMatchObject({ reason: "closed" });
    expect(remote.http.routeIds().filter((route) => route === "remote")).toHaveLength(1);
  });

  it("opens loopback writes only for an explicit paired-writer cookie", async () => {
    const harness = createHarness(loopbackOrigin);
    harness.http.enqueue(
      "access",
      jsonResponse(200, pairedAccess(loopbackOrigin, "write"))
    );
    harness.http.enqueue(
      "host",
      jsonResponse(200, hostStatus({ mode: "paired_write", origin: loopbackOrigin }))
    );
    harness.http.enqueue(
      "list",
      jsonResponse(200, sessionList("paired_write", loopbackOrigin, []))
    );
    harness.http.enqueue("csrf", jsonResponse(200, csrfBootstrap(1)));

    const snapshot = await harness.coordinator.setTarget({ kind: "mission_control" });

    expect(snapshot).toMatchObject({
      phase: "ready",
      access: {
        data: {
          network_mode: "loopback",
          authentication_state: "paired_device",
          permission: "write"
        }
      },
      host: { data: { access: { mode: "paired_write" } } },
      targetState: { data: { access: { mode: "paired_write" } } },
      csrf: { phase: "ready", generation: 1 },
      writeEligibility: { eligible: true, causes: [] }
    });
    expect(harness.http.routeIds().filter((route) => route === "csrf")).toHaveLength(1);
    harness.coordinator.close();
  });

  it("fails loudly when a browser response claims loopback local-admin authority", async () => {
    const harness = createHarness(loopbackOrigin);
    harness.http.enqueue("access", jsonResponse(200, localAdminAccess()));

    const snapshot = await harness.coordinator.setTarget({ kind: "mission_control" });

    expect(snapshot).toMatchObject({
      phase: "fatal",
      access: {
        state: "failed",
        failure: { source: "access", reason: "authority_mismatch" }
      },
      host: { state: "blocked", data: null },
      targetState: { state: "blocked", data: null },
      csrf: { phase: "idle", invalidationReason: "access_lost" }
    });
    expect(harness.http.routeIds()).toEqual(["access"]);
    harness.coordinator.close();
  });

  it("publishes host and target independently, then opens writes after one CSRF bootstrap", async () => {
    const host = deferred<BrowserHttpResponsePort>();
    const list = deferred<BrowserHttpResponsePort>();
    const csrf = deferred<BrowserHttpResponsePort>();
    const harness = createHarness(remoteOrigin);
    harness.http.enqueue("access", jsonResponse(200, pairedAccess(remoteOrigin, "write")));
    harness.http.enqueue("host", async () => await host.promise);
    harness.http.enqueue("list", async () => await list.promise);
    harness.http.enqueue("csrf", async () => await csrf.promise);

    const pending = harness.coordinator.setTarget({ kind: "mission_control" });
    await waitFor(() => harness.http.requests.length === 3);
    list.resolve(
      jsonResponse(
        200,
        sessionList("paired_write", remoteOrigin, [sessionItem(firstSessionId)])
      )
    );
    await waitFor(() => harness.coordinator.snapshot().targetState.state === "current");
    expect(harness.coordinator.snapshot()).toMatchObject({
      host: { state: "loading", data: null },
      targetState: { state: "current" },
      writeEligibility: {
        eligible: false,
        causes: ["host_status_unavailable", "csrf_not_ready"]
      }
    });
    expect(harness.http.routeIds()).not.toContain("csrf");

    host.resolve(
      jsonResponse(
        200,
        hostStatus({ mode: "paired_write", origin: remoteOrigin, remoteGeneration: 7 })
      )
    );
    await waitFor(() => harness.http.routeIds().includes("csrf"));
    expect(harness.coordinator.snapshot()).toMatchObject({
      host: { state: "current" },
      csrf: { phase: "bootstrapping" },
      writeEligibility: { eligible: false, causes: ["csrf_not_ready"] }
    });

    csrf.resolve(jsonResponse(200, csrfBootstrap(1)));
    const snapshot = await pending;
    expect(snapshot).toMatchObject({
      phase: "ready",
      csrf: { phase: "ready", generation: 1 },
      writeEligibility: { eligible: true, causes: [] }
    });
    expect(harness.operationIds).toBe(1);
    expect(harness.http.routeIds().filter((route) => route === "csrf")).toHaveLength(1);
    harness.coordinator.close();
  });

  it.each([
    ["offline", "runtime_disconnected", "offline"],
    ["incompatible", "runtime_incompatible", "incompatible"],
    ["fatal", "storage_unavailable", "fatal"]
  ] as const)(
    "classifies %s local health and keeps writes closed",
    async (_label, localCause, expectedPhase) => {
      const harness = createHarness(remoteOrigin);
      harness.http.enqueue("access", jsonResponse(200, pairedAccess(remoteOrigin, "write")));
      harness.http.enqueue(
        "host",
        jsonResponse(
          200,
          hostStatus({
            mode: "paired_write",
            origin: remoteOrigin,
            localCause,
            remoteGeneration: 7
          })
        )
      );
      harness.http.enqueue(
        "list",
        jsonResponse(200, sessionList("paired_write", remoteOrigin, []))
      );
      harness.http.enqueue("csrf", jsonResponse(200, csrfBootstrap(1)));

      const snapshot = await harness.coordinator.setTarget({ kind: "mission_control" });
      expect(snapshot.phase).toBe(expectedPhase);
      expect(snapshot.writeEligibility).toMatchObject({
        eligible: false,
        causes: ["host_not_ready"]
      });
      harness.coordinator.close();
    }
  );

  it("retains same-target data as stale across transport loss and records recovery", async () => {
    const harness = createHarness(loopbackOrigin);
    enqueueLoopbackMission(harness, [sessionItem(firstSessionId)]);
    const first = await harness.coordinator.setTarget({ kind: "mission_control" });
    expect(first.targetState.state).toBe("current");

    harness.http.enqueue("access", async () => {
      throw new Error("private transport detail");
    });
    const stale = await harness.coordinator.refresh();
    expect(stale).toMatchObject({
      phase: "unreachable",
      access: { state: "stale", failure: { source: "access", reason: "transport_unavailable" } },
      host: { state: "stale" },
      targetState: { state: "stale", data: { kind: "mission_control" } },
      lastFailure: { source: "access", reason: "transport_unavailable" }
    });

    enqueueLoopbackMission(harness, [sessionItem(firstSessionId)]);
    const recovered = await harness.coordinator.refresh();
    expect(recovered).toMatchObject({
      phase: "ready",
      access: { state: "current", failure: null },
      host: { state: "current", failure: null },
      targetState: { state: "current", failure: null },
      lastFailure: { source: "access", reason: "transport_unavailable" }
    });
    expect(recovered.lastFailure).toBe(stale.lastFailure);
    harness.coordinator.close();
  });

  it("purges protected data and invalidates CSRF when a paired device is revoked", async () => {
    const harness = createHarness(remoteOrigin);
    enqueueRemoteWriterMission(harness, [sessionItem(firstSessionId)], 7, 1);
    const ready = await harness.coordinator.setTarget({ kind: "mission_control" });
    expect(ready.writeEligibility.eligible).toBe(true);

    harness.http.enqueue(
      "access",
      jsonResponse(200, deniedAccess(remoteOrigin, "revoked_device"))
    );
    const revoked = await harness.coordinator.refresh();

    expect(harness.http.routeIds().slice(-1)).toEqual(["access"]);
    expect(revoked).toMatchObject({
      phase: "access_limited",
      access: { state: "current", data: { authentication_state: "revoked_device" } },
      host: { state: "blocked", data: null },
      targetState: { state: "blocked", data: null },
      csrf: { phase: "idle", invalidationReason: "device_revoked" },
      writeEligibility: { eligible: false, causes: ["revoked_device"] }
    });
    harness.coordinator.close();
  });

  it("labels a contradictory origin transition as remote-authority loss", async () => {
    const harness = createHarness(remoteOrigin);
    enqueueRemoteWriterMission(harness, [sessionItem(firstSessionId)], 7, 1);
    await harness.coordinator.setTarget({ kind: "mission_control" });
    harness.http.enqueue(
      "access",
      jsonResponse(200, pairedAccess(otherRemoteOrigin, "write"))
    );

    const mismatch = await harness.coordinator.refresh();

    expect(harness.http.routeIds().slice(-1)).toEqual(["access"]);
    expect(mismatch).toMatchObject({
      phase: "fatal",
      access: { state: "failed", failure: { reason: "authority_mismatch" } },
      host: { state: "blocked", data: null },
      targetState: { state: "blocked", data: null },
      csrf: {
        phase: "idle",
        generation: null,
        invalidationReason: "remote_authority_changed"
      },
      writeEligibility: { eligible: false, causes: ["connection_not_current"] }
    });
    harness.coordinator.close();
  });

  it("invalidates CSRF exactly when a paired device is replaced", async () => {
    const harness = createHarness(remoteOrigin);
    enqueueRemoteWriterMission(harness, [sessionItem(firstSessionId)], 7, 1);
    await harness.coordinator.setTarget({ kind: "mission_control" });
    harness.http.enqueue(
      "access",
      jsonResponse(
        200,
        selectedAccessStateResponseSchema.parse({
          ...pairedAccess(remoteOrigin, "write"),
          device_id: "device_connection_replacement"
        })
      )
    );
    harness.http.enqueue(
      "host",
      jsonResponse(
        200,
        hostStatus({ mode: "paired_write", origin: remoteOrigin, remoteGeneration: 7 })
      )
    );
    harness.http.enqueue(
      "list",
      jsonResponse(
        200,
        sessionList("paired_write", remoteOrigin, [sessionItem(firstSessionId)])
      )
    );

    const replaced = await harness.coordinator.refresh();

    expect(replaced).toMatchObject({
      phase: "ready",
      access: { state: "current", data: { device_id: "device_connection_replacement" } },
      host: { state: "current" },
      targetState: { state: "current" },
      csrf: { phase: "idle", invalidationReason: "pairing_replaced" },
      writeEligibility: { eligible: false, causes: ["csrf_not_ready"] }
    });
    expect(harness.http.routeIds().filter((route) => route === "csrf")).toHaveLength(1);
    harness.coordinator.close();
  });

  it("invalidates CSRF exactly when writer permission is downgraded", async () => {
    const harness = createHarness(remoteOrigin);
    enqueueRemoteWriterMission(harness, [sessionItem(firstSessionId)], 7, 1);
    await harness.coordinator.setTarget({ kind: "mission_control" });
    harness.http.enqueue(
      "access",
      jsonResponse(200, pairedAccess(remoteOrigin, "read"))
    );
    harness.http.enqueue(
      "host",
      jsonResponse(
        200,
        hostStatus({ mode: "paired_read", origin: remoteOrigin, remoteGeneration: 7 })
      )
    );
    harness.http.enqueue(
      "list",
      jsonResponse(
        200,
        sessionList("paired_read", remoteOrigin, [sessionItem(firstSessionId)])
      )
    );

    const downgraded = await harness.coordinator.refresh();

    expect(downgraded).toMatchObject({
      phase: "ready",
      access: { state: "current", data: { permission: "read" } },
      host: { state: "current", data: { access: { mode: "paired_read" } } },
      targetState: { state: "current", data: { access: { mode: "paired_read" } } },
      csrf: { phase: "idle", invalidationReason: "access_lost" },
      writeEligibility: { eligible: false, causes: ["read_only_access"] }
    });
    expect(harness.http.routeIds().filter((route) => route === "csrf")).toHaveLength(1);
    harness.coordinator.close();
  });

  it("purges previously authorized data when the access route denies authority", async () => {
    const harness = createHarness(remoteOrigin);
    enqueueRemoteWriterMission(harness, [sessionItem(firstSessionId)], 7, 1);
    const ready = await harness.coordinator.setTarget({ kind: "mission_control" });
    expect(ready.writeEligibility.eligible).toBe(true);

    harness.http.enqueue(
      "access",
      jsonResponse(403, apiError("permission_denied", false))
    );
    const denied = await harness.coordinator.refresh();

    expect(harness.http.routeIds().slice(-1)).toEqual(["access"]);
    expect(denied).toMatchObject({
      phase: "access_limited",
      access: {
        state: "stale",
        failure: { source: "access", status: 403, apiError: { code: "permission_denied" } }
      },
      host: { state: "blocked", data: null },
      targetState: { state: "blocked", data: null },
      csrf: { phase: "idle", invalidationReason: "access_lost" },
      writeEligibility: { eligible: false, causes: ["permission_denied"] }
    });
    harness.coordinator.close();
  });

  it("ignores an aborted session load that completes after a newer route", async () => {
    const oldAccess = deferred<BrowserHttpResponsePort>();
    const harness = createHarness(loopbackOrigin);
    harness.http.enqueue("access", async () => await oldAccess.promise);
    harness.http.enqueue("access", jsonResponse(200, loopbackAccess()));
    harness.http.enqueue(
      "host",
      jsonResponse(200, hostStatus({ mode: "loopback_read", origin: loopbackOrigin }))
    );
    harness.http.enqueue(
      "detail",
      jsonResponse(
        200,
        sessionDetail("loopback_read", loopbackOrigin, sessionItem(secondSessionId))
      )
    );

    const oldLoad = harness.coordinator.setTarget({
      kind: "session_detail",
      sessionId: firstSessionId
    });
    await waitFor(() => harness.http.requests.length === 1);
    const oldSignal = harness.http.requests[0]?.init.signal;
    const currentLoad = harness.coordinator.setTarget({
      kind: "session_detail",
      sessionId: secondSessionId
    });
    expect(oldSignal?.aborted).toBe(true);

    const current = await currentLoad;
    oldAccess.resolve(jsonResponse(200, loopbackAccess()));
    await oldLoad;

    expect(current.target).toEqual({
      kind: "session_detail",
      sessionId: secondSessionId
    });
    expect(harness.coordinator.snapshot().targetState).toMatchObject({
      state: "current",
      data: {
        kind: "session_detail",
        response: { session: { session: { id: secondSessionId } } }
      }
    });
    expect(harness.http.routeIds().filter((route) => route === "detail")).toHaveLength(1);
    harness.coordinator.close();
  });

  it("keeps authorized not-found distinct from permission loss", async () => {
    const notFound = createHarness(loopbackOrigin);
    notFound.http.enqueue("access", jsonResponse(200, loopbackAccess()));
    notFound.http.enqueue(
      "host",
      jsonResponse(200, hostStatus({ mode: "loopback_read", origin: loopbackOrigin }))
    );
    notFound.http.enqueue(
      "detail",
      jsonResponse(404, apiError("session_not_found", false))
    );
    const absent = await notFound.coordinator.setTarget({
      kind: "session_detail",
      sessionId: firstSessionId
    });
    expect(absent).toMatchObject({
      phase: "not_found",
      targetState: {
        state: "not_found",
        data: null,
        failure: { source: "session_detail", status: 404 }
      }
    });
    notFound.coordinator.close();

    const denied = createHarness(loopbackOrigin);
    denied.http.enqueue("access", jsonResponse(200, loopbackAccess()));
    denied.http.enqueue(
      "host",
      jsonResponse(200, hostStatus({ mode: "loopback_read", origin: loopbackOrigin }))
    );
    denied.http.enqueue(
      "detail",
      jsonResponse(403, apiError("permission_denied", false))
    );
    const forbidden = await denied.coordinator.setTarget({
      kind: "session_detail",
      sessionId: firstSessionId
    });
    expect(forbidden.targetState).toMatchObject({ state: "blocked", data: null });
    expect(forbidden.targetState.state).not.toBe("not_found");
    expect(forbidden.lastFailure).toMatchObject({
      source: "session_detail",
      status: 403
    });
    denied.coordinator.close();
  });

  it("merges only ordered unique cursor pages and retains the prior page on mismatch", async () => {
    const first = sessionItem(firstSessionId, { attention: "watch", activityAt: laterTimestamp });
    const second = sessionItem(secondSessionId, { attention: "none", activityAt: timestamp });
    const harness = createHarness(loopbackOrigin);
    harness.http.enqueue("access", jsonResponse(200, loopbackAccess()));
    harness.http.enqueue(
      "host",
      jsonResponse(200, hostStatus({ mode: "loopback_read", origin: loopbackOrigin }))
    );
    harness.http.enqueue(
      "list",
      jsonResponse(200, sessionList("loopback_read", loopbackOrigin, [first], true))
    );
    await harness.coordinator.setTarget({ kind: "mission_control" });

    harness.http.enqueue(
      "list",
      jsonResponse(200, sessionList("loopback_read", loopbackOrigin, [second], true))
    );
    const merged = await harness.coordinator.loadMoreSessions();
    expect(merged.targetState).toMatchObject({
      state: "current",
      data: { pageCount: 2, hasMore: true }
    });
    expect(missionIds(merged)).toEqual([firstSessionId, secondSessionId]);
    expect(harness.http.requests.at(-1)?.path).toContain("?cursor=v1.");

    harness.http.enqueue(
      "list",
      jsonResponse(200, sessionList("loopback_read", loopbackOrigin, [second]))
    );
    const mismatch = await harness.coordinator.loadMoreSessions();
    expect(mismatch.targetState).toMatchObject({
      state: "stale",
      failure: { source: "session_list", reason: "page_mismatch" },
      data: { pageCount: 2 }
    });
    expect(missionIds(mismatch)).toEqual([firstSessionId, secondSessionId]);
    harness.coordinator.close();
  });

  it("rejects a continuation that substitutes a different order snapshot", async () => {
    const first = sessionItem(firstSessionId, {
      attention: "watch",
      activityAt: laterTimestamp
    });
    const second = sessionItem(secondSessionId, { activityAt: timestamp });
    const harness = createHarness(loopbackOrigin);
    harness.http.enqueue("access", jsonResponse(200, loopbackAccess()));
    harness.http.enqueue(
      "host",
      jsonResponse(200, hostStatus({ mode: "loopback_read", origin: loopbackOrigin }))
    );
    harness.http.enqueue(
      "list",
      jsonResponse(
        200,
        sessionList("loopback_read", loopbackOrigin, [first], true, "a".repeat(64))
      )
    );
    await harness.coordinator.setTarget({ kind: "mission_control" });

    harness.http.enqueue(
      "list",
      jsonResponse(
        200,
        sessionList("loopback_read", loopbackOrigin, [second], true, "b".repeat(64))
      )
    );
    const mismatch = await harness.coordinator.loadMoreSessions();

    expect(mismatch.targetState).toMatchObject({
      state: "stale",
      failure: { source: "session_list", reason: "page_mismatch" },
      data: { pageCount: 1 }
    });
    expect(missionIds(mismatch)).toEqual([firstSessionId]);
    harness.coordinator.close();
  });

  it("resumes one detail stream, preserves its retention boundary, and closes it on route change", async () => {
    const reader = new ControlledReader();
    const harness = createHarness(loopbackOrigin);
    harness.http.enqueue("access", jsonResponse(200, loopbackAccess()));
    harness.http.enqueue(
      "host",
      jsonResponse(200, hostStatus({ mode: "loopback_read", origin: loopbackOrigin }))
    );
    harness.http.enqueue(
      "detail",
      jsonResponse(
        200,
        sessionDetail(
          "loopback_read",
          loopbackOrigin,
          sessionItem(firstSessionId, { cursor: 1, bounded: true })
        )
      )
    );
    harness.sse.enqueue(async () => sseResponse(reader));
    await harness.coordinator.setTarget({
      kind: "session_detail",
      sessionId: firstSessionId
    });
    const events: SelectedProjectionEvent[] = [];
    harness.coordinator.connectSessionStream((event) => {
      events.push(event);
    });
    await waitFor(() => harness.sse.requests.length === 1);
    expect(harness.sse.requests[0]?.path).toBe(
      `/api/v1/sessions/${firstSessionId}/events/stream?after=1`
    );
    await waitFor(() => harness.coordinator.snapshot().stream.state === "connected");
    expect(harness.coordinator.snapshot().stream).toMatchObject({
      continuity: "boundary",
      boundary: { after: 0, cursor: 1, reason: "retention" }
    });

    reader.pushText(eventFrame(messageEvent(firstSessionId, 2)));
    await waitFor(() => events.length === 1);
    expect(events[0]?.cursor).toBe(2);

    enqueueLoopbackMission(harness, []);
    await harness.coordinator.setTarget({ kind: "mission_control" });
    expect(reader.cancelCalls).toBe(1);
    expect(reader.releaseCalls).toBe(1);
    expect(harness.coordinator.snapshot().stream.state).toBe("not_applicable");
    reader.pushText(eventFrame(messageEvent(firstSessionId, 3)));
    await settle();
    expect(events).toHaveLength(1);
    harness.coordinator.close();
  });

  it("replays a bounded recent detail window without changing the live-only default", async () => {
    const recentReader = new ControlledReader();
    const harness = createHarness(loopbackOrigin);
    harness.http.enqueue("access", jsonResponse(200, loopbackAccess()));
    harness.http.enqueue(
      "host",
      jsonResponse(200, hostStatus({ mode: "loopback_read", origin: loopbackOrigin }))
    );
    harness.http.enqueue(
      "detail",
      jsonResponse(
        200,
        sessionDetail(
          "loopback_read",
          loopbackOrigin,
          sessionItem(firstSessionId, { cursor: 150 })
        )
      )
    );
    harness.sse.enqueue(async () => sseResponse(recentReader));
    await harness.coordinator.setTarget({
      kind: "session_detail",
      sessionId: firstSessionId
    });
    const consumer = () => undefined;
    const connected = harness.coordinator.connectSessionStream(consumer, {
      start: "recent"
    });
    expect(
      harness.coordinator.connectSessionStream(consumer, { start: "recent" })
    ).toBe(connected);
    expect(() =>
      harness.coordinator.connectSessionStream(consumer, { start: "live" })
    ).toThrowError(/not ready/u);
    await waitFor(() => harness.sse.requests.length === 1);
    expect(harness.sse.requests[0]?.path).toBe(
      `/api/v1/sessions/${firstSessionId}/events/stream?after=50`
    );
    harness.coordinator.close();
    expect(recentReader.cancelCalls).toBe(1);
    expect(recentReader.releaseCalls).toBe(1);
  });

  it("starts empty recent detail replay before the first event and rejects invalid options", async () => {
    const reader = new ControlledReader();
    const harness = createHarness(loopbackOrigin);
    harness.http.enqueue("access", jsonResponse(200, loopbackAccess()));
    harness.http.enqueue(
      "host",
      jsonResponse(200, hostStatus({ mode: "loopback_read", origin: loopbackOrigin }))
    );
    harness.http.enqueue(
      "detail",
      jsonResponse(
        200,
        sessionDetail("loopback_read", loopbackOrigin, sessionItem(firstSessionId))
      )
    );
    await harness.coordinator.setTarget({
      kind: "session_detail",
      sessionId: firstSessionId
    });

    for (const options of [
      null,
      {},
      { start: "all" },
      { start: "recent", after: 1 },
      Object.create({ start: "recent" })
    ]) {
      expect(() =>
        harness.coordinator.connectSessionStream(
          () => undefined,
          options as never
        )
      ).toThrowError(/contract/u);
    }
    expect(harness.sse.requests).toHaveLength(0);

    harness.sse.enqueue(async () => sseResponse(reader));
    harness.coordinator.connectSessionStream(() => undefined, { start: "recent" });
    await waitFor(() => harness.sse.requests.length === 1);
    expect(harness.sse.requests[0]?.path).toBe(
      `/api/v1/sessions/${firstSessionId}/events/stream`
    );
    harness.coordinator.close();
  });

  it("owns synchronous stream publication before reentrant disconnect and leaves no request", async () => {
    const harness = createHarness(loopbackOrigin);
    harness.http.enqueue("access", jsonResponse(200, loopbackAccess()));
    harness.http.enqueue(
      "host",
      jsonResponse(200, hostStatus({ mode: "loopback_read", origin: loopbackOrigin }))
    );
    harness.http.enqueue(
      "detail",
      jsonResponse(
        200,
        sessionDetail(
          "loopback_read",
          loopbackOrigin,
          sessionItem(firstSessionId, { cursor: 1 })
        )
      )
    );
    await harness.coordinator.setTarget({
      kind: "session_detail",
      sessionId: firstSessionId
    });

    let disconnected: ReturnType<BrowserConnectionStateCoordinator["snapshot"]> | null = null;
    const unsubscribe = harness.coordinator.subscribe(() => {
      if (
        disconnected === null &&
        harness.coordinator.snapshot().stream.state === "connecting"
      ) {
        disconnected = harness.coordinator.disconnectSessionStream();
      }
    });
    const result = harness.coordinator.connectSessionStream(() => undefined);
    await Promise.resolve();

    expect(result).toBe(disconnected);
    expect(result.stream).toMatchObject({ state: "idle", snapshot: null });
    expect(harness.sse.requests).toHaveLength(0);
    unsubscribe();
    harness.coordinator.close();
  });

  it("retains a recovered SSE failure after bounded reconnect succeeds", async () => {
    const sseClock = new ManualSseClock();
    const reader = new ControlledReader();
    const harness = createHarness(loopbackOrigin, { sseClock: sseClock.port });
    harness.http.enqueue("access", jsonResponse(200, loopbackAccess()));
    harness.http.enqueue(
      "host",
      jsonResponse(200, hostStatus({ mode: "loopback_read", origin: loopbackOrigin }))
    );
    harness.http.enqueue(
      "detail",
      jsonResponse(
        200,
        sessionDetail("loopback_read", loopbackOrigin, sessionItem(firstSessionId))
      )
    );
    harness.sse.enqueue(async () => {
      throw new Error("private stream transport detail");
    });
    harness.sse.enqueue(async () => sseResponse(reader));
    await harness.coordinator.setTarget({
      kind: "session_detail",
      sessionId: firstSessionId
    });
    harness.coordinator.connectSessionStream(() => {});

    await waitFor(() => harness.coordinator.snapshot().stream.state === "reconnecting");
    const failed = harness.coordinator.snapshot();
    expect(failed.stream.failure).toMatchObject({
      source: "session_stream",
      reason: "transport_unavailable"
    });
    sseClock.advance(defaultBrowserSseClientLimits.reconnectInitialDelayMs);
    await waitFor(() => harness.coordinator.snapshot().stream.state === "connected");
    reader.pushText(": heartbeat\n\n");
    await waitFor(() => harness.coordinator.snapshot().stream.failure === null);
    const recovered = harness.coordinator.snapshot();
    expect(recovered.stream.failure).toBeNull();
    expect(recovered.lastFailure).toMatchObject({
      source: "session_stream",
      reason: "transport_unavailable"
    });
    expect(sseClock.pendingCount).toBe(2);
    harness.coordinator.close();
    expect(sseClock.pendingCount).toBe(0);
  });

  it("projects live catalog upserts and removals into Mission Control and selected detail", async () => {
    const harness = createHarness(loopbackOrigin);
    const initial = catalogSessionItem("a");
    enqueueLoopbackMission(harness, [initial]);
    await harness.coordinator.setTarget({ kind: "mission_control" });
    await waitFor(() => harness.sse.catalogReaders.length === 1);
    const catalogReader = requireCatalogReader(harness.sse, 0);

    catalogReader.pushText(
      eventFrame(catalogReset(100, 1)) +
        eventFrame(catalogUpsert(101, "a")) +
        eventFrame(catalogReady(102, 1))
    );
    await waitFor(() => harness.coordinator.snapshot().catalog?.state === "current");
    expect(missionIds(harness.coordinator.snapshot())).toEqual([
      "sess_catalog_connection_a"
    ]);

    catalogReader.pushText(
      eventFrame(
        catalogUpsert(103, "a", {
          attention: "watch",
          summary: "Laptop activity is now visible.",
          updatedAt: laterTimestamp
        })
      ) + eventFrame(catalogUpsert(104, "b"))
    );
    await waitFor(
      () =>
        harness.coordinator.snapshot().catalog?.snapshot?.cursor === 104
    );
    expect(
      harness.coordinator.snapshot().catalog?.data?.sessions.map((item) => ({
        id: item.session.id,
        summary: item.session.recent_summary
      }))
    ).toEqual([
      {
        id: "sess_catalog_connection_a",
        summary: "Laptop activity is now visible."
      },
      {
        id: "sess_catalog_connection_b",
        summary: "Catalog connection fixture."
      }
    ]);

    catalogReader.pushText(eventFrame(catalogRemove(105, "a")));
    await waitFor(() => missionIds(harness.coordinator.snapshot()).length === 1);
    expect(missionIds(harness.coordinator.snapshot())).toEqual([
      "sess_catalog_connection_b"
    ]);

    harness.http.enqueue("access", jsonResponse(200, loopbackAccess()));
    harness.http.enqueue(
      "host",
      jsonResponse(
        200,
        hostStatus({ mode: "loopback_read", origin: loopbackOrigin })
      )
    );
    harness.http.enqueue(
      "detail",
      jsonResponse(
        200,
        sessionDetail(
          "loopback_read",
          loopbackOrigin,
          catalogSessionItem("b")
        )
      )
    );
    await harness.coordinator.setTarget({
      kind: "session_detail",
      sessionId: "sess_catalog_connection_b"
    });
    expect(harness.sse.catalogRequests).toHaveLength(1);

    catalogReader.pushText(
      eventFrame(
        catalogUpsert(106, "b", {
          attention: "watch",
          summary: "Selected detail updated live.",
          updatedAt: laterTimestamp
        })
      )
    );
    await waitFor(() => {
      const data = harness.coordinator.snapshot().targetState.data;
      return (
        data?.kind === "session_detail" &&
        data.response.session.session.recent_summary ===
          "Selected detail updated live."
      );
    });
    const selectedDetail = harness.coordinator.snapshot().targetState.data;
    expect(
      selectedDetail?.kind === "session_detail"
        ? selectedDetail.response.session.session.codex_thread_id
        : null
    ).toBe(catalogNativeId("b"));

    catalogReader.pushText(eventFrame(catalogRemove(107, "b")));
    await waitFor(
      () => harness.coordinator.snapshot().targetState.state === "not_found"
    );
    expect(harness.coordinator.snapshot()).toMatchObject({
      phase: "not_found",
      targetState: {
        state: "not_found",
        data: null,
        failure: {
          source: "session_catalog",
          reason: "session_removed",
          routeId: "session_catalog_stream"
        }
      },
      stream: { state: "idle" }
    });
    harness.coordinator.close();
  });

  it("retains one complete catalog through a boundary and swaps only on ready", async () => {
    const sseClock = new ManualSseClock();
    const harness = createHarness(loopbackOrigin, { sseClock: sseClock.port });
    enqueueLoopbackMission(harness, [catalogSessionItem("a")]);
    await harness.coordinator.setTarget({ kind: "mission_control" });
    await waitFor(() => harness.sse.catalogReaders.length === 1);
    const firstReader = requireCatalogReader(harness.sse, 0);
    firstReader.pushText(
      eventFrame(catalogReset(10, 1)) +
        eventFrame(catalogUpsert(11, "a")) +
        eventFrame(catalogReady(12, 1)) +
        eventFrame(catalogBoundary(13))
    );
    await waitFor(
      () => harness.coordinator.snapshot().catalog?.boundary?.cursor === 13
    );
    expect(harness.coordinator.snapshot()).toMatchObject({
      phase: "ready",
      catalog: {
        state: "stale",
        data: { sessions: [{ session: { id: "sess_catalog_connection_a" } }] },
        boundary: { reason: "lag" }
      }
    });
    firstReader.end();
    await waitFor(
      () =>
        harness.coordinator.snapshot().catalog?.snapshot?.phase ===
        "reconnecting"
    );
    sseClock.advance(defaultBrowserSseClientLimits.reconnectInitialDelayMs);
    await waitFor(() => harness.sse.catalogReaders.length === 2);
    expect(harness.sse.catalogRequests[1]?.path).toBe(
      "/api/v1/sessions/catalog/stream?after=13"
    );
    const secondReader = requireCatalogReader(harness.sse, 1);
    secondReader.pushText(
      eventFrame(catalogReset(20, 1, catalogStreamB)) +
        eventFrame(catalogUpsert(21, "b", {}, catalogStreamB))
    );
    await waitFor(
      () => harness.coordinator.snapshot().catalog?.snapshot?.cursor === 21
    );
    expect(harness.coordinator.snapshot().catalog).toMatchObject({
      state: "resetting",
      data: { sessions: [{ session: { id: "sess_catalog_connection_a" } }] }
    });
    expect(missionIds(harness.coordinator.snapshot())).toEqual([
      "sess_catalog_connection_a"
    ]);

    secondReader.pushText(eventFrame(catalogReady(22, 1, catalogStreamB)));
    await waitFor(() => harness.coordinator.snapshot().catalog?.state === "current");
    expect(missionIds(harness.coordinator.snapshot())).toEqual([
      "sess_catalog_connection_b"
    ]);
    expect(harness.coordinator.snapshot().phase).toBe("ready");
    harness.coordinator.close();
  });

  it("fails an invalid live catalog mutation visibly without replacing retained rows", async () => {
    const harness = createHarness(loopbackOrigin);
    enqueueLoopbackMission(harness, [catalogSessionItem("a")]);
    await harness.coordinator.setTarget({ kind: "mission_control" });
    await waitFor(() => harness.sse.catalogReaders.length === 1);
    const reader = requireCatalogReader(harness.sse, 0);
    reader.pushText(
      eventFrame(catalogReset(1, 1)) +
        eventFrame(catalogUpsert(2, "a")) +
        eventFrame(catalogReady(3, 1))
    );
    await waitFor(() => harness.coordinator.snapshot().catalog?.state === "current");

    reader.pushText(eventFrame(catalogRemove(4, "b")));
    await waitFor(
      () => harness.coordinator.snapshot().catalog?.snapshot?.phase === "failed"
    );
    expect(harness.coordinator.snapshot()).toMatchObject({
      phase: "ready",
      catalog: {
        state: "stale",
        data: { sessions: [{ session: { id: "sess_catalog_connection_a" } }] },
        failure: {
          source: "session_catalog",
          reason: "consumer_error"
        }
      }
    });
    expect(missionIds(harness.coordinator.snapshot())).toEqual([
      "sess_catalog_connection_a"
    ]);
    harness.coordinator.close();
  });

  it("owns host lock outside the generic write path and latches an unconfirmed outcome", async () => {
    const harness = createHarness(remoteOrigin);
    await expect(
      harness.coordinator.requestHostLock({
        body: { operation_id: "op_connection_early_lock", confirmed: true }
      })
    ).rejects.toMatchObject({ reason: "not_ready" });
    expect(harness.http.requests).toHaveLength(0);

    enqueueRemoteWriterMission(harness, [], 7, 1);
    await harness.coordinator.setTarget({ kind: "mission_control" });
    const mutation = deferred<BrowserHttpResponsePort>();
    harness.http.enqueue("mutation", async () => await mutation.promise);
    const pending = harness.coordinator.requestHostLock({
      body: { operation_id: "op_connection_failed_lock", confirmed: true }
    });
    await waitFor(() => harness.http.routeIds().includes("mutation"));
    expect(harness.coordinator.snapshot().writeEligibility).toEqual({
      scope: "browser_shell",
      eligible: false,
      causes: ["host_lock_pending"]
    });
    await expect(
      harness.coordinator.requestProtected("prompt_dispatch", {
        params: { session_id: firstSessionId },
        body: {
          operation_id: "op_connection_prompt_during_lock",
          kind: "prompt",
          text: "Do not dispatch this request."
        }
      })
    ).rejects.toMatchObject({ reason: "not_ready" });
    harness.http.enqueue(
      "devices",
      jsonResponse(200, deviceListPage(["device_connection_phone", "device_other"]))
    );
    await expect(
      harness.coordinator.requestDeviceList({ query: { limit: "20" } })
    ).resolves.toMatchObject({ data: { devices: expect.any(Array) } });
    harness.http.enqueue(
      "revoke",
      jsonResponse(200, {
        operation_id: "op_connection_revoke_during_lock",
        device_id: "device_other",
        revoked_at: laterTimestamp,
        authority_invalidated: true,
        self_revoked: false
      })
    );
    await expect(
      harness.coordinator.requestDeviceRevoke({
        params: { device_id: "device_other" },
        body: {
          operation_id: "op_connection_revoke_during_lock",
          confirmed: true
        }
      })
    ).resolves.toMatchObject({ data: { device_id: "device_other" } });
    expect(harness.coordinator.snapshot().writeEligibility.causes).toEqual([
      "host_lock_pending"
    ]);
    await expect(
      Reflect.apply(
        harness.coordinator.requestProtected,
        harness.coordinator,
        [
          "host_lock",
          {
            body: { operation_id: "op_connection_generic_lock", confirmed: true }
          }
        ]
      )
    ).rejects.toMatchObject({ reason: "client_contract" });
    await expect(
      Reflect.apply(
        harness.coordinator.requestProtected,
        harness.coordinator,
        [
          "host_unlock",
          {
            body: { operation_id: "op_connection_generic_unlock", confirmed: true }
          }
        ]
      )
    ).rejects.toMatchObject({ reason: "client_contract" });
    expect(harness.http.routeIds()).not.toContain("host_unlock");

    mutation.resolve(jsonResponse(503, apiError("runtime_unavailable", true)));
    await expect(pending).rejects.toMatchObject({ reason: "api_error" });
    expect(harness.http.routeIds().filter((route) => route === "mutation")).toHaveLength(1);
    expect(harness.coordinator.snapshot()).toMatchObject({
      access: { state: "current", data: { locked: false } },
      csrf: { phase: "ready" },
      lastFailure: { source: "csrf", reason: "api_error", status: 503 },
      writeEligibility: {
        eligible: false,
        causes: ["host_lock_unconfirmed"]
      }
    });
    await expect(
      harness.coordinator.requestHostLock({
        body: { operation_id: "op_connection_retry_lock", confirmed: true }
      })
    ).rejects.toMatchObject({ reason: "not_ready" });
    harness.http.enqueue(
      "devices",
      jsonResponse(200, deviceListPage(["device_connection_phone"]))
    );
    await expect(
      harness.coordinator.requestDeviceList({ query: { limit: "20" } })
    ).resolves.toMatchObject({ data: { devices: [{ device_id: "device_connection_phone" }] } });
    expect(harness.http.routeIds().filter((route) => route === "mutation")).toHaveLength(1);
    harness.coordinator.close();
  });

  it("locks with exact credentials despite degraded runtime and adopts success before resolving", async () => {
    const harness = createHarness(remoteOrigin);
    harness.http.enqueue("access", jsonResponse(200, pairedAccess(remoteOrigin, "write")));
    harness.http.enqueue(
      "host",
      jsonResponse(
        200,
        hostStatus({
          mode: "paired_write",
          origin: remoteOrigin,
          localCause: "runtime_disconnected",
          remoteGeneration: 7
        })
      )
    );
    harness.http.enqueue(
      "list",
      jsonResponse(200, sessionList("paired_write", remoteOrigin, []))
    );
    harness.http.enqueue("csrf", jsonResponse(200, csrfBootstrap(1)));
    const degraded = await harness.coordinator.setTarget({ kind: "mission_control" });
    expect(degraded).toMatchObject({
      phase: "offline",
      csrf: { phase: "ready", generation: 1 },
      writeEligibility: { eligible: false, causes: ["host_not_ready"] }
    });

    const mutation = deferred<BrowserHttpResponsePort>();
    harness.http.enqueue("mutation", async () => await mutation.promise);
    const pending = harness.coordinator.requestHostLock({
      body: { operation_id: "op_connection_lock_success_001", confirmed: true }
    });
    await waitFor(() => harness.http.routeIds().includes("mutation"));
    expect(harness.coordinator.snapshot().writeEligibility).toEqual({
      scope: "browser_shell",
      eligible: false,
      causes: ["host_lock_pending", "host_not_ready"]
    });
    expect(harness.http.requests.at(-1)).toMatchObject({
      routeId: "mutation",
      path: "/api/v1/access/lock",
      init: {
        method: "POST",
        headers: {
          accept: "application/json",
          "cache-control": "no-store",
          "content-type": "application/json",
          "x-hostdeck-csrf": rawCsrfToken,
          "x-hostdeck-csrf-generation": "1"
        },
        body: JSON.stringify({
          operation_id: "op_connection_lock_success_001",
          confirmed: true
        })
      }
    });

    mutation.resolve(jsonResponse(200, pairedAccess(remoteOrigin, "write", true)));
    await expect(pending).resolves.toMatchObject({ data: { locked: true } });
    expect(harness.coordinator.snapshot()).toMatchObject({
      access: { state: "current", data: { locked: true, can_write_sessions: false } },
      host: { state: "current" },
      targetState: { state: "current" },
      csrf: { phase: "ready", generation: 1 },
      writeEligibility: {
        eligible: false,
        causes: ["host_locked", "host_not_ready"]
      }
    });
    expect(harness.http.routeIds().filter((route) => route === "mutation")).toHaveLength(1);
    harness.coordinator.close();
  });

  it("adopts a later local unlock across Mission Control refresh and Session Detail navigation", async () => {
    const harness = createHarness(remoteOrigin);
    enqueueRemoteWriterMission(
      harness,
      [sessionItem(firstSessionId)],
      7,
      1
    );
    await harness.coordinator.setTarget({ kind: "mission_control" });
    harness.http.enqueue(
      "mutation",
      jsonResponse(200, pairedAccess(remoteOrigin, "write", true))
    );
    await harness.coordinator.requestHostLock({
      body: { operation_id: "op_connection_lock_before_local_unlock", confirmed: true }
    });
    expect(harness.coordinator.snapshot()).toMatchObject({
      access: { state: "current", data: { locked: true } },
      writeEligibility: { eligible: false, causes: ["host_locked"] }
    });

    harness.http.enqueue(
      "access",
      jsonResponse(200, pairedAccess(remoteOrigin, "write", false))
    );
    harness.http.enqueue(
      "host",
      jsonResponse(
        200,
        hostStatus({ mode: "paired_write", origin: remoteOrigin, remoteGeneration: 7 })
      )
    );
    harness.http.enqueue(
      "list",
      jsonResponse(
        200,
        sessionList("paired_write", remoteOrigin, [sessionItem(firstSessionId)])
      )
    );
    const mission = await harness.coordinator.refresh();
    expect(mission).toMatchObject({
      phase: "ready",
      access: { state: "current", data: { locked: false, can_write_sessions: true } },
      csrf: { phase: "ready", generation: 1 },
      writeEligibility: { eligible: true, causes: [] }
    });

    harness.http.enqueue(
      "access",
      jsonResponse(200, pairedAccess(remoteOrigin, "write", false))
    );
    harness.http.enqueue(
      "host",
      jsonResponse(
        200,
        hostStatus({ mode: "paired_write", origin: remoteOrigin, remoteGeneration: 7 })
      )
    );
    harness.http.enqueue(
      "detail",
      jsonResponse(
        200,
        sessionDetail(
          "paired_write",
          remoteOrigin,
          sessionItem(firstSessionId)
        )
      )
    );
    const detail = await harness.coordinator.setTarget({
      kind: "session_detail",
      sessionId: firstSessionId
    });
    expect(detail).toMatchObject({
      phase: "ready",
      target: { kind: "session_detail", sessionId: firstSessionId },
      access: { state: "current", data: { locked: false, can_write_sessions: true } },
      targetState: { state: "current", data: { kind: "session_detail" } },
      csrf: { phase: "ready", generation: 1 },
      writeEligibility: { eligible: true, causes: [] }
    });
    harness.coordinator.close();
  });

  it("does not let a refresh begun during lock dispatch overwrite correlated success", async () => {
    const harness = createHarness(remoteOrigin);
    enqueueRemoteWriterMission(harness, [], 7, 1);
    await harness.coordinator.setTarget({ kind: "mission_control" });

    const mutation = deferred<BrowserHttpResponsePort>();
    const access = deferred<BrowserHttpResponsePort>();
    harness.http.enqueue("mutation", async () => await mutation.promise);
    harness.http.enqueue("access", async () => await access.promise);
    harness.http.enqueue(
      "host",
      jsonResponse(
        200,
        hostStatus({ mode: "paired_write", origin: remoteOrigin, remoteGeneration: 7 })
      )
    );
    harness.http.enqueue(
      "list",
      jsonResponse(200, sessionList("paired_write", remoteOrigin, []))
    );

    const lock = harness.coordinator.requestHostLock({
      body: { operation_id: "op_connection_lock_race_success", confirmed: true }
    });
    const refresh = harness.coordinator.refresh();
    await waitFor(() => harness.http.routeIds().filter((route) => route === "access").length === 2);
    mutation.resolve(jsonResponse(200, pairedAccess(remoteOrigin, "write", true)));
    await expect(lock).resolves.toMatchObject({ data: { locked: true } });

    access.resolve(jsonResponse(200, pairedAccess(remoteOrigin, "write", false)));
    await refresh;
    expect(harness.coordinator.snapshot()).toMatchObject({
      access: { state: "current", data: { locked: true, can_write_sessions: false } },
      csrf: { phase: "ready" },
      writeEligibility: { eligible: false, causes: ["host_locked"] }
    });
    harness.coordinator.close();
  });

  it("does not publish a locked access bit from a refresh begun during pending lock", async () => {
    const harness = createHarness(remoteOrigin);
    enqueueRemoteWriterMission(harness, [], 7, 1);
    await harness.coordinator.setTarget({ kind: "mission_control" });

    const mutation = deferred<BrowserHttpResponsePort>();
    const access = deferred<BrowserHttpResponsePort>();
    harness.http.enqueue("mutation", async () => await mutation.promise);
    harness.http.enqueue("access", async () => await access.promise);
    harness.http.enqueue(
      "host",
      jsonResponse(
        200,
        hostStatus({ mode: "paired_write", origin: remoteOrigin, remoteGeneration: 7 })
      )
    );
    harness.http.enqueue(
      "list",
      jsonResponse(200, sessionList("paired_write", remoteOrigin, []))
    );

    const lock = harness.coordinator.requestHostLock({
      body: { operation_id: "op_connection_lock_pending_read", confirmed: true }
    });
    const overlappingRefresh = harness.coordinator.refresh();
    await waitFor(() => harness.http.routeIds().filter((route) => route === "access").length === 2);
    access.resolve(jsonResponse(200, pairedAccess(remoteOrigin, "write", true)));
    await overlappingRefresh;
    expect(harness.coordinator.snapshot()).toMatchObject({
      access: { state: "current", data: { locked: false, can_write_sessions: true } },
      writeEligibility: { eligible: false, causes: ["host_lock_pending"] }
    });

    mutation.resolve(jsonResponse(409, apiError("operation_conflict", false)));
    await expect(lock).rejects.toMatchObject({ reason: "api_error", status: 409 });
    expect(harness.coordinator.snapshot()).toMatchObject({
      access: { state: "current", data: { locked: false } },
      writeEligibility: { eligible: false, causes: ["host_lock_unconfirmed"] }
    });

    harness.http.enqueue(
      "access",
      jsonResponse(200, pairedAccess(remoteOrigin, "write", true))
    );
    harness.http.enqueue(
      "host",
      jsonResponse(
        200,
        hostStatus({ mode: "paired_write", origin: remoteOrigin, remoteGeneration: 7 })
      )
    );
    harness.http.enqueue(
      "list",
      jsonResponse(200, sessionList("paired_write", remoteOrigin, []))
    );
    const proven = await harness.coordinator.refresh();
    expect(proven).toMatchObject({
      access: { state: "current", data: { locked: true, can_write_sessions: false } },
      writeEligibility: { eligible: false, causes: ["host_locked"] }
    });
    harness.coordinator.close();
  });

  it("blocks later writes without cancelling a mutation already dispatched", async () => {
    const harness = createHarness(remoteOrigin);
    enqueueRemoteWriterMission(harness, [sessionItem(firstSessionId)], 7, 1);
    await harness.coordinator.setTarget({ kind: "mission_control" });

    const promptResponse = deferred<BrowserHttpResponsePort>();
    const lockResponse = deferred<BrowserHttpResponsePort>();
    harness.http.enqueue("prompt", async () => await promptResponse.promise);
    harness.http.enqueue("mutation", async () => await lockResponse.promise);
    const prompt = harness.coordinator.requestProtected("prompt_dispatch", {
      params: { session_id: firstSessionId },
      body: {
        operation_id: "op_connection_prompt_before_lock",
        kind: "prompt",
        text: "Continue the bounded task."
      }
    });
    await waitFor(() => harness.http.routeIds().includes("prompt"));
    const promptRequest = harness.http.requests.find(({ routeId }) => routeId === "prompt");
    expect(promptRequest?.init.signal.aborted).toBe(false);

    const lock = harness.coordinator.requestHostLock({
      body: { operation_id: "op_connection_lock_after_prompt", confirmed: true }
    });
    await waitFor(() => harness.http.routeIds().includes("mutation"));
    await expect(
      harness.coordinator.requestProtected("prompt_dispatch", {
        params: { session_id: firstSessionId },
        body: {
          operation_id: "op_connection_prompt_blocked_by_lock",
          kind: "prompt",
          text: "This request must stay local."
        }
      })
    ).rejects.toMatchObject({ reason: "not_ready" });
    expect(harness.http.routeIds().filter((route) => route === "prompt")).toHaveLength(1);
    expect(promptRequest?.init.signal.aborted).toBe(false);

    lockResponse.resolve(jsonResponse(200, pairedAccess(remoteOrigin, "write", true)));
    await lock;
    expect(promptRequest?.init.signal.aborted).toBe(false);
    promptResponse.resolve(
      jsonResponse(
        202,
        promptDispatchResponseSchema.parse({
          operation_id: "op_connection_prompt_before_lock",
          kind: "prompt",
          target: {
            type: "managed_session",
            session_id: firstSessionId,
            codex_thread_id: "thread_connection_prompt"
          },
          state: "accepted",
          accepted_at: timestamp,
          audit_record_id: "audit_connection_prompt",
          turn_id: "turn_connection_prompt",
          action: "start"
        })
      )
    );
    await expect(prompt).resolves.toMatchObject({
      status: 202,
      data: { operation_id: "op_connection_prompt_before_lock" }
    });
    expect(harness.coordinator.snapshot().writeEligibility).toMatchObject({
      eligible: false,
      causes: ["host_locked"]
    });
    harness.coordinator.close();
  });

  it("requires a causally later access proof after a host-lock conflict", async () => {
    const harness = createHarness(remoteOrigin);
    enqueueRemoteWriterMission(harness, [], 7, 1);
    await harness.coordinator.setTarget({ kind: "mission_control" });

    const mutation = deferred<BrowserHttpResponsePort>();
    const accessDuringDispatch = deferred<BrowserHttpResponsePort>();
    harness.http.enqueue("mutation", async () => await mutation.promise);
    harness.http.enqueue("access", async () => await accessDuringDispatch.promise);
    harness.http.enqueue(
      "host",
      jsonResponse(
        200,
        hostStatus({ mode: "paired_write", origin: remoteOrigin, remoteGeneration: 7 })
      )
    );
    harness.http.enqueue(
      "list",
      jsonResponse(200, sessionList("paired_write", remoteOrigin, []))
    );

    const lock = harness.coordinator.requestHostLock({
      body: { operation_id: "op_connection_lock_conflict", confirmed: true }
    });
    const overlappingRefresh = harness.coordinator.refresh();
    await waitFor(() => harness.http.routeIds().filter((route) => route === "access").length === 2);
    mutation.resolve(jsonResponse(409, apiError("operation_conflict", false)));
    await expect(lock).rejects.toMatchObject({ reason: "api_error", status: 409 });
    expect(harness.coordinator.snapshot()).toMatchObject({
      csrf: { phase: "ready", generation: 1 },
      writeEligibility: {
        eligible: false,
        causes: ["connection_not_current", "host_lock_unconfirmed"]
      }
    });

    accessDuringDispatch.resolve(
      jsonResponse(200, pairedAccess(remoteOrigin, "write", false))
    );
    await overlappingRefresh;
    expect(harness.coordinator.snapshot()).toMatchObject({
      access: { state: "current", data: { locked: false } },
      writeEligibility: { eligible: false, causes: ["host_lock_unconfirmed"] }
    });

    harness.http.enqueue(
      "access",
      jsonResponse(200, pairedAccess(remoteOrigin, "write", true))
    );
    harness.http.enqueue(
      "host",
      jsonResponse(
        200,
        hostStatus({ mode: "paired_write", origin: remoteOrigin, remoteGeneration: 7 })
      )
    );
    harness.http.enqueue(
      "list",
      jsonResponse(200, sessionList("paired_write", remoteOrigin, []))
    );
    const proven = await harness.coordinator.refresh();
    expect(proven).toMatchObject({
      access: { state: "current", data: { locked: true } },
      csrf: { phase: "ready", generation: 1 },
      writeEligibility: { eligible: false, causes: ["host_locked"] }
    });
    expect(harness.http.routeIds().filter((route) => route === "mutation")).toHaveLength(1);
    harness.coordinator.close();
  });

  it("preserves stronger authority rejection during host lock", async () => {
    const harness = createHarness(remoteOrigin);
    enqueueRemoteWriterMission(harness, [], 7, 1);
    await harness.coordinator.setTarget({ kind: "mission_control" });
    harness.http.enqueue(
      "mutation",
      jsonResponse(403, apiError("permission_denied", false))
    );
    await expect(
      harness.coordinator.requestHostLock({
        body: { operation_id: "op_connection_failed_lock", confirmed: true }
      })
    ).rejects.toMatchObject({ reason: "authority_rejected" });
    expect(harness.coordinator.snapshot()).toMatchObject({
      access: { state: "stale" },
      host: { state: "stale" },
      targetState: { state: "stale" },
      csrf: { phase: "failed" },
      writeEligibility: {
        eligible: false,
        causes: ["permission_denied"]
      }
    });
    harness.coordinator.close();
  });

  it("rejects malformed, read-only, stale, local-admin, and already-locked lock calls before HTTP", async () => {
    const malformed = createHarness(remoteOrigin);
    enqueueRemoteWriterMission(malformed, [], 7, 1);
    await malformed.coordinator.setTarget({ kind: "mission_control" });
    for (const input of [
      {},
      { body: { operation_id: "op_connection_invalid_confirm", confirmed: false } },
      {
        body: {
          operation_id: "op_connection_invalid_extra",
          confirmed: true,
          extra: true
        }
      }
    ]) {
      await expect(
        Reflect.apply(malformed.coordinator.requestHostLock, malformed.coordinator, [input])
      ).rejects.toMatchObject({ reason: "client_contract" });
    }
    let hostileGetterCalls = 0;
    const hostileBody = Object.defineProperty({}, "operation_id", {
      enumerable: true,
      get() {
        hostileGetterCalls += 1;
        return "op_connection_hostile_lock";
      }
    });
    Object.defineProperty(hostileBody, "confirmed", {
      enumerable: true,
      value: true
    });
    await expect(
      Reflect.apply(malformed.coordinator.requestHostLock, malformed.coordinator, [
        { body: hostileBody }
      ])
    ).rejects.toMatchObject({ reason: "client_contract" });
    expect(hostileGetterCalls).toBe(0);
    await expect(
      Reflect.apply(malformed.coordinator.requestHostLock, malformed.coordinator, [
        {
          body: { operation_id: "op_connection_invalid_options", confirmed: true }
        },
        { signal: {} }
      ])
    ).rejects.toMatchObject({ reason: "client_contract" });
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      malformed.coordinator.requestHostLock(
        {
          body: { operation_id: "op_connection_aborted_lock", confirmed: true }
        },
        { signal: aborted.signal }
      )
    ).rejects.toMatchObject({ reason: "caller_aborted" });
    expect(malformed.coordinator.snapshot().writeEligibility).toEqual({
      scope: "browser_shell",
      eligible: true,
      causes: []
    });
    expect(malformed.http.routeIds().filter((route) => route === "mutation")).toHaveLength(0);
    malformed.coordinator.close();

    const reader = createHarness(remoteOrigin);
    reader.http.enqueue("access", jsonResponse(200, pairedAccess(remoteOrigin, "read")));
    reader.http.enqueue(
      "host",
      jsonResponse(
        200,
        hostStatus({ mode: "paired_read", origin: remoteOrigin, remoteGeneration: 7 })
      )
    );
    reader.http.enqueue(
      "list",
      jsonResponse(200, sessionList("paired_read", remoteOrigin, []))
    );
    await reader.coordinator.setTarget({ kind: "mission_control" });
    reader.coordinator.adoptCsrfBootstrap(csrfBootstrap(1));
    await expect(
      reader.coordinator.requestHostLock({
        body: { operation_id: "op_connection_reader_lock", confirmed: true }
      })
    ).rejects.toMatchObject({ reason: "not_ready" });
    expect(reader.http.routeIds()).not.toContain("mutation");
    reader.coordinator.close();

    const stale = createHarness(remoteOrigin);
    enqueueRemoteWriterMission(stale, [], 7, 1);
    await stale.coordinator.setTarget({ kind: "mission_control" });
    stale.http.enqueue("access", async () => {
      throw new Error("private stale access fixture");
    });
    await stale.coordinator.refresh();
    await expect(
      stale.coordinator.requestHostLock({
        body: { operation_id: "op_connection_stale_lock", confirmed: true }
      })
    ).rejects.toMatchObject({ reason: "not_ready" });
    expect(stale.http.routeIds()).not.toContain("mutation");
    stale.coordinator.close();

    const localAdmin = createHarness(loopbackOrigin);
    localAdmin.http.enqueue("access", jsonResponse(200, localAdminAccess()));
    localAdmin.http.enqueue(
      "host",
      jsonResponse(200, hostStatus({ mode: "local_admin", origin: loopbackOrigin }))
    );
    localAdmin.http.enqueue(
      "list",
      jsonResponse(200, sessionList("local_admin", loopbackOrigin, []))
    );
    await localAdmin.coordinator.setTarget({ kind: "mission_control" });
    localAdmin.coordinator.adoptCsrfBootstrap(csrfBootstrap(1));
    await expect(
      localAdmin.coordinator.requestHostLock({
        body: { operation_id: "op_connection_local_admin_lock", confirmed: true }
      })
    ).rejects.toMatchObject({ reason: "not_ready" });
    expect(localAdmin.http.routeIds()).not.toContain("mutation");
    localAdmin.coordinator.close();

    const locked = createHarness(remoteOrigin);
    locked.http.enqueue(
      "access",
      jsonResponse(200, pairedAccess(remoteOrigin, "write", true))
    );
    locked.http.enqueue(
      "host",
      jsonResponse(
        200,
        hostStatus({ mode: "paired_write", origin: remoteOrigin, remoteGeneration: 7 })
      )
    );
    locked.http.enqueue(
      "list",
      jsonResponse(200, sessionList("paired_write", remoteOrigin, []))
    );
    locked.http.enqueue("csrf", jsonResponse(200, csrfBootstrap(1)));
    await locked.coordinator.setTarget({ kind: "mission_control" });
    await expect(
      locked.coordinator.requestHostLock({
        body: { operation_id: "op_connection_already_locked", confirmed: true }
      })
    ).rejects.toMatchObject({ reason: "not_ready" });
    expect(locked.http.routeIds()).not.toContain("mutation");
    locked.coordinator.close();
  });

  it("lists devices for exact paired readers without session-write authority", async () => {
    const harness = createHarness(remoteOrigin);
    await expect(
      harness.coordinator.requestDeviceList({ query: { limit: "20" } })
    ).rejects.toMatchObject({ reason: "not_ready" });
    expect(harness.http.requests).toHaveLength(0);

    harness.http.enqueue("access", jsonResponse(200, pairedAccess(remoteOrigin, "read")));
    harness.http.enqueue(
      "host",
      jsonResponse(
        200,
        hostStatus({ mode: "paired_read", origin: remoteOrigin, remoteGeneration: 7 })
      )
    );
    harness.http.enqueue(
      "list",
      jsonResponse(200, sessionList("paired_read", remoteOrigin, []))
    );
    await harness.coordinator.setTarget({ kind: "mission_control" });
    harness.http.enqueue(
      "devices",
      jsonResponse(200, deviceListPage(["device_connection_phone", "device_other"]))
    );

    const response = await harness.coordinator.requestDeviceList({
      query: { limit: "20" }
    });

    expect(response.data.devices.map((device) => device.device_id)).toEqual([
      "device_connection_phone",
      "device_other"
    ]);
    expect(harness.http.requests.at(-1)).toMatchObject({
      routeId: "devices",
      path: "/api/v1/access/devices?limit=20",
      init: { method: "GET" }
    });
    expect(harness.http.requests.at(-1)?.init).not.toHaveProperty("body");
    await expect(
      harness.coordinator.requestDeviceRevoke({
        params: { device_id: "device_other" },
        body: { operation_id: "op_connection_device_reader_001", confirmed: true }
      })
    ).rejects.toMatchObject({ reason: "not_ready" });
    expect(harness.http.routeIds().filter((route) => route === "revoke")).toHaveLength(0);
    harness.coordinator.close();
  });

  it("revokes another device while the host is locked without using session write eligibility", async () => {
    const harness = createHarness(remoteOrigin);
    harness.http.enqueue(
      "access",
      jsonResponse(200, pairedAccess(remoteOrigin, "write", true))
    );
    harness.http.enqueue(
      "host",
      jsonResponse(
        200,
        hostStatus({ mode: "paired_write", origin: remoteOrigin, remoteGeneration: 7 })
      )
    );
    harness.http.enqueue(
      "list",
      jsonResponse(200, sessionList("paired_write", remoteOrigin, []))
    );
    harness.http.enqueue("csrf", jsonResponse(200, csrfBootstrap(1)));
    const locked = await harness.coordinator.setTarget({ kind: "mission_control" });
    expect(locked.writeEligibility).toMatchObject({
      eligible: false,
      causes: ["host_locked"]
    });
    await expect(
      Reflect.apply(
        harness.coordinator.requestProtected,
        harness.coordinator,
        [
          "device_revoke",
          {
            params: { device_id: "device_other" },
            body: {
              operation_id: "op_connection_device_generic_bypass",
              confirmed: true
            }
          }
        ]
      ) as Promise<unknown>
    ).rejects.toMatchObject({ reason: "client_contract" });
    expect(harness.http.routeIds().filter((route) => route === "revoke")).toHaveLength(0);
    harness.http.enqueue(
      "revoke",
      jsonResponse(200, {
        operation_id: "op_connection_device_other_001",
        device_id: "device_other",
        revoked_at: laterTimestamp,
        authority_invalidated: true,
        self_revoked: false
      })
    );

    const response = await harness.coordinator.requestDeviceRevoke({
      params: { device_id: "device_other" },
      body: { operation_id: "op_connection_device_other_001", confirmed: true }
    });

    expect(response.data).toMatchObject({
      device_id: "device_other",
      self_revoked: false
    });
    expect(harness.http.requests.at(-1)).toMatchObject({
      routeId: "revoke",
      path: "/api/v1/access/devices/device_other/revoke",
      init: {
        method: "POST",
        body: JSON.stringify({
          operation_id: "op_connection_device_other_001",
          confirmed: true
        })
      }
    });
    expect(harness.coordinator.snapshot()).toMatchObject({
      access: { state: "current", data: { device_id: "device_connection_phone" } },
      csrf: { phase: "ready" },
      writeEligibility: { eligible: false, causes: ["host_locked"] }
    });

    harness.http.enqueue(
      "revoke",
      jsonResponse(409, apiError("operation_conflict", false))
    );
    await expect(
      harness.coordinator.requestDeviceRevoke({
        params: { device_id: "device_other" },
        body: { operation_id: "op_connection_device_conflict", confirmed: true }
      })
    ).rejects.toMatchObject({ reason: "api_error", status: 409 });
    expect(harness.coordinator.snapshot()).toMatchObject({
      access: { state: "current", data: { device_id: "device_connection_phone" } },
      csrf: { phase: "ready" },
      writeEligibility: { eligible: false, causes: ["host_locked"] }
    });
    harness.coordinator.close();
  });

  it("rejects cross-target and contradictory-self revoke success without false publication", async () => {
    const crossTarget = createHarness(remoteOrigin);
    enqueueRemoteWriterMission(crossTarget, [], 7, 1);
    await crossTarget.coordinator.setTarget({ kind: "mission_control" });
    crossTarget.http.enqueue(
      "revoke",
      jsonResponse(200, {
        operation_id: "op_connection_device_cross_target",
        device_id: "device_different",
        revoked_at: laterTimestamp,
        authority_invalidated: true,
        self_revoked: false
      })
    );
    await expect(
      crossTarget.coordinator.requestDeviceRevoke({
        params: { device_id: "device_other" },
        body: { operation_id: "op_connection_device_cross_target", confirmed: true }
      })
    ).rejects.toMatchObject({ reason: "client_contract" });
    expect(crossTarget.coordinator.snapshot()).toMatchObject({
      access: { state: "current", data: { device_id: "device_connection_phone" } },
      csrf: { phase: "ready" },
      writeEligibility: { eligible: true }
    });
    crossTarget.coordinator.close();

    const contradictorySelf = createHarness(remoteOrigin);
    enqueueRemoteWriterMission(contradictorySelf, [], 7, 1);
    await contradictorySelf.coordinator.setTarget({ kind: "mission_control" });
    contradictorySelf.http.enqueue(
      "revoke",
      jsonResponse(200, {
        operation_id: "op_connection_device_self_contradiction",
        device_id: "device_connection_phone",
        revoked_at: laterTimestamp,
        authority_invalidated: true,
        self_revoked: false
      })
    );
    await expect(
      contradictorySelf.coordinator.requestDeviceRevoke({
        params: { device_id: "device_connection_phone" },
        body: {
          operation_id: "op_connection_device_self_contradiction",
          confirmed: true
        }
      })
    ).rejects.toMatchObject({ reason: "client_contract" });
    expect(contradictorySelf.coordinator.snapshot()).toMatchObject({
      access: { state: "stale" },
      host: { state: "blocked", data: null },
      targetState: { state: "blocked", data: null },
      csrf: { phase: "idle", invalidationReason: "device_revoked" },
      writeEligibility: { eligible: false }
    });
    contradictorySelf.coordinator.close();
  });

  it("adopts self-revoke before resolving and closes active protected authority", async () => {
    const harness = createHarness(remoteOrigin);
    const reader = new ControlledReader();
    harness.http.enqueue("access", jsonResponse(200, pairedAccess(remoteOrigin, "write")));
    harness.http.enqueue(
      "host",
      jsonResponse(
        200,
        hostStatus({ mode: "paired_write", origin: remoteOrigin, remoteGeneration: 7 })
      )
    );
    harness.http.enqueue(
      "detail",
      jsonResponse(
        200,
        sessionDetail("paired_write", remoteOrigin, sessionItem(firstSessionId))
      )
    );
    harness.http.enqueue("csrf", jsonResponse(200, csrfBootstrap(1)));
    await harness.coordinator.setTarget({
      kind: "session_detail",
      sessionId: firstSessionId
    });
    harness.sse.enqueue(async () => sseResponse(reader));
    harness.coordinator.connectSessionStream(() => {});
    await waitFor(() => harness.coordinator.snapshot().stream.state === "connected");
    harness.http.enqueue(
      "revoke",
      jsonResponse(200, {
        operation_id: "op_connection_device_self_001",
        device_id: "device_connection_phone",
        revoked_at: laterTimestamp,
        authority_invalidated: true,
        self_revoked: true
      })
    );

    const response = await harness.coordinator.requestDeviceRevoke({
      params: { device_id: "device_connection_phone" },
      body: { operation_id: "op_connection_device_self_001", confirmed: true }
    });
    const revoked = harness.coordinator.snapshot();

    expect(response.data.self_revoked).toBe(true);
    expect(revoked).toMatchObject({
      phase: "access_limited",
      access: {
        state: "current",
        data: {
          authentication_state: "revoked_device",
          device_id: null,
          permission: null,
          can_read_sessions: false,
          can_write_sessions: false
        }
      },
      host: { state: "blocked", data: null },
      targetState: { state: "blocked", data: null },
      stream: { state: "idle", boundary: null },
      csrf: { phase: "idle", invalidationReason: "device_revoked" },
      writeEligibility: { eligible: false, causes: ["revoked_device"] }
    });
    expect(reader.cancelCalls).toBe(1);
    await expect(
      harness.coordinator.requestHostLock({
        body: { operation_id: "op_connection_after_self_revoke", confirmed: true }
      })
    ).rejects.toMatchObject({ reason: "not_ready" });
    harness.coordinator.close();
  });

  it("fails closed after an unconfirmed self-revoke and after device-list authority denial", async () => {
    const failedSelf = createHarness(remoteOrigin);
    enqueueRemoteWriterMission(failedSelf, [], 7, 1);
    await failedSelf.coordinator.setTarget({ kind: "mission_control" });
    failedSelf.http.enqueue(
      "revoke",
      jsonResponse(503, apiError("runtime_unavailable", true))
    );

    await expect(
      failedSelf.coordinator.requestDeviceRevoke({
        params: { device_id: "device_connection_phone" },
        body: { operation_id: "op_connection_device_self_unknown", confirmed: true }
      })
    ).rejects.toMatchObject({ reason: "api_error" });
    expect(failedSelf.coordinator.snapshot()).toMatchObject({
      access: { state: "stale" },
      host: { state: "blocked", data: null },
      targetState: { state: "blocked", data: null },
      csrf: { phase: "idle", invalidationReason: "device_revoked" },
      writeEligibility: { eligible: false }
    });
    failedSelf.coordinator.close();

    const deniedList = createHarness(remoteOrigin);
    enqueueRemoteWriterMission(deniedList, [], 7, 1);
    await deniedList.coordinator.setTarget({ kind: "mission_control" });
    deniedList.http.enqueue(
      "devices",
      jsonResponse(403, apiError("permission_denied", false))
    );
    await expect(
      deniedList.coordinator.requestDeviceList({ query: { limit: "20" } })
    ).rejects.toMatchObject({ reason: "api_error" });
    expect(deniedList.coordinator.snapshot()).toMatchObject({
      access: { state: "stale" },
      host: { state: "blocked", data: null },
      targetState: { state: "blocked", data: null },
      csrf: { phase: "idle", invalidationReason: "access_lost" },
      writeEligibility: { eligible: false }
    });
    deniedList.coordinator.close();
  });

  it("bounds selected-session control reads to the current detail authority and epoch", async () => {
    const harness = createHarness(remoteOrigin);
    await expect(
      harness.coordinator.requestSelectedSessionRead("model_read", {
        params: { session_id: firstSessionId }
      })
    ).rejects.toMatchObject({ reason: "not_ready" });
    expect(harness.http.requests).toHaveLength(0);

    harness.http.enqueue("access", jsonResponse(200, pairedAccess(remoteOrigin, "write")));
    harness.http.enqueue(
      "host",
      jsonResponse(
        200,
        hostStatus({ mode: "paired_write", origin: remoteOrigin, remoteGeneration: 7 })
      )
    );
    harness.http.enqueue(
      "detail",
      jsonResponse(
        200,
        sessionDetail(
          "paired_write",
          remoteOrigin,
          sessionItem(firstSessionId)
        )
      )
    );
    harness.http.enqueue("csrf", jsonResponse(200, csrfBootstrap(1)));
    await harness.coordinator.setTarget({
      kind: "session_detail",
      sessionId: firstSessionId
    });

    harness.http.enqueue("detail", jsonResponse(200, modelSnapshot()));
    const response = await harness.coordinator.requestSelectedSessionRead(
      "model_read",
      { params: { session_id: firstSessionId } }
    );
    expect(response).toMatchObject({
      status: 200,
      data: { current: { model_id: "model-a" }, pending: null }
    });
    expect(harness.http.requests.at(-1)).toMatchObject({
      path: `/api/v1/sessions/${firstSessionId}/model`,
      init: { method: "GET" }
    });
    expect(harness.http.requests.at(-1)?.init).not.toHaveProperty("body");

    harness.http.enqueue("detail", jsonResponse(200, resumeMetadata()));
    const resumeResponse = await harness.coordinator.requestSelectedSessionRead(
      "session_resume_metadata",
      { params: { session_id: firstSessionId } }
    );
    expect(resumeResponse).toMatchObject({
      status: 200,
      data: {
        session_id: firstSessionId,
        local_only: true,
        available: true,
        launch: {
          args: ["resume", resumeThreadId]
        }
      }
    });
    expect(harness.http.requests.at(-1)).toMatchObject({
      path: `/api/v1/sessions/${firstSessionId}/resume`,
      init: {
        method: "GET",
        cache: "no-store",
        credentials: "same-origin",
        redirect: "error",
        referrerPolicy: "no-referrer"
      }
    });
    expect(harness.http.requests.at(-1)?.init).not.toHaveProperty("body");

    const exactResumeRequestCount = harness.http.requests.length;
    await expect(
      harness.coordinator.requestSelectedSessionRead("session_resume_metadata", {
        params: { session_id: firstSessionId },
        body: { command: "private" }
      } as never)
    ).rejects.toMatchObject({ reason: "client_contract" });
    await expect(
      harness.coordinator.requestSelectedSessionRead("session_resume_metadata", {
        params: { session_id: firstSessionId },
        query: { retry: "true" }
      } as never)
    ).rejects.toMatchObject({ reason: "client_contract" });
    expect(harness.http.requests).toHaveLength(exactResumeRequestCount);

    const event = selectedProjectionEventSchema.parse({
      session_id: firstSessionId,
      cursor: 1,
      captured_at: timestamp,
      upstream_at: null,
      codex_event_id: "codex-connection-event-1",
      codex_event_type: "item/message",
      content_state: "complete",
      content_notice: null,
      type: "message",
      role: "agent",
      phase: "completed",
      item_id: "item-connection-event-1",
      text: "One exact selected event."
    });
    harness.http.enqueue(
      "detail",
      jsonResponse(200, {
        session_id: firstSessionId,
        events: [event],
        next_cursor: 1,
        truncated: false
      })
    );
    const eventResponse = await harness.coordinator.requestSelectedSessionRead(
      "session_events",
      {
        params: { session_id: firstSessionId },
        query: { after: "0", limit: "1" }
      }
    );
    expect(eventResponse).toMatchObject({
      status: 200,
      data: { session_id: firstSessionId, events: [{ cursor: 1 }], next_cursor: 1 }
    });
    expect(harness.http.requests.at(-1)).toMatchObject({
      path: `/api/v1/sessions/${firstSessionId}/events?after=0&limit=1`,
      init: { method: "GET" }
    });
    expect(harness.http.requests.at(-1)?.init).not.toHaveProperty("body");

    const exactRequestCount = harness.http.requests.length;
    await expect(
      harness.coordinator.requestSelectedSessionRead("session_events", {
        params: { session_id: firstSessionId }
      } as never)
    ).rejects.toMatchObject({ reason: "client_contract" });
    await expect(
      harness.coordinator.requestSelectedSessionRead("session_events", {
        params: { session_id: firstSessionId },
        query: { limit: "1", unexpected: "private" }
      } as never)
    ).rejects.toMatchObject({ reason: "client_contract" });
    expect(harness.http.requests).toHaveLength(exactRequestCount);

    harness.http.enqueue("detail", jsonResponse(200, goalSnapshot()));
    const goalResponse = await harness.coordinator.requestSelectedSessionRead(
      "goal_read",
      { params: { session_id: firstSessionId } }
    );
    expect(goalResponse).toMatchObject({
      status: 200,
      data: { goal: { objective: "Validate selected goal authority." }, uncertain_mutation: null }
    });
    expect(harness.http.requests.at(-1)).toMatchObject({
      path: `/api/v1/sessions/${firstSessionId}/goal`,
      init: { method: "GET" }
    });
    expect(harness.http.requests.at(-1)?.init).not.toHaveProperty("body");

    const requestCount = harness.http.requests.length;
    await expect(
      harness.coordinator.requestSelectedSessionRead("model_read", {
        params: { session_id: secondSessionId }
      })
    ).rejects.toMatchObject({ reason: "not_ready" });
    await expect(
      harness.coordinator.requestSelectedSessionRead("host_status" as never, {
        params: { session_id: firstSessionId }
      } as never)
    ).rejects.toMatchObject({ reason: "client_contract" });
    expect(harness.http.requests).toHaveLength(requestCount);

    const late = deferred<BrowserHttpResponsePort>();
    harness.http.enqueue("detail", () => late.promise);
    const pending = harness.coordinator.requestSelectedSessionRead("session_resume_metadata", {
      params: { session_id: firstSessionId }
    });
    await settle();
    enqueueRemoteWriterMission(harness, [], 7, 2);
    await harness.coordinator.setTarget({ kind: "mission_control" });
    late.resolve(jsonResponse(200, resumeMetadata()));
    await expect(pending).rejects.toMatchObject({ reason: "not_ready" });
    harness.coordinator.close();
  });

  it("maps an access-route denial without starting protected reads", async () => {
    const harness = createHarness(remoteOrigin);
    harness.http.enqueue(
      "access",
      jsonResponse(403, apiError("permission_denied", false))
    );

    const snapshot = await harness.coordinator.setTarget({ kind: "mission_control" });

    expect(snapshot).toMatchObject({
      phase: "access_limited",
      access: {
        state: "failed",
        data: null,
        failure: { source: "access", status: 403 }
      },
      host: { state: "blocked", data: null },
      targetState: { state: "blocked", data: null },
      writeEligibility: { eligible: false, causes: ["permission_denied"] }
    });
    expect(harness.http.routeIds()).toEqual(["access"]);
    harness.coordinator.close();
  });

  it.each([
    ["invalid_device", "invalid_device"],
    ["expired_device", "expired_device"]
  ] as const)("publishes the exact %s write-block cause", async (state, cause) => {
    const harness = createHarness(remoteOrigin);
    harness.http.enqueue(
      "access",
      jsonResponse(200, deniedAccess(remoteOrigin, state))
    );

    const snapshot = await harness.coordinator.setTarget({ kind: "mission_control" });

    expect(snapshot).toMatchObject({
      phase: "access_limited",
      host: { state: "blocked", data: null },
      targetState: { state: "blocked", data: null },
      writeEligibility: { eligible: false, causes: [cause] }
    });
    expect(harness.http.routeIds()).toEqual(["access"]);
    harness.coordinator.close();
  });

  it("keeps a failed writer bootstrap degraded until explicit recovery", async () => {
    const harness = createHarness(remoteOrigin);
    harness.http.enqueue("access", jsonResponse(200, pairedAccess(remoteOrigin, "write")));
    harness.http.enqueue(
      "host",
      jsonResponse(
        200,
        hostStatus({ mode: "paired_write", origin: remoteOrigin, remoteGeneration: 7 })
      )
    );
    harness.http.enqueue(
      "list",
      jsonResponse(200, sessionList("paired_write", remoteOrigin, []))
    );
    harness.http.enqueue(
      "csrf",
      jsonResponse(503, apiError("runtime_unavailable", true))
    );

    const failed = await harness.coordinator.setTarget({ kind: "mission_control" });
    expect(failed).toMatchObject({
      phase: "degraded",
      csrf: { phase: "failed", failure: { reason: "api_error" } },
      lastFailure: { source: "csrf", reason: "api_error", status: 503 },
      writeEligibility: { eligible: false, causes: ["csrf_not_ready"] }
    });

    harness.http.enqueue("access", jsonResponse(200, pairedAccess(remoteOrigin, "write")));
    harness.http.enqueue(
      "host",
      jsonResponse(
        200,
        hostStatus({ mode: "paired_write", origin: remoteOrigin, remoteGeneration: 7 })
      )
    );
    harness.http.enqueue(
      "list",
      jsonResponse(200, sessionList("paired_write", remoteOrigin, []))
    );
    await harness.coordinator.refresh();
    expect(harness.http.routeIds().filter((route) => route === "csrf")).toHaveLength(1);

    harness.http.enqueue("csrf", jsonResponse(200, csrfBootstrap(1)));
    const recovered = await harness.coordinator.bootstrapCsrf();
    expect(recovered).toMatchObject({
      phase: "ready",
      csrf: { phase: "ready", generation: 1 },
      writeEligibility: { eligible: true }
    });
    harness.coordinator.close();
  });

  it("publishes a rejected CSRF adoption immediately and removes prior write authority", async () => {
    const harness = createHarness(remoteOrigin);
    enqueueRemoteWriterMission(harness, [], 7, 1);
    await harness.coordinator.setTarget({ kind: "mission_control" });

    expect(() =>
      harness.coordinator.adoptCsrfBootstrap({
        csrf_token: "short",
        csrf_generation: 2,
        rotated_at: laterTimestamp
      })
    ).toThrowError(expect.objectContaining({ reason: "client_contract" }));
    expect(harness.coordinator.snapshot()).toMatchObject({
      phase: "fatal",
      csrf: { phase: "failed", generation: null, failure: { reason: "client_contract" } },
      lastFailure: { source: "csrf", reason: "client_contract" },
      writeEligibility: { eligible: false, causes: ["csrf_not_ready"] }
    });
    expect(JSON.stringify(harness.coordinator.snapshot())).not.toContain(rawCsrfToken);
    harness.coordinator.close();
  });

  it("rejects a continuation beyond the 4,096-session inventory cap atomically", async () => {
    const items = Array.from({ length: 4_096 }, (_value, index) =>
      sessionItem(`sess_capacity_${String(index).padStart(4, "0")}`)
    );
    const harness = createHarness(loopbackOrigin);
    harness.http.enqueue("access", jsonResponse(200, loopbackAccess()));
    harness.http.enqueue(
      "host",
      jsonResponse(200, hostStatus({ mode: "loopback_read", origin: loopbackOrigin }))
    );
    for (let offset = 0; offset < items.length; offset += 100) {
      const page = items.slice(offset, offset + 100);
      harness.http.enqueue(
        "list",
        jsonResponse(200, sessionList("loopback_read", loopbackOrigin, page, true))
      );
    }

    await harness.coordinator.setTarget({ kind: "mission_control" });
    for (let page = 1; page < 41; page += 1) {
      await harness.coordinator.loadMoreSessions();
    }
    const capped = harness.coordinator.snapshot();
    expect(capped.targetState).toMatchObject({
      state: "stale",
      failure: { source: "session_list", reason: "page_mismatch" },
      data: { pageCount: 40, hasMore: true }
    });
    expect(missionIds(capped)).toHaveLength(4_000);
    expect(new Set(missionIds(capped)).size).toBe(4_000);
    await expect(harness.coordinator.loadMoreSessions()).rejects.toMatchObject({
      reason: "not_ready"
    });
    harness.coordinator.close();
  }, 60_000);

  it("installs request ownership before notifying a reentrant same-target subscriber", async () => {
    const harness = createHarness(loopbackOrigin);
    enqueueLoopbackMission(harness, []);
    let reentrant: Promise<unknown> | null = null;
    const unsubscribe = harness.coordinator.subscribe(() => {
      if (reentrant === null && harness.coordinator.snapshot().phase === "loading") {
        reentrant = harness.coordinator.setTarget({ kind: "mission_control" });
      }
    });

    const outer = harness.coordinator.setTarget({ kind: "mission_control" });
    expect(reentrant).toBe(outer);
    await outer;
    expect(harness.http.routeIds()).toEqual(["access", "host", "list"]);
    unsubscribe();
    harness.coordinator.close();
  });

  it("rejects invalid target, clock, and subscriber contracts before fetch", async () => {
    const harness = createHarness(loopbackOrigin, {
      connectionClock: Object.freeze({ now: () => Number.MAX_SAFE_INTEGER })
    });
    await expect(
      harness.coordinator.setTarget({ kind: "mission_control" })
    ).rejects.toMatchObject({ reason: "client_contract" });
    await expect(
      harness.coordinator.setTarget({
        kind: "session_detail",
        sessionId: "invalid session id"
      })
    ).rejects.toMatchObject({ reason: "client_contract" });
    expect(harness.http.requests).toHaveLength(0);
    expect(() => harness.coordinator.subscribe(null as never)).toThrow(
      HostDeckBrowserConnectionError
    );
    const listener = () => undefined;
    const unsubscribe = harness.coordinator.subscribe(listener);
    expect(() => harness.coordinator.subscribe(listener)).toThrow(
      HostDeckBrowserConnectionError
    );
    const unsubscribers = Array.from({ length: 31 }, () =>
      harness.coordinator.subscribe(() => undefined)
    );
    expect(() => harness.coordinator.subscribe(() => undefined)).toThrow(
      HostDeckBrowserConnectionError
    );
    unsubscribe();
    for (const release of unsubscribers) release();
    harness.coordinator.close();
  });
});

type HttpRouteId =
  | "access"
  | "host"
  | "remote"
  | "list"
  | "detail"
  | "csrf"
  | "devices"
  | "revoke"
  | "prompt"
  | "mutation";
type HttpHandler = (
  path: string,
  init: BrowserHttpRequestInit
) => BrowserHttpResponsePort | Promise<BrowserHttpResponsePort>;

class HttpRouter {
  readonly requests: Array<{
    readonly routeId: HttpRouteId;
    readonly path: string;
    readonly init: BrowserHttpRequestInit;
  }> = [];
  private readonly handlers = new Map<HttpRouteId, HttpHandler[]>();

  readonly fetch: BrowserHttpFetchPort = async (path, init) => {
    const routeId = httpRouteId(path, init.method);
    this.requests.push({ routeId, path, init });
    const handler = this.handlers.get(routeId)?.shift();
    if (handler === undefined) {
      throw new Error(`No test response is configured for ${routeId}.`);
    }
    return await handler(path, init);
  };

  enqueue(
    routeId: HttpRouteId,
    response: BrowserHttpResponsePort | HttpHandler
  ): void {
    const handlers = this.handlers.get(routeId) ?? [];
    handlers.push(
      typeof response === "function" ? response : () => response
    );
    this.handlers.set(routeId, handlers);
  }

  routeIds(): HttpRouteId[] {
    return this.requests.map((request) => request.routeId);
  }
}

type SseHandler = (
  path: string,
  init: BrowserSseRequestInit
) => BrowserSseResponsePort | Promise<BrowserSseResponsePort>;

class SseRouter {
  readonly requests: Array<{
    readonly path: string;
    readonly init: BrowserSseRequestInit;
  }> = [];
  readonly catalogRequests: Array<{
    readonly path: string;
    readonly init: BrowserSseRequestInit;
  }> = [];
  readonly catalogReaders: ControlledReader[] = [];
  private readonly handlers: SseHandler[] = [];

  readonly fetch = async (
    path: string,
    init: BrowserSseRequestInit
  ): Promise<BrowserSseResponsePort> => {
    if (path.startsWith("/api/v1/sessions/catalog/stream")) {
      const reader = new ControlledReader();
      this.catalogRequests.push({ path, init });
      this.catalogReaders.push(reader);
      return sseResponse(reader);
    }
    this.requests.push({ path, init });
    const handler = this.handlers.shift();
    if (handler === undefined) throw new Error("No SSE test response is configured.");
    return await handler(path, init);
  };

  enqueue(handler: SseHandler): void {
    this.handlers.push(handler);
  }
}

function createHarness(
  origin: string,
  options: {
    readonly connectionClock?: BrowserConnectionClockPort;
    readonly sseClock?: BrowserSseClockPort;
    readonly sseLimits?: BrowserSseClientLimits;
  } = {}
): {
  readonly coordinator: BrowserConnectionStateCoordinator;
  readonly http: HttpRouter;
  readonly sse: SseRouter;
  readonly httpClient: BrowserHttpClient;
  readonly csrfClient: ReturnType<typeof createBrowserCsrfClient>;
  readonly sseClient: ReturnType<typeof createBrowserSseClient>;
  readonly operationIds: number;
} {
  const http = new HttpRouter();
  const sse = new SseRouter();
  const httpClient = createBrowserHttpClient({ origin, fetch: http.fetch });
  let operationIds = 0;
  const csrfClient = createBrowserCsrfClient({
    httpClient,
    createOperationId: () => {
      operationIds += 1;
      return `op_connection_csrf_${String(operationIds).padStart(4, "0")}`;
    }
  });
  const sseClient = createBrowserSseClient({
    origin,
    fetch: sse.fetch,
    ...(options.sseClock === undefined ? {} : { clock: options.sseClock }),
    ...(options.sseLimits === undefined ? {} : { limits: options.sseLimits })
  });
  let now = Date.parse(timestamp);
  const connectionClock = options.connectionClock ??
    Object.freeze({ now: () => now++ });
  const coordinator = createBrowserConnectionStateCoordinator({
    httpClient,
    sseClient,
    csrfClient,
    origin,
    clock: connectionClock
  });
  return {
    coordinator,
    http,
    sse,
    httpClient,
    csrfClient,
    sseClient,
    get operationIds() {
      return operationIds;
    }
  };
}

function httpRouteId(path: string, method: "GET" | "POST"): HttpRouteId {
  if (path === "/api/v1/access" && method === "GET") return "access";
  if (path.startsWith("/api/v1/access/devices?") && method === "GET") return "devices";
  if (path === "/api/v1/access/devices" && method === "GET") return "devices";
  if (
    path.startsWith("/api/v1/access/devices/") &&
    path.endsWith("/revoke") &&
    method === "POST"
  ) {
    return "revoke";
  }
  if (path === "/api/v1/host/status" && method === "GET") return "host";
  if (path === "/api/v1/remote/status" && method === "GET") return "remote";
  if (path.startsWith("/api/v1/sessions?") || path === "/api/v1/sessions") return "list";
  if (path === "/api/v1/access/csrf" && method === "POST") return "csrf";
  if (path === "/api/v1/access/lock" && method === "POST") return "mutation";
  if (path.endsWith("/prompts") && method === "POST") return "prompt";
  if (path.startsWith("/api/v1/sessions/") && method === "GET") return "detail";
  throw new Error(`Unexpected browser HTTP route: ${method} ${path}`);
}

function loopbackAccess(): SelectedAccessStateResponse {
  return selectedAccessStateResponseSchema.parse({
    authentication_state: "unpaired",
    device_id: null,
    permission: null,
    device_expires_at: null,
    configured_origin: loopbackOrigin,
    network_mode: "loopback",
    transport: "http",
    locked: false,
    can_read_sessions: true,
    can_write_sessions: false,
    can_lock: false,
    can_unlock: false
  });
}

function localAdminAccess(): SelectedAccessStateResponse {
  return selectedAccessStateResponseSchema.parse({
    authentication_state: "local_admin",
    device_id: null,
    permission: "local_admin",
    device_expires_at: null,
    configured_origin: loopbackOrigin,
    network_mode: "loopback",
    transport: "http",
    locked: false,
    can_read_sessions: true,
    can_write_sessions: true,
    can_lock: true,
    can_unlock: true
  });
}

function pairedAccess(
  origin: string,
  permission: "read" | "write",
  locked = false
): SelectedAccessStateResponse {
  const remote = origin.startsWith("https:");
  return selectedAccessStateResponseSchema.parse({
    authentication_state: "paired_device",
    device_id: "device_connection_phone",
    permission,
    device_expires_at: "2026-08-22T18:00:00.000Z",
    configured_origin: origin,
    network_mode: remote ? "remote" : "loopback",
    transport: remote ? "https" : "http",
    locked,
    can_read_sessions: true,
    can_write_sessions: permission === "write" && !locked,
    can_lock: permission === "write",
    can_unlock: false
  });
}

function deniedAccess(
  origin: string,
  state: "unpaired" | "invalid_device" | "expired_device" | "revoked_device"
): SelectedAccessStateResponse {
  return selectedAccessStateResponseSchema.parse({
    authentication_state: state,
    device_id: null,
    permission: null,
    device_expires_at: null,
    configured_origin: origin,
    network_mode: "remote",
    transport: "https",
    locked: false,
    can_read_sessions: false,
    can_write_sessions: false,
    can_lock: false,
    can_unlock: false
  });
}

function hostStatus(options: {
  readonly mode: SelectedHostAccessMode;
  readonly origin: string;
  readonly localCause?:
    | "runtime_disconnected"
    | "runtime_incompatible"
    | "storage_unavailable";
  readonly remoteGeneration?: number;
}): SelectedHostStatusResponse {
  const components = selectedHostLocalHealthComponents.map((component) => {
    const override = localComponentOverride(component, options.localCause);
    return {
      component,
      state: override?.state ?? "ready",
      checked_at: timestamp,
      causes: override === null ? [] : [override.cause]
    };
  });
  const localState = options.localCause === undefined
    ? "ready"
    : options.localCause === "runtime_disconnected"
      ? "degraded"
      : "failed";
  const localReady = localState === "ready";
  const remote = options.origin.startsWith("https:")
    ? {
        generation: options.remoteGeneration ?? 1,
        state_generation: options.remoteGeneration ?? 1,
        availability: "ready" as const,
        cause: null,
        external_origin: options.origin,
        laptop_action_required: false,
        observed_at: timestamp,
        checked_at: timestamp,
        updated_at: timestamp
      }
    : {
        generation: 0,
        state_generation: null,
        availability: "unknown" as const,
        cause: "not_observed" as const,
        external_origin: null,
        laptop_action_required: true,
        observed_at: null,
        checked_at: null,
        updated_at: timestamp
      };
  const readOnly = options.mode === "loopback_read" || options.mode === "paired_read";
  const causes = [
    ...(readOnly ? ["read_only_access" as const] : []),
    ...(!localReady ? ["host_not_ready" as const] : [])
  ];
  return selectedHostStatusResponseSchema.parse({
    local: {
      generation: 1,
      state: localState,
      readiness: localReady ? "ready" : "not_ready",
      updated_at: timestamp,
      components,
      mutation_admission: localReady ? "open" : "closed"
    },
    compatibility: hostCompatibility(options.localCause),
    remote,
    access: {
      mode: options.mode,
      network_mode: options.origin.startsWith("https:") ? "remote" : "loopback",
      transport: options.origin.startsWith("https:") ? "https" : "http",
      write_eligibility: {
        scope: "host_health_and_authority",
        eligible: causes.length === 0,
        causes
      }
    }
  });
}

function localComponentOverride(
  component: SelectedHostLocalHealthComponent,
  cause: "runtime_disconnected" | "runtime_incompatible" | "storage_unavailable" | undefined
): {
  readonly state: SelectedHostLocalHealthState;
  readonly cause: SelectedHostLocalHealthCause;
} | null {
  switch (cause) {
    case "runtime_disconnected":
      if (component === "runtime") return { state: "degraded", cause };
      return component === "compatibility"
        ? { state: "degraded", cause: "compatibility_degraded" }
        : null;
    case "runtime_incompatible":
      if (component === "runtime") {
        return { state: "failed", cause: "runtime_failed" };
      }
      return component === "compatibility"
        ? { state: "failed", cause }
        : null;
    case "storage_unavailable":
      return component === "storage" ? { state: "failed", cause } : null;
    case undefined:
      return null;
  }
}

function hostCompatibility(
  cause: "runtime_disconnected" | "runtime_incompatible" | "storage_unavailable" | undefined
): SelectedHostStatusResponse["compatibility"] {
  if (cause === "runtime_disconnected") {
    return {
      state: "disconnected",
      evidence: "last_known",
      observed_version: "0.148.0",
      supported_version: "0.148.0",
      capability_state: "unverified",
      checked_at: compatibilityTimestamp,
      recorded_at: compatibilityTimestamp
    };
  }
  if (cause === "runtime_incompatible") {
    return {
      state: "incompatible",
      evidence: "current",
      observed_version: "0.148.0",
      supported_version: "0.148.0",
      capability_state: "blocked",
      checked_at: compatibilityTimestamp,
      recorded_at: compatibilityTimestamp
    };
  }
  return {
    state: "supported",
    evidence: "current",
    observed_version: "0.148.0",
    supported_version: "0.148.0",
    capability_state: "verified",
    checked_at: compatibilityTimestamp,
    recorded_at: compatibilityTimestamp
  };
}

function sessionItem(
  id: string,
  options: {
    readonly attention?: "none" | "watch";
    readonly activityAt?: string;
    readonly cursor?: number | null;
    readonly bounded?: boolean;
  } = {}
): SelectedSessionReadItem {
  const cursor = options.cursor ?? null;
  const session = managedSessionProjectionSchema.parse({
    id,
    name: id.slice(5),
    codex_thread_id: `thread-${id}`,
    cwd: `/workspace/${id}`,
    runtime_source: "codex_app_server",
    runtime_version: "0.148.0",
    created_at: timestamp,
    archived_at: null,
    session_state: "active",
    turn_state: "idle",
    attention: options.attention ?? "none",
    freshness: "current",
    freshness_reason: null,
    updated_at: options.activityAt ?? timestamp,
    last_activity_at: options.activityAt ?? timestamp,
    branch: "main",
    model: "gpt-5.5-codex",
    goal: null,
    recent_summary: "Bounded connection-state fixture.",
    last_event_cursor: cursor
  });
  return selectedSessionReadItemSchema.parse({
    session,
    event_window: cursor === null
      ? {
          state: "empty",
          retained_event_count: 0,
          earliest_retained_cursor: null,
          boundary_cursor: null
        }
      : {
          state: options.bounded === true ? "bounded" : "contiguous",
          retained_event_count: cursor,
          earliest_retained_cursor: 1,
          boundary_cursor: options.bounded === true ? 0 : null
        }
  });
}

function sessionAccess(
  mode: SelectedHostAccessMode,
  origin: string
): SelectedSessionReadAccess {
  return {
    mode,
    network_mode: origin.startsWith("https:") ? "remote" : "loopback",
    transport: origin.startsWith("https:") ? "https" : "http"
  };
}

function sessionList(
  mode: SelectedHostAccessMode,
  origin: string,
  sessions: readonly SelectedSessionReadItem[],
  hasMore = false,
  orderSnapshot = "a".repeat(64)
) {
  const final = sessions.at(-1);
  const nextCursor = hasMore && final !== undefined
    ? encodeSelectedSessionListCursor({
        order_snapshot: orderSnapshot,
        after: selectedSessionListSortKey(final.session)
      })
    : null;
  return selectedSessionListResponseSchema.parse({
    access: sessionAccess(mode, origin),
    sessions,
    next_cursor: nextCursor,
    has_more: hasMore
  });
}

function sessionDetail(
  mode: SelectedHostAccessMode,
  origin: string,
  session: SelectedSessionReadItem
) {
  return selectedSessionDetailResponseSchema.parse({
    access: sessionAccess(mode, origin),
    session
  });
}

function modelSnapshot() {
  return modelControlSnapshotSchema.parse({
    catalog_revision: "b".repeat(64),
    catalog_observed_at: timestamp,
    current: {
      model_id: "model-a",
      runtime_model: "runtime-a",
      reasoning_effort: "high",
      catalog_state: "available",
      observed_at: timestamp
    },
    pending: null,
    models: [
      {
        id: "model-a",
        runtime_model: "runtime-a",
        label: "Model A",
        description: null,
        is_default: true,
        input_modalities: ["text"],
        reasoning_efforts: [
          { id: "high", description: null, is_default: true }
        ]
      }
    ]
  });
}

function resumeMetadata() {
  const launch = {
    executable: "codex",
    args: ["resume", resumeThreadId]
  } as const;
  return selectedResumeMetadataResponseSchema.parse({
    session_id: firstSessionId,
    codex_thread_id: resumeThreadId,
    local_only: true,
    available: true,
    command: formatSelectedResumeLaunchCommand(launch),
    launch,
    unavailable_reason: null
  });
}

function goalSnapshot() {
  return goalControlSnapshotSchema.parse({
    goal: {
      revision: "d".repeat(64),
      objective: "Validate selected goal authority.",
      status: "paused",
      token_budget: null,
      tokens_used: 0,
      time_used_seconds: 0,
      created_at: timestamp,
      updated_at: timestamp
    },
    uncertain_mutation: null
  });
}

function enqueueLoopbackMission(
  harness: ReturnType<typeof createHarness>,
  sessions: readonly SelectedSessionReadItem[]
): void {
  harness.http.enqueue("access", jsonResponse(200, loopbackAccess()));
  harness.http.enqueue(
    "host",
    jsonResponse(200, hostStatus({ mode: "loopback_read", origin: loopbackOrigin }))
  );
  harness.http.enqueue(
    "list",
    jsonResponse(200, sessionList("loopback_read", loopbackOrigin, sessions))
  );
}

function enqueueRemoteWriterMission(
  harness: ReturnType<typeof createHarness>,
  sessions: readonly SelectedSessionReadItem[],
  remoteGeneration: number,
  csrfGeneration: number
): void {
  harness.http.enqueue("access", jsonResponse(200, pairedAccess(remoteOrigin, "write")));
  harness.http.enqueue(
    "host",
    jsonResponse(
      200,
      hostStatus({ mode: "paired_write", origin: remoteOrigin, remoteGeneration })
    )
  );
  harness.http.enqueue(
    "list",
    jsonResponse(200, sessionList("paired_write", remoteOrigin, sessions))
  );
  harness.http.enqueue("csrf", jsonResponse(200, csrfBootstrap(csrfGeneration)));
}

function deviceListPage(deviceIds: readonly string[]) {
  return {
    devices: deviceIds.map((deviceId) => ({
      device_id: deviceId,
      client_label: deviceId === "device_connection_phone" ? "Xiaomi 15 Pro" : "Laptop browser",
      permission: "write",
      created_at: timestamp,
      last_used_at: timestamp,
      expires_at: "2026-08-22T18:00:00.000Z",
      revoked_at: null
    })),
    next_cursor: null,
    has_more: false
  };
}

function csrfBootstrap(generation: number) {
  return {
    csrf_token: generation === 1 ? rawCsrfToken : "D".repeat(43),
    csrf_generation: generation,
    rotated_at: generation === 1 ? timestamp : laterTimestamp
  };
}

function remoteStatus(generation: number) {
  return remoteIngressPublicStateSchema.parse({
    generation,
    availability: "ready",
    reason: null,
    external_origin: remoteOrigin,
    laptop_action_required: false,
    observed_at: timestamp
  });
}

function apiError(code: string, retryable: boolean) {
  return {
    error: {
      code,
      message: "Bounded connection-state fixture failure.",
      retryable
    }
  };
}

function jsonResponse(status: number, payload: unknown): BrowserHttpResponsePort {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  let read = false;
  return Object.freeze({
    status,
    ok: status >= 200 && status < 300,
    headers: Object.freeze({
      get(name: string) {
        if (name.toLowerCase() === "content-type") return "application/json";
        if (name.toLowerCase() === "content-length") return String(bytes.byteLength);
        return null;
      }
    }),
    body: Object.freeze({
      getReader() {
        return Object.freeze({
          async read() {
            if (read) return Object.freeze({ done: true as const });
            read = true;
            return Object.freeze({ done: false as const, value: bytes });
          },
          async cancel() {
            read = true;
          },
          releaseLock() {}
        });
      }
    })
  });
}

class ControlledReader implements BrowserSseBodyReaderPort {
  private readonly queued: Array<
    | { readonly done: false; readonly value: Uint8Array }
    | { readonly done: true }
  > = [];
  private readonly waiting: Array<
    (value: { readonly done: boolean; readonly value?: Uint8Array }) => void
  > = [];
  cancelCalls = 0;
  releaseCalls = 0;

  read(): Promise<{ readonly done: boolean; readonly value?: Uint8Array }> {
    const next = this.queued.shift();
    if (next !== undefined) return Promise.resolve(next);
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  async cancel(): Promise<void> {
    this.cancelCalls += 1;
    while (this.waiting.length > 0) this.waiting.shift()?.({ done: true });
  }

  releaseLock(): void {
    this.releaseCalls += 1;
  }

  pushText(value: string): void {
    const next = { done: false as const, value: new TextEncoder().encode(value) };
    const waiting = this.waiting.shift();
    if (waiting === undefined) this.queued.push(next);
    else waiting(next);
  }

  end(): void {
    const next = { done: true as const };
    const waiting = this.waiting.shift();
    if (waiting === undefined) this.queued.push(next);
    else waiting(next);
  }
}

function sseResponse(reader: ControlledReader): BrowserSseResponsePort {
  return {
    status: 200,
    ok: true,
    headers: {
      get(name: string) {
        return name.toLowerCase() === "content-type" ? "text/event-stream" : null;
      }
    },
    body: {
      getReader() {
        return reader;
      }
    }
  };
}

function messageEvent(sessionId: string, cursor: number): SelectedProjectionEvent {
  return selectedProjectionEventSchema.parse({
    session_id: sessionId,
    cursor,
    captured_at: timestamp,
    upstream_at: null,
    codex_event_id: null,
    codex_event_type: null,
    content_state: "complete",
    content_notice: null,
    type: "message",
    role: "agent",
    phase: "completed",
    item_id: null,
    text: `message-${cursor}`
  });
}

function catalogReset(
  cursor: number,
  expectedSessionCount: number,
  streamId = catalogStreamA
): SessionCatalogEvent {
  return sessionCatalogEventSchema.parse({
    stream_id: streamId,
    cursor,
    emitted_at: timestamp,
    type: "catalog_reset",
    reason: "initial",
    expected_session_count: expectedSessionCount
  });
}

function catalogUpsert(
  cursor: number,
  suffix: "a" | "b",
  options: {
    readonly attention?: "none" | "watch";
    readonly summary?: string;
    readonly updatedAt?: string;
  } = {},
  streamId = catalogStreamA
): SessionCatalogEvent {
  return sessionCatalogEventSchema.parse({
    stream_id: streamId,
    cursor,
    emitted_at: timestamp,
    type: "session_upsert",
    session: catalogConnectionEntry(suffix, options)
  });
}

function catalogReady(
  cursor: number,
  sessionCount: number,
  streamId = catalogStreamA
): SessionCatalogEvent {
  return sessionCatalogEventSchema.parse({
    stream_id: streamId,
    cursor,
    emitted_at: timestamp,
    type: "catalog_ready",
    session_count: sessionCount,
    endpoint_generation: 7
  });
}

function catalogRemove(
  cursor: number,
  suffix: "a" | "b",
  streamId = catalogStreamA
): SessionCatalogEvent {
  return sessionCatalogEventSchema.parse({
    stream_id: streamId,
    cursor,
    emitted_at: timestamp,
    type: "session_remove",
    native_thread_id: catalogNativeId(suffix),
    internal_session_id: `sess_catalog_connection_${suffix}`,
    reason: "archived"
  });
}

function catalogBoundary(
  cursor: number,
  streamId = catalogStreamA
): SessionCatalogEvent {
  return sessionCatalogEventSchema.parse({
    stream_id: streamId,
    cursor,
    emitted_at: timestamp,
    type: "catalog_boundary",
    reason: "lag",
    reset_required: true,
    detail: "Catalog receiver must reconnect."
  });
}

function catalogSessionItem(
  suffix: "a" | "b",
  options: {
    readonly attention?: "none" | "watch";
    readonly summary?: string;
    readonly updatedAt?: string;
  } = {}
): SelectedSessionReadItem {
  return selectedSessionReadItemSchema.parse({
    session: catalogConnectionEntry(suffix, options).projection,
    event_window: {
      state: "empty",
      retained_event_count: 0,
      earliest_retained_cursor: null,
      boundary_cursor: null
    }
  });
}

function catalogConnectionEntry(
  suffix: "a" | "b",
  options: {
    readonly attention?: "none" | "watch";
    readonly summary?: string;
    readonly updatedAt?: string;
  } = {}
): SharedSessionCatalogEntry {
  const sessionId = `sess_catalog_connection_${suffix}`;
  const nativeThreadId = catalogNativeId(suffix);
  const updatedAt = options.updatedAt ?? timestamp;
  return sharedSessionCatalogEntrySchema.parse({
    tracked: {
      native_thread_id: nativeThreadId,
      internal_session_id: sessionId,
      alias: `catalog-connection-${suffix}`,
      cwd: `/workspace/catalog-connection-${suffix}`,
      project_cue: `catalog-connection-${suffix}`,
      branch: "main",
      runtime_version: "0.148.0",
      runtime_source: "codex_app_server",
      enrollment_origin: "loaded_before",
      archived: false,
      created_at: timestamp,
      updated_at: updatedAt,
      archived_at: null
    },
    projection: {
      id: sessionId,
      name: `catalog-connection-${suffix}`,
      codex_thread_id: nativeThreadId,
      cwd: `/workspace/catalog-connection-${suffix}`,
      runtime_source: "codex_app_server",
      runtime_version: "0.148.0",
      created_at: timestamp,
      archived_at: null,
      session_state: "active",
      turn_state: "idle",
      attention: options.attention ?? "none",
      freshness: "current",
      freshness_reason: null,
      updated_at: updatedAt,
      last_activity_at: updatedAt,
      branch: "main",
      model: "gpt-5.5-codex",
      settings: null,
      goal: null,
      recent_summary: options.summary ?? "Catalog connection fixture.",
      last_event_cursor: null
    }
  });
}

function catalogNativeId(suffix: "a" | "b"): string {
  return suffix === "a"
    ? "019fc8bd-25ef-74c3-a3bf-c6e59e4122a4"
    : "019fc8c8-f71a-7080-9d4d-d5cdbe484587";
}

function eventFrame(event: SelectedProjectionEvent | SessionCatalogEvent): string {
  return `id: ${String(event.cursor)}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

class ManualSseClock {
  readonly port: BrowserSseClockPort;
  private value = Date.parse(timestamp);
  private sequence = 0;
  private readonly timers = new Map<
    number,
    { readonly at: number; readonly callback: () => void }
  >();

  constructor() {
    this.port = Object.freeze({
      now: () => this.value,
      setTimeout: (callback: () => void, delayMs: number) => {
        const handle = ++this.sequence;
        this.timers.set(handle, { at: this.value + delayMs, callback });
        return handle;
      },
      clearTimeout: (handle: unknown) => {
        if (typeof handle === "number") this.timers.delete(handle);
      }
    });
  }

  advance(delayMs: number): void {
    const target = this.value + delayMs;
    while (true) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (next === undefined) break;
      this.value = next[1].at;
      this.timers.delete(next[0]);
      next[1].callback();
    }
    this.value = target;
  }

  get pendingCount(): number {
    return this.timers.size;
  }
}

function missionIds(snapshot: ReturnType<BrowserConnectionStateCoordinator["snapshot"]>): string[] {
  return snapshot.targetState.data?.kind === "mission_control"
    ? snapshot.targetState.data.sessions.map((item) => item.session.id)
    : [];
}

function requireCatalogReader(router: SseRouter, index: number): ControlledReader {
  const reader = router.catalogReaders[index];
  if (reader === undefined) throw new Error("Expected catalog SSE reader.");
  return reader;
}

function deferred<Value>(): {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolve!: (value: Value) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return Object.freeze({ promise, resolve, reject });
}

async function settle(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await settle();
  }
  throw new Error("Timed out waiting for browser connection state.");
}
