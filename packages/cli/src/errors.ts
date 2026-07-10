import type { ApiErrorEnvelope } from "@hostdeck/contracts";
import { type CliExitCode, cliExitCodes } from "./exit-codes.js";

export type CliFailureKind = "usage" | "invalid_config" | "daemon_unavailable" | "api_error" | "internal";

export interface CliFailureInput {
  readonly kind: CliFailureKind;
  readonly code: ApiErrorEnvelope["code"];
  readonly message: string;
  readonly exitCode: CliExitCode;
  readonly field?: string;
  readonly retryable?: boolean;
  readonly status?: number;
  readonly apiError?: ApiErrorEnvelope;
  readonly cause?: unknown;
}

export class CliFailure extends Error {
  readonly kind: CliFailureKind;
  readonly code: ApiErrorEnvelope["code"];
  readonly exitCode: CliExitCode;
  readonly field?: string;
  readonly retryable: boolean;
  readonly status?: number;
  readonly apiError?: ApiErrorEnvelope;
  readonly causeValue?: unknown;

  constructor(input: CliFailureInput) {
    super(input.message);
    this.name = "CliFailure";
    this.kind = input.kind;
    this.code = input.code;
    this.exitCode = input.exitCode;
    this.retryable = input.retryable ?? false;

    if (input.field !== undefined) {
      this.field = input.field;
    }

    if (input.status !== undefined) {
      this.status = input.status;
    }

    if (input.apiError !== undefined) {
      this.apiError = input.apiError;
    }

    if (input.cause !== undefined) {
      this.causeValue = input.cause;
    }
  }
}

export function usageFailure(message: string, field = "args"): CliFailure {
  return new CliFailure({
    kind: "usage",
    code: "malformed_request",
    message,
    exitCode: cliExitCodes.usage,
    field
  });
}

export function configFailure(message: string, field = "config", cause?: unknown): CliFailure {
  return new CliFailure({
    kind: "invalid_config",
    code: "invalid_config",
    message,
    exitCode: cliExitCodes.config,
    field,
    ...(cause !== undefined ? { cause } : {})
  });
}

export function daemonUnavailableFailure(baseUrl: URL, cause: unknown): CliFailure {
  return new CliFailure({
    kind: "daemon_unavailable",
    code: "daemon_unavailable",
    message: `Unable to reach HostDeck daemon at ${formatBaseUrl(baseUrl)}.`,
    exitCode: cliExitCodes.daemonUnavailable,
    retryable: true,
    cause
  });
}

export function apiFailure(status: number, apiError: ApiErrorEnvelope): CliFailure {
  const input: CliFailureInput = {
    kind: "api_error",
    code: apiError.code,
    message: apiError.message,
    exitCode: cliExitCodes.apiError,
    retryable: apiError.retryable,
    status,
    apiError
  };

  if (apiError.field !== undefined) {
    return new CliFailure({
      ...input,
      field: apiError.field
    });
  }

  return new CliFailure(input);
}

export function internalFailure(message: string, cause?: unknown): CliFailure {
  return new CliFailure({
    kind: "internal",
    code: "internal_error",
    message,
    exitCode: cliExitCodes.internal,
    cause
  });
}

export function toCliFailure(error: unknown): CliFailure {
  if (error instanceof CliFailure) {
    return error;
  }

  if (error instanceof Error) {
    return internalFailure(error.message, error);
  }

  return internalFailure("Unknown HostDeck CLI failure.", error);
}

function formatBaseUrl(baseUrl: URL): string {
  return baseUrl.toString().replace(/\/$/u, "");
}
