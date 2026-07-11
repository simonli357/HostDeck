import {
  absoluteCwdSchema,
  codexItemIdSchema,
  codexModelContractLimits,
  codexThreadIdSchema,
  codexTurnIdSchema
} from "@hostdeck/contracts";
import { z } from "zod";
import {
  boundedNonemptyStringSchema,
  boundedStringSchema,
  maximumCollectionLength,
  maximumDetailLength,
  maximumPlanSteps,
  maximumTextLength,
  nonnegativeSafeIntegerSchema,
  positiveSafeIntegerSchema,
  requiredValueSchema,
  unixMillisecondsSchema,
  unixSecondsSchema
} from "./event-normalizer-support.js";

export const threadStatusSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("notLoaded") }).strict(),
  z.object({ type: z.literal("idle") }).strict(),
  z.object({ type: z.literal("systemError") }).strict(),
  z
    .object({
      type: z.literal("active"),
      activeFlags: z.array(z.enum(["waitingOnApproval", "waitingOnUserInput"])).max(2)
    })
    .strict()
]);

const gitInfoSchema = z
  .object({
    sha: boundedStringSchema(240).nullable(),
    branch: boundedStringSchema(240).nullable(),
    originUrl: boundedStringSchema(maximumTextLength).nullable()
  })
  .strict();

const subAgentSourceSchema = z.union([
  z.enum(["review", "compact", "memory_consolidation"]),
  z.object({ other: boundedStringSchema(240) }).strict(),
  z
    .object({
      thread_spawn: z
        .object({
          parent_thread_id: codexThreadIdSchema,
          depth: nonnegativeSafeIntegerSchema,
          agent_path: boundedStringSchema(maximumTextLength).nullable(),
          agent_nickname: boundedStringSchema(240).nullable(),
          agent_role: boundedStringSchema(240).nullable()
        })
        .strict()
    })
    .strict()
]);

const sessionSourceSchema = z.union([
  z.enum(["cli", "vscode", "exec", "appServer", "unknown"]),
  z.object({ custom: boundedStringSchema(240) }).strict(),
  z.object({ subAgent: subAgentSourceSchema }).strict()
]);

export const rawThreadSchema = z
  .object({
    id: codexThreadIdSchema,
    extra: z.object({}).strict().nullable(),
    sessionId: boundedNonemptyStringSchema(128),
    forkedFromId: codexThreadIdSchema.nullable(),
    parentThreadId: codexThreadIdSchema.nullable(),
    preview: boundedStringSchema(maximumTextLength),
    ephemeral: z.boolean(),
    historyMode: z.enum(["legacy", "paginated"]),
    modelProvider: boundedNonemptyStringSchema(120),
    createdAt: unixSecondsSchema,
    updatedAt: unixSecondsSchema,
    recencyAt: unixSecondsSchema.nullable(),
    status: threadStatusSchema,
    path: boundedStringSchema(maximumTextLength).nullable(),
    cwd: absoluteCwdSchema,
    cliVersion: boundedNonemptyStringSchema(64),
    source: sessionSourceSchema,
    threadSource: boundedStringSchema(240).nullable(),
    agentNickname: boundedStringSchema(240).nullable(),
    agentRole: boundedStringSchema(240).nullable(),
    gitInfo: gitInfoSchema.nullable(),
    name: boundedNonemptyStringSchema(240).nullable(),
    turns: z.array(z.never()).max(0)
  })
  .strict()
  .superRefine((value, context) => {
    if (value.updatedAt < value.createdAt) context.addIssue({ code: "custom", message: "Thread update precedes creation." });
  });

export const collaborationModeSchema = z
  .object({
    mode: z.enum(["default", "plan"]),
    settings: z
      .object({
        model: boundedStringSchema(codexModelContractLimits.identityLength),
        reasoning_effort: boundedStringSchema(codexModelContractLimits.reasoningEffortLength).nullable(),
        developer_instructions: boundedStringSchema(maximumTextLength).nullable()
      })
      .strict()
  })
  .strict();

const approvalPolicySchema = z.union([
  z.enum(["untrusted", "on-request", "never"]),
  z
    .object({
      granular: z
        .object({
          sandbox_approval: z.boolean(),
          rules: z.boolean(),
          skill_approval: z.boolean(),
          request_permissions: z.boolean(),
          mcp_elicitations: z.boolean()
        })
        .strict()
    })
    .strict()
]);

const activePermissionProfileSchema = z
  .object({ id: boundedNonemptyStringSchema(240), extends: boundedStringSchema(240).nullable() })
  .strict();

const sandboxPolicySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("dangerFullAccess") }).strict(),
  z.object({ type: z.literal("readOnly"), networkAccess: z.boolean() }).strict(),
  z.object({ type: z.literal("externalSandbox"), networkAccess: z.enum(["restricted", "enabled"]) }).strict(),
  z
    .object({
      type: z.literal("workspaceWrite"),
      writableRoots: z.array(absoluteCwdSchema).max(maximumCollectionLength),
      networkAccess: z.boolean(),
      excludeTmpdirEnvVar: z.boolean(),
      excludeSlashTmp: z.boolean()
    })
    .strict()
]);

const multiAgentModeSchema = z.union([
  z.enum(["explicitRequestOnly", "proactive"]),
  z.object({ custom: boundedStringSchema(maximumTextLength) }).strict()
]);

export const threadSettingsSchema = z
  .object({
    cwd: absoluteCwdSchema,
    approvalPolicy: approvalPolicySchema,
    approvalsReviewer: z.enum(["user", "auto_review", "guardian_subagent"]),
    sandboxPolicy: sandboxPolicySchema,
    activePermissionProfile: activePermissionProfileSchema.nullable(),
    model: boundedNonemptyStringSchema(codexModelContractLimits.identityLength),
    modelProvider: boundedNonemptyStringSchema(120),
    serviceTier: boundedStringSchema(120).nullable(),
    effort: boundedStringSchema(codexModelContractLimits.reasoningEffortLength).nullable(),
    summary: z.enum(["auto", "concise", "detailed", "none"]).nullable(),
    collaborationMode: collaborationModeSchema,
    multiAgentMode: multiAgentModeSchema,
    personality: z.enum(["none", "friendly", "pragmatic"]).nullable()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.collaborationMode.settings.model !== value.model) {
      context.addIssue({ code: "custom", message: "Collaboration mode model contradicts the effective thread model." });
    }
    if (value.collaborationMode.settings.reasoning_effort !== value.effort) {
      context.addIssue({ code: "custom", message: "Collaboration mode effort contradicts the effective thread effort." });
    }
  });

export const goalSchema = z
  .object({
    threadId: codexThreadIdSchema,
    objective: boundedNonemptyStringSchema(maximumTextLength * 4),
    status: z.enum(["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"]),
    tokenBudget: positiveSafeIntegerSchema.nullable(),
    tokensUsed: nonnegativeSafeIntegerSchema,
    timeUsedSeconds: z.number().finite().nonnegative(),
    createdAt: unixSecondsSchema,
    updatedAt: unixSecondsSchema
  })
  .strict()
  .superRefine((value, context) => {
    if (value.updatedAt < value.createdAt) context.addIssue({ code: "custom", message: "Goal update precedes creation." });
  });

export const tokenUsageSchema = z
  .object({
    totalTokens: nonnegativeSafeIntegerSchema,
    inputTokens: nonnegativeSafeIntegerSchema,
    cachedInputTokens: nonnegativeSafeIntegerSchema,
    outputTokens: nonnegativeSafeIntegerSchema,
    reasoningOutputTokens: nonnegativeSafeIntegerSchema
  })
  .strict();

export const threadTokenUsageSchema = z
  .object({
    total: tokenUsageSchema,
    last: tokenUsageSchema,
    modelContextWindow: positiveSafeIntegerSchema.nullable()
  })
  .strict();

export const turnErrorSchema = z
  .object({
    message: boundedNonemptyStringSchema(maximumDetailLength),
    codexErrorInfo: requiredValueSchema,
    additionalDetails: boundedStringSchema(maximumDetailLength).nullable()
  })
  .strict();

const turnItemEnvelopeSchema = z
  .object({ type: boundedNonemptyStringSchema(80), id: codexItemIdSchema })
  .passthrough();

export const turnSchema = z
  .object({
    id: codexTurnIdSchema,
    items: z.array(turnItemEnvelopeSchema).max(maximumCollectionLength),
    itemsView: z.enum(["notLoaded", "summary", "full"]),
    status: z.enum(["completed", "interrupted", "failed", "inProgress"]),
    error: turnErrorSchema.nullable(),
    startedAt: unixSecondsSchema.nullable(),
    completedAt: unixSecondsSchema.nullable(),
    durationMs: nonnegativeSafeIntegerSchema.nullable()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === "failed" && value.error === null) context.addIssue({ code: "custom", message: "Failed turn lacks error." });
    if (value.status !== "failed" && value.error !== null) context.addIssue({ code: "custom", message: "Non-failed turn carries error." });
    if (value.completedAt !== null && value.startedAt !== null && value.completedAt < value.startedAt) {
      context.addIssue({ code: "custom", message: "Turn completion precedes start." });
    }
  });

