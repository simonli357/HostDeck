import type { ModelCatalogEntry } from "@hostdeck/contracts";
import { describe, expect, it } from "vitest";
import { selectStructuredVerticalPlanModel } from "./codex-structured-vertical-selection.js";

describe("structured vertical model selection", () => {
  it("selects the first noncurrent model at low effort", () => {
    const current = model("model-current", "Current");
    const first = model("model-first", "First");
    const later = model("model-later", "Later");

    expect(selectStructuredVerticalPlanModel([current, first, later], current.id, "low")).toEqual({
      model: first,
      effort: "low"
    });
  });

  it("skips noncurrent models without minimal or low effort", () => {
    const unsupported = model("model-high", "High", ["high"]);
    const supported = model("model-low", "Low", ["minimal", "high"]);

    expect(selectStructuredVerticalPlanModel([unsupported, supported], null, null)).toEqual({
      model: supported,
      effort: "minimal"
    });
  });

  it("rejects catalogs without a noncurrent minimal or low selection", () => {
    const current = model("model-current", "Current");
    expect(() => selectStructuredVerticalPlanModel([current], current.id, "low")).toThrow(
      "Aggregate requires one noncurrent model selection at minimal or low reasoning effort."
    );
    expect(() => selectStructuredVerticalPlanModel([model("model-high", "High", ["high"])], null, null)).toThrow(
      "Aggregate requires one noncurrent model selection at minimal or low reasoning effort."
    );
  });
});

function model(id: string, label: string, efforts: readonly string[] = ["low", "high"]): ModelCatalogEntry {
  return {
    id,
    runtime_model: id,
    label,
    description: null,
    is_default: false,
    input_modalities: ["text"],
    reasoning_efforts: efforts.map((effort, index) => ({
      id: effort,
      description: null,
      is_default: index === efforts.length - 1
    }))
  };
}
