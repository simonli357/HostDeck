import { describe, expect, it } from "vitest";
import { HostDeckCodexAdapterError } from "./errors.js";
import {
  decodeCodexInboundFrame,
  encodeCodexClientNotification,
  encodeCodexClientRequest,
  encodeCodexServerError
} from "./protocol.js";

describe("Codex wire envelope decoder", () => {
  it("decodes successful and remote-error responses without interpreting result payloads", () => {
    expect(decodeCodexInboundFrame('{"id":3,"result":{"thread":{"id":"thread-1"}}}')).toEqual({
      kind: "response",
      id: 3,
      result: { thread: { id: "thread-1" } },
      error: null
    });
    expect(decodeCodexInboundFrame('{"id":4,"error":{"code":-32001,"message":"Server overloaded","data":{"retry":true}}}')).toEqual({
      kind: "response",
      id: 4,
      result: null,
      error: { code: -32001, message: "Server overloaded", data: { retry: true } }
    });
  });

  it("classifies selected, generated-unhandled, and unknown notifications", () => {
    expect(decodeCodexInboundFrame('{"method":"turn/started","params":{"turn":{"id":"turn-1"}}}')).toMatchObject({
      kind: "notification",
      classification: "selected"
    });
    expect(decodeCodexInboundFrame('{"method":"account/updated","params":{}}')).toMatchObject({
      kind: "notification",
      classification: "generated_unhandled"
    });
    expect(decodeCodexInboundFrame('{"method":"future/required","params":{}}')).toMatchObject({
      kind: "notification",
      classification: "unknown"
    });
  });

  it("classifies supported, generated-unsupported, and unknown server requests", () => {
    expect(
      decodeCodexInboundFrame(
        '{"method":"item/commandExecution/requestApproval","id":"approval-1","params":{"threadId":"thread-1"}}'
      )
    ).toMatchObject({ kind: "server_request", classification: "supported" });
    expect(decodeCodexInboundFrame('{"method":"attestation/generate","id":8,"params":{}}')).toMatchObject({
      kind: "server_request",
      classification: "generated_unsupported"
    });
    expect(decodeCodexInboundFrame('{"method":"future/request","id":9,"params":{}}')).toMatchObject({
      kind: "server_request",
      classification: "unknown"
    });
  });

  it.each([
    "",
    "not-json",
    "[]",
    "{}",
    '{"id":1}',
    '{"id":1,"result":{},"error":{"code":1,"message":"bad"}}',
    '{"id":-1,"result":{}}',
    '{"id":1.5,"result":{}}',
    '{"id":1,"result":{},"extra":true}',
    '{"method":"turn/started","params":{},"id":null}',
    '{"method":"turn/started","params":{},"result":{}}',
    '{"method":"turn/started"}',
    '{"id":1,"error":{"code":1.5,"message":"bad"}}',
    '{"id":1,"error":{"code":1,"message":"","secret":"x"}}'
  ])("rejects malformed or contradictory frame %s", (frame) => {
    expectProtocolError(() => decodeCodexInboundFrame(frame));
  });

  it("enforces the configured UTF-8 frame bound", () => {
    const frame = '{"method":"future/event","params":{"value":"é"}}';
    expectProtocolError(() => decodeCodexInboundFrame(frame, Buffer.byteLength(frame, "utf8") - 1));
  });
});

describe("Codex outbound envelope encoder", () => {
  it("encodes only generated client methods and notifications", () => {
    expect(encodeCodexClientRequest("thread/list", 1, { limit: 10 })).toBe(
      '{"method":"thread/list","id":1,"params":{"limit":10}}'
    );
    expect(encodeCodexClientNotification("initialized")).toBe('{"method":"initialized"}');
    expect(encodeCodexServerError("request-1", -32601, "Unsupported request.")).toBe(
      '{"id":"request-1","error":{"code":-32601,"message":"Unsupported request."}}'
    );
    expect(encodeCodexServerError("request-2", -32601, "Unsafe\n\u0000detail")).toBe(
      '{"id":"request-2","error":{"code":-32601,"message":"Unsafe detail"}}'
    );
    expectProtocolError(() => encodeCodexClientRequest("future/mutation", 2, {}), "unsupported_method");
    expectProtocolError(() => encodeCodexClientNotification("future/notification"), "unsupported_method");
  });
});

function expectProtocolError(fn: () => unknown, code = "invalid_protocol_message"): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(HostDeckCodexAdapterError);
    expect((error as HostDeckCodexAdapterError).code).toBe(code);
    return;
  }
  throw new Error(`Expected HostDeckCodexAdapterError ${code}.`);
}
