import { Buffer } from "node:buffer";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  codexItemIdSchema,
  defaultResourceBudget,
  defaultRetentionPolicy,
  isoTimestampSchema,
  type ResourceBudget,
  type RetentionPolicy,
  resolveResourceBudget,
  type SelectedEventPageInput,
  type SelectedProjectionEvent,
  selectedEventPageResponseSchema,
  selectedProjectionEventSchema
} from "@hostdeck/contracts";
import {
  createProductionProjectionAppendPort,
  createSelectedStateRepository,
  HostDeckAuthRepositoryError,
  openMigratedDatabase,
  type SelectedStateRepository,
  selectedStateRevision
} from "@hostdeck/storage";
import { afterEach, describe, expect, it } from "vitest";
import {
  createHostDeckFastifyApp,
  createHostDeckTailscaleServeFastifyApp,
  type HostDeckFastifyInstance
} from "./fastify-app.js";
import type { HostDeckInternalErrorObservation } from "./fastify-error-policy.js";
import {
  createHostDeckRequestAuthenticationPolicy,
  type HostDeckDeviceAuthenticationPort,
  hostDeckDeviceCookieName
} from "./fastify-request-authentication.js";
import {
  createHostDeckRequestTrustPolicy,
  type HostDeckRequestTrustPolicy
} from "./fastify-request-trust.js";
import {
  createHostDeckProjectedEventRouteRegistration,
  type HostDeckProjectedEventStatePort,
  hostDeckProjectedEventRouteRegistrationId
} from "./projected-event-routes.js";
import { createTailscaleServeProxyTrustPolicy } from "./tailscale-serve-proxy-trust.js";

const roots: string[] = [];
const apps: HostDeckFastifyInstance[] = [];
const databases: Array<{ close: () => unknown }> = [];
const sessionId = "sess_event_route_001";
const createdAt = "2026-07-15T12:00:00.000Z";
const readToken = "R".repeat(43);
const writeToken = "W".repeat(43);
const expiredToken = "E".repeat(43);
const storageToken = "S".repeat(43);
const loopbackOrigin = "http://localhost";
const remoteLocalOrigin = "http://127.0.0.1:3777";
const externalOrigin = "https://hostdeck-events.fixture-tailnet.ts.net";
const remoteSource = "100.90.80.70";
const loopbackTrustPolicy = createHostDeckRequestTrustPolicy({
  allowedOrigins: [loopbackOrigin],
  mode: "loopback",
  transport: "http"
});

