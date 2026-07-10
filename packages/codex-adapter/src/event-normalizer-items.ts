import { codexItemIdSchema, codexThreadIdSchema } from "@hostdeck/contracts";
import type { CodexItemId } from "@hostdeck/core";
import { z } from "zod";
import type {
  NormalizedCodexContentState,
  NormalizedCodexItem,
  NormalizedCodexItemCategory
} from "./event-normalizer.js";
import {
  boundCodexContent,
  boundedCodexText,
  boundedNonemptyStringSchema,
  boundedStringSchema,
  codexNormalizationError,
  maximumCollectionLength,
  maximumTextLength,
  nonnegativeSafeIntegerSchema,
  parseCodexParams,
  requiredValueSchema
} from "./event-normalizer-support.js";

const imageDetailSchema = z.enum(["auto", "low", "high", "original"]);

const textElementSchema = z
  .object({
    byteRange: z
      .object({ start: nonnegativeSafeIntegerSchema, end: nonnegativeSafeIntegerSchema })
      .strict()
      .refine((range) => range.end >= range.start, { message: "Text element byte range is reversed." }),
    placeholder: boundedStringSchema(maximumTextLength).nullable()
  })
  .strict();

const userInputSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("text"),
      text: boundedStringSchema(maximumTextLength * 4),
      text_elements: z.array(textElementSchema).max(maximumCollectionLength)
    })
    .strict(),
  z.object({ type: z.literal("image"), detail: imageDetailSchema.optional(), url: boundedNonemptyStringSchema(maximumTextLength) }).strict(),
  z
    .object({ type: z.literal("localImage"), detail: imageDetailSchema.optional(), path: boundedNonemptyStringSchema(maximumTextLength) })
    .strict(),
  z
    .object({ type: z.literal("skill"), name: boundedNonemptyStringSchema(240), path: boundedNonemptyStringSchema(maximumTextLength) })
    .strict(),
  z
    .object({ type: z.literal("mention"), name: boundedNonemptyStringSchema(240), path: boundedNonemptyStringSchema(maximumTextLength) })
    .strict()
]);

const itemEnvelopeSchema = z.object({ type: boundedNonemptyStringSchema(80), id: codexItemIdSchema }).passthrough();

const memoryCitationSchema = z
  .object({
    entries: z
      .array(
        z
          .object({
            path: boundedStringSchema(maximumTextLength),
            lineStart: nonnegativeSafeIntegerSchema,
            lineEnd: nonnegativeSafeIntegerSchema,
            note: boundedStringSchema(maximumTextLength)
          })
          .strict()
      )
      .max(maximumCollectionLength),
    threadIds: z.array(codexThreadIdSchema).max(maximumCollectionLength)
  })
  .strict();

const commandActionSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("read"),
      command: boundedStringSchema(maximumTextLength * 4),
      name: boundedStringSchema(240),
      path: boundedStringSchema(maximumTextLength)
    })
    .strict(),
  z
    .object({
      type: z.literal("listFiles"),
      command: boundedStringSchema(maximumTextLength * 4),
      path: boundedStringSchema(maximumTextLength).nullable()
    })
    .strict(),
  z
    .object({
      type: z.literal("search"),
      command: boundedStringSchema(maximumTextLength * 4),
      query: boundedStringSchema(maximumTextLength).nullable(),
      path: boundedStringSchema(maximumTextLength).nullable()
    })
    .strict(),
  z.object({ type: z.literal("unknown"), command: boundedStringSchema(maximumTextLength * 4) }).strict()
]);

const patchChangeKindSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("add") }).strict(),
  z.object({ type: z.literal("delete") }).strict(),
  z.object({ type: z.literal("update"), move_path: boundedStringSchema(maximumTextLength).nullable() }).strict()
]);

const fileUpdateChangeSchema = z
  .object({
    path: boundedStringSchema(maximumTextLength),
    kind: patchChangeKindSchema,
    diff: boundedStringSchema(maximumTextLength * 4)
  })
  .strict();

const dynamicToolContentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("inputText"), text: boundedStringSchema(maximumTextLength * 4) }).strict(),
  z.object({ type: z.literal("inputImage"), imageUrl: boundedStringSchema(maximumTextLength * 4) }).strict()
]);

