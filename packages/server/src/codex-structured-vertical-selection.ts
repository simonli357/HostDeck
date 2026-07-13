import type { ModelCatalogEntry } from "@hostdeck/contracts";

export interface StructuredVerticalModelSelection {
  readonly model: ModelCatalogEntry;
  readonly effort: string;
}

export function selectStructuredVerticalPlanModel(
  models: readonly ModelCatalogEntry[],
  currentModelId: string | null,
  _currentEffort: string | null
): StructuredVerticalModelSelection {
  for (const model of models) {
    if (model.id === currentModelId) continue;
    const effort = model.reasoning_efforts.find((candidate) => ["minimal", "low"].includes(candidate.id));
    if (effort !== undefined) return { model, effort: effort.id };
  }
  throw new Error("Aggregate requires one noncurrent model selection at minimal or low reasoning effort.");
}
