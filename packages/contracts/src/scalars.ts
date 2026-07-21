import {
  parseAbsoluteCwd,
  parseIsoTimestamp,
  parseOutputCursor,
  parseSessionId,
  parseSessionName
} from "@hostdeck/core";
import { z } from "zod";

export const detailValueSchema = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
export const nonNegativeSafeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const positiveSafeIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

function brandedStringSchema<T>(name: string, parser: (value: string) => { ok: true; value: T } | { ok: false; message: string }) {
  return z
    .string()
    .superRefine((value, context) => {
      const result = parser(value);

      if (!result.ok) {
        context.addIssue({
          code: "custom",
          message: result.message
        });
      }
    })
    .transform((value, context) => {
      const result = parser(value);

      if (!result.ok) {
        context.addIssue({
          code: "custom",
          message: `${name} failed validation after refinement.`
        });
        return z.NEVER;
      }

      return result.value;
    });
}

export const sessionIdSchema = brandedStringSchema("session_id", parseSessionId);
export const sessionNameSchema = brandedStringSchema("session_name", parseSessionName);
export const absoluteCwdSchema = brandedStringSchema("cwd", parseAbsoluteCwd);
export const isoTimestampSchema = brandedStringSchema("timestamp", parseIsoTimestamp);

export const outputCursorSchema = z
  .number()
  .int()
  .nonnegative()
  .superRefine((value, context) => {
    const result = parseOutputCursor(value);

    if (!result.ok) {
      context.addIssue({
        code: "custom",
        message: result.message
      });
    }
  })
  .transform((value, context) => {
    const result = parseOutputCursor(value);

    if (!result.ok) {
      context.addIssue({
        code: "custom",
        message: "Output cursor failed validation after refinement."
      });
      return z.NEVER;
    }

    return result.value;
  });