const collabAgentStateSchema = z
  .object({
    status: z.enum(["pendingInit", "running", "interrupted", "completed", "errored", "shutdown", "notFound"]),
    message: boundedStringSchema(maximumTextLength).nullable()
  })
  .strict();

export function normalizeCodexItem(
  candidate: unknown,
  lifecycle: "started" | "completed",
  method: string
): NormalizedCodexItem {
  const envelope = parseCodexParams(itemEnvelopeSchema, candidate, method);
  switch (envelope.type) {
    case "userMessage": {
      const parsed = parseCodexParams(
        z
          .object({
            type: z.literal("userMessage"),
            id: codexItemIdSchema,
            clientId: z.string().max(128).nullable(),
            content: z.array(userInputSchema).max(maximumCollectionLength)
          })
          .strict(),
        candidate,
        method
      );
      const textInputs = parsed.content.filter(
        (input): input is Extract<(typeof parsed.content)[number], { type: "text" }> => input.type === "text"
      );
      const rawText = textInputs.map((input) => input.text).join("\n");
      const hasOmitted = textInputs.length !== parsed.content.length;
      const content = boundCodexContent(
        rawText,
        maximumTextLength,
        hasOmitted ? "Non-text user input was omitted from projection." : "User message was truncated for projection.",
        hasOmitted
      );
      return normalizedItem(parsed.id, "user_message", lifecycle === "started" ? "started" : "completed", "User message", content);
    }
    case "agentMessage": {
      const parsed = parseCodexParams(
        z
          .object({
            type: z.literal("agentMessage"),
            id: codexItemIdSchema,
            text: boundedStringSchema(maximumTextLength * 4),
            phase: z.enum(["commentary", "final_answer"]).nullable(),
            memoryCitation: memoryCitationSchema.nullable()
          })
          .strict(),
        candidate,
        method
      );
      return normalizedItem(
        parsed.id,
        "agent_message",
        lifecycle === "started" ? "started" : "completed",
        "Agent message",
        boundCodexContent(parsed.text, maximumTextLength, "Agent message was truncated for projection.")
      );
    }
    case "plan": {
      const parsed = parseCodexParams(
        z.object({ type: z.literal("plan"), id: codexItemIdSchema, text: boundedStringSchema(maximumTextLength * 4) }).strict(),
        candidate,
        method
      );
      return normalizedItem(
        parsed.id,
        "plan",
        lifecycle === "started" ? "started" : "completed",
        "Plan",
        boundCodexContent(parsed.text, maximumTextLength, "Plan text was truncated for projection.")
      );
    }
    case "reasoning": {
      const parsed = parseCodexParams(
        z
          .object({
            type: z.literal("reasoning"),
            id: codexItemIdSchema,
            summary: z.array(boundedStringSchema(maximumTextLength)).max(maximumCollectionLength),
            content: z.array(boundedStringSchema(maximumTextLength)).max(maximumCollectionLength)
          })
          .strict(),
        candidate,
        method
      );
      return redactedItem(parsed.id, "reasoning", lifecycle, "Reasoning", "Reasoning content is not retained in HostDeck projection.");
    }
    case "commandExecution": {
      const parsed = parseCodexParams(
        z
          .object({
            type: z.literal("commandExecution"),
            id: codexItemIdSchema,
            command: boundedStringSchema(maximumTextLength * 4),
            cwd: boundedStringSchema(maximumTextLength),
            processId: z.string().max(240).nullable(),
            source: z.enum(["agent", "userShell", "unifiedExecStartup", "unifiedExecInteraction"]),
            status: z.enum(["inProgress", "completed", "failed", "declined"]),
            commandActions: z.array(commandActionSchema).max(maximumCollectionLength),
            aggregatedOutput: boundedStringSchema(maximumTextLength * 4).nullable(),
            exitCode: z.number().int().nullable(),
            durationMs: nonnegativeSafeIntegerSchema.nullable()
          })
          .strict(),
        candidate,
        method
      );
      assertLifecycleStatus(parsed.status, lifecycle, method);
      return redactedItem(
        parsed.id,
        "command",
        lifecycle,
        parsed.status === "declined" ? "Command declined" : "Command execution",
        "Command text and output are omitted from HostDeck projection.",
        parsed.status === "failed"
      );
    }
    case "fileChange": {
      const parsed = parseCodexParams(
        z
          .object({
            type: z.literal("fileChange"),
            id: codexItemIdSchema,
            changes: z.array(fileUpdateChangeSchema).max(maximumCollectionLength),
            status: z.enum(["inProgress", "completed", "failed", "declined"])
          })
          .strict(),
        candidate,
        method
      );
      assertLifecycleStatus(parsed.status, lifecycle, method);
      return redactedItem(
        parsed.id,
        "file_change",
        lifecycle,
        parsed.status === "declined" ? "File change declined" : "File change",
        "File paths and patches are omitted from HostDeck projection.",
        parsed.status === "failed"
      );
    }
    case "mcpToolCall":
    case "dynamicToolCall":
    case "collabAgentToolCall":
    case "webSearch":
    case "imageGeneration":
    case "imageView":
    case "sleep":
    case "subAgentActivity": {
      const failed = validateToolItem(candidate, envelope.type, lifecycle, method);
      return redactedItem(
        envelope.id,
        "tool",
        lifecycle,
        "Tool activity",
        "Tool arguments, results, paths, and prompts are omitted from HostDeck projection.",
        failed
      );
    }
    case "contextCompaction": {
      parseCodexParams(z.object({ type: z.literal("contextCompaction"), id: codexItemIdSchema }).strict(), candidate, method);
      return normalizedItem(envelope.id, "compaction", lifecycle === "started" ? "started" : "completed", "Context compaction", {
        text: null,
        content_state: "complete",
        content_notice: null
      });
    }
    case "hookPrompt":
    case "enteredReviewMode":
    case "exitedReviewMode": {
      validateOtherItem(candidate, envelope.type, method);
      return redactedItem(envelope.id, "other", lifecycle, "Runtime activity", "Internal prompt/review content is omitted.");
    }
    default:
      throw codexNormalizationError(
        "unsupported_item_type",
        `Codex item type ${boundedCodexText(envelope.type, 80)} is unsupported.`,
        method
      );
  }
}

