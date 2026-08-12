import { z } from "zod";
import {
  absoluteCwdSchema,
  isoTimestampSchema,
  positiveSafeIntegerSchema,
  sessionIdSchema,
  sessionNameSchema
} from "./scalars.js";
import {
  clientOperationIdSchema,
  codexItemIdSchema,
  codexThreadIdSchema,
  codexTurnIdSchema,
  codexVersionSchema,
  managedSessionProjectionSchema
} from "./selected-runtime.js";

export const nativeSessionContractLimits = Object.freeze({
  discoveryLimit: 100,
  historyTurns: 20,
  messagesPerTurn: 64,
  messageTextLength: 12_000
});

export const nativeCodexThreadTargetSchema = z
  .object({
    type: z.literal("native_codex_thread"),
    codex_thread_id: codexThreadIdSchema
  })
  .strict();

export const nativeCodexThreadIdentitySchema = z
  .object({
    thread_id: codexThreadIdSchema,
    cwd: absoluteCwdSchema,
    source: z.literal("cli"),
    runtime_version: codexVersionSchema,
    created_at: isoTimestampSchema,
    updated_at: isoTimestampSchema,
    status: z.enum(["idle", "not_loaded"]),
    archived: z.literal(false),
    ephemeral: z.literal(false),
    parent_thread_id: z.null(),
    forked_from_id: z.null(),
    history_mode: z.enum(["legacy", "paginated"])
  })
  .strict()
  .superRefine((value, context) => {
    if (value.updated_at < value.created_at) {
      context.addIssue({ code: "custom", message: "Native Codex thread update cannot precede creation." });
    }
  });

export const nativeSessionDiscoveryRequestSchema = z
  .object({
    limit: positiveSafeIntegerSchema.max(nativeSessionContractLimits.discoveryLimit).optional()
  })
  .strict();

export const nativeSessionDiscoveryResponseSchema = z
  .object({
    limit: positiveSafeIntegerSchema.max(nativeSessionContractLimits.discoveryLimit),
    threads: z.array(nativeCodexThreadIdentitySchema).max(nativeSessionContractLimits.discoveryLimit),
    truncated: z.boolean()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.threads.length > value.limit) {
      context.addIssue({ code: "custom", message: "Native Codex discovery exceeds its declared limit." });
    }
    const ids = new Set<string>();
    for (const [index, thread] of value.threads.entries()) {
      if (ids.has(thread.thread_id)) {
        context.addIssue({
          code: "custom",
          message: "Native Codex discovery cannot repeat a thread id.",
          path: ["threads", index, "thread_id"]
        });
      }
      ids.add(thread.thread_id);
      const previous = value.threads[index - 1];
      if (
        previous !== undefined &&
        (previous.updated_at < thread.updated_at ||
          (previous.updated_at === thread.updated_at && previous.thread_id >= thread.thread_id))
      ) {
        context.addIssue({
          code: "custom",
          message: "Native Codex discovery must use deterministic newest-first order.",
          path: ["threads", index]
        });
      }
    }
  });

export const nativeCodexHistoryMessageSchema = z
  .object({
    item_id: codexItemIdSchema,
    role: z.enum(["user", "agent"]),
    text: z.string().min(1).max(nativeSessionContractLimits.messageTextLength)
  })
  .strict();

export const nativeCodexHistoryTurnSchema = z
  .object({
    turn_id: codexTurnIdSchema,
    status: z.enum(["completed", "interrupted", "failed"]),
    started_at: isoTimestampSchema,
    completed_at: isoTimestampSchema,
    messages: z.array(nativeCodexHistoryMessageSchema).max(nativeSessionContractLimits.messagesPerTurn)
  })
  .strict()
  .superRefine((value, context) => {
    if (value.completed_at < value.started_at) {
      context.addIssue({ code: "custom", message: "Native Codex turn completion cannot precede its start." });
    }
    if (new Set(value.messages.map((message) => message.item_id)).size !== value.messages.length) {
      context.addIssue({ code: "custom", message: "Native Codex turn messages cannot repeat item ids." });
    }
  });