export const planStepSchema = z
  .object({
    step: boundedNonemptyStringSchema(maximumDetailLength),
    status: z.enum(["pending", "inProgress", "completed"])
  })
  .strict();

export const threadStartedParamsSchema = z.object({ thread: rawThreadSchema }).strict();
export const threadStatusParamsSchema = z.object({ threadId: codexThreadIdSchema, status: threadStatusSchema }).strict();
export const threadNameParamsSchema = z
  .object({ threadId: codexThreadIdSchema, threadName: boundedNonemptyStringSchema(240).optional() })
  .strict();
export const threadIdParamsSchema = z.object({ threadId: codexThreadIdSchema }).strict();
export const threadSettingsParamsSchema = z.object({ threadId: codexThreadIdSchema, threadSettings: threadSettingsSchema }).strict();
export const threadGoalUpdatedParamsSchema = z
  .object({ threadId: codexThreadIdSchema, turnId: codexTurnIdSchema.nullable(), goal: goalSchema })
  .strict();
export const threadTokenUsageParamsSchema = z
  .object({ threadId: codexThreadIdSchema, turnId: codexTurnIdSchema, tokenUsage: threadTokenUsageSchema })
  .strict();
export const turnParamsSchema = z.object({ threadId: codexThreadIdSchema, turn: turnSchema }).strict();
export const turnPlanParamsSchema = z
  .object({
    threadId: codexThreadIdSchema,
    turnId: codexTurnIdSchema,
    explanation: boundedStringSchema(maximumDetailLength).nullable(),
    plan: z.array(planStepSchema).max(maximumPlanSteps)
  })
  .strict();
export const itemStartedParamsSchema = z
  .object({ item: requiredValueSchema, threadId: codexThreadIdSchema, turnId: codexTurnIdSchema, startedAtMs: unixMillisecondsSchema })
  .strict();
export const itemCompletedParamsSchema = z
  .object({ item: requiredValueSchema, threadId: codexThreadIdSchema, turnId: codexTurnIdSchema, completedAtMs: unixMillisecondsSchema })
  .strict();
export const deltaParamsSchema = z
  .object({
    threadId: codexThreadIdSchema,
    turnId: codexTurnIdSchema,
    itemId: codexItemIdSchema,
    delta: boundedStringSchema(maximumTextLength * 4)
  })
  .strict();
export const requestResolvedParamsSchema = z
  .object({ threadId: codexThreadIdSchema, requestId: z.union([z.string().min(1).max(120), nonnegativeSafeIntegerSchema]) })
  .strict();

export const rateLimitWindowSchema = z
  .object({
    usedPercent: z.number().finite().nonnegative(),
    windowDurationMins: nonnegativeSafeIntegerSchema.nullable(),
    resetsAt: unixSecondsSchema.nullable()
  })
  .strict();

const creditsSnapshotSchema = z
  .object({ hasCredits: z.boolean(), unlimited: z.boolean(), balance: boundedStringSchema(240).nullable() })
  .strict();

const spendControlLimitSchema = z
  .object({
    limit: boundedNonemptyStringSchema(240),
    used: boundedNonemptyStringSchema(240),
    remainingPercent: z.number().finite(),
    resetsAt: unixSecondsSchema
  })
  .strict();

const planTypeSchema = z.enum([
  "free",
  "go",
  "plus",
  "pro",
  "prolite",
  "team",
  "self_serve_business_usage_based",
  "business",
  "enterprise_cbp_usage_based",
  "enterprise",
  "edu",
  "unknown"
]);

const rateLimitReachedTypeSchema = z.enum([
  "rate_limit_reached",
  "workspace_owner_credits_depleted",
  "workspace_member_credits_depleted",
  "workspace_owner_usage_limit_reached",
  "workspace_member_usage_limit_reached"
]);
export const rateLimitParamsSchema = z
  .object({
    rateLimits: z
      .object({
        limitId: boundedStringSchema(160).nullable(),
        limitName: boundedStringSchema(160).nullable(),
        primary: rateLimitWindowSchema.nullable(),
        secondary: rateLimitWindowSchema.nullable(),
        credits: creditsSnapshotSchema.nullable(),
        individualLimit: spendControlLimitSchema.nullable(),
        planType: planTypeSchema.nullable(),
        rateLimitReachedType: rateLimitReachedTypeSchema.nullable()
      })
      .strict()
  })
  .strict();

export const threadIdentityEnvelopeSchema = z.object({ threadId: codexThreadIdSchema }).passthrough();
export const threadStartedIdentityEnvelopeSchema = z.object({ thread: z.object({ id: codexThreadIdSchema }).passthrough() }).passthrough();
