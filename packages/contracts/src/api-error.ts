import type { ErrorEnvelopeInput, ErrorEnvelopeOrigin } from "@hostdeck/core";
import { createErrorEnvelope, errorCodes, errorEnvelopeLimits } from "@hostdeck/core";
import { z } from "zod";
import { detailValueSchema, sessionIdSchema } from "./scalars.js";

function apiErrorEnvelopeSchemaFor(origin: ErrorEnvelopeOrigin) {
  return z
  .object({
    code: z.enum(errorCodes),
    message: z.string().trim().min(1).max(errorEnvelopeLimits.messageLength),
    retryable: z.boolean().optional().default(false),
    field: z.string().max(errorEnvelopeLimits.fieldLength).optional(),
    session_id: sessionIdSchema.optional(),
    details: z.record(z.string(), detailValueSchema).optional()
  })
  .strict()
  .superRefine((value, context) => {
    const result = createEnvelopeResult(value, origin);
    if (!result.ok) context.addIssue({ code: "custom", message: result.message });
  });
}

/** Envelope HostDeck is about to emit. A credential-shaped detail key is our own defect. */
export const apiErrorEnvelopeSchema = apiErrorEnvelopeSchemaFor("produced");

/**
 * Envelope HostDeck is reading back from a peer. Credential-shaped detail keys are stripped
 * rather than rejected, so a correctly typed failure is still surfaced instead of collapsing
 * to `internal_error` over a field the caller discards anyway.
 */
export const receivedApiErrorEnvelopeSchema = apiErrorEnvelopeSchemaFor("received");

export const apiRouteErrorBodySchema = z
  .object({
    error: apiErrorEnvelopeSchema
  })
  .strict();

export const receivedApiRouteErrorBodySchema = z
  .object({
    error: receivedApiErrorEnvelopeSchema
  })
  .strict();

export type ApiErrorEnvelope = z.infer<typeof apiErrorEnvelopeSchema>;
export type ApiRouteErrorBody = z.infer<typeof apiRouteErrorBodySchema>;

interface ApiErrorEnvelopeCandidate {
  code: (typeof errorCodes)[number];
  message: string;
  retryable?: boolean | undefined;
  field?: string | undefined;
  session_id?: z.infer<typeof sessionIdSchema> | undefined;
  details?: Readonly<Record<string, string | number | boolean | null>> | undefined;
}

function createEnvelopeResult(value: ApiErrorEnvelopeCandidate, origin: ErrorEnvelopeOrigin) {
  try {
    const input: ErrorEnvelopeInput = {
      code: value.code,
      message: value.message,
      ...(value.retryable !== undefined ? { retryable: value.retryable } : {}),
      ...(value.field !== undefined ? { field: value.field } : {}),
      ...(value.session_id !== undefined ? { sessionId: value.session_id } : {}),
      ...(value.details !== undefined ? { details: value.details } : {})
    };
    createErrorEnvelope(input, origin);
    return { ok: true as const };
  } catch (error) {
    return {
      ok: false as const,
      message: error instanceof Error ? error.message : "Invalid error envelope."
    };
  }
}
