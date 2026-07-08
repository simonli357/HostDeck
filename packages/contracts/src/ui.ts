import { allowedSlashCommands, attentionLevels, attentionPriority, lifecycleStates, sessionStatuses, writeActions } from "@hostdeck/core";
import { z } from "zod";
import {
  apiSessionSchema,
  hostStatusResponseSchema,
  networkStateResponseSchema,
  securityStateResponseSchema,
  sessionOutputResponseSchema
} from "./api.js";
import { absoluteCwdSchema, isoTimestampSchema, outputCursorSchema, sessionIdSchema, sessionNameSchema } from "./scalars.js";

const uiLimits = {
  projectLabelLength: 120,
  outputPreviewLength: 280,
  boundaryMessageLength: 240,
  errorMessageLength: 240
} as const;

export const uiScreenStateSchema = z.enum(["loading", "empty", "ready", "disconnected", "permission_denied", "agent_error"]);
export const uiStreamStateSchema = z.enum(["connected", "reconnecting", "disconnected", "error"]);
export const uiTrustStateSchema = z.enum([
  "unpaired",
  "trusted_write",
  "trusted_read_only",
  "expired",
  "revoked",
  "locked",
  "permission_denied"
]);
export const uiOutputBoundaryTypeSchema = z.enum(["none", "replay_boundary", "truncated"]);
export const uiDisabledWriteReasonSchema = z.enum([
  "untrusted",
  "read_only",
  "locked",
  "stale",
  "stopped",
  "crashed",
  "unknown",
  "not_running",
  "unsupported_slash",
  "raw_input_confirmation_required",
  "audit_unavailable",
  "stream_disconnected"
]);

export const uiWriteControlStateSchema = z
  .object({
    action: z.enum(writeActions),
    enabled: z.boolean(),
    disabled_reason: uiDisabledWriteReasonSchema.nullable(),
    requires_confirmation: z.boolean(),
    advanced_required: z.boolean()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.enabled && value.disabled_reason !== null) {
      context.addIssue({
        code: "custom",
        message: "Enabled write controls must not carry a disabled reason."
      });
    }

    if (!value.enabled && value.disabled_reason === null) {
      context.addIssue({
        code: "custom",
        message: "Disabled write controls must carry a disabled reason."
      });
    }

    if (value.action === "raw_input" && (!value.requires_confirmation || !value.advanced_required)) {
      context.addIssue({
        code: "custom",
        message: "Raw input controls must require confirmation and advanced mode."
      });
    }
  });

export const uiOutputBoundarySchema = z
  .object({
    type: uiOutputBoundaryTypeSchema,
    session_id: sessionIdSchema,
    after: outputCursorSchema.nullable(),
    next_cursor: outputCursorSchema.nullable(),
    visible: z.boolean(),
    message: z.string().max(uiLimits.boundaryMessageLength).nullable()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.type === "none") {
      if (value.visible || value.message !== null) {
        context.addIssue({
          code: "custom",
          message: "Absent output boundaries must not be visible or carry UI copy."
        });
      }
      return;
    }

    if (!value.visible || value.next_cursor === null || value.message === null) {
      context.addIssue({
        code: "custom",
        message: "Output boundaries must be visible and include the next cursor plus user-facing copy."
      });
    }
  });

export const uiSessionCardSchema = z
  .object({
    id: sessionIdSchema,
    name: sessionNameSchema,
    cwd: absoluteCwdSchema,
    project_label: z.string().min(1).max(uiLimits.projectLabelLength),
    branch: z.string().min(1).max(240).nullable(),
    lifecycle_state: z.enum(lifecycleStates),
    status: z.enum(sessionStatuses),
    attention: z.enum(attentionLevels),
    last_activity_at: isoTimestampSchema.nullable(),
    recent_output: z
      .object({
        text: z.string().max(uiLimits.outputPreviewLength),
        cursor: outputCursorSchema.nullable(),
        truncated: z.boolean()
      })
      .strict(),
    write_control: uiWriteControlStateSchema
  })
  .strict()
  .superRefine((value, context) => {
    if (value.lifecycle_state !== "running" && value.write_control.enabled) {
      context.addIssue({
        code: "custom",
        message: "Session cards must not expose enabled write controls for non-running sessions.",
        path: ["write_control", "enabled"]
      });
    }
  });

