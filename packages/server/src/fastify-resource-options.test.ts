import { defaultResourceBudget } from "@hostdeck/contracts";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { fastifyResourceOptionsFromBudget } from "./fastify-resource-options.js";

describe("Fastify resource options", () => {
  it("keeps receive, route, socket, and application bounds distinct", async () => {
    const options = fastifyResourceOptionsFromBudget(defaultResourceBudget);
    expect(options).toEqual({
      factory: {
        bodyLimit: 65_536,
        connectionTimeout: 60_000,
        handlerTimeout: 30_000,
        keepAliveTimeout: 5_000,
        maxRequestsPerSocket: 1_000,
        requestTimeout: 15_000,
        routerOptions: { maxParamLength: 128 }
      },
      node: {
        connectionsCheckingInterval: 1_000,
        headersTimeout: 10_000,
        keepAliveTimeoutBuffer: 0,
        maxAcceptedHeadersCount: 64,
        maxConnections: 64,
        maxHeaderSize: 16_384,
        parserMaxHeadersCount: 65
      },
      application: {
        maxInFlightRequests: 64,
        maxRouteParamBytes: 128,
        maxUrlBytes: 2_048
      }
    });
    expect(Object.isFrozen(options)).toBe(true);
    expect(Object.isFrozen(options.factory)).toBe(true);
    expect(Object.isFrozen(options.factory.routerOptions)).toBe(true);
    expect(Object.isFrozen(options.node)).toBe(true);
    expect(Object.isFrozen(options.application)).toBe(true);

    const app = Fastify(options.factory);
    try {
      await app.ready();
      expect(app.initialConfig).toMatchObject({
        bodyLimit: 65_536,
        connectionTimeout: 60_000,
        handlerTimeout: 30_000,
        keepAliveTimeout: 5_000,
        routerOptions: { maxParamLength: 128 }
      });
      expect(app.server.requestTimeout).toBe(15_000);
      expect(app.server.maxRequestsPerSocket).toBe(1_000);
    } finally {
      await app.close();
    }
  });

  it("rejects contradictory policy before constructing Fastify options", () => {
    expect(() =>
      fastifyResourceOptionsFromBudget({
        http_request_receive_timeout_ms: 60_000,
        http_request_deadline_ms: 1_000
      })
    ).toThrow();
  });
});
