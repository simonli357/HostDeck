import type { SharedSessionEnrollment } from "@hostdeck/contracts";

export type AutomaticEnrollmentFailureHealthEffect =
  | "isolated"
  | "projector_failed";

type FailedEnrollment = Extract<
  SharedSessionEnrollment,
  { readonly state: "failed" }
>;

export interface AutomaticEnrollmentFailureHealthContext {
  readonly event_pipeline_failed: boolean;
  readonly has_selected_mapping: boolean;
}

export function classifyAutomaticEnrollmentFailureHealth(
  outcome: FailedEnrollment,
  context: AutomaticEnrollmentFailureHealthContext
): AutomaticEnrollmentFailureHealthEffect {
  if (
    outcome.failure === "storage_failure" ||
    context.event_pipeline_failed ||
    context.has_selected_mapping
  ) {
    return "projector_failed";
  }
  return "isolated";
}
