import type { SessionId } from "./session.js";

export const errorCodes = [
  "malformed_request",
  "request_too_large",
  "validation_error",
  "invalid_config",
  "missing_binary",
  "invalid_cwd",
  "duplicate_session_name",
  "invalid_session_id",
  "session_not_found",
  "session_not_writable",
  "stale_session",
  "host_locked",
  "permission_denied",
  "read_only",
  "unsupported_slash",
  "audit_unavailable",
  "tmux_error",
  "storage_error",
  "daemon_unavailable",
  "runtime_unavailable",
  "incompatible_runtime",
  "protocol_error",
  "operation_timeout",
  "operation_conflict",
  "capability_unavailable",
  "approval_not_pending",
  "rate_limited",
  "service_overloaded",
  "invalid_origin",
  "insecure_transport",
  "internal_error",
  "unknown_error"
] as const;

export type ErrorCode = (typeof errorCodes)[number];

export type ErrorDetailValue = string | number | boolean | null;
export type ErrorDetails = Readonly<Record<string, ErrorDetailValue>>;

export interface ErrorEnvelope {
  readonly code: ErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly field?: string;
  readonly sessionId?: SessionId;
  readonly details?: ErrorDetails;
}

export interface ErrorEnvelopeInput {
  readonly code: ErrorCode;
  readonly message: string;
  readonly retryable?: boolean;
  readonly field?: string;
  readonly sessionId?: SessionId;
  readonly details?: Readonly<Record<string, unknown>>;
}

export const errorEnvelopeLimits = {
  messageLength: 240,
  fieldLength: 80,
  detailFieldCount: 12,
  detailKeyLength: 64,
  detailStringLength: 256
} as const;

export type ErrorEnvelopeIssueCode =
  | "empty_message"
  | "message_too_long"
  | "field_too_long"
  | "invalid_details"
  | "too_many_detail_fields"
  | "invalid_detail_key"
  | "sensitive_detail_key"
  | "invalid_detail_value"
  | "detail_value_too_long";

type ErrorEnvelopeIssue = { readonly ok: false; readonly code: ErrorEnvelopeIssueCode; readonly message: string };

export type ErrorEnvelopeResult = { readonly ok: true; readonly value: ErrorEnvelope } | ErrorEnvelopeIssue;

type DetailsValidationResult =
  | { readonly ok: true; readonly value?: ErrorDetails }
  | ErrorEnvelopeIssue;

const detailKeyPattern = /^[a-zA-Z0-9_.-]+$/u;
const sensitiveDetailKeyPattern = /(authorization|cookie|password|secret|token)/iu;

export function isErrorCode(value: string): value is ErrorCode {
  return (errorCodes as readonly string[]).includes(value);
}

export function parseErrorEnvelope(input: ErrorEnvelopeInput): ErrorEnvelopeResult {
  const message = input.message.trim();

  if (message.length === 0) {
    return invalid("empty_message", "Error message is required.");
  }

  if (message.length > errorEnvelopeLimits.messageLength) {
    return invalid("message_too_long", `Error message must be ${errorEnvelopeLimits.messageLength} characters or fewer.`);
  }

  if (input.field !== undefined && input.field.length > errorEnvelopeLimits.fieldLength) {
    return invalid("field_too_long", `Error field must be ${errorEnvelopeLimits.fieldLength} characters or fewer.`);
  }

  const detailsResult = validateDetails(input.details);

  if (!detailsResult.ok) {
    return detailsResult;
  }

  const envelope: ErrorEnvelope = {
    code: input.code,
    message,
    retryable: input.retryable ?? false
  };

  if (input.field !== undefined) {
    envelopeWith(envelope, "field", input.field);
  }

  if (input.sessionId !== undefined) {
    envelopeWith(envelope, "sessionId", input.sessionId);
  }

  if (detailsResult.value !== undefined) {
    envelopeWith(envelope, "details", detailsResult.value);
  }

  return { ok: true, value: envelope };
}

export function createErrorEnvelope(input: ErrorEnvelopeInput): ErrorEnvelope {
  const result = parseErrorEnvelope(input);

  if (!result.ok) {
    throw new TypeError(result.message);
  }

  return result.value;
}

function validateDetails(details: Readonly<Record<string, unknown>> | undefined): DetailsValidationResult {
  if (details === undefined) {
    return { ok: true };
  }

  if (details === null || typeof details !== "object" || Array.isArray(details)) {
    return invalid("invalid_details", "Error details must be a flat object.");
  }

  const entries = Object.entries(details);

  if (entries.length > errorEnvelopeLimits.detailFieldCount) {
    return invalid("too_many_detail_fields", `Error details must have ${errorEnvelopeLimits.detailFieldCount} fields or fewer.`);
  }

  const boundedDetails: Record<string, ErrorDetailValue> = {};

  for (const [key, value] of entries) {
    const keyIssue = validateDetailKey(key);

    if (keyIssue !== null) {
      return keyIssue;
    }

    if (typeof value === "string") {
      if (value.length > errorEnvelopeLimits.detailStringLength) {
        return invalid("detail_value_too_long", `Error detail "${key}" must be ${errorEnvelopeLimits.detailStringLength} characters or fewer.`);
      }

      boundedDetails[key] = value;
      continue;
    }

    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        return invalid("invalid_detail_value", `Error detail "${key}" must be finite.`);
      }

      boundedDetails[key] = value;
      continue;
    }

    if (typeof value === "boolean" || value === null) {
      boundedDetails[key] = value;
      continue;
    }

    return invalid("invalid_detail_value", `Error detail "${key}" must be a string, finite number, boolean, or null.`);
  }

  return { ok: true, value: boundedDetails };
}

function validateDetailKey(key: string): ErrorEnvelopeIssue | null {
  if (key.length === 0 || key.length > errorEnvelopeLimits.detailKeyLength || !detailKeyPattern.test(key)) {
    return invalid("invalid_detail_key", `Error detail key "${key}" is invalid.`);
  }

  if (sensitiveDetailKeyPattern.test(key)) {
    return invalid("sensitive_detail_key", `Error detail key "${key}" appears sensitive.`);
  }

  return null;
}

function envelopeWith<K extends keyof ErrorEnvelope>(envelope: ErrorEnvelope, key: K, value: ErrorEnvelope[K]): void {
  Object.assign(envelope, { [key]: value });
}

function invalid(code: ErrorEnvelopeIssueCode, message: string): ErrorEnvelopeIssue {
  return { ok: false, code, message };
}
