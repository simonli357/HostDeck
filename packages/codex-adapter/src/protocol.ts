import { Buffer } from "node:buffer";
import { codexBindingDescriptor } from "./binding.js";
import { boundedProtocolText, HostDeckCodexAdapterError } from "./errors.js";
import {
  generatedClientNotificationMethods,
  generatedClientRequestMethods,
  generatedServerNotificationMethods,
  generatedServerRequestMethods
} from "./protocol-methods.generated.js";

export type CodexRequestId = number | string;
export type CodexMethodClassification = "generated_unhandled" | "selected" | "unknown";
export type CodexServerRequestClassification = "generated_unsupported" | "supported" | "unknown";

export interface CodexRpcError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export type DecodedCodexInboundMessage =
  | {
      readonly kind: "response";
      readonly id: CodexRequestId;
      readonly result: unknown;
      readonly error: null;
    }
  | {
      readonly kind: "response";
      readonly id: CodexRequestId;
      readonly result: null;
      readonly error: CodexRpcError;
    }
  | {
      readonly kind: "notification";
      readonly method: string;
      readonly params: unknown;
      readonly classification: CodexMethodClassification;
    }
  | {
      readonly kind: "server_request";
      readonly id: CodexRequestId;
      readonly method: string;
      readonly params: unknown;
      readonly classification: CodexServerRequestClassification;
    };

const generatedClientRequestSet = new Set<string>(generatedClientRequestMethods);
const generatedClientNotificationSet = new Set<string>(generatedClientNotificationMethods);
const generatedServerNotificationSet = new Set<string>(generatedServerNotificationMethods);
const generatedServerRequestSet = new Set<string>(generatedServerRequestMethods);
const selectedNotificationSet = new Set(codexBindingDescriptor.surface.server_notifications);
const supportedServerRequestSet = new Set(codexBindingDescriptor.surface.server_requests);

export function isGeneratedClientRequestMethod(method: string): boolean {
  return generatedClientRequestSet.has(method);
}

export function isGeneratedClientNotificationMethod(method: string): boolean {
  return generatedClientNotificationSet.has(method);
}

export function decodeCodexInboundFrame(frame: string, maxFrameBytes = 1_048_576): DecodedCodexInboundMessage {
  const frameBytes = Buffer.byteLength(frame, "utf8");
  if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1 || frameBytes < 1 || frameBytes > maxFrameBytes) {
    throw protocolError(`Codex protocol frame must contain 1 to ${maxFrameBytes} UTF-8 bytes.`);
  }

  let candidate: unknown;
  try {
    candidate = JSON.parse(frame) as unknown;
  } catch (error) {
    throw protocolError("Codex protocol frame is not valid JSON.", error);
  }
  const value = requireRecord(candidate, "Codex protocol message must be an object.");
  const hasMethod = Object.hasOwn(value, "method");
  const hasId = Object.hasOwn(value, "id");
  const hasResult = Object.hasOwn(value, "result");
  const hasError = Object.hasOwn(value, "error");

  if (hasMethod) {
    assertExactKeys(value, hasId ? ["id", "method", "params"] : ["method", "params"]);
    const method = parseMethod(value.method);
    const params = Object.hasOwn(value, "params") ? value.params : undefined;
    if (hasResult || hasError) throw protocolError("Codex method messages cannot also contain result or error.");
    if (hasId) {
      const id = parseRequestId(value.id);
      return {
        kind: "server_request",
        id,
        method,
        params,
        classification: supportedServerRequestSet.has(method)
          ? "supported"
          : generatedServerRequestSet.has(method)
            ? "generated_unsupported"
            : "unknown"
      };
    }
    return {
      kind: "notification",
      method,
      params,
      classification: selectedNotificationSet.has(method)
        ? "selected"
        : generatedServerNotificationSet.has(method)
          ? "generated_unhandled"
          : "unknown"
    };
  }

  if (!hasId || hasResult === hasError) {
    throw protocolError("Codex responses require id and exactly one of result or error.");
  }
  assertExactKeys(value, hasResult ? ["id", "result"] : ["error", "id"]);
  const id = parseRequestId(value.id);
  if (hasResult) return { kind: "response", id, result: value.result, error: null };
  return { kind: "response", id, result: null, error: parseRpcError(value.error) };
}

export function encodeCodexClientRequest(method: string, id: number, params: unknown): string {
  if (!isGeneratedClientRequestMethod(method)) {
    throw new HostDeckCodexAdapterError("unsupported_method", `Codex client request method ${boundedProtocolText(method)} is not generated.`, {
      outcome: "not_sent",
      retry_safe: true
    });
  }
  return JSON.stringify({ method, id, params });
}

export function encodeCodexClientNotification(method: string): string {
  if (!isGeneratedClientNotificationMethod(method)) {
    throw new HostDeckCodexAdapterError("unsupported_method", `Codex client notification method ${boundedProtocolText(method)} is not generated.`, {
      outcome: "not_sent",
      retry_safe: true
    });
  }
  return JSON.stringify({ method });
}

export function encodeCodexServerError(id: CodexRequestId, code: number, message: string): string {
  return JSON.stringify({ id: parseRequestId(id), error: { code: parseRpcCode(code), message: boundedProtocolText(message) } });
}

function parseRpcError(candidate: unknown): CodexRpcError {
  const value = requireRecord(candidate, "Codex response error must be an object.");
  assertExactKeys(value, Object.hasOwn(value, "data") ? ["code", "data", "message"] : ["code", "message"]);
  const error: CodexRpcError = {
    code: parseRpcCode(value.code),
    message: parseBoundedString(value.message, "Codex response error message", 1_000)
  };
  return Object.hasOwn(value, "data") ? { ...error, data: value.data } : error;
}

function parseRpcCode(candidate: unknown): number {
  if (typeof candidate !== "number" || !Number.isSafeInteger(candidate)) throw protocolError("Codex RPC error code must be a safe integer.");
  return candidate;
}

function parseRequestId(candidate: unknown): CodexRequestId {
  if (typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0) return candidate;
  if (typeof candidate === "string" && candidate.length >= 1 && candidate.length <= 120 && !containsControlCharacter(candidate)) {
    return candidate;
  }
  throw protocolError("Codex request id must be a non-negative safe integer or bounded string.");
}

function parseMethod(candidate: unknown): string {
  return parseBoundedString(candidate, "Codex protocol method", 160);
}

function parseBoundedString(candidate: unknown, label: string, maxLength: number): string {
  if (typeof candidate !== "string" || candidate.length < 1 || candidate.length > maxLength || containsControlCharacter(candidate)) {
    throw protocolError(`${label} must be a bounded printable string.`);
  }
  return candidate;
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function requireRecord(candidate: unknown, message: string): Record<string, unknown> {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) throw protocolError(message);
  return candidate as Record<string, unknown>;
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const keys = Object.keys(value).sort();
  if (JSON.stringify(keys) !== JSON.stringify([...expected].sort())) {
    throw protocolError(`Codex protocol message fields are invalid: ${keys.join(", ") || "none"}.`);
  }
}

function protocolError(message: string, cause?: unknown): HostDeckCodexAdapterError {
  return new HostDeckCodexAdapterError("invalid_protocol_message", message, { cause, outcome: "not_applicable", retry_safe: false });
}
