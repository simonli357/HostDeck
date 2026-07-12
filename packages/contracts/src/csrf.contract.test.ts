import { describe, expect, it } from "vitest";
import {
  selectedCsrfBootstrapRequestSchema,
  selectedCsrfBootstrapResponseSchema,
  selectedCsrfGenerationHeaderName,
  selectedCsrfGenerationHeaderValueSchema,
  selectedCsrfTokenHeaderName,
  selectedRawCsrfTokenSchema
} from "./csrf.js";

describe("selected CSRF contracts", () => {
  it("freezes the selected header names and exact raw token syntax", () => {
    expect(selectedCsrfTokenHeaderName).toBe("x-hostdeck-csrf");
    expect(selectedCsrfGenerationHeaderName).toBe("x-hostdeck-csrf-generation");
    const exact = "A".repeat(43);
    expect(selectedRawCsrfTokenSchema.parse(exact)).toBe(exact);

    for (const invalid of [
      "A".repeat(42),
      "A".repeat(44),
      `${"A".repeat(42)}=`,
      `${"A".repeat(42)}.`,
      `${"A".repeat(42)}~`,
      `${"A".repeat(42)} `,
      `%${"A".repeat(42)}`,
      "界".repeat(43),
      ""
    ]) {
      expect(() => selectedRawCsrfTokenSchema.parse(invalid)).toThrow();
    }
  });

  it("parses only canonical positive-safe decimal generation headers", () => {
    expect(selectedCsrfGenerationHeaderValueSchema.parse("1")).toBe(1);
    expect(selectedCsrfGenerationHeaderValueSchema.parse("9007199254740991")).toBe(
      Number.MAX_SAFE_INTEGER
    );

    for (const invalid of [
      "",
      "0",
      "00",
      "01",
      "+1",
      "-1",
      " 1",
      "1 ",
      "1.0",
      "1e0",
      "1,2",
      "9007199254740992",
      "99999999999999999",
      "１２"
    ]) {
      expect(() => selectedCsrfGenerationHeaderValueSchema.parse(invalid)).toThrow();
    }
  });

  it("requires one exact operation id for bootstrap requests", () => {
    const request = { operation_id: "op_csrf_contract_001" };
    expect(selectedCsrfBootstrapRequestSchema.parse(request)).toEqual(request);

    for (const invalid of [
      null,
      {},
      { operation_id: "" },
      { operation_id: "not an operation" },
      { operation_id: request.operation_id, csrf_token: "A".repeat(43) },
      { operation_id: request.operation_id, device_id: "client_forbidden" },
      { operation_id: request.operation_id, csrf_generation: 1 }
    ]) {
      expect(() => selectedCsrfBootstrapRequestSchema.parse(invalid)).toThrow();
    }
  });

  it("accepts only the exact canonical bootstrap response", () => {
    const response = {
      csrf_token: "B".repeat(43),
      csrf_generation: 2,
      rotated_at: "2026-07-12T15:00:00.000Z"
    };
    expect(selectedCsrfBootstrapResponseSchema.parse(response)).toEqual(response);

    for (const invalid of [
      null,
      {},
      { ...response, csrf_token: "short" },
      { ...response, csrf_generation: 0 },
      { ...response, csrf_generation: 1.5 },
      { ...response, csrf_generation: Number.MAX_SAFE_INTEGER + 1 },
      { ...response, rotated_at: "not-a-time" },
      { ...response, device_id: "client_forbidden" },
      { ...response, bearer_token: "C".repeat(43) }
    ]) {
      expect(() => selectedCsrfBootstrapResponseSchema.parse(invalid)).toThrow();
    }
  });
});
