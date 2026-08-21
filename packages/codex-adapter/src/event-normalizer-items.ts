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
  codexNormalizationError,
  maximumCollectionLength,
  maximumTextLength,
  nonnegativeSafeIntegerSchema,
  parseCodexParams
} from "./event-normalizer-support.js";
import type { JsonValue } from "./generated/serde_json/JsonValue.js";
import type { ThreadItem } from "./generated/v2/ThreadItem.js";
import type { UserInput } from "./generated/v2/UserInput.js";

const imageDetailSchema = z.enum(["auto", "low", "high", "original"]);
const jsonValueSchema = z.custom<JsonValue>((value) => value !== undefined, {
  message: "Required JSON value is missing."
});

type ZodCompatibleGeneratedType<Value> = Value extends string | number | boolean | null | undefined
  ? Value
  : Value extends readonly (infer Item)[]
    ? Array<ZodCompatibleGeneratedType<Item>>
    : Value extends object
      ? {
          [Key in keyof Value]: Record<never, never> extends Pick<Value, Key>
            ? ZodCompatibleGeneratedType<Value[Key]> | undefined
            : ZodCompatibleGeneratedType<Value[Key]>;
        }
      : Value;

function threadItemSchema<Schema extends z.ZodType>(
  schema: Schema &
    (z.output<Schema> extends ZodCompatibleGeneratedType<ThreadItem> ? unknown : never)
): Schema {
  return schema;
}

// Transport and collection budgets bound input. Projection text limits are
// applied only to content HostDeck retains.

const textElementSchema = z
  .object({
    byteRange: z
      .object({ start: nonnegativeSafeIntegerSchema, end: nonnegativeSafeIntegerSchema })
      .strict()
      .refine((range) => range.end >= range.start, { message: "Text element byte range is reversed." }),
    placeholder: z.string().nullable()
  })
  .strict();

const userInputSchema: z.ZodType<ZodCompatibleGeneratedType<UserInput>> = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("text"),
      text: z.string(),
      text_elements: z.array(textElementSchema).max(maximumCollectionLength)
    })
    .strict(),
  z.object({ type: z.literal("image"), detail: imageDetailSchema.optional(), url: z.string() }).strict(),
  z
    .object({ type: z.literal("localImage"), detail: imageDetailSchema.optional(), path: z.string() })
    .strict(),
  z.object({ type: z.literal("audio"), url: z.string() }).strict(),
  z.object({ type: z.literal("localAudio"), path: z.string() }).strict(),
  z
    .object({ type: z.literal("skill"), name: z.string(), path: z.string() })
    .strict(),
  z
    .object({ type: z.literal("mention"), name: z.string(), path: z.string() })
    .strict()
]);

const itemEnvelopeSchema = z.object({ type: boundedNonemptyStringSchema(80), id: codexItemIdSchema }).passthrough();

const memoryCitationSchema = z
  .object({
    entries: z
      .array(
        z
          .object({
            path: z.string(),
            lineStart: nonnegativeSafeIntegerSchema,
            lineEnd: nonnegativeSafeIntegerSchema,
            note: z.string()
          })
          .strict()
      )
      .max(maximumCollectionLength),
    threadIds: z.array(z.string()).max(maximumCollectionLength)
  })
  .strict();

const commandActionSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("read"),
      command: z.string(),
      name: z.string(),
      path: z.string()
    })
    .strict(),
  z
    .object({
      type: z.literal("listFiles"),
      command: z.string(),
      path: z.string().nullable()
    })
    .strict(),
  z
    .object({
      type: z.literal("search"),
      command: z.string(),
      query: z.string().nullable(),
      path: z.string().nullable()
    })
    .strict(),
  z.object({ type: z.literal("unknown"), command: z.string() }).strict()
]);

const patchChangeKindSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("add") }).strict(),
  z.object({ type: z.literal("delete") }).strict(),
  z.object({ type: z.literal("update"), move_path: z.string().nullable() }).strict()
]);

const fileUpdateChangeSchema = z
  .object({
    path: z.string(),
    kind: patchChangeKindSchema,
    diff: z.string()
  })
  .strict();

const dynamicToolContentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("inputText"), text: z.string() }).strict(),
  z.object({ type: z.literal("inputImage"), imageUrl: z.string() }).strict(),
  z.object({ type: z.literal("inputAudio"), audioUrl: z.string() }).strict()
]);

