import {
  encodeSelectedSessionListCursor,
  managedSessionProjectionSchema,
  type SelectedAccessStateResponse,
  type SelectedHostAccessMode,
  type SelectedHostLocalHealthCause,
  type SelectedHostLocalHealthComponent,
  type SelectedHostLocalHealthState,
  type SelectedHostStatusResponse,
  type SelectedProjectionEvent,
  type SelectedSessionReadAccess,
  type SelectedSessionReadItem,
  selectedAccessStateResponseSchema,
  selectedHostLocalHealthComponents,
  selectedHostStatusResponseSchema,
  selectedProjectionEventSchema,
  selectedSessionDetailResponseSchema,
  selectedSessionListResponseSchema,
  selectedSessionListSortKey,
  selectedSessionReadItemSchema
} from "@hostdeck/contracts";
import {
  type BrowserSseClientLimits,
  defaultBrowserSseClientLimits
} from "@hostdeck/contracts/browser-sse-resource-policy";
import { describe, expect, it } from "vitest";
import {
  type BrowserConnectionClockPort,
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
const laterTimestamp = "2026-07-22T18:01:00.000Z";
const rawCsrfToken = "C".repeat(43);
const firstSessionId = "sess_connection_001";
const secondSessionId = "sess_connection_002";

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
    expect(sseClock.pendingCount).toBe(1);
    harness.coordinator.close();
    expect(sseClock.pendingCount).toBe(0);
  });

  it("gates protected mutations and never retries an explicit failure", async () => {
    const harness = createHarness(remoteOrigin);
    await expect(
      harness.coordinator.requestProtected("host_lock", {
        body: { operation_id: "op_connection_early_lock", confirmed: true }
      })
    ).rejects.toMatchObject({ reason: "not_ready" });

    enqueueRemoteWriterMission(harness, [], 7, 1);
    await harness.coordinator.setTarget({ kind: "mission_control" });
    harness.http.enqueue(
      "mutation",
      jsonResponse(503, apiError("runtime_unavailable", true))
    );
    await expect(
      harness.coordinator.requestProtected("host_lock", {
        body: { operation_id: "op_connection_failed_lock", confirmed: true }
      })
    ).rejects.toMatchObject({ reason: "api_error" });
    expect(harness.http.routeIds().filter((route) => route === "mutation")).toHaveLength(1);
    expect(harness.coordinator.snapshot()).toMatchObject({
      lastFailure: { source: "csrf", reason: "api_error", status: 503 },
      writeEligibility: { eligible: true }
    });

    harness.http.enqueue(
      "mutation",
      jsonResponse(403, apiError("permission_denied", false))
    );
    await expect(
      harness.coordinator.requestProtected("host_lock", {
        body: { operation_id: "op_connection_denied_lock", confirmed: true }
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
  }, 20_000);

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

type HttpRouteId = "access" | "host" | "list" | "detail" | "csrf" | "mutation";
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
  private readonly handlers: SseHandler[] = [];

  readonly fetch = async (
    path: string,
    init: BrowserSseRequestInit
  ): Promise<BrowserSseResponsePort> => {
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
  if (path === "/api/v1/host/status" && method === "GET") return "host";
  if (path.startsWith("/api/v1/sessions?") || path === "/api/v1/sessions") return "list";
  if (path === "/api/v1/access/csrf" && method === "POST") return "csrf";
  if (path === "/api/v1/access/lock" && method === "POST") return "mutation";
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
  const componentOverride = localComponentOverride(options.localCause);
  const components = selectedHostLocalHealthComponents.map((component) => {
    const override = componentOverride?.component === component
      ? componentOverride
      : null;
    return {
      component,
      state: override?.state ?? "ready",
      checked_at: timestamp,
      causes: override === null ? [] : [override.cause]
    };
  });
  const localState = componentOverride?.state ?? "ready";
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
  cause: "runtime_disconnected" | "runtime_incompatible" | "storage_unavailable" | undefined
): {
  readonly component: SelectedHostLocalHealthComponent;
  readonly state: SelectedHostLocalHealthState;
  readonly cause: SelectedHostLocalHealthCause;
} | null {
  switch (cause) {
    case "runtime_disconnected":
      return { component: "runtime", state: "degraded", cause };
    case "runtime_incompatible":
      return { component: "compatibility", state: "failed", cause };
    case "storage_unavailable":
      return { component: "storage", state: "failed", cause };
    case undefined:
      return null;
  }
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
    runtime_version: "0.144.0",
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

function csrfBootstrap(generation: number) {
  return {
    csrf_token: generation === 1 ? rawCsrfToken : "D".repeat(43),
    csrf_generation: generation,
    rotated_at: generation === 1 ? timestamp : laterTimestamp
  };
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

function eventFrame(event: SelectedProjectionEvent): string {
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
