import { createHash } from "node:crypto";
import { isoTimestampSchema, runtimeRequestIdSchema } from "@hostdeck/contracts";
import type { IsoTimestamp, RuntimeRequestId } from "@hostdeck/core";
import { z } from "zod";

export type CodexEventNormalizationErrorCode =
  | "duplicate_event"
  | "event_out_of_order"
  | "invalid_clock"
  | "malformed_required_event"
  | "normalizer_stopped"
  | "normalizer_capacity_exceeded"
  | "thread_scope_resolution_failed"
  | "unknown_notification"
  | "unsupported_item_type"
  | "unsupported_selected_event";

export class HostDeckCodexEventNormalizationError extends Error {
  constructor(
    readonly code: CodexEventNormalizationErrorCode,
    message: string,
    readonly method: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "HostDeckCodexEventNormalizationError";
  }
}

export type NormalizedCodexContentState = "complete" | "redacted" | "redacted_and_truncated" | "truncated";

export interface BoundedCodexContent {
  readonly text: string;
  readonly content_state: NormalizedCodexContentState;
  readonly content_notice: string | null;
}

export const maximumTextLength = 12_000;
export const maximumSummaryLength = 512;
export const maximumDetailLength = 2_000;
export const maximumMethodLength = 160;
export const maximumPlanSteps = 256;
export const maximumCollectionLength = 4_096;

const unixSecondMaximum = 253_402_300_799;
const unixMillisecondMaximum = 253_402_300_799_999;

export const nonnegativeSafeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const positiveSafeIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const unixSecondsSchema = z.number().int().nonnegative().max(unixSecondMaximum);
export const unixMillisecondsSchema = z.number().int().nonnegative().max(unixMillisecondMaximum);
export const boundedStringSchema = (maximum: number) => z.string().max(maximum);
export const boundedNonemptyStringSchema = (maximum: number) => z.string().min(1).max(maximum);
export const requiredValueSchema = z.unknown().refine((value) => value !== undefined, { message: "Required value is missing." });

export function parseCodexParams<Schema extends z.ZodType>(
  schema: Schema,
  candidate: unknown,
  method: string
): z.output<Schema> {
  const parsed = schema.safeParse(candidate);
  if (!parsed.success) {
    throw codexNormalizationError("malformed_required_event", `Codex ${method} payload is malformed.`, method, parsed.error);
  }
  return parsed.data;
}

export function boundCodexContent(
  value: string,
  maximum: number,
  notice: string,
  redacted = false
): BoundedCodexContent {
  const truncated = value.length > maximum;
  return {
    text: truncated ? value.slice(0, maximum) : value,
    content_state: redacted ? (truncated ? "redacted_and_truncated" : "redacted") : truncated ? "truncated" : "complete",
    content_notice: redacted || truncated ? notice : null
  };
}

export function unixSecondsToIso(value: number, method: string): IsoTimestamp {
  return parseIso(new Date(value * 1_000).toISOString(), method);
}

export function nullableUnixSecondsToIso(value: number | null, method: string): IsoTimestamp | null {
  return value === null ? null : unixSecondsToIso(value, method);
}

export function unixMillisecondsToIso(value: number, method: string): IsoTimestamp {
  return parseIso(new Date(value).toISOString(), method);
}

export function canonicalRuntimeRequestId(value: string | number, method: string): RuntimeRequestId {
  const candidate = `${typeof value === "number" ? "number" : "string"}:${value}`;
  const parsed = runtimeRequestIdSchema.safeParse(candidate);
  if (!parsed.success) {
    throw codexNormalizationError("malformed_required_event", "Codex request id cannot be normalized.", method, parsed.error);
  }
  return parsed.data;
}

export function stableCodexEventId(namespace: string, value: string): string {
  return `${namespace}:sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

export function boundedCodexText(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, Math.max(0, maximum - 3))}...`;
}

export function codexNormalizationError(
  code: CodexEventNormalizationErrorCode,
  message: string,
  method: string,
  cause?: unknown
): HostDeckCodexEventNormalizationError {
  return new HostDeckCodexEventNormalizationError(
    code,
    boundedCodexText(message, 240),
    boundedCodexText(method, maximumMethodLength),
    { ...(cause === undefined ? {} : { cause }) }
  );
}

export function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function parseIso(value: string, method: string): IsoTimestamp {
  const parsed = isoTimestampSchema.safeParse(value);
  if (!parsed.success) {
    throw codexNormalizationError("malformed_required_event", "Codex timestamp cannot be normalized.", method, parsed.error);
  }
  return parsed.data;
}