export function parseCodexItemId(candidate: unknown, method: string): CodexItemId {
  return parseCodexParams(itemEnvelopeSchema, candidate, method).id;
}

function validateToolItem(
  candidate: unknown,
  type: string,
  lifecycle: "started" | "completed",
  method: string
): boolean {
  switch (type) {
    case "mcpToolCall": {
      const parsed = parseCodexParams(
        z
          .object({
            type: z.literal("mcpToolCall"),
            id: codexItemIdSchema,
            server: boundedNonemptyStringSchema(240),
            tool: boundedNonemptyStringSchema(240),
            status: z.enum(["inProgress", "completed", "failed"]),
            arguments: requiredValueSchema,
            appContext: requiredValueSchema,
            mcpAppResourceUri: boundedStringSchema(maximumTextLength).optional(),
            pluginId: boundedStringSchema(240).nullable(),
            result: requiredValueSchema,
            error: requiredValueSchema,
            durationMs: nonnegativeSafeIntegerSchema.nullable()
          })
          .strict(),
        candidate,
        method
      );
      assertLifecycleStatus(parsed.status, lifecycle, method);
      return parsed.status === "failed";
    }
    case "dynamicToolCall": {
      const parsed = parseCodexParams(
        z
          .object({
            type: z.literal("dynamicToolCall"),
            id: codexItemIdSchema,
            namespace: boundedStringSchema(240).nullable(),
            tool: boundedNonemptyStringSchema(240),
            arguments: requiredValueSchema,
            status: z.enum(["inProgress", "completed", "failed"]),
            contentItems: z.array(dynamicToolContentSchema).max(maximumCollectionLength).nullable(),
            success: z.boolean().nullable(),
            durationMs: nonnegativeSafeIntegerSchema.nullable()
          })
          .strict(),
        candidate,
        method
      );
      assertLifecycleStatus(parsed.status, lifecycle, method);
      return parsed.status === "failed";
    }
    case "collabAgentToolCall": {
      const parsed = parseCodexParams(
        z
          .object({
            type: z.literal("collabAgentToolCall"),
            id: codexItemIdSchema,
            tool: z.enum(["spawnAgent", "sendInput", "resumeAgent", "wait", "closeAgent"]),
            status: z.enum(["inProgress", "completed", "failed"]),
            senderThreadId: codexThreadIdSchema,
            receiverThreadIds: z.array(codexThreadIdSchema).max(maximumCollectionLength),
            prompt: boundedStringSchema(maximumTextLength * 4).nullable(),
            model: boundedStringSchema(120).nullable(),
            reasoningEffort: boundedStringSchema(64).nullable(),
            agentsStates: z.record(z.string(), collabAgentStateSchema)
          })
          .strict(),
        candidate,
        method
      );
      assertLifecycleStatus(parsed.status, lifecycle, method);
      return parsed.status === "failed";
    }
    case "webSearch":
      parseCodexParams(
        z
          .object({
            type: z.literal("webSearch"),
            id: codexItemIdSchema,
            query: boundedStringSchema(maximumTextLength * 4),
            action: requiredValueSchema
          })
          .strict(),
        candidate,
        method
      );
      return false;
    case "imageGeneration":
      parseCodexParams(
        z
          .object({
            type: z.literal("imageGeneration"),
            id: codexItemIdSchema,
            status: boundedStringSchema(120),
            revisedPrompt: boundedStringSchema(maximumTextLength * 4).nullable(),
            result: boundedStringSchema(maximumTextLength * 4),
            savedPath: boundedStringSchema(maximumTextLength).optional()
          })
          .strict(),
        candidate,
        method
      );
      return false;
    case "imageView":
      parseCodexParams(
        z.object({ type: z.literal("imageView"), id: codexItemIdSchema, path: boundedStringSchema(maximumTextLength) }).strict(),
        candidate,
        method
      );
      return false;
    case "sleep":
      parseCodexParams(
        z.object({ type: z.literal("sleep"), id: codexItemIdSchema, durationMs: nonnegativeSafeIntegerSchema }).strict(),
        candidate,
        method
      );
      return false;
    case "subAgentActivity":
      parseCodexParams(
        z
          .object({
            type: z.literal("subAgentActivity"),
            id: codexItemIdSchema,
            kind: z.enum(["started", "interacted", "interrupted"]),
            agentThreadId: codexThreadIdSchema,
            agentPath: boundedStringSchema(maximumTextLength)
          })
          .strict(),
        candidate,
        method
      );
      return false;
    default:
      throw codexNormalizationError(
        "unsupported_item_type",
        `Codex tool item type ${boundedCodexText(type, 80)} is unsupported.`,
        method
      );
  }
}

