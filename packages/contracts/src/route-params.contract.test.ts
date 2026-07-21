import { describe, expect, it } from "vitest";
import { sessionIdParamsSchema } from "./route-params.js";

describe("selected route parameters", () => {
  it("accepts one exact selected session id", () => {
    expect(sessionIdParamsSchema.parse({ session_id: "sess_contract_01" }).session_id).toBe("sess_contract_01");
  });

  it("rejects malformed, inherited-only, and extra parameters", () => {
    expect(() => sessionIdParamsSchema.parse({ session_id: "bad" })).toThrow();
    expect(() => sessionIdParamsSchema.parse(Object.create({ session_id: "sess_contract_01" }))).toThrow();
    expect(() => sessionIdParamsSchema.parse({ session_id: "sess_contract_01", raw: true })).toThrow();
  });
});
