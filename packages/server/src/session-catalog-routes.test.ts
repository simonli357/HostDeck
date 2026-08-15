import {
  defaultResourceBudget,
  type ResourceBudget,
  resolveResourceBudget,
  selectedRequestAuthenticationContextSchema
} from "@hostdeck/contracts";
import { describe, expect, it } from "vitest";
import {
  createHostDeckFastifyApp,
  hostDeckFastifyResourceSnapshot
} from "./fastify-app.js";
import {
  hostDeckLoopbackTestOrigin,
  injectHostDeckLoopback
} from "./fastify-loopback-test-request.js";
import {
  createHostDeckRequestAuthenticationPolicy,
  type HostDeckRequestAuthenticationPolicy,
  hostDeckDeviceCookieName
} from "./fastify-request-authentication.js";
import { createHostDeckRequestTrustPolicy } from "./fastify-request-trust.js";
import type { HostDeckSseFailureObservation } from "./fastify-sse-transport.js";
import { createSessionCatalogHub } from "./session-catalog-hub.js";
import {
  createHostDeckSessionCatalogRouteRegistration,
  hostDeckSessionCatalogRouteRegistrationId
} from "./session-catalog-routes.js";
import type { SessionCatalogStateReader } from "./session-catalog-state-reader.js";
import { createSseSubscriberAdmissionService } from "./sse-subscriber-admission.js";

const timestamp = "2026-08-15T12:00:00.000Z";
const deviceToken = "C".repeat(43);
const deviceId = "client_catalog_route";
const loopbackTrust = createHostDeckRequestTrustPolicy({
  allowedOrigin: hostDeckLoopbackTestOrigin
});

describe("selected live session catalog route", () => {
  it("requires the branded hub and exact frozen manifest registration", () => {
    const fixture = createFixture();
    const registration = createHostDeckSessionCatalogRouteRegistration({
      catalog: fixture.hub,
      observe_error: () => undefined
    });
    expect(registration).toMatchObject({
      id: hostDeckSessionCatalogRouteRegistrationId,
      surface: "sse"
    });
    expect(Object.isFrozen(registration)).toBe(true);

    for (const candidate of [
      null,
      {},
      { catalog: fixture.hub, observe_error: undefined },
      { catalog: {}, observe_error: () => undefined },
      { catalog: fixture.hub, observe_error: () => undefined, extra: true }
    ]) {
      expect(() =>
        createHostDeckSessionCatalogRouteRegistration(candidate as never)
      ).toThrow();
    }
    fixture.hub.close();
  });

  it("streams reset/ready framing to an unpaired loopback browser without polling", async () => {
    const fixture = createFixture();
    const app = createApp(fixture);
    await app.ready();
    try {
      const pending = injectHostDeckLoopback(app, {
        headers: { accept: "text/event-stream" },
        method: "GET",
        url: "/api/v1/sessions/catalog/stream"
      });
      await waitUntil(() => fixture.hub.snapshot().active_subscribers === 1);
      fixture.hub.close();
      const response = await pending;

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toBe("text/event-stream");
      expect(response.headers["cache-control"]).toContain("no-cache");
      expect(response.body).toContain("id: 1001\nevent: catalog_reset\ndata: ");
      expect(response.body).toContain("id: 1002\nevent: catalog_ready\ndata: ");
      expect(response.body).not.toContain("private transcript");
      expect(fixture.authorizations).toMatchObject([
        { state: "unpaired", network_mode: "loopback" }
      ]);
      expect(fixture.failures).toEqual([]);
      await waitUntil(
        () => hostDeckFastifyResourceSnapshot(app).in_flight_requests === 0
      );
    } finally {
      await app.close();
    }
  });

  it("resumes from one cursor and rejects conflicting or future cursor claims", async () => {
    const fixture = createFixture();
    const app = createApp(fixture);
    await app.ready();
    try {
      const resumed = injectHostDeckLoopback(app, {
        headers: {
          accept: "text/event-stream",
          "last-event-id": "1001"
        },
        method: "GET",
        url: "/api/v1/sessions/catalog/stream?after=1001"
      });
      await waitUntil(() => fixture.hub.snapshot().active_subscribers === 1);
      fixture.hub.close();
      const response = await resumed;
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain("event: catalog_reset");
      expect(response.body).toContain("id: 1002\nevent: catalog_ready");

      const conflictFixture = createFixture();
      const conflictApp = createApp(conflictFixture);
      await conflictApp.ready();
      try {
        const conflict = await injectHostDeckLoopback(conflictApp, {
          headers: {
            accept: "text/event-stream",
            "last-event-id": "1000"
          },
          method: "GET",
          url: "/api/v1/sessions/catalog/stream?after=1001"
        });
        expect(conflict.statusCode).toBe(400);
        expect(conflict.json()).toMatchObject({
          error: { code: "validation_error", field: "after" }
        });
        expect(conflictFixture.hub.snapshot().active_subscribers).toBe(0);

        const future = await injectHostDeckLoopback(conflictApp, {
          headers: {
            accept: "text/event-stream",
            "last-event-id": "9000"
          },
          method: "GET",
          url: "/api/v1/sessions/catalog/stream"
        });
        expect(future.statusCode).toBe(409);
        expect(future.json()).toMatchObject({
          error: { code: "stale_session", field: "after" }
        });
      } finally {
        conflictFixture.hub.close();
        await conflictApp.close();
      }
    } finally {
      await app.close();
    }
  });

  it("terminates a paired device stream immediately when its authority is revoked", async () => {
    const fixture = createFixture({ paired: true });
    let authentication: HostDeckRequestAuthenticationPolicy | undefined;
    const app = createApp(fixture, (policy) => {
      authentication = policy;
    });
    await app.ready();
    try {
      const pending = injectHostDeckLoopback(app, {
        headers: {
          accept: "text/event-stream",
          cookie: `${hostDeckDeviceCookieName}=${deviceToken}`
        },
        method: "GET",
        url: "/api/v1/sessions/catalog/stream"
      });
      await waitUntil(() => fixture.hub.snapshot().active_subscribers === 1);
      expect(authentication?.activeDeviceAuthority.invalidate(deviceId)).toMatchObject({
        closedLeases: 1
      });
      expect((await pending).statusCode).toBe(200);
      expect(fixture.hub.snapshot()).toMatchObject({ active_subscribers: 0 });
      expect(fixture.admission.snapshot().active_subscribers).toBe(0);
    } finally {
      fixture.hub.close();
      await app.close();
    }
  });

  it("maps shared subscriber exhaustion and durable catalog failure to stable errors", async () => {
    const budget = resolveResourceBudget({
      sse_max_subscribers: 1,
      sse_max_subscribers_per_device: 1,
      sse_max_subscribers_per_session: 1
    });
    const fixture = createFixture({ budget });
    const app = createApp(fixture);
    await app.ready();
    try {
      const first = injectHostDeckLoopback(app, {
        headers: { accept: "text/event-stream" },
        method: "GET",
        url: "/api/v1/sessions/catalog/stream"
      });
      await waitUntil(() => fixture.hub.snapshot().active_subscribers === 1);
      const overloaded = await injectHostDeckLoopback(app, {
        headers: { accept: "text/event-stream" },
        method: "GET",
        url: "/api/v1/sessions/catalog/stream"
      });
      expect(overloaded.statusCode).toBe(503);
      expect(overloaded.json()).toMatchObject({
        error: { code: "service_overloaded" }
      });
      fixture.hub.close();
      await first;
    } finally {
      fixture.hub.close();
      await app.close();
    }

    const failed = createFixture();
    failed.reader.readOneFailure = new Error("sqlite unavailable");
    expect(() => failed.hub.synchronize("sess_catalog_missing", "missing")).toThrow();
    const failedApp = createApp(failed);
    await failedApp.ready();
    try {
      const response = await injectHostDeckLoopback(failedApp, {
        headers: { accept: "text/event-stream" },
        method: "GET",
        url: "/api/v1/sessions/catalog/stream"
      });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toMatchObject({
        error: { code: "storage_error" }
      });
    } finally {
      failed.hub.close();
      await failedApp.close();
    }
  });
});