afterEach(async () => {
  for (const app of apps.splice(0).reverse()) await app.close();
  for (const database of databases.splice(0).reverse()) database.close();
  for (const root of roots.splice(0).reverse()) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("selected projected-event diagnostic read route", () => {
  it("requires one exact accessor-free state port and snapshots both methods", async () => {
    let observedThis: unknown = "not-called";
    const state = fakeStatePort({
      listEvents: function listEvents(this: void) {
        observedThis = this;
        return eventPage([messageEvent(1)]);
      }
    });
    const registration = createHostDeckProjectedEventRouteRegistration({ state });
    expect(registration).toMatchObject({
      id: hostDeckProjectedEventRouteRegistrationId,
      surface: "api"
    });
    expect(Object.isFrozen(registration)).toBe(true);

    const mutable = {
      listEvents: state.listEvents,
      require: state.require
    };
    const snapshotted = createHostDeckProjectedEventRouteRegistration({
      state: mutable
    });
    mutable.listEvents = () => {
      throw new Error("mutated-list-private-sentinel");
    };
    mutable.require = () => {
      throw new Error("mutated-require-private-sentinel");
    };
    const app = createEventAppFromRegistration(snapshotted);
    await app.ready();
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/sessions/${sessionId}/events`
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(observedThis).toBeUndefined();

    const nullState = Object.assign(Object.create(null) as Record<string, unknown>, {
      listEvents: state.listEvents,
      require: state.require
    });
    const nullInput = Object.assign(Object.create(null) as Record<string, unknown>, {
      state: nullState
    });
    expect(() =>
      createHostDeckProjectedEventRouteRegistration(nullInput as never)
    ).not.toThrow();

    let accessorCalls = 0;
    const inputAccessor = Object.defineProperty({}, "state", {
      enumerable: true,
      get() {
        accessorCalls += 1;
        throw new Error("input-accessor-private-sentinel");
      }
    });
    const portAccessor = Object.defineProperty({}, "listEvents", {
      enumerable: true,
      get() {
        accessorCalls += 1;
        throw new Error("port-accessor-private-sentinel");
      }
    });
    Object.defineProperty(portAccessor, "require", {
      enumerable: true,
      value: state.require
    });
    const hostileProxy = new Proxy(
      { state },
      {
        ownKeys() {
          throw new Error("proxy-private-sentinel");
        }
      }
    );
    for (const candidate of [
      null,
      [],
      {},
      { state, extra: true },
      Object.assign(Object.create({ inherited: true }), { state }),
      { state: null },
      { state: {} },
      { state: { ...state, extra: true } },
      { state: { listEvents: null, require: state.require } },
      { state: { listEvents: state.listEvents, require: null } },
      inputAccessor,
      { state: portAccessor },
      hostileProxy
    ]) {
      expect(() =>
        createHostDeckProjectedEventRouteRegistration(candidate as never)
      ).toThrow(TypeError);
    }
    expect(accessorCalls).toBe(0);
  });

  it("binds the exact canonical no-store page surface and no adjacent methods", async () => {
    const calls: SelectedEventPageInput[] = [];
    let requireCalls = 0;
    const allEvents = [messageEvent(1), messageEvent(2)];
    const state = fakeStatePort({
      events: allEvents,
      onList(input) {
        calls.push(input);
      },
      onRequire() {
        requireCalls += 1;
      }
    });
    const app = createEventApp(state);
    await app.ready();

    const first = await app.inject({
      method: "GET",
      url: `/api/v1/sessions/${sessionId}/events`
    });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.headers["cache-control"]).toBe("no-store");
    expect(first.headers["content-type"]).toContain("application/json");
    expect(first.json()).toEqual(eventPage(allEvents));
    expect(calls[0]).toEqual({ after: null, limit: 100 });
    expect(Object.isFrozen(calls[0])).toBe(true);

    const second = await app.inject({
      method: "GET",
      url: `/api/v1/sessions/${sessionId}/events?after=1&limit=1`
    });
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json()).toEqual(eventPage([allEvents[1] as SelectedProjectionEvent]));
    expect(calls[1]).toEqual({ after: 1, limit: 1 });
    expect(requireCalls).toBe(4);

    const callsBeforeMalformed = calls.length;
    for (const suffix of [
      "?after=00",
      "?after=3",
      "?after=1&after=1",
      "?limit=0",
      "?limit=01",
      "?limit=101",
      "?limit=1&limit=2",
      "?cursor=1"
    ]) {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/sessions/${sessionId}/events${suffix}`
      });
      expectStableError(
        response,
        suffix === "?after=3" ? 409 : 400,
        suffix === "?after=3" ? "stale_session" : "validation_error",
        suffix === "?after=3" ? "after" : "query"
      );
      expect(response.headers["cache-control"]).toBe("no-store");
    }
    expect(calls).toHaveLength(callsBeforeMalformed);

    expectStableError(
      await app.inject({
        method: "GET",
        url: "/api/v1/sessions/session%20with%20spaces/events"
      }),
      400,
      "validation_error",
      "params"
    );
    expectStableError(
      await app.inject({
        method: "HEAD",
        url: `/api/v1/sessions/${sessionId}/events`
      }),
      405,
      "method_not_allowed"
    );
    expectStableError(
      await app.inject({
        method: "POST",
        url: `/api/v1/sessions/${sessionId}/events`
      }),
      405,
      "method_not_allowed"
    );
    expectStableError(
      await app.inject({
        method: "GET",
        url: `/api/v1/sessions/${sessionId}/events/`
      }),
      404,
      "route_not_found"
    );
    expectStableError(
      await app.inject({
        method: "GET",
        url: `/api/v1/sessions/${sessionId}/Events`
      }),
      404,
      "route_not_found"
    );
  });

  it("authenticates before query validation and storage for paired credential states", async () => {
    let listCalls = 0;
    let requireCalls = 0;
    let authCalls = 0;
    const state = fakeStatePort({
      events: [messageEvent(1)],
      onList() {
        listCalls += 1;
      },
      onRequire() {
        requireCalls += 1;
      }
    });
    const app = createEventApp(state, {
      authenticateDeviceToken({ rawDeviceToken }) {
        authCalls += 1;
        if (rawDeviceToken === readToken) {
          return authenticatedDevice("read", "client_event_reader");
        }
        if (rawDeviceToken === writeToken) {
          return authenticatedDevice("write", "client_event_writer");
        }
        if (rawDeviceToken === expiredToken) {
          throw new HostDeckAuthRepositoryError(
            "device_expired",
            "expired-auth-private-sentinel"
          );
        }
        if (rawDeviceToken === storageToken) {
          throw new Error("auth-storage-private-sentinel");
        }
        throw new HostDeckAuthRepositoryError(
          "device_not_found",
          "unknown-auth-private-sentinel"
        );
      }
    });
    await app.ready();

    const local = await app.inject({
      method: "GET",
      url: `/api/v1/sessions/${sessionId}/events`
    });
    expect(local.statusCode, local.body).toBe(200);
    for (const token of [readToken, writeToken]) {
      const paired = await app.inject({
        method: "GET",
        url: `/api/v1/sessions/${sessionId}/events`,
        headers: deviceCookie(token)
      });
      expect(paired.statusCode, paired.body).toBe(200);
    }
    expect(listCalls).toBe(3);
    expect(requireCalls).toBe(6);

    for (const token of [expiredToken, "U".repeat(43)]) {
      const denied = await app.inject({
        method: "GET",
        url: `/api/v1/sessions/${sessionId}/events?limit=0`,
        headers: deviceCookie(token)
      });
      expectStableError(denied, 401, "permission_denied");
      expect(denied.body).not.toMatch(/private|auth|cookie|token/iu);
    }
    const storage = await app.inject({
      method: "GET",
      url: `/api/v1/sessions/${sessionId}/events`,
      headers: deviceCookie(storageToken)
    });
    expectStableError(storage, 500, "storage_error");
    expect(storage.body).not.toContain("auth-storage-private-sentinel");

    const duplicate = await app.inject({
      method: "GET",
      url: `/api/v1/sessions/${sessionId}/events`,
      headers: {
        cookie: `${hostDeckDeviceCookieName}=${readToken}; ${hostDeckDeviceCookieName}=${readToken}`
      }
    });
    expectStableError(duplicate, 401, "permission_denied");
    expect(listCalls).toBe(3);
    expect(requireCalls).toBe(6);
    expect(authCalls).toBe(5);
  });

  it("requires app pairing inside admitted Tailscale Serve context", async () => {
    let listCalls = 0;
    let requireCalls = 0;
    const state = fakeStatePort({
      events: [messageEvent(1)],
      onList() {
        listCalls += 1;
      },
      onRequire() {
        requireCalls += 1;
      }
    });
    const app = createHostDeckTailscaleServeFastifyApp({
      observeInternalError: () => undefined,
      requestAuthenticationPolicy: createHostDeckRequestAuthenticationPolicy({
        authenticateDeviceToken({ rawDeviceToken }) {
          if (rawDeviceToken === readToken) {
            return authenticatedDevice("read", "client_remote_event_reader");
          }
          throw new HostDeckAuthRepositoryError(
            "device_not_found",
            "remote-auth-private-sentinel"
          );
        },
        now: () => new Date(createdAt)
      }),
      resourceBudget: defaultResourceBudget,
      routePlugins: [createHostDeckProjectedEventRouteRegistration({ state })],
      tailscaleServeProxyTrustPolicy: createTailscaleServeProxyTrustPolicy({
        localOrigin: remoteLocalOrigin,
        readRemoteAdmission: () => ({
          admission: "open",
          external_origin: externalOrigin,
          generation: 7
        })
      })
    });
    apps.push(app);
    await app.ready();

    const unpaired = await app.inject({
      method: "GET",
      url: `/api/v1/sessions/${sessionId}/events?limit=0`,
      headers: remoteHeaders({ identity: true })
    });
    expectStableError(unpaired, 401, "permission_denied");
    for (const forbidden of [
      "identity-does-not-authorize@example.test",
      "Identity Does Not Authorize",
      "remote-auth-private-sentinel",
      remoteSource,
      externalOrigin
    ]) {
      expect(unpaired.body).not.toContain(forbidden);
    }
    expect(listCalls).toBe(0);
    expect(requireCalls).toBe(0);

    const paired = await app.inject({
      method: "GET",
      url: `/api/v1/sessions/${sessionId}/events`,
      headers: remoteHeaders({ cookie: readToken, identity: true })
    });
    expect(paired.statusCode, paired.body).toBe(200);
    expect(paired.headers["cache-control"]).toBe("no-store");
    expect(listCalls).toBe(1);
    expect(requireCalls).toBe(2);
  });

  it("reads normal, empty, paged, missing, future, archived, and recovery states", async () => {
    const harness = await createSqliteHarness();
    await appendMessages(harness.repository, 3);
    const app = createEventApp(selectedStatePort(harness.repository));
    await app.ready();

    const first = await app.inject({
      method: "GET",
      url: `/api/v1/sessions/${sessionId}/events?limit=2`
    });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({
      session_id: sessionId,
      next_cursor: 2,
      truncated: false
    });
    expect(first.json().events.map((event: { cursor: number }) => event.cursor)).toEqual([
      1, 2
    ]);

    const second = await app.inject({
      method: "GET",
      url: `/api/v1/sessions/${sessionId}/events?after=2&limit=2`
    });
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json().events.map((event: { cursor: number }) => event.cursor)).toEqual([
      3
    ]);
    expect(second.json().next_cursor).toBe(3);

    const current = await app.inject({
      method: "GET",
      url: `/api/v1/sessions/${sessionId}/events?after=3`
    });
    expect(current.statusCode, current.body).toBe(200);
    expect(current.json()).toEqual({
      session_id: sessionId,
      events: [],
      next_cursor: 3,
      truncated: false
    });

    expectStableError(
      await app.inject({
        method: "GET",
        url: "/api/v1/sessions/sess_event_route_missing/events"
      }),
      404,
      "session_not_found"
    );
    expectStableError(
      await app.inject({
        method: "GET",
        url: `/api/v1/sessions/${sessionId}/events?after=4`
      }),
      409,
      "stale_session",
      "after"
    );

    for (const state of [
      fakeStatePort({ archived: true }),
      fakeStatePort({ recoveryRequired: true })
    ]) {
      let listCalls = 0;
      const guarded: HostDeckProjectedEventStatePort = {
        require: state.require,
        listEvents(...args) {
          listCalls += 1;
          return state.listEvents(...args);
        }
      };
      const guardedApp = createEventApp(guarded);
      await guardedApp.ready();
      const response = await guardedApp.inject({
        method: "GET",
        url: `/api/v1/sessions/${sessionId}/events`
      });
      expectStableError(response, 409, "stale_session");
      expect(listCalls).toBe(0);
    }
  });

  it("returns exactly one durable retention boundary and does not repeat it", async () => {
    const initialBoundaryApp = createEventApp(
      fakeStatePort({ events: [replayBoundaryEvent(1, null, "disconnect")] })
    );
    await initialBoundaryApp.ready();
    const fromZero = await initialBoundaryApp.inject({
      method: "GET",
      url: `/api/v1/sessions/${sessionId}/events?after=0`
    });
    expect(fromZero.statusCode, fromZero.body).toBe(200);
    expect(fromZero.json()).toMatchObject({
      next_cursor: 1,
      truncated: true,
      events: [{ type: "replay_boundary", after: null, reason: "disconnect" }]
    });

    const harness = await createSqliteHarness();
    await appendMessages(harness.repository, 6, {
      ...defaultRetentionPolicy,
      output_event_limit: 3
    });
    const durable = harness.repository.require(sessionId);
    expect(durable.projection).toMatchObject({
      retained_event_count: 3,
      retention_boundary_cursor: expect.any(Number)
    });
    const boundaryAfter = durable.projection.retention_boundary_cursor;
    if (boundaryAfter === null) throw new Error("Missing retained boundary fixture.");

    const app = createEventApp(selectedStatePort(harness.repository));
    await app.ready();
    const crossed = await app.inject({
      method: "GET",
      url: `/api/v1/sessions/${sessionId}/events?after=0&limit=1`
    });
    expect(crossed.statusCode, crossed.body).toBe(200);
    expect(crossed.json()).toMatchObject({
      session_id: sessionId,
      next_cursor: boundaryAfter + 1,
      truncated: true,
      events: [
        {
          type: "replay_boundary",
          cursor: boundaryAfter + 1,
          after: boundaryAfter,
          next_cursor: boundaryAfter + 1,
          reason: "retention"
        }
      ]
    });

    const continued = await app.inject({
      method: "GET",
      url: `/api/v1/sessions/${sessionId}/events?after=${boundaryAfter + 1}`
    });
    expect(continued.statusCode, continued.body).toBe(200);
    expect(continued.json().truncated).toBe(false);
    expect(
      continued
        .json()
        .events.some((event: { type: string }) => event.type === "replay_boundary")
    ).toBe(false);
    expect(continued.json().events[0]?.cursor).toBe(boundaryAfter + 2);

    const crossedAgain = await app.inject({
      method: "GET",
      url: `/api/v1/sessions/${sessionId}/events?after=${boundaryAfter}`
    });
    expect(crossedAgain.statusCode, crossedAgain.body).toBe(200);
    expect(crossedAgain.json().events[0]).toMatchObject({
      type: "replay_boundary",
      after: boundaryAfter
    });
  });

  it("sanitizes storage exceptions, corrupt rows, impossible pages, and unstable reads", async () => {
    const privateEvent = "event-storage-private-sentinel";
    const throwingApp = createEventApp(
      fakeStatePort({
        listEvents() {
          throw new Error(privateEvent);
        }
      })
    );
    await throwingApp.ready();
    const throwing = await throwingApp.inject({
      method: "GET",
      url: `/api/v1/sessions/${sessionId}/events`
    });
    expectStableError(throwing, 500, "storage_error");
    expect(throwing.body).not.toContain(privateEvent);
    expect(throwing.body).not.toContain("events");

    const impossibleApp = createEventApp(
      fakeStatePort({
        listEvents() {
          return {
            ...eventPage([messageEvent(1)]),
            session_id: "sess_event_route_foreign",
            private_row: "impossible-page-private-sentinel"
          };
        }
      })
    );
    await impossibleApp.ready();
    const impossible = await impossibleApp.inject({
      method: "GET",
      url: `/api/v1/sessions/${sessionId}/events`
    });
    expectStableError(impossible, 500, "storage_error");
    expect(impossible.body).not.toMatch(/foreign|impossible-page|events/iu);

    for (const candidate of [
      (() => {
        const state = structuredClone(selectedStateCandidate());
        state.projection.session.id = "sess_event_route_foreign";
        return state;
      })(),
      (() => {
        const state = structuredClone(selectedStateCandidate({ eventCount: 2 }));
        state.projection.retained_event_count = 1;
        return state;
      })()
    ]) {
      let listCalls = 0;
      const corruptStateApp = createEventApp({
        require() {
          return candidate;
        },
        listEvents() {
          listCalls += 1;
          return eventPage([messageEvent(1)]);
        }
      });
      await corruptStateApp.ready();
      const corruptState = await corruptStateApp.inject({
        method: "GET",
        url: `/api/v1/sessions/${sessionId}/events`
      });
      expectStableError(corruptState, 500, "storage_error");
      expect(corruptState.body).not.toMatch(/foreign|projection|mapping|events/iu);
      expect(listCalls).toBe(0);
    }

    const retainedBase = selectedStateCandidate({ eventCount: 2 });
    const contradictoryRetentionState = {
      mapping: retainedBase.mapping,
      projection: {
        ...retainedBase.projection,
        session: {
          ...retainedBase.projection.session,
          last_event_cursor: 5
        },
        earliest_retained_cursor: 4,
        retention_boundary_cursor: 3
      }
    };
    const contradictoryRetentionApp = createEventApp({
      require() {
        return contradictoryRetentionState;
      },
      listEvents() {
        return eventPage([messageEvent(4), messageEvent(5)]);
      }
    });
    await contradictoryRetentionApp.ready();
    const contradictoryRetention = await contradictoryRetentionApp.inject({
      method: "GET",
      url: `/api/v1/sessions/${sessionId}/events`
    });
    expectStableError(contradictoryRetention, 500, "storage_error");
    expect(contradictoryRetention.body).not.toMatch(/retention|boundary|events/iu);

    const harness = await createSqliteHarness();
    await appendMessages(harness.repository, 2);
    const corruptSentinel = "corrupt-row-private-sentinel";
    harness.db
      .prepare(
        "UPDATE selected_projected_events SET event_json = ? WHERE session_id = ? AND cursor = 2"
      )
      .run(JSON.stringify({ raw_shell: corruptSentinel }), sessionId);
    const corruptApp = createEventApp(selectedStatePort(harness.repository));
    await corruptApp.ready();
    const corrupt = await corruptApp.inject({
      method: "GET",
      url: `/api/v1/sessions/${sessionId}/events`
    });
    expectStableError(corrupt, 500, "storage_error");
    expect(corrupt.body).not.toContain(corruptSentinel);
    expect(corrupt.body).not.toContain("raw_shell");
    expect(corrupt.body).not.toContain("Bounded projected message 1");

    let requireCalls = 0;
    let listCalls = 0;
    const unstable = fakeStatePort({ events: [messageEvent(1), messageEvent(2)] });
    const unstablePort: HostDeckProjectedEventStatePort = {
      require(_session) {
        requireCalls += 1;
        return selectedStateCandidate({ eventCount: requireCalls % 2 === 1 ? 1 : 2 });
      },
      listEvents(session, input) {
        listCalls += 1;
        return unstable.listEvents(session, input);
      }
    };
    const unstableApp = createEventApp(unstablePort);
    await unstableApp.ready();
    const changed = await unstableApp.inject({
      method: "GET",
      url: `/api/v1/sessions/${sessionId}/events`
    });
    expectStableError(changed, 500, "storage_error", undefined, true);
    expect(requireCalls).toBe(6);
    expect(listCalls).toBe(3);
  });

  it("accepts the exact serialized response bound and rejects one byte less", async () => {
    const text = `Bounded event ${"x".repeat(1_400)}`;
    const page = selectedEventPageResponseSchema.parse(
      eventPage([messageEvent(1, text)])
    );
    const exactBytes = Buffer.byteLength(JSON.stringify(page), "utf8");
    expect(exactBytes).toBeGreaterThan(1_024);

    const exactApp = createEventApp(
      fakeStatePort({ events: [messageEvent(1, text)] }),
      { resourceBudget: budgetWithResponseBytes(exactBytes) }
    );
    await exactApp.ready();
    const exact = await exactApp.inject({
      method: "GET",
      url: `/api/v1/sessions/${sessionId}/events`
    });
    expect(exact.statusCode, exact.body).toBe(200);
    expect(Buffer.byteLength(exact.body, "utf8")).toBe(exactBytes);

    const overApp = createEventApp(
      fakeStatePort({ events: [messageEvent(1, text)] }),
      { resourceBudget: budgetWithResponseBytes(exactBytes - 1) }
    );
    await overApp.ready();
    const over = await overApp.inject({
      method: "GET",
      url: `/api/v1/sessions/${sessionId}/events`
    });
    expectStableError(over, 503, "service_overloaded", "limit");
    expect(over.body).not.toContain(text);
    expect(over.body).not.toContain('"events"');
  });

  it("serves one bounded raw loopback response without storage or runtime identity fields", async () => {
    const port = await getAvailablePort();
    const origin = `http://127.0.0.1:${port}`;
    const app = createEventApp(
      fakeStatePort({ events: [messageEvent(1)] }),
      {
        trustPolicy: createHostDeckRequestTrustPolicy({
          allowedOrigins: [origin],
          mode: "loopback",
          transport: "http"
        })
      }
    );
    await app.listen({
      host: "127.0.0.1",
      port,
      listenTextResolver: () => ""
    });

    const response = await rawExchange(
      port,
      `GET /api/v1/sessions/${sessionId}/events HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`
    );
    expect(statusCode(response)).toBe(200);
    expect(response).toMatch(/cache-control: no-store/iu);
    expect(response).toContain('"session_id":"sess_event_route_001"');
    expect(response).toContain('"type":"message"');
    for (const forbidden of [
      "codex_thread_id",
      '"cwd"',
      "runtime_version",
      "retained_event_bytes",
      "event_json",
      "raw_frame",
      "raw_shell",
      "cookie",
      "token"
    ]) {
      expect(response).not.toContain(forbidden);
    }

    const head = await rawExchange(
      port,
      `HEAD /api/v1/sessions/${sessionId}/events HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`
    );
    expect(statusCode(head)).toBe(405);
    expect(head).not.toContain('"events"');
  });
});

