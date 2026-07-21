import { describe, expect, it } from "vitest";
import {
  mobileInteractionIds,
  mobileInteractionTraces,
  mobileStateTraceIds,
  mobileStateTraces,
  selectedMobileStateFixtures,
  selectedStructuredRuntimeFixtures
} from "./index.js";

describe("selected mobile and runtime fixtures", () => {
  it("exports complete mobile state and interaction inventories", () => {
    expect(mobileStateTraces.map((trace) => trace.id)).toEqual(mobileStateTraceIds);
    expect(mobileInteractionTraces.map((trace) => trace.id)).toEqual(mobileInteractionIds);
  });

  it("keeps the first phone viewport useful and preload failures outside the app render tree", () => {
    const mission = mobileStateTraces.find((trace) => trace.id === "mission_mixed_attention");
    const detail = mobileStateTraces.find((trace) => trace.id === "detail_active_writable");
    const preload = mobileStateTraces.find((trace) => trace.id === "preload_remote_origin_unreachable");

    expect(mission?.firstViewport).toEqual(["host_access_strip", "page_title", "session_rows_two"]);
    expect(detail?.firstViewport).toContain("sticky_composer");
    expect(detail?.firstViewport).toContain("primary_controls");
    expect(preload).toMatchObject({
      renderBoundary: "browser_preload",
      diagnosisSource: "browser_network_only",
      dataDisclosure: "none"
    });
  });

  it("keeps both selected fixture collections populated", () => {
    expect(selectedMobileStateFixtures.length).toBeGreaterThan(0);
    expect(selectedStructuredRuntimeFixtures.length).toBeGreaterThan(0);
  });
});
