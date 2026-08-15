import { describe, expect, it } from "vitest";
import { sessionIdParamsSchema } from "./route-params.js";

describe("selected route parameters", () => {
  it("accepts one exact internal or native session target", () => {
    expect(sessionIdParamsSchema.parse({ session_id: "sess_contract_01" }).session_id).toBe("sess_contract_01");
    expect(
      sessionIdParamsSchema.parse({ session_id: "019f489a-1f9d-7402-ae00-eac6ea322f64" }).session_id
    ).toBe("019f489a-1f9d-7402-ae00-eac6ea322f64");
  });

  it("rejects malformed, inherited-only, and extra parameters", () => {
    expect(() => sessionIdParamsSchema.parse({ session_id: "bad" })).toThrow();
    expect(() => sessionIdParamsSchema.parse(Object.create({ session_id: "sess_contract_01" }))).toThrow();
    expect(() => sessionIdParamsSchema.parse({ session_id: "sess_contract_01", raw: true })).toThrow();
  });
});