interface EventAppOptions {
  readonly authenticateDeviceToken?: HostDeckDeviceAuthenticationPort;
  readonly observations?: HostDeckInternalErrorObservation[];
  readonly resourceBudget?: ResourceBudget;
  readonly trustPolicy?: HostDeckRequestTrustPolicy;
}

function createEventApp(
  state: HostDeckProjectedEventStatePort,
  options: EventAppOptions = {}
): HostDeckFastifyInstance {
  return createEventAppFromRegistration(
    createHostDeckProjectedEventRouteRegistration({ state }),
    options
  );
}

function selectedStatePort(
  repository: SelectedStateRepository
): HostDeckProjectedEventStatePort {
  return {
    listEvents: repository.listEvents,
    require: repository.require
  };
}

function createEventAppFromRegistration(
  registration: ReturnType<typeof createHostDeckProjectedEventRouteRegistration>,
  options: EventAppOptions = {}
): HostDeckFastifyInstance {
  const app = createHostDeckFastifyApp({
    observeInternalError(observation) {
      options.observations?.push(observation);
    },
    requestAuthenticationPolicy: createHostDeckRequestAuthenticationPolicy({
      authenticateDeviceToken:
        options.authenticateDeviceToken ??
        (({ rawDeviceToken }) => {
          if (rawDeviceToken === readToken) {
            return authenticatedDevice("read", "client_event_reader");
          }
          throw new HostDeckAuthRepositoryError(
            "device_not_found",
            "Device authentication failed."
          );
        }),
      now: () => new Date(createdAt)
    }),
    requestTrustPolicy: options.trustPolicy ?? loopbackTrustPolicy,
    resourceBudget: options.resourceBudget ?? defaultResourceBudget,
    routePlugins: [registration]
  });
  apps.push(app);
  return app;
}

