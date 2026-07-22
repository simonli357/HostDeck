import { selectedApiRouteManifest } from "@hostdeck/server";
import { describe, expect, it } from "vitest";
import {
  type BrowserHttpRouteData,
  type BrowserHttpRouteRequest,
  type BrowserHttpRouteRequestOptions,
  browserHttpRouteContracts
} from "./http-route-contracts.js";

describe("FE-V1-019 browser HTTP route contracts", () => {
  it("binds exactly the 34 selected JSON routes and excludes SSE", () => {
    const selectedJson = selectedApiRouteManifest.filter(
      (route) => route.transport === "json"
    );
    const browser = Object.values(browserHttpRouteContracts);

    expect(browser).toHaveLength(34);
    expect(selectedJson).toHaveLength(34);
    expect(browser.map((route) => route.id)).toEqual(
      selectedJson.map((route) => route.id)
    );
    expect(browser.map(toComparableContract)).toEqual(
      selectedJson.map((route) => ({
        id: route.id,
        method: route.method,
        path: route.path,
        csrf: route.csrf,
        request: route.request,
        response: route.response
      }))
    );
    expect(Reflect.has(browserHttpRouteContracts, "session_event_stream")).toBe(
      false
    );
  });

  it("freezes route metadata and binds executable schemas and exact statuses", () => {
    for (const [key, route] of Object.entries(browserHttpRouteContracts)) {
      expect(route.id).toBe(key);
      expect(Object.isFrozen(route)).toBe(true);
      expect(Object.isFrozen(route.request)).toBe(true);
      expect(Object.isFrozen(route.request.queryKeys)).toBe(true);
      expect(Object.isFrozen(route.response)).toBe(true);
      expect(Object.isFrozen(route.response.statuses)).toBe(true);
      expect(typeof route.response.schema.safeParse).toBe("function");
      for (const requestSchema of [
        route.request.params,
        route.request.query,
        route.request.body
      ]) {
        if (requestSchema !== null) {
          expect(typeof requestSchema.schema.safeParse).toBe("function");
        }
      }
    }

    expect(browserHttpRouteContracts.health_readiness.response.statuses).toEqual([
      200,
      503
    ]);
    expect(browserHttpRouteContracts.session_start.response.statuses).toEqual([
      201
    ]);
    expect(browserHttpRouteContracts.prompt_dispatch.response.statuses).toEqual([
      202
    ]);
    expect(browserHttpRouteContracts.compact_start.response.statuses).toEqual([
      202
    ]);
  });

  it("keeps route-id inference exact at compile time", () => {
    const detail: BrowserHttpRouteRequest<"session_detail"> = {
      params: { session_id: "sess_http_contract_001" }
    };
    const eventPage: BrowserHttpRouteRequest<"session_events"> = {
      params: { session_id: "sess_http_contract_001" },
      query: { after: "0", limit: "100" }
    };
    const liveness: BrowserHttpRouteData<"health_liveness"> = {
      status: "alive"
    };
    const csrf: BrowserHttpRouteRequestOptions<"host_lock"> = {
      csrfToken: "C".repeat(43),
      csrfGeneration: "7"
    };

    // @ts-expect-error Session detail requires params.
    const missingParams: BrowserHttpRouteRequest<"session_detail"> = {};
    const extraBody: BrowserHttpRouteRequest<"health_liveness"> = {
      // @ts-expect-error Liveness has no request body.
      body: {}
    };
    // @ts-expect-error CSRF-required routes require both selected values.
    const missingGeneration: BrowserHttpRouteRequestOptions<"host_lock"> = {
      csrfToken: "C".repeat(43)
    };
    const readCsrf: BrowserHttpRouteRequestOptions<"host_status"> = {
      // @ts-expect-error Read routes do not accept CSRF values.
      csrfToken: "C".repeat(43),
      csrfGeneration: "7"
    };

    expect({
      detail,
      eventPage,
      liveness,
      csrf,
      missingParams,
      extraBody,
      missingGeneration,
      readCsrf
    }).toBeDefined();
  });
});

function toComparableContract(
  route: (typeof browserHttpRouteContracts)[keyof typeof browserHttpRouteContracts]
) {
  return {
    id: route.id,
    method: route.method,
    path: route.path,
    csrf: route.csrf,
    request: {
      params: route.request.params?.id ?? null,
      query: route.request.query?.id ?? null,
      body: route.request.body?.id ?? null
    },
    response: {
      success: route.response.id,
      error: "selected_api_error_v1"
    }
  };
}
