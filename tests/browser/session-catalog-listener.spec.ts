import { createServer } from "node:net";
import { expect, test } from "@playwright/test";
import { defaultResourceBudget } from "../../packages/contracts/src/index.js";
import { createHostDeckFastifyApp } from "../../packages/server/src/fastify-app.js";
import { createHostDeckRequestAuthenticationPolicy } from "../../packages/server/src/fastify-request-authentication.js";
import { createHostDeckRequestTrustPolicy } from "../../packages/server/src/fastify-request-trust.js";
import { createSessionCatalogHub } from "../../packages/server/src/session-catalog-hub.js";
import { createHostDeckSessionCatalogRouteRegistration } from "../../packages/server/src/session-catalog-routes.js";
import { createSseSubscriberAdmissionService } from "../../packages/server/src/sse-subscriber-admission.js";

const timestamp = "2026-08-15T12:00:00.000Z";

test("Chromium receives the live catalog over the real loopback listener", async ({
  page
}) => {
  const port = await reserveLoopbackPort();
  const origin = `http://127.0.0.1:${port}`;
  const failures: unknown[] = [];
  const hub = createSessionCatalogHub({
    admission: createSseSubscriberAdmissionService(defaultResourceBudget),
    authorize: () => ({ ok: true }),
    create_stream_id: () => "catalog_browser_0001",
    initial_cursor: 1_000,
    now: () => new Date(timestamp),
    reader: Object.freeze({
      read: () => Object.freeze([]),
      readOne: () => null
    }),
    resource_budget: defaultResourceBudget
  });
  hub.initialize(1);
  const app = createHostDeckFastifyApp({
    observeInternalError: (error) => failures.push(error),
    requestAuthenticationPolicy: createHostDeckRequestAuthenticationPolicy({
      authenticateDeviceToken: () => {
        throw new Error("Browser listener acceptance does not use device credentials.");
      },
      now: () => new Date(timestamp)
    }),
    requestTrustPolicy: createHostDeckRequestTrustPolicy({ allowedOrigin: origin }),
    resourceBudget: defaultResourceBudget,
    routePlugins: [
      createHostDeckSessionCatalogRouteRegistration({
        catalog: hub,
        observe_error: (failure) => failures.push(failure)
      })
    ]
  });

  await app.listen({ host: "127.0.0.1", port });
  try {
    await page.goto(`${origin}/browser-listener-probe`);
    const events = await page.evaluate(async () => {
      return await new Promise<readonly { id: string; type: string }[]>(
        (resolve, reject) => {
          const received: { id: string; type: string }[] = [];
          const source = new EventSource("/api/v1/sessions/catalog/stream");
          const timeout = setTimeout(() => {
            source.close();
            reject(new Error("Catalog browser stream timed out."));
          }, 5_000);
          source.addEventListener("catalog_reset", (event) => {
            received.push({ id: event.lastEventId, type: event.type });
          });
          source.addEventListener("catalog_ready", (event) => {
            received.push({ id: event.lastEventId, type: event.type });
            clearTimeout(timeout);
            source.close();
            resolve(received);
          });
          source.onerror = () => {
            clearTimeout(timeout);
            source.close();
            reject(new Error("Catalog browser stream failed."));
          };
        }
      );
    });

    expect(events).toEqual([
      { id: "1001", type: "catalog_reset" },
      { id: "1002", type: "catalog_ready" }
    ]);
    await expect.poll(() => hub.snapshot().active_subscribers).toBe(0);
    expect(failures).toEqual([]);
  } finally {
    hub.close();
    await app.close();
  }
});

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Loopback port reservation returned no TCP address.");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  return address.port;
}