function fakeStatePort(
  options: {
    readonly archived?: boolean;
    readonly events?: readonly SelectedProjectionEvent[];
    readonly listEvents?: HostDeckProjectedEventStatePort["listEvents"];
    readonly onList?: (input: SelectedEventPageInput) => void;
    readonly onRequire?: () => void;
    readonly recoveryRequired?: boolean;
  } = {}
): HostDeckProjectedEventStatePort {
  const events = options.events ?? [messageEvent(1)];
  const state = selectedStateCandidate({
    eventCount: events.length,
    ...(options.archived === undefined ? {} : { archived: options.archived }),
    ...(options.recoveryRequired === undefined
      ? {}
      : { recoveryRequired: options.recoveryRequired })
  });
  return {
    require() {
      options.onRequire?.();
      return state;
    },
    listEvents:
      options.listEvents ??
      ((_session, input) => {
        options.onList?.(input as SelectedEventPageInput);
        const after = input.after ?? null;
        const limit = input.limit ?? 100;
        const selected = events
          .filter((event) => after === null || event.cursor > after)
          .slice(0, limit);
        return eventPage(selected, events.at(-1)?.cursor ?? 0);
      })
  };
}

function selectedStateCandidate(
  options: {
    readonly archived?: boolean;
    readonly eventCount?: number;
    readonly recoveryRequired?: boolean;
  } = {}
) {
  const eventCount = options.eventCount ?? 1;
  const archivedAt = options.archived ? "2026-07-15T12:10:00.000Z" : null;
  const mapping = {
    id: sessionId,
    name: "event-route-session",
    codex_thread_id: "thread-event-route-001",
    cwd: "/home/simonli/work/event-route-session",
    runtime_source: "codex_app_server" as const,
    runtime_version: "0.144.0",
    disposition: options.recoveryRequired
      ? ("recovery_required" as const)
      : ("selected" as const),
    created_at: createdAt,
    updated_at: archivedAt ?? createdAt,
    archived_at: archivedAt
  };
  return {
    mapping,
    projection: {
      session: {
        id: mapping.id,
        name: mapping.name,
        codex_thread_id: mapping.codex_thread_id,
        cwd: mapping.cwd,
        runtime_source: mapping.runtime_source,
        runtime_version: mapping.runtime_version,
        created_at: mapping.created_at,
        archived_at: archivedAt,
        session_state: options.archived ? ("archived" as const) : ("active" as const),
        turn_state: "idle" as const,
        attention: "none" as const,
        freshness: "current" as const,
        freshness_reason: null,
        updated_at: archivedAt ?? createdAt,
        last_activity_at: eventCount === 0 ? null : createdAt,
        branch: "main",
        model: "gpt-5.5-codex",
        goal: null,
        recent_summary: eventCount === 0 ? "No events." : "Projected events available.",
        last_event_cursor: eventCount === 0 ? null : eventCount
      },
      retained_event_count: eventCount,
      retained_event_bytes: eventCount === 0 ? 0 : eventCount * 512,
      earliest_retained_cursor: eventCount === 0 ? null : 1,
      retention_boundary_cursor: null
    }
  };
}