const mcpToolCallAppContextSchema = z
  .object({
    connectorId: z.string(),
    linkId: z.string().nullable(),
    resourceUri: z.string().nullable(),
    appName: z.string().nullable(),
    actionName: z.string().nullable()
  })
  .strict();

const mcpToolCallResultSchema = z
  .object({
    content: z.array(jsonValueSchema).max(maximumCollectionLength),
    structuredContent: jsonValueSchema,
    _meta: jsonValueSchema
  })
  .strict();

const webSearchActionSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("search"),
      query: z.string().nullable(),
      queries: z.array(z.string()).max(maximumCollectionLength).nullable()
    })
    .strict(),
  z.object({ type: z.literal("openPage"), url: z.string().nullable() }).strict(),
  z
    .object({
      type: z.literal("findInPage"),
      url: z.string().nullable(),
      pattern: z.string().nullable()
    })
    .strict(),
  z.object({ type: z.literal("other") }).strict()
]);

const imageGenerationFailureSchema = z
  .object({
    type: z.literal("usageLimitExceeded"),
    limitId: z.string(),
    resetsAt: z.number().nullable()
  })
  .strict();

const collabAgentStateSchema = z
  .object({
    status: z.enum(["pendingInit", "running", "interrupted", "completed", "errored", "shutdown", "notFound"]),
    message: z.string().nullable()
  })
  .strict();

const nativeHistoryItemPolicy = Object.freeze({
  userMessage: "retain",
  hookPrompt: "omit",
  agentMessage: "retain",
  plan: "omit",
  reasoning: "omit",
  commandExecution: "omit",
  fileChange: "omit",
  mcpToolCall: "omit",
  dynamicToolCall: "omit",
  collabAgentToolCall: "omit",
  subAgentActivity: "omit",
  webSearch: "omit",
  imageView: "omit",
  sleep: "omit",
  imageGeneration: "omit",
  enteredReviewMode: "omit",
  exitedReviewMode: "omit",
  contextCompaction: "omit"
} as const satisfies Record<ThreadItem["type"], "omit" | "retain">);

const nativeHistoryUserInputPolicy = Object.freeze({
  text: "retain",
  image: "omit",
  localImage: "omit",
  audio: "omit",
  localAudio: "omit",
  skill: "omit",
  mention: "omit"
} as const satisfies Record<UserInput["type"], "omit" | "retain">);

export interface NormalizedCodexHistoryItem {
  readonly id: CodexItemId;
  readonly message: NormalizedCodexItem | null;
}

export function normalizeCodexHistoryItem(
  candidate: unknown,
  method: string
): NormalizedCodexHistoryItem {
  const envelope = parseCodexParams(itemEnvelopeSchema, candidate, method);
  const policy = nativeHistoryItemPolicy[envelope.type as ThreadItem["type"]];
  if (policy === undefined) {
    throw codexNormalizationError(
      "unsupported_item_type",
      `Codex item type ${boundedCodexText(envelope.type, 80)} is unsupported.`,
      method
    );
  }
  if (policy === "omit") return Object.freeze({ id: envelope.id, message: null });
  if (envelope.type !== "agentMessage" && envelope.type !== "userMessage") {
    throw codexNormalizationError(
      "unsupported_item_type",
      `Codex history item type ${boundedCodexText(envelope.type, 80)} has an invalid retention policy.`,
      method
    );
  }
  return Object.freeze({
    id: envelope.id,
    message: normalizeCodexHistoryMessage(candidate, envelope.type, method)
  });
}

function normalizeCodexHistoryMessage(
  candidate: unknown,
  type: "agentMessage" | "userMessage",
  method: string
): NormalizedCodexItem {
  if (type === "agentMessage") {
    const parsed = parseCodexParams(
      threadItemSchema(
        z
          .object({
            type: z.literal("agentMessage"),
            id: codexItemIdSchema,
            text: z.string(),
            phase: z.enum(["commentary", "final_answer"]).nullable(),
            memoryCitation: memoryCitationSchema.nullable()
          })
          .strict()
      ),
      candidate,
      method
    );
    return normalizedItem(
      parsed.id,
      "agent_message",
      "completed",
      "Agent message",
      boundCodexContent(parsed.text, maximumTextLength, "Agent message was truncated for projection.")
    );
  }

  const parsed = parseCodexParams(
    threadItemSchema(
      z
        .object({
          type: z.literal("userMessage"),
          id: codexItemIdSchema,
          clientId: z.string().nullable(),
          content: z.array(userInputSchema).max(maximumCollectionLength)
        })
        .strict()
    ),
    candidate,
    method
  );
  const textInputs: string[] = [];
  let hasOmitted = false;
  for (const input of parsed.content) {
    const policy = nativeHistoryUserInputPolicy[input.type];
    if (policy === "omit") {
      hasOmitted = true;
      continue;
    }
    if (input.type !== "text") {
      throw codexNormalizationError(
        "unsupported_item_type",
        `Codex user input type ${boundedCodexText(input.type, 80)} has an invalid retention policy.`,
        method
      );
    }
    textInputs.push(input.text);
  }
  const content = boundCodexContent(
    textInputs.join("\n"),
    maximumTextLength,
    hasOmitted ? "Non-text user input was omitted from projection." : "User message was truncated for projection.",
    hasOmitted
  );
  return normalizedItem(parsed.id, "user_message", "completed", "User message", content);
}