export const nativeCodexAdoptionSnapshotSchema = z
  .object({
    thread: nativeCodexThreadIdentitySchema,
    turns: z.array(nativeCodexHistoryTurnSchema).max(nativeSessionContractLimits.historyTurns),
    truncated_before: z.boolean()
  })
  .strict()
  .superRefine((value, context) => {
    const turnIds = new Set<string>();
    const itemIds = new Set<string>();
    let priorCompletedAt: string | null = null;
    for (const [turnIndex, turn] of value.turns.entries()) {
      if (turnIds.has(turn.turn_id)) {
        context.addIssue({
          code: "custom",
          message: "Native Codex adoption history cannot repeat turn ids.",
          path: ["turns", turnIndex, "turn_id"]
        });
      }
      turnIds.add(turn.turn_id);
      if (priorCompletedAt !== null && turn.started_at < priorCompletedAt) {
        context.addIssue({
          code: "custom",
          message: "Native Codex adoption history must use chronological turn order.",
          path: ["turns", turnIndex]
        });
      }
      priorCompletedAt = turn.completed_at;
      for (const [messageIndex, message] of turn.messages.entries()) {
        if (itemIds.has(message.item_id)) {
          context.addIssue({
            code: "custom",
            message: "Native Codex adoption history cannot repeat message item ids.",
            path: ["turns", turnIndex, "messages", messageIndex, "item_id"]
          });
        }
        itemIds.add(message.item_id);
      }
    }
  });

export const nativeSessionAdoptRequestSchema = z
  .object({
    operation_id: clientOperationIdSchema,
    thread_id: codexThreadIdSchema,
    name: sessionNameSchema,
    confirm_handoff: z.literal(true)
  })
  .strict();

export const nativeSessionAdoptResponseSchema = z
  .object({
    operation_id: clientOperationIdSchema,
    session: managedSessionProjectionSchema
  })
  .strict();

export const nativeSessionUnmanageRequestSchema = z
  .object({
    operation_id: clientOperationIdSchema,
    confirm: z.literal(true)
  })
  .strict();

export const nativeSessionUnmanageResponseSchema = z
  .object({
    operation_id: clientOperationIdSchema,
    session_id: sessionIdSchema,
    codex_thread_id: codexThreadIdSchema,
    unmanaged_at: isoTimestampSchema
  })
  .strict();

export const selectedNativeSessionMembershipRecordSchema = z
  .object({
    session_id: sessionIdSchema,
    codex_thread_id: codexThreadIdSchema,
    origin: z.literal("adopted"),
    adopted_at: isoTimestampSchema,
    handoff_confirmed_at: isoTimestampSchema
  })
  .strict()
  .superRefine((value, context) => {
    if (value.adopted_at < value.handoff_confirmed_at) {
      context.addIssue({ code: "custom", message: "Native session adoption cannot precede handoff confirmation." });
    }
  });

export type NativeCodexThreadTarget = z.infer<typeof nativeCodexThreadTargetSchema>;
export type NativeCodexThreadIdentity = z.infer<typeof nativeCodexThreadIdentitySchema>;
export type NativeSessionDiscoveryRequest = z.infer<typeof nativeSessionDiscoveryRequestSchema>;
export type NativeSessionDiscoveryResponse = z.infer<typeof nativeSessionDiscoveryResponseSchema>;
export type NativeCodexHistoryMessage = z.infer<typeof nativeCodexHistoryMessageSchema>;
export type NativeCodexHistoryTurn = z.infer<typeof nativeCodexHistoryTurnSchema>;
export type NativeCodexAdoptionSnapshot = z.infer<typeof nativeCodexAdoptionSnapshotSchema>;
export type NativeSessionAdoptRequest = z.infer<typeof nativeSessionAdoptRequestSchema>;
export type NativeSessionAdoptResponse = z.infer<typeof nativeSessionAdoptResponseSchema>;
export type NativeSessionUnmanageRequest = z.infer<typeof nativeSessionUnmanageRequestSchema>;
export type NativeSessionUnmanageResponse = z.infer<typeof nativeSessionUnmanageResponseSchema>;
export type SelectedNativeSessionMembershipRecord = z.infer<typeof selectedNativeSessionMembershipRecordSchema>;
