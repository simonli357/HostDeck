import { z } from "zod";
import { sessionIdSchema } from "./scalars.js";
import { codexThreadIdSchema } from "./selected-runtime.js";
import {
  nativeCodexThreadIdSchema,
  sharedSessionTargetIdSchema
} from "./shared-codex-runtime.js";

export const selectedResumeCommandMaxLength = 1_000;
export const selectedResumeExecutableMaxLength = 4_096;
export const selectedResumeUnavailableReasonMaxLength = 240;

const bareExecutablePattern = /^[A-Za-z0-9._+-]+$/u;
const safeUnquotedShellTokenPattern = /^[A-Za-z0-9_@%+=:,./-]+$/u;

const selectedResumeExecutableSchema = z
  .string()
  .min(1)
  .max(selectedResumeExecutableMaxLength)
  .superRefine((value, context) => {
    if (
      containsControlCharacter(value) ||
      (!value.startsWith("/") && !bareExecutablePattern.test(value))
    ) {
      context.addIssue({
        code: "custom",
        message: "Selected resume executable must be an absolute path or bare command name without control characters."
      });
    }
  });

export const selectedResumeLaunchSchema = z
  .object({
    executable: selectedResumeExecutableSchema,
    args: z.tuple([z.literal("resume"), nativeCodexThreadIdSchema])
  })
  .strict();

export const selectedResumeParamsSchema = z
  .object({
    session_id: sharedSessionTargetIdSchema
  })
  .strict();

export const selectedResumeMetadataResponseSchema = z
  .object({
    session_id: sessionIdSchema,
    codex_thread_id: codexThreadIdSchema,
    local_only: z.literal(true),
    available: z.boolean(),
    command: z
      .string()
      .min(1)
      .max(selectedResumeCommandMaxLength)
      .refine((value) => !containsControlCharacter(value), {
        message: "Selected resume display command must not contain control characters."
      })
      .nullable(),
    launch: selectedResumeLaunchSchema.nullable(),
    unavailable_reason: z
      .string()
      .min(1)
      .max(selectedResumeUnavailableReasonMaxLength)
      .nullable()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.available) {
      if (
        value.command === null ||
        value.launch === null ||
        value.unavailable_reason !== null
      ) {
        context.addIssue({
          code: "custom",
          message: "Available selected resume metadata requires one command and launch descriptor without an unavailable reason."
        });
        return;
      }
      if (value.command !== formatParsedLaunch(value.launch)) {
        context.addIssue({
          code: "custom",
          message: "Selected resume display command must exactly match its launch descriptor.",
          path: ["command"]
        });
      }
      if (String(value.launch.args[1]) !== String(value.codex_thread_id)) {
        context.addIssue({
          code: "custom",
          message: "Selected resume launch must target the response Codex thread.",
          path: ["launch", "args", 1]
        });
      }
      return;
    }

    if (
      value.command !== null ||
      value.launch !== null ||
      value.unavailable_reason === null
    ) {
      context.addIssue({
        code: "custom",
        message: "Unavailable selected resume metadata requires one reason and no command or launch descriptor."
      });
    }
  });

export function formatSelectedResumeLaunchCommand(candidate: unknown): string {
  const parsed = selectedResumeLaunchSchema.parse(candidate);
  return formatParsedLaunch(parsed);
}

function formatParsedLaunch(launch: SelectedResumeLaunch): string {
  return [launch.executable, ...launch.args].map(quoteShellToken).join(" ");
}

function quoteShellToken(value: string): string {
  if (safeUnquotedShellTokenPattern.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  });
}

export type SelectedResumeLaunch = z.infer<typeof selectedResumeLaunchSchema>;
export type SelectedResumeMetadataResponse = z.infer<
  typeof selectedResumeMetadataResponseSchema
>;
export type SelectedResumeParams = z.infer<typeof selectedResumeParamsSchema>;