export function normalizeCodexItem(
  candidate: unknown,
  lifecycle: "started" | "completed",
  method: string
): NormalizedCodexItem {
  const envelope = parseCodexParams(itemEnvelopeSchema, candidate, method);
  switch (envelope.type) {
    case "userMessage": {
      const parsed = parseCodexParams(
        threadItemSchema(
          z
            .object({
              type: z.literal("userMessage"),
              id: codexItemIdSchema,
              clientId: z.string().nullable(),
              content: z.array(userInputSchema).max(maximumCollectionLength)
            })
            .strict()
        ),
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
        threadItemSchema(
          z
            .object({
              type: z.literal("agentMessage"),
              id: codexItemIdSchema,
              text: z.string(),
              phase: z.enum(["commentary", "final_answer"]).nullable(),
              memoryCitation: memoryCitationSchema.nullable()
            })
            .strict()
        ),
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
        threadItemSchema(
          z.object({ type: z.literal("plan"), id: codexItemIdSchema, text: z.string() }).strict()
        ),
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
        threadItemSchema(
          z
            .object({
              type: z.literal("reasoning"),
              id: codexItemIdSchema,
              summary: z.array(z.string()).max(maximumCollectionLength),
              content: z.array(z.string()).max(maximumCollectionLength)
            })
            .strict()
        ),
        candidate,
        method
      );
      return redactedItem(parsed.id, "reasoning", lifecycle, "Reasoning", "Reasoning content is not retained in HostDeck projection.");
    }
    case "commandExecution": {
      const parsed = parseCodexParams(
        threadItemSchema(
          z.object({
            type: z.literal("commandExecution"),
            id: codexItemIdSchema,
            pluginId: z.string().nullable(),
            scriptPath: z.string().nullable(),
            command: z.string(),
            cwd: z.string(),
            processId: z.string().nullable(),
            source: z.enum(["agent", "userShell", "unifiedExecStartup", "unifiedExecInteraction"]),
            status: z.enum(["inProgress", "completed", "failed", "declined"]),
            commandActions: z.array(commandActionSchema).max(maximumCollectionLength),
            // The transport already bounds the complete frame. This field is
            // validated for shape and then discarded, so projection text
            // limits must not reject otherwise valid Codex command output.
            aggregatedOutput: z.string().nullable(),
            exitCode: z.number().int().nullable(),
            durationMs: nonnegativeSafeIntegerSchema.nullable()
          }).strict()
        ),
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
        threadItemSchema(
          z
            .object({
              type: z.literal("fileChange"),
              id: codexItemIdSchema,
              changes: z.array(fileUpdateChangeSchema).max(maximumCollectionLength),
              status: z.enum(["inProgress", "completed", "failed", "declined"])
            })
            .strict()
        ),
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
      parseCodexParams(
        threadItemSchema(
          z.object({ type: z.literal("contextCompaction"), id: codexItemIdSchema }).strict()
        ),
        candidate,
        method
      );
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

export function hasCompletedOnlyCodexItemLifecycle(candidate: unknown, method: string): boolean {
  return parseCodexParams(itemEnvelopeSchema, candidate, method).type === "subAgentActivity";
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
        threadItemSchema(
          z.object({
            type: z.literal("mcpToolCall"),
            id: codexItemIdSchema,
            server: z.string(),
            tool: z.string(),
            status: z.enum(["inProgress", "completed", "failed"]),
            arguments: jsonValueSchema,
            appContext: mcpToolCallAppContextSchema.nullable(),
            mcpAppResourceUri: z.string().optional(),
            pluginId: z.string().nullable(),
            readOnlyHint: z.boolean().nullable(),
            result: mcpToolCallResultSchema.nullable(),
            error: z.object({ message: z.string() }).strict().nullable(),
            durationMs: nonnegativeSafeIntegerSchema.nullable()
          }).strict()
        ),
        candidate,
        method
      );
      assertLifecycleStatus(parsed.status, lifecycle, method);
      return parsed.status === "failed";
    }
    case "dynamicToolCall": {
      const parsed = parseCodexParams(
        threadItemSchema(
          z.object({
            type: z.literal("dynamicToolCall"),
            id: codexItemIdSchema,
            namespace: z.string().nullable(),
            tool: z.string(),
            arguments: jsonValueSchema,
            status: z.enum(["inProgress", "completed", "failed"]),
            contentItems: z.array(dynamicToolContentSchema).max(maximumCollectionLength).nullable(),
            success: z.boolean().nullable(),
            durationMs: nonnegativeSafeIntegerSchema.nullable()
          }).strict()
        ),
        candidate,
        method
      );
      assertLifecycleStatus(parsed.status, lifecycle, method);
      return parsed.status === "failed";
    }
    case "collabAgentToolCall": {
      const parsed = parseCodexParams(
        threadItemSchema(
          z.object({
            type: z.literal("collabAgentToolCall"),
            id: codexItemIdSchema,
            tool: z.enum(["spawnAgent", "sendInput", "resumeAgent", "wait", "closeAgent"]),
            status: z.enum(["inProgress", "completed", "failed"]),
            senderThreadId: codexThreadIdSchema,
            receiverThreadIds: z.array(codexThreadIdSchema).max(maximumCollectionLength),
            prompt: z.string().nullable(),
            model: z.string().nullable(),
            reasoningEffort: z.string().nullable(),
            agentsStates: z.record(z.string(), collabAgentStateSchema)
          }).strict()
        ),
        candidate,
        method
      );
      assertLifecycleStatus(parsed.status, lifecycle, method);
      return parsed.status === "failed";
    }
    case "webSearch":
      parseCodexParams(
        threadItemSchema(
          z
            .object({
              type: z.literal("webSearch"),
              id: codexItemIdSchema,
              query: z.string(),
              action: webSearchActionSchema.nullable(),
              results: z.array(jsonValueSchema).max(maximumCollectionLength).nullable()
            })
            .strict()
        ),
        candidate,
        method
      );
      return false;
    case "imageGeneration":
      parseCodexParams(
        threadItemSchema(
          z
            .object({
              type: z.literal("imageGeneration"),
              id: codexItemIdSchema,
              status: z.string(),
              revisedPrompt: z.string().nullable(),
              result: z.string(),
              transparentBackground: z.boolean().optional(),
              failure: imageGenerationFailureSchema.nullable(),
              savedPath: z.string().optional()
            })
            .strict()
        ),
        candidate,
        method
      );
      return false;
    case "imageView":
      parseCodexParams(
        threadItemSchema(
          z.object({ type: z.literal("imageView"), id: codexItemIdSchema, path: z.string() }).strict()
        ),
        candidate,
        method
      );
      return false;
    case "sleep":
      parseCodexParams(
        threadItemSchema(
          z.object({ type: z.literal("sleep"), id: codexItemIdSchema, durationMs: nonnegativeSafeIntegerSchema }).strict()
        ),
        candidate,
        method
      );
      return false;
    case "subAgentActivity":
      parseCodexParams(
        threadItemSchema(
          z
            .object({
              type: z.literal("subAgentActivity"),
              id: codexItemIdSchema,
              kind: z.enum(["started", "interacted", "interrupted"]),
              agentThreadId: codexThreadIdSchema,
              agentPath: z.string()
            })
            .strict()
        ),
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
      threadItemSchema(
        z
          .object({
            type: z.literal("hookPrompt"),
            id: codexItemIdSchema,
            fragments: z
              .array(
                z
                  .object({
                    text: z.string(),
                    hookRunId: z.string()
                  })
                  .strict()
              )
              .max(maximumCollectionLength)
          })
          .strict()
      ),
      candidate,
      method
    );
    return;
  }
  if (type === "enteredReviewMode" || type === "exitedReviewMode") {
    parseCodexParams(
      type === "enteredReviewMode"
        ? threadItemSchema(
            z
              .object({
                type: z.literal("enteredReviewMode"),
                id: codexItemIdSchema,
                review: z.string()
              })
              .strict()
          )
        : threadItemSchema(
            z
              .object({
                type: z.literal("exitedReviewMode"),
                id: codexItemIdSchema,
                review: z.string()
              })
              .strict()
          ),
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
