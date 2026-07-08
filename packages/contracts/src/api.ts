import type { ErrorEnvelopeInput } from "@hostdeck/core";
import {
  allowedSlashCommands,
  attentionLevels,
  createErrorEnvelope,
  errorCodes,
  errorEnvelopeLimits,
  lifecycleStates,
  sessionStatuses
} from "@hostdeck/core";
import { z } from "zod";
import {
  absoluteCwdSchema,
  bindModeSchema,
  detailValueSchema,
  isoTimestampSchema,
  outputCursorSchema,
  sessionIdSchema,
  sessionNameSchema
} from "./scalars.js";

const healthStateSchema = z.enum(["ok", "degraded", "error", "unknown"]);
const streamStatusSchema = z.enum(["connected", "reconnecting", "closed"]);

export { absoluteCwdSchema, bindModeSchema, isoTimestampSchema, outputCursorSchema, sessionIdSchema, sessionNameSchema };

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

    if (!result.ok) {
      context.addIssue({
        code: "custom",
        message: result.message
      });
    }
  });

export const healthCheckSchema = z
  .object({
    state: healthStateSchema,
    message: z.string().max(240).optional(),
    checked_at: isoTimestampSchema.optional()
  })
  .strict();

export const hostStatusResponseSchema = z
  .object({
    version: z.string().min(1),
    bind: z
      .object({
        mode: bindModeSchema,
        host: z.string().min(1),
        port: z.number().int().min(1).max(65_535)
      })
      .strict(),
    locked: z.boolean(),
    lan_enabled: z.boolean(),
    storage: healthCheckSchema,
    tmux: healthCheckSchema,
    stream: healthCheckSchema,
    startup_checks: z.array(
      z
        .object({
          name: z.string().min(1).max(80),
          state: healthStateSchema,
          message: z.string().max(240).optional()
        })
        .strict()
    ),
    stale_session_count: z.number().int().nonnegative(),
    last_error: apiErrorEnvelopeSchema.nullable()
  })
  .strict()
  .superRefine((value, context) => {
    assertLanModeConsistency(value.bind.mode, value.lan_enabled, context);
  });

export const apiSessionSchema = z
  .object({
    id: sessionIdSchema,
    name: sessionNameSchema,
    cwd: absoluteCwdSchema,
    backend: z
      .object({
        type: z.literal("tmux"),
        tmux: z
          .object({
            session_name: z.string().min(1),
            window_name: z.string().min(1).optional(),
            pane_id: z.string().min(1).optional()
          })
          .strict()
      })
      .strict(),
    lifecycle_state: z.enum(lifecycleStates),
    status: z.enum(sessionStatuses),
    attention: z.enum(attentionLevels),
    created_at: isoTimestampSchema,
    updated_at: isoTimestampSchema,
    last_activity_at: isoTimestampSchema.nullable(),
    branch: z.string().min(1).max(240).nullable(),
    recent_output: z
      .object({
        text: z.string().max(12_000),
        cursor: outputCursorSchema.nullable(),
        line_count: z.number().int().nonnegative(),
        truncated: z.boolean()
      })
      .strict()
  })
  .strict();

export const sessionIdParamsSchema = z
  .object({
    session_id: sessionIdSchema
  })
  .strict();

export const outputQuerySchema = z
  .object({
    after: outputCursorSchema.optional()
  })
  .strict();

export const sessionListResponseSchema = z
  .object({
    sessions: z.array(apiSessionSchema)
  })
  .strict();

export const sessionDetailResponseSchema = z
  .object({
    session: apiSessionSchema
  })
  .strict();

export const outputDataEventSchema = z
  .object({
    type: z.literal("output"),
    session_id: sessionIdSchema,
    cursor: outputCursorSchema,
    captured_at: isoTimestampSchema.nullable(),
    text: z.string().max(12_000)
  })
  .strict();

export const replayBoundaryEventSchema = z
  .object({
    type: z.literal("replay_boundary"),
    session_id: sessionIdSchema,
    after: outputCursorSchema.nullable(),
    next_cursor: outputCursorSchema,
    reason: z.enum(["retention", "stale_cursor", "restart"])
  })
  .strict()
  .superRefine((value, context) => {
    if (value.after !== null && value.next_cursor <= value.after) {
      context.addIssue({
        code: "custom",
        message: "Replay boundaries must advance to a cursor after the requested cursor."
      });
    }
  });

export const streamStatusEventSchema = z
  .object({
    type: z.literal("stream_status"),
    session_id: sessionIdSchema,
    status: streamStatusSchema,
    message: z.string().max(240).optional()
  })
  .strict();