interface MutableReader {
  reader: SessionCatalogStateReader;
  readOneFailure: Error | null;
}

function createFixture(
  input: {
    readonly budget?: ResourceBudget;
    readonly paired?: boolean;
  } = {}
) {
  const budget = input.budget ?? defaultResourceBudget;
  const mutableReader: MutableReader = {
    readOneFailure: null,
    reader: undefined as never
  };
  mutableReader.reader = Object.freeze({
    read: () => Object.freeze([]),
    readOne: () => {
      if (mutableReader.readOneFailure !== null) {
        throw mutableReader.readOneFailure;
      }
      return null;
    }
  });
  const admission = createSseSubscriberAdmissionService(budget);
  const authorizations: unknown[] = [];
  const hub = createSessionCatalogHub({
    admission,
    authorize: ({ authorization }) => {
      authorizations.push(authorization);
      const parsed = selectedRequestAuthenticationContextSchema.safeParse(
        authorization
      );
      return parsed.success &&
          (parsed.data.state === "local_admin" ||
            parsed.data.state === "paired_device" ||
            (parsed.data.state === "unpaired" &&
              parsed.data.network_mode === "loopback"))
        ? { ok: true }
        : { ok: false };
    },
    create_stream_id: () => "catalog_route_0001",
    initial_cursor: 1_000,
    now: () => new Date(timestamp),
    reader: mutableReader.reader,
    resource_budget: budget
  });
  hub.initialize(1);
  return {
    admission,
    authorizations,
    budget,
    failures: [] as HostDeckSseFailureObservation[],
    hub,
    paired: input.paired ?? false,
    reader: mutableReader
  };
}

function createApp(
  fixture: ReturnType<typeof createFixture>,
  captureAuthentication?: (policy: HostDeckRequestAuthenticationPolicy) => void
) {
  const authentication = createHostDeckRequestAuthenticationPolicy({
    authenticateDeviceToken: ({ rawDeviceToken }) => {
      if (!fixture.paired || rawDeviceToken !== deviceToken) {
        throw new Error("Unknown test device token.");
      }
      return {
        device: {
          client_label: "Catalog route phone",
          created_at: timestamp,
          csrf_generation: 1,
          csrf_rotated_at: timestamp,
          csrf_token_hash: `sha256:${"b".repeat(64)}`,
          expires_at: null,
          id: deviceId,
          last_used_at: timestamp,
          permission: "read" as const,
          revoked_at: null,
          token_hash: `sha256:${"a".repeat(64)}`
        },
        readOnly: true,
        trusted: true as const
      };
    },
    now: () => new Date(timestamp)
  });
  captureAuthentication?.(authentication);
  return createHostDeckFastifyApp({
    observeInternalError: () => undefined,
    requestAuthenticationPolicy: authentication,
    requestTrustPolicy: loopbackTrust,
    resourceBudget: fixture.budget,
    routePlugins: [
      createHostDeckSessionCatalogRouteRegistration({
        catalog: fixture.hub,
        observe_error: (failure) => fixture.failures.push(failure)
      })
    ]
  });
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 1_000;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error("Condition timed out.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
