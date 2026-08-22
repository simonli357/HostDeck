import { describe, expect, it } from "vitest";
import {
  createErrorEnvelope,
  errorCodes,
  errorEnvelopeLimits,
  isErrorCode,
  parseErrorEnvelope
} from "./errors.js";
import { parseSessionId } from "./identifiers.js";

function validSessionId() {
  const result = parseSessionId("sess_errors_01");

  if (!result.ok) {
    throw new Error(result.message);
  }

  return result.value;
}

describe("error codes", () => {
  it("exposes stable error code families used by API and CLI boundaries", () => {
    expect(errorCodes).toContain("malformed_request");
    expect(errorCodes).toContain("invalid_cwd");
    expect(errorCodes).toContain("duplicate_session_name");
    expect(errorCodes).toContain("missing_binary");
    expect(errorCodes).toContain("daemon_unavailable");
    expect(errorCodes).toContain("incompatible_runtime");
    expect(errorCodes).toContain("capability_unavailable");
    expect(errorCodes).toContain("approval_not_pending");
    expect(errorCodes).toContain("insecure_transport");
    expect(errorCodes).toContain("audit_unavailable");
    expect(errorCodes).toContain("request_too_large");
    expect(errorCodes).toContain("service_overloaded");
    expect(errorCodes).toContain("route_not_found");
    expect(errorCodes).toContain("method_not_allowed");
    expect(errorCodes).toContain("not_acceptable");
    expect(errorCodes).toContain("unsupported_media_type");
    expect(isErrorCode("host_locked")).toBe(true);
    expect(isErrorCode("not-a-code")).toBe(false);
  });
});

describe("error envelope", () => {
  it("creates a bounded envelope with default retryability", () => {
    const envelope = createErrorEnvelope({
      code: "validation_error",
      message: "Invalid request.",
      field: "cwd",
      sessionId: validSessionId(),
      details: {
        reason: "not_absolute",
        retry_after_ms: 0,
        retryable_by_user: true
      }
    });

    expect(envelope).toEqual({
      code: "validation_error",
      message: "Invalid request.",
      retryable: false,
      field: "cwd",
      sessionId: "sess_errors_01",
      details: {
        reason: "not_absolute",
        retry_after_ms: 0,
        retryable_by_user: true
      }
    });
  });

  it("preserves explicit retryability", () => {
    expect(
      createErrorEnvelope({
        code: "daemon_unavailable",
        message: "Daemon is not running.",
        retryable: true
      }).retryable
    ).toBe(true);
  });

  it("rejects empty and unbounded messages", () => {
    expect(parseErrorEnvelope({ code: "validation_error", message: "   " })).toMatchObject({
      ok: false,
      code: "empty_message"
    });

    expect(
      parseErrorEnvelope({
        code: "validation_error",
        message: "x".repeat(errorEnvelopeLimits.messageLength + 1)
      })
    ).toMatchObject({ ok: false, code: "message_too_long" });
  });

  it("rejects every credential-shaped detail key on the produced side", () => {
    const credentialKeys = [
      "auth_token", "authorization", "authentication", "auth", "bearer", "cookie",
      "credential", "csrf", "csrf_hash", "nonce", "otp", "pairing_code", "passphrase",
      "password", "pin", "device_pin", "signature", "key", "keys", "api_key", "node_key",
      "private_key", "refresh_token"
    ];
    const accepted = credentialKeys.filter(
      (key) => parseErrorEnvelope({ code: "internal_error", message: "No secrets.", details: { [key]: "x" } }).ok
    );
    expect(accepted).toStrictEqual([]);
  });

  it("keeps public product vocabulary usable as detail keys", () => {
    const publicKeys = [
      "session_id", "device_id", "operation_id", "thread_id", "turn_id", "request_id",
      "reason", "cursor", "limit", "key_count_total", "pin_count"
    ];
    const rejected = publicKeys.filter(
      (key) => !parseErrorEnvelope({ code: "internal_error", message: "Fine.", details: { [key]: "x" } }).ok
    );
    expect(rejected).toStrictEqual([]);
  });

  it("strips rather than rejects credential-shaped keys on the received side", () => {
    const result = parseErrorEnvelope(
      {
        code: "validation_error",
        message: "Requested model is absent from the live catalog.",
        details: { private_key: "leaked", session_id: "sess_1", csrf: "leaked" }
      },
      "received"
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.code).toBe("validation_error");
    expect(result.value.message).toBe("Requested model is absent from the live catalog.");
    expect(result.value.details).toStrictEqual({ session_id: "sess_1" });
  });

  it("still rejects malformed received details rather than silently dropping them", () => {
    const result = parseErrorEnvelope(
      { code: "internal_error", message: "Bad.", details: { reason: { nested: true } as never } },
      "received"
    );
    expect(result).toMatchObject({ ok: false, code: "invalid_detail_value" });
  });

  it("rejects sensitive or unbounded details", () => {
    expect(
      parseErrorEnvelope({
        code: "internal_error",
        message: "No secrets.",
        details: { auth_token: "abc" }
      })
    ).toMatchObject({ ok: false, code: "sensitive_detail_key" });

    expect(
      parseErrorEnvelope({
        code: "internal_error",
        message: "No nested details.",
        details: { nested: { value: true } }
      })
    ).toMatchObject({ ok: false, code: "invalid_detail_value" });

    expect(
      parseErrorEnvelope({
        code: "internal_error",
        message: "No long details.",
        details: { output: "x".repeat(errorEnvelopeLimits.detailStringLength + 1) }
      })
    ).toMatchObject({ ok: false, code: "detail_value_too_long" });
  });

  it("throws loudly when callers try to create an invalid envelope", () => {
    expect(() =>
      createErrorEnvelope({
        code: "internal_error",
        message: "",
        details: { password: "do-not-accept" }
      })
    ).toThrow("Error message is required.");
  });
});