function eventPage(
  events: readonly SelectedProjectionEvent[],
  emptyCursor = 0
) {
  return {
    session_id: sessionId,
    events: [...events],
    next_cursor: events.at(-1)?.cursor ?? emptyCursor,
    truncated: events[0]?.type === "replay_boundary"
  };
}

function messageEvent(
  cursor: number,
  text = `Bounded projected message ${cursor}.`
): SelectedProjectionEvent {
  return selectedProjectionEventSchema.parse({
    session_id: sessionId,
    cursor,
    captured_at: eventTime(cursor),
    upstream_at: null,
    codex_event_id: `event-route-${cursor}`,
    codex_event_type: "item/agentMessage/delta",
    content_state: "complete" as const,
    content_notice: null,
    type: "message" as const,
    role: "agent" as const,
    phase: "delta" as const,
    item_id: `item-event-route-${cursor}`,
    text
  });
}

function replayBoundaryEvent(
  cursor: number,
  after: number | null,
  reason: "disconnect" | "restart" | "retention" | "schema_change"
): SelectedProjectionEvent {
  return selectedProjectionEventSchema.parse({
    session_id: sessionId,
    cursor,
    captured_at: eventTime(cursor),
    upstream_at: null,
    codex_event_id: null,
    codex_event_type: null,
    content_state: "complete",
    content_notice: null,
    type: "replay_boundary",
    after,
    next_cursor: cursor,
    reason
  });
}