function validateOtherItem(candidate: unknown, type: string, method: string): void {
  if (type === "hookPrompt") {
    parseCodexParams(
      z
        .object({
          type: z.literal("hookPrompt"),
          id: codexItemIdSchema,
          fragments: z
            .array(
              z
                .object({
                  text: boundedStringSchema(maximumTextLength * 4),
                  hookRunId: boundedNonemptyStringSchema(240)
                })
                .strict()
            )
            .max(maximumCollectionLength)
        })
        .strict(),
      candidate,
      method
    );
    return;
  }
  if (type === "enteredReviewMode" || type === "exitedReviewMode") {
    parseCodexParams(
      z
        .object({
          type: z.literal(type),
          id: codexItemIdSchema,
          review: boundedStringSchema(maximumTextLength * 4)
        })
        .strict(),
      candidate,
      method
    );
    return;
  }
  throw codexNormalizationError(
    "unsupported_item_type",
    `Codex runtime item type ${boundedCodexText(type, 80)} is unsupported.`,
    method
  );
}

function assertLifecycleStatus(
  status: "completed" | "declined" | "failed" | "inProgress",
  lifecycle: "started" | "completed",
  method: string
): void {
  if ((lifecycle === "started") !== (status === "inProgress")) {
    throw codexNormalizationError(
      "malformed_required_event",
      "Codex item status contradicts its lifecycle notification.",
      method
    );
  }
}

interface NormalizedItemContent {
  readonly text: string | null;
  readonly content_state: NormalizedCodexContentState;
  readonly content_notice: string | null;
}

function normalizedItem(
  id: CodexItemId,
  category: NormalizedCodexItemCategory,
  state: NormalizedCodexItem["state"],
  title: string,
  content: NormalizedItemContent
): NormalizedCodexItem {
  return { id, category, state, title, ...content };
}

function redactedItem(
  id: CodexItemId,
  category: NormalizedCodexItemCategory,
  lifecycle: "started" | "completed",
  title: string,
  notice: string,
  failed = false
): NormalizedCodexItem {
  return normalizedItem(id, category, failed ? "failed" : lifecycle === "started" ? "started" : "completed", title, {
    text: null,
    content_state: "redacted",
    content_notice: notice
  });
}