export const streamErrorEventSchema = z
  .object({
    type: z.literal("error"),
    session_id: sessionIdSchema.optional(),
    error: apiErrorEnvelopeSchema
  })
  .strict();

export const sessionOutputEventSchema = z.discriminatedUnion("type", [outputDataEventSchema, replayBoundaryEventSchema]);

export const sessionStreamEventSchema = z.discriminatedUnion("type", [
  outputDataEventSchema,
  replayBoundaryEventSchema,
  streamStatusEventSchema,
  streamErrorEventSchema
]);

export const sessionOutputResponseSchema = z
  .object({
    session_id: sessionIdSchema,
    events: z.array(sessionOutputEventSchema),
    next_cursor: outputCursorSchema,
    truncated: z.boolean()
  })
  .strict()
  .superRefine((value, context) => {
    let previousCursor: number | null = null;

    for (const [index, event] of value.events.entries()) {
      if (event.session_id !== value.session_id) {
        context.addIssue({
          code: "custom",
          message: "Output responses must not mix events from multiple sessions.",
          path: ["events", index, "session_id"]
        });
      }

      const eventCursor = event.type === "output" ? event.cursor : event.next_cursor;

      if (previousCursor !== null && eventCursor < previousCursor) {
        context.addIssue({
          code: "custom",
          message: "Output response events must be ordered by cursor.",
          path: ["events", index]
        });
      }

      if (eventCursor > value.next_cursor) {
        context.addIssue({
          code: "custom",
          message: "Output response next_cursor must be at or after every event cursor.",
          path: ["next_cursor"]
        });
      }

      previousCursor = eventCursor;
    }
  });

export const promptInputRequestSchema = z
  .object({
    text: z.string().min(1).max(20_000)
  })
  .strict();

export const slashCommandRequestSchema = z
  .object({
    command: z.enum(allowedSlashCommands),
    argument: z.string().max(4_000).optional()
  })
  .strict();

export const stopSessionRequestSchema = z
  .object({
    confirm: z.literal(true)
  })
  .strict();

export const rawInputRequestSchema = z
  .object({
    text: z.string().min(1).max(20_000),
    confirmed: z.literal(true)
  })
  .strict();

export const writeAcceptedResponseSchema = z
  .object({
    accepted: z.literal(true),
    session_id: sessionIdSchema,
    action: z.enum(["prompt", "slash", "stop", "raw_input"]),
    audit_required: z.literal(true)
  })
  .strict();

export const writeRejectedResponseSchema = z
  .object({
    accepted: z.literal(false),
    error: apiErrorEnvelopeSchema
  })
  .strict();

export const writeResponseSchema = z.discriminatedUnion("accepted", [writeAcceptedResponseSchema, writeRejectedResponseSchema]);

export const pairClaimRequestSchema = z
  .object({
    code: z.string().min(6).max(128),
    client_label: z.string().min(1).max(120).optional()
  })
  .strict();

export const trustStateSchema = z
  .object({
    trusted: z.boolean(),
    read_only: z.boolean(),
    locked: z.boolean(),
    lan_enabled: z.boolean(),
    client_id: z.string().min(1).max(120).nullable()
  })
  .strict();

export const pairClaimResponseSchema = trustStateSchema;
export const pairStatusResponseSchema = trustStateSchema;
export const securityStateResponseSchema = trustStateSchema;

export const lockRequestSchema = z
  .object({
    lock: z.literal(true),
    reason: z.string().max(240).optional()
  })
  .strict();

export const networkStateResponseSchema = z
  .object({
    mode: bindModeSchema,
    host: z.string().min(1),
    port: z.number().int().min(1).max(65_535),
    lan_enabled: z.boolean()
  })
  .strict()
  .superRefine((value, context) => {
    assertLanModeConsistency(value.mode, value.lan_enabled, context);
  });

export type ApiErrorEnvelope = z.infer<typeof apiErrorEnvelopeSchema>;
export type ApiSession = z.infer<typeof apiSessionSchema>;
export type HostStatusResponse = z.infer<typeof hostStatusResponseSchema>;
export type SessionStreamEvent = z.infer<typeof sessionStreamEventSchema>;
export type SessionOutputResponse = z.infer<typeof sessionOutputResponseSchema>;
export type WriteResponse = z.infer<typeof writeResponseSchema>;

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

function assertLanModeConsistency(mode: z.infer<typeof bindModeSchema>, lanEnabled: boolean, context: z.RefinementCtx): void {
  if ((mode === "lan") !== lanEnabled) {
    context.addIssue({
      code: "custom",
      message: "LAN bind mode and lan_enabled must describe the same current network state."
    });
  }
}