function authenticatedDevice(permission: "read" | "write", deviceId: string) {
  return {
    trusted: true as const,
    readOnly: permission === "read",
    device: {
      id: deviceId,
      token_hash: `sha256:${"a".repeat(64)}`,
      csrf_token_hash: `sha256:${"b".repeat(64)}`,
      csrf_generation: 1,
      csrf_rotated_at: createdAt,
      client_label: "Phone",
      permission,
      created_at: createdAt,
      last_used_at: createdAt,
      expires_at: null,
      revoked_at: null
    }
  };
}

function deviceCookie(rawDeviceToken: string): Readonly<Record<string, string>> {
  return { cookie: `${hostDeckDeviceCookieName}=${rawDeviceToken}` };
}

function remoteHeaders(options: {
  readonly cookie?: string;
  readonly identity?: boolean;
}): Record<string, string> {
  const authority = new URL(externalOrigin).host;
  const headers: Record<string, string> = {
    host: authority,
    "x-forwarded-for": remoteSource,
    "x-forwarded-host": authority,
    "x-forwarded-proto": "https"
  };
  if (options.cookie !== undefined) {
    headers.cookie = `${hostDeckDeviceCookieName}=${options.cookie}`;
  }
  if (options.identity) {
    headers["tailscale-headers-info"] = "https://tailscale.com/s/serve-headers";
    headers["tailscale-user-login"] = "identity-does-not-authorize@example.test";
    headers["tailscale-user-name"] = "Identity Does Not Authorize";
    headers["tailscale-user-profile-pic"] = "https://example.test/avatar";
  }
  return headers;
}

