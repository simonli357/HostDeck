import { describe, expect, it } from "vitest";
import { type ApiRouteAuthMode, type ApiRouteMethod, apiRouteContracts } from "./api-route-contracts.js";

const expectedRouteIds = [
  "host_status",
  "session_list",
  "session_detail",
  "session_output",
  "session_stream",
  "prompt_input",
  "slash_command",
  "stop_session",
  "raw_input",
  "pair_claim",
  "pair_status",
  "security_state",
  "dashboard_lock",
  "dashboard_unlock_rejected",
  "network_state",
  "dashboard_lan_mutation_rejected"
] as const;

const validMethods = new Set<ApiRouteMethod>(["GET", "POST"]);
const validAuthModes = new Set<ApiRouteAuthMode>([
  "local_read_policy",
  "dashboard_write_cookie_csrf",
  "pairing_code",
  "optional_device_cookie",
  "none",
  "admin_only_rejected"
]);

describe("API route contract manifest", () => {
  it("covers every current V1 route family with stable ids", () => {
    expect(apiRouteContracts.map((route) => route.id)).toEqual(expectedRouteIds);
    expect(new Set(apiRouteContracts.map((route) => route.id)).size).toBe(apiRouteContracts.length);
    expect(new Set(apiRouteContracts.map((route) => `${route.method} ${route.path}`)).size).toBe(apiRouteContracts.length);
    expect(new Set(apiRouteContracts.map((route) => route.family))).toEqual(new Set(["host", "sessions", "stream", "writes", "pairing", "security", "network"]));
  });

  it("declares method, path, auth mode, handler, and error schema for every route", () => {
    for (const route of apiRouteContracts) {
      expect(validMethods.has(route.method)).toBe(true);
      expect(route.path.startsWith("/api/")).toBe(true);
      expect(route.operation.length).toBeGreaterThan(0);
      expect(route.handler).toMatch(/^[a-z]+\.[A-Za-z]+/u);
      expect(validAuthModes.has(route.auth)).toBe(true);
      for (const typedError of route.typedErrors) {
        expect(route.errorResponseSchema.parse(typedError.sample)).toMatchObject({
          error: {
            code: typedError.code
          }
        });
      }
    }
  });

  it("declares request schemas where params, query, or body are required", () => {
    for (const route of apiRouteContracts) {
      if (route.samples.params !== undefined) {
        expect(route.paramsSchema?.parse(route.samples.params)).toBeDefined();
      } else {
        expect(route.paramsSchema).toBeUndefined();
      }

      if (route.samples.query !== undefined) {
        expect(route.querySchema?.parse(route.samples.query)).toBeDefined();
      } else {
        expect(route.querySchema).toBeUndefined();
      }

      if (route.samples.body !== undefined) {
        expect(route.bodySchema?.parse(route.samples.body)).toBeDefined();
      } else {
        expect(route.bodySchema).toBeUndefined();
      }
    }
  });

  it("validates success response or stream-event schemas for every non-error-only route", () => {
    for (const route of apiRouteContracts) {
      const hasSuccess = route.successResponseSchema !== undefined;
      const hasStream = route.streamEventSchema !== undefined;

      if (route.auth === "admin_only_rejected") {
        expect(hasSuccess).toBe(false);
        expect(hasStream).toBe(false);
        continue;
      }

      expect(hasSuccess || hasStream).toBe(true);

      if (route.samples.successResponse !== undefined) {
        expect(route.successResponseSchema?.parse(route.samples.successResponse)).toBeDefined();
      }

      if (route.samples.streamEvent !== undefined) {
        expect(route.streamEventSchema?.parse(route.samples.streamEvent)).toBeDefined();
      }
    }
  });

  it("asserts typed error contracts with bounded error envelopes for every route", () => {
    for (const route of apiRouteContracts) {
      expect(route.typedErrors.length).toBeGreaterThan(0);

      for (const typedError of route.typedErrors) {
        expect(typedError.status).toBeGreaterThanOrEqual(400);
        expect(typedError.status).toBeLessThan(600);
        expect(route.errorResponseSchema.parse(typedError.sample)).toMatchObject({
          error: {
            code: typedError.code
          }
        });
      }
    }
  });

  it("keeps auth modes aligned with route families and dangerous mutations", () => {
    const contracts = Object.fromEntries(apiRouteContracts.map((route) => [route.id, route]));

    expect(contracts.host_status?.auth).toBe("local_read_policy");
    expect(contracts.session_stream).toMatchObject({
      method: "GET",
      auth: "local_read_policy"
    });
    expect(contracts.prompt_input).toMatchObject({
      method: "POST",
      auth: "dashboard_write_cookie_csrf"
    });
    expect(contracts.slash_command).toMatchObject({
      method: "POST",
      auth: "dashboard_write_cookie_csrf"
    });
    expect(contracts.stop_session).toMatchObject({
      method: "POST",
      auth: "dashboard_write_cookie_csrf"
    });
    expect(contracts.raw_input).toMatchObject({
      method: "POST",
      auth: "dashboard_write_cookie_csrf"
    });
    expect(contracts.dashboard_unlock_rejected).toMatchObject({
      method: "POST",
      auth: "admin_only_rejected"
    });
    expect(contracts.dashboard_lan_mutation_rejected).toMatchObject({
      method: "POST",
      auth: "admin_only_rejected"
    });
  });
});
