import type { ErrorEnvelopeInput } from "@hostdeck/core";
import { createErrorEnvelope, errorCodes, errorEnvelopeLimits } from "@hostdeck/core";
import { z } from "zod";
import { detailValueSchema, sessionIdSchema } from "./scalars.js";

export const apiErrorEnvelopeSchema = z
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
    const result = createEnvelopeResult(value);
    if (!result.ok) context.addIssue({ code: "custom", message: result.message });
  });

export const apiRouteErrorBodySchema = z
  .object({
    error: apiErrorEnvelopeSchema
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

function createEnvelopeResult(value: ApiErrorEnvelopeCandidate) {
  try {
    const input: ErrorEnvelopeInput = {
      code: value.code,
      message: value.message,
      ...(value.retryable !== undefined ? { retryable: value.retryable } : {}),
      ...(value.field !== undefined ? { field: value.field } : {}),
      ...(value.session_id !== undefined ? { sessionId: value.session_id } : {}),
      ...(value.details !== undefined ? { details: value.details } : {})
    };
    createErrorEnvelope(input);
    return { ok: true as const };
  } catch (error) {
    return {
      ok: false as const,
      message: error instanceof Error ? error.message : "Invalid error envelope."
    };
  }
}