async function createSqliteHarness(): Promise<{
  readonly db: ReturnType<typeof openMigratedDatabase>["db"];
  readonly repository: SelectedStateRepository;
}> {
  const root = mkdtempSync(join(tmpdir(), "hostdeck-event-route-"));
  roots.push(root);
  const opened = openMigratedDatabase(join(root, "hostdeck.sqlite"), {
    now: () => new Date(createdAt)
  });
  databases.push(opened.db);
  const repository = createSelectedStateRepository(opened.db);
  repository.create(selectedStateCandidate({ eventCount: 0 }));
  return { db: opened.db, repository };
}

async function appendMessages(
  repository: SelectedStateRepository,
  count: number,
  retention: RetentionPolicy = defaultRetentionPolicy
): Promise<void> {
  const append = createProductionProjectionAppendPort({
    repository,
    publish() {
      // Route evidence reads only committed durable state.
    },
    retention
  });
  for (let cursor = 1; cursor <= count; cursor += 1) {
    const current = repository.require(sessionId);
    const session = current.projection.session;
    const capturedAt = eventTime(cursor);
    await append.append({
      session_id: sessionId,
      expected_revision: selectedStateRevision(current),
      event: {
        captured_at: capturedAt,
        upstream_at: null,
        codex_event_id: `event-route-${cursor}`,
        codex_event_type: "item/agentMessage/delta",
        content_state: "complete",
        content_notice: null,
        type: "message",
        role: "agent",
        phase: "delta",
        item_id: codexItemIdSchema.parse(`item-event-route-${cursor}`),
        text: `Bounded projected message ${cursor}.`
      },
      next_session: {
        id: session.id,
        name: session.name,
        codex_thread_id: session.codex_thread_id,
        cwd: session.cwd,
        runtime_source: session.runtime_source,
        runtime_version: session.runtime_version,
        created_at: session.created_at,
        archived_at: session.archived_at,
        session_state: session.session_state,
        turn_state: "in_progress",
        attention: "watch",
        freshness: session.freshness,
        freshness_reason: session.freshness_reason,
        updated_at: capturedAt,
        last_activity_at: capturedAt,
        branch: session.branch,
        model: session.model,
        settings: session.settings,
        goal: session.goal,
        recent_summary: `Projected event ${cursor}.`
      }
    });
  }
}

