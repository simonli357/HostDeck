import {
  type SharedSessionEnrollment,
  sharedSessionEnrollmentSchema
} from "@hostdeck/contracts";
import { describe, expect, it } from "vitest";
import { classifyAutomaticEnrollmentFailureHealth } from "./automatic-session-enrollment-health.js";

const nativeThreadId = "019f489a-1f9d-7402-ae00-eac6ea322f64";

describe("automatic enrollment health classification", () => {
  it.each([
    "metadata_failure",
    "pending_overflow",
    "pending_timeout",
    "runtime_boundary",
    "subscription_failure"
  ] as const)("isolates an unmanaged %s outcome", (failure) => {
    expect(
      classifyAutomaticEnrollmentFailureHealth(failed(failure), {
        event_pipeline_failed: false,
        has_selected_mapping: false
      })
    ).toBe("isolated");
  });

  it("fails the projector for storage, pipeline, or selected-session uncertainty", () => {
    expect(
      classifyAutomaticEnrollmentFailureHealth(failed("storage_failure"), {
        event_pipeline_failed: false,
        has_selected_mapping: false
      })
    ).toBe("projector_failed");
    expect(
      classifyAutomaticEnrollmentFailureHealth(failed("pending_timeout"), {
        event_pipeline_failed: true,
        has_selected_mapping: false
      })
    ).toBe("projector_failed");
    expect(
      classifyAutomaticEnrollmentFailureHealth(failed("pending_timeout"), {
        event_pipeline_failed: false,
        has_selected_mapping: true
      })
    ).toBe("projector_failed");
  });
});

function failed(
  failure: Extract<
    SharedSessionEnrollment,
    { readonly state: "failed" }
  >["failure"]
): Extract<SharedSessionEnrollment, { readonly state: "failed" }> {
  return sharedSessionEnrollmentSchema.parse({
    state: "failed",
    native_thread_id: nativeThreadId,
    phase: "pending_materialization",
    failure,
    failed_at: "2026-08-17T18:30:00.000Z",
    detail: "Automatic enrollment failed at its explicit boundary.",
    boundary_required: true
  }) as Extract<SharedSessionEnrollment, { readonly state: "failed" }>;
}
