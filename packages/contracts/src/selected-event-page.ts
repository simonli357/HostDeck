import { z } from "zod";
import { outputCursorSchema, sessionIdSchema } from "./scalars.js";
import { selectedSessionEventStreamSchema } from "./selected-runtime.js";

export const selectedEventPageMaxSize = 100;
export const selectedEventPageDefaultSize = selectedEventPageMaxSize;

const canonicalEventPageLimitTextSchema = z
  .string()
  .min(1)
  .max(3)
  .regex(/^(?:[1-9]|[1-9][0-9]|100)$/u);

const canonicalEventCursorTextSchema = z
  .string()
  .min(1)
  .max(16)
  .regex(/^(?:0|[1-9][0-9]{0,15})$/u)
  .transform((value, context) => {
    const parsed = outputCursorSchema.safeParse(Number(value));
    if (!parsed.success || String(parsed.data) !== value) {
      context.addIssue({
        code: "custom",
        message: "Selected event-page cursor is invalid."
      });
      return z.NEVER;
    }
    return parsed.data;
  });

export const selectedEventPageParamsSchema = z
  .object({
    session_id: sessionIdSchema
  })
  .strict();

export const selectedEventPageInputSchema = z
  .object({
    after: outputCursorSchema.nullable(),
    limit: z.number().int().min(1).max(selectedEventPageMaxSize)
  })
  .strict();

export const selectedEventPageQuerySchema = z
  .object({
    after: canonicalEventCursorTextSchema.optional(),
    limit: canonicalEventPageLimitTextSchema.optional()
  })
  .strict()
  .transform((value) =>
    Object.freeze({
      after: value.after ?? null,
      limit:
        value.limit === undefined
          ? selectedEventPageDefaultSize
          : Number(value.limit)
    })
  );

export const selectedEventPageResponseSchema = selectedSessionEventStreamSchema
  .superRefine((value, context) => {
    if (value.events.length > selectedEventPageMaxSize) {
      context.addIssue({
        code: "custom",
        message: "Selected event pages exceed the event-count limit.",
        path: ["events"]
      });
    }

    for (let index = 1; index < value.events.length; index += 1) {
      const previous = value.events[index - 1];
      const current = value.events[index];
      if (
        previous !== undefined &&
        current !== undefined &&
        current.cursor !== previous.cursor + 1
      ) {
        context.addIssue({
          code: "custom",
          message: "Selected event-page cursors must be contiguous.",
          path: ["events", index, "cursor"]
        });
      }
    }

    const finalCursor = value.events.at(-1)?.cursor;
    if (finalCursor !== undefined && value.next_cursor !== finalCursor) {
      context.addIssue({
        code: "custom",
        message: "Selected event-page continuation must equal the final event cursor.",
        path: ["next_cursor"]
      });
    }
  });

export type SelectedEventPageInput = z.infer<
  typeof selectedEventPageInputSchema
>;
export type SelectedEventPageParams = z.infer<
  typeof selectedEventPageParamsSchema
>;
export type SelectedEventPageResponse = z.infer<
  typeof selectedEventPageResponseSchema
>;