function eventTime(cursor: number) {
  return isoTimestampSchema.parse(
    new Date(Date.parse(createdAt) + cursor * 1_000).toISOString()
  );
}

function budgetWithResponseBytes(bytes: number): ResourceBudget {
  return resolveResourceBudget({
    ...defaultResourceBudget,
    cli_response_max_bytes: bytes
  });
}

function expectStableError(
  response: Awaited<ReturnType<HostDeckFastifyInstance["inject"]>>,
  status: number,
  code: string,
  field?: string,
  retryable = false
): void {
  const requestId = response.headers["x-request-id"];
  expect(response.statusCode, response.body).toBe(status);
  expect(response.headers["content-type"]).toContain("application/json");
  expect(requestId).toMatch(/^req_[0-9a-f-]{36}$/u);
  expect(response.json()).toMatchObject({
    error: {
      code,
      retryable,
      details: { request_id: requestId },
      ...(field === undefined ? {} : { field })
    }
  });
}

async function getAvailablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Missing loopback probe address.");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) =>
      error === undefined ? resolve() : reject(error)
    );
  });
  return address.port;
}

function rawExchange(port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = createConnection({ host: "127.0.0.1", port }, () =>
      socket.end(request)
    );
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.once("error", reject);
    socket.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function statusCode(response: string): number {
  const match = /^HTTP\/1\.1 (\d{3}) /u.exec(response);
  if (match?.[1] === undefined) {
    throw new Error("Raw response has no status line.");
  }
  return Number(match[1]);
}
