import { describe, expect, it } from "vitest";
import { selectedApiRouteManifest } from "../../server/src/selected-api-route-manifest.js";
import { browserSseRouteContract } from "./sse-route-contract.js";

describe("browser SSE route contract", () => {
  it("matches the sole selected production SSE route exactly", () => {
    const selected = selectedApiRouteManifest.filter(
      (route) => route.transport === "sse"
    );
    expect(selected).toHaveLength(1);
    expect(browserSseRouteContract).toEqual(selected[0]);
    expect(Object.isFrozen(browserSseRouteContract)).toBe(true);
    expect(Object.isFrozen(browserSseRouteContract.request)).toBe(true);
    expect(Object.isFrozen(browserSseRouteContract.response)).toBe(true);
  });
});