export const uiTrustStateViewModelSchema = z
  .object({
    state: uiTrustStateSchema,
    trusted: z.boolean(),
    read_only: z.boolean(),
    locked: z.boolean(),
    lan_enabled: z.boolean(),
    client_id: z.string().min(1).max(120).nullable(),
    write_controls_enabled: z.boolean(),
    message: z.string().max(uiLimits.errorMessageLength).nullable()
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.state === "unpaired" || value.state === "expired" || value.state === "revoked" || value.state === "permission_denied") && value.trusted) {
      context.addIssue({
        code: "custom",
        message: "Unpaired, expired, revoked, or permission-denied trust states must not be trusted."
      });
    }

    if ((value.locked || value.read_only || !value.trusted) && value.write_controls_enabled) {
      context.addIssue({
        code: "custom",
        message: "Write controls must be disabled before writes when trust, read-only, or lock state forbids writes."
      });
    }

    if (value.state !== "locked" && value.locked) {
      context.addIssue({
        code: "custom",
        message: "Locked trust flags must use the locked trust state."
      });
    }

    if (value.state === "trusted_write") {
      if (!value.trusted || value.read_only || value.locked || !value.write_controls_enabled || value.client_id === null) {
        context.addIssue({
          code: "custom",
          message: "Trusted write state must be trusted, writable, unlocked, identified, and have write controls enabled."
        });
      }
    }

    if (value.state === "trusted_read_only") {
      if (!value.trusted || !value.read_only || value.locked || value.write_controls_enabled || value.client_id === null) {
        context.addIssue({
          code: "custom",
          message: "Trusted read-only state must be trusted, read-only, unlocked, identified, and have write controls disabled."
        });
      }
    }

    if (value.state === "locked" && (!value.locked || value.write_controls_enabled)) {
      context.addIssue({
        code: "custom",
        message: "Locked trust state must carry a locked flag and disabled write controls."
      });
    }

    if ((value.state === "unpaired" || value.state === "expired" || value.state === "revoked" || value.state === "permission_denied") && value.write_controls_enabled) {
      context.addIssue({
        code: "custom",
        message: "Untrusted trust states must keep write controls disabled."
      });
    }
  });

export const uiHostSafetyViewModelSchema = z
  .object({
    host: hostStatusResponseSchema,
    security: securityStateResponseSchema,
    network: networkStateResponseSchema,
    remote_unlock_available: z.literal(false),
    dashboard_lan_mutation_available: z.literal(false)
  })
  .strict();

export const uiMissionControlViewModelSchema = z
  .object({
    screen: z.literal("mission_control"),
    state: uiScreenStateSchema,
    host_safety: uiHostSafetyViewModelSchema,
    trust: uiTrustStateViewModelSchema,
    sessions: z.array(uiSessionCardSchema),
    attention_sorted: z.literal(true),
    error_message: z.string().max(uiLimits.errorMessageLength).nullable()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.state === "empty" && value.sessions.length !== 0) {
      context.addIssue({
        code: "custom",
        message: "Empty Mission Control state must not carry session cards."
      });
    }

    if (value.state === "ready" && value.error_message !== null) {
      context.addIssue({
        code: "custom",
        message: "Ready Mission Control state must not carry an error message."
      });
    }

    for (let index = 1; index < value.sessions.length; index += 1) {
      const previous = value.sessions[index - 1];
      const current = value.sessions[index];

      if (previous === undefined || current === undefined) {
        continue;
      }

      if (attentionPriority(previous.attention) < attentionPriority(current.attention)) {
        context.addIssue({
          code: "custom",
          message: "Mission Control sessions must be sorted by descending attention priority.",
          path: ["sessions", index]
        });
      }
    }
  });

export const uiSessionDetailViewModelSchema = z
  .object({
    screen: z.literal("session_detail"),
    session: apiSessionSchema,
    output: sessionOutputResponseSchema,
    boundary: uiOutputBoundarySchema,
    stream_state: uiStreamStateSchema,
    prompt_control: uiWriteControlStateSchema,
    slash_controls: z.array(
      z
        .object({
          command: z.enum(allowedSlashCommands),
          control: uiWriteControlStateSchema
        })
        .strict()
    ),
    stop_control: uiWriteControlStateSchema,
    raw_input_control: uiWriteControlStateSchema,
    advanced_raw_visible: z.boolean(),
    error_message: z.string().max(uiLimits.errorMessageLength).nullable()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.session.id !== value.output.session_id || value.session.id !== value.boundary.session_id) {
      context.addIssue({
        code: "custom",
        message: "Session Detail view model must target exactly one session."
      });
    }

    if (!value.advanced_raw_visible && value.raw_input_control.enabled) {
      context.addIssue({
        code: "custom",
        message: "Raw input cannot be enabled while the advanced raw fallback is hidden."
      });
    }

    if (value.prompt_control.action !== "prompt" || value.stop_control.action !== "stop" || value.raw_input_control.action !== "raw_input") {
      context.addIssue({
        code: "custom",
        message: "Session Detail controls must match their declared action slots."
      });
    }

    for (const slashControl of value.slash_controls) {
      if (slashControl.control.action !== "slash") {
        context.addIssue({
          code: "custom",
          message: "Slash command controls must use the slash write action."
        });
      }
    }
  });

export type UiWriteControlState = z.infer<typeof uiWriteControlStateSchema>;
export type UiOutputBoundary = z.infer<typeof uiOutputBoundarySchema>;
export type UiSessionCard = z.infer<typeof uiSessionCardSchema>;
export type UiTrustStateViewModel = z.infer<typeof uiTrustStateViewModelSchema>;
export type UiHostSafetyViewModel = z.infer<typeof uiHostSafetyViewModelSchema>;
export type UiMissionControlViewModel = z.infer<typeof uiMissionControlViewModelSchema>;
export type UiSessionDetailViewModel = z.infer<typeof uiSessionDetailViewModelSchema>;
