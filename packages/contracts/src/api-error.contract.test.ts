import { describe, expect, it } from "vitest";
import { apiErrorEnvelopeSchema, apiRouteErrorBodySchema } from "./api-error.js";

describe("selected API error envelopes", () => {
  it("accepts bounded errors and defaults retryability", () => {
    expect(
      apiErrorEnvelopeSchema.parse({
        code: "validation_error",
        message: "Invalid cursor.",
        field: "after",
        session_id: "sess_contract_01",
        details: { reason: "not_integer" }
      })
    ).toMatchObject({ code: "validation_error", retryable: false });

    expect(
      apiRouteErrorBodySchema.parse({
        error: { code: "permission_denied", message: "Read token is required.", retryable: false }
      }).error.code
    ).toBe("permission_denied");
  });

  it("rejects sensitive, nested, extra, and obsolete error state", () => {
    for (const details of [{ auth_token: "secret" }, { nested: { value: true } }]) {
      expect(() =>
        apiErrorEnvelopeSchema.parse({ code: "internal_error", message: "No details.", details })
      ).toThrow();
    }
    expect(() =>
      apiErrorEnvelopeSchema.parse({ code: "tmux_error", message: "Obsolete.", retryable: false })
    ).toThrow();
    expect(() =>
      apiRouteErrorBodySchema.parse({
        error: { code: "internal_error", message: "Failed.", retryable: false },
        fallback: true
      })
    ).toThrow();
  });
});
