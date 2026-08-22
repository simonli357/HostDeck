import { describe, expect, it } from "vitest";
import {
  apiErrorEnvelopeSchema,
  apiRouteErrorBodySchema,
  receivedApiRouteErrorBodySchema
} from "./api-error.js";

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

  it("rejects a credential-shaped detail key on the produced side", () => {
    expect(
      apiErrorEnvelopeSchema.safeParse({
        code: "internal_error",
        message: "No secrets.",
        details: { private_key: "leaked" }
      }).success
    ).toBe(false);
  });

  it("surfaces a typed received failure while stripping its credential-shaped details", () => {
    const parsed = receivedApiRouteErrorBodySchema.safeParse({
      error: {
        code: "validation_error",
        message: "Requested model is absent from the live catalog.",
        retryable: false,
        details: { private_key: "leaked", session_id: "sess_contract_02" }
      }
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.error.code).toBe("validation_error");
    expect(parsed.data.error.details).toMatchObject({ session_id: "sess_contract_02" });
  });

  it("keeps the produced route body strict about the same envelope", () => {
    expect(
      apiRouteErrorBodySchema.safeParse({
        error: { code: "validation_error", message: "x", retryable: false, details: { csrf: "leaked" } }
      }).success
    ).toBe(false);
  });
});
