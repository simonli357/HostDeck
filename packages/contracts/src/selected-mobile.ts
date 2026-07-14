import { mobileAttentionPriority, type StructuredControlKind } from "@hostdeck/core";
import { z } from "zod";
import { apiErrorEnvelopeSchema } from "./api.js";
import {
  hostDeckLoopbackOriginSchema,
  remoteExternalOriginSchema,
  remoteIngressPublicStateSchema,
  requestIngressProvenanceSchema
} from "./remote-ingress.js";
import { pendingApprovalSchema, selectedControlStateSchema } from "./selected-operations.js";
import {
  managedSessionProjectionSchema,
  runtimeCompatibilitySchema,
  selectedSessionEventStreamSchema
} from "./selected-runtime.js";

const mobileLimits = {
  originLength: 2_048,
  labelLength: 120,
  projectCueLength: 160,
  summaryLength: 512,
  reasonLength: 240,
  resumeCommandLength: 1_000
} as const;

export const selectedMobileScreenStateSchema = z.enum([
  "loading",
  "empty",
  "ready",
  "offline",
  "incompatible",
  "remote_unreachable",
  "remote_unavailable",
  "permission_denied",
  "not_found",
  "stale",
  "degraded",
  "fatal"
]);

export const selectedMobileStreamStateSchema = z.enum(["connecting", "connected", "reconnecting", "disconnected", "error"]);
export const selectedMobileClientConnectionStateSchema = z.enum(["loading", "online", "reconnecting", "unreachable"]);

export const selectedHostAccessSchema = z
  .object({
    origin: z.union([hostDeckLoopbackOriginSchema, remoteExternalOriginSchema]),
    client_connection: selectedMobileClientConnectionStateSchema,
    ingress_provenance: requestIngressProvenanceSchema.nullable(),
    remote_ingress: remoteIngressPublicStateSchema.nullable(),
    access: z.enum([
      "unknown",
      "loopback_local",
      "unpaired",
      "paired_read_only",
      "paired_write",
      "expired",
      "revoked",
      "permission_denied"
    ]),
    device_id: z.string().min(1).max(mobileLimits.labelLength).nullable(),
    device_label: z.string().min(1).max(mobileLimits.labelLength).nullable(),
    reads_enabled: z.boolean(),
    writes_enabled: z.boolean(),
    locked: z.boolean(),
    runtime: runtimeCompatibilitySchema.nullable(),
    stream_state: selectedMobileStreamStateSchema,
    remote_unlock_available: z.literal(false),
    remote_network_mutation_available: z.literal(false),
    last_error: apiErrorEnvelopeSchema.nullable()
  })
  .strict()
  .superRefine((value, context) => {
    const online = value.client_connection === "online";
    if (online && (value.ingress_provenance === null || value.remote_ingress === null)) {
      context.addIssue({ code: "custom", message: "Online host access requires current provenance and remote state." });
    }
    if (!online && value.ingress_provenance !== null) {
      context.addIssue({ code: "custom", message: "Disconnected clients cannot retain admitted request provenance." });
    }
    if (value.ingress_provenance !== null && value.ingress_provenance.origin !== value.origin) {
      context.addIssue({ code: "custom", message: "Host access origin must match admitted request provenance." });
    }
    if (value.ingress_provenance?.kind === "admitted_remote") {
      if (
        value.remote_ingress?.availability !== "ready" ||
        value.remote_ingress.external_origin !== value.origin
      ) {
        context.addIssue({ code: "custom", message: "Admitted remote access requires the same ready external origin." });
      }
    }
    if (!online && value.access !== "unknown") {
      context.addIssue({ code: "custom", message: "Disconnected client access authority must remain unknown." });
    }
    if (online && value.access === "unknown") {
      context.addIssue({ code: "custom", message: "Online host access must resolve application authority explicitly." });
    }
    if (
      ["unknown", "loopback_local", "unpaired", "permission_denied"].includes(value.access) &&
      (value.device_id !== null || value.device_label !== null)
    ) {
      context.addIssue({ code: "custom", message: "Non-device host access cannot expose paired-device identity." });
    }
    if (value.reads_enabled && value.runtime === null) {
      context.addIssue({ code: "custom", message: "Readable host access requires current bounded runtime compatibility." });
    }
    if (["unknown", "unpaired", "expired", "revoked", "permission_denied"].includes(value.access) && value.runtime !== null) {
      context.addIssue({ code: "custom", message: "Unauthenticated host access cannot expose runtime compatibility." });
    }
    if (value.access === "paired_write" && (value.device_id === null || value.device_label === null)) {
      context.addIssue({ code: "custom", message: "Paired writers must expose their bounded device identity." });
    }
    if (value.access === "paired_read_only" && (value.device_id === null || value.device_label === null)) {
      context.addIssue({ code: "custom", message: "Paired readers must expose their bounded device identity." });
    }
    const readable = online && ["loopback_local", "paired_read_only", "paired_write"].includes(value.access);
    if (value.reads_enabled !== readable) {
      context.addIssue({ code: "custom", message: "Phone read availability must match current application authority." });
    }
    const writableAuthority = value.access === "paired_write" || value.access === "loopback_local";
    const writable =
      online &&
      writableAuthority &&
      !value.locked &&
      value.runtime?.mutation_policy === "allowed";
    if (value.writes_enabled !== writable) {
      context.addIssue({
        code: "custom",
        message: "Phone write availability must match connection, application authority, lock, and runtime compatibility."
      });
    }
    if (!value.reads_enabled && value.writes_enabled) {
      context.addIssue({ code: "custom", message: "Phone writes cannot be enabled when reads are forbidden." });
    }
    if (["unknown", "expired", "revoked", "permission_denied", "unpaired"].includes(value.access) && value.writes_enabled) {
      context.addIssue({ code: "custom", message: "Untrusted phone access states cannot enable writes." });
    }
    if (["reconnecting", "unreachable"].includes(value.client_connection) && value.last_error === null) {
      context.addIssue({ code: "custom", message: "Disconnected client states require one bounded connection error." });
    }
  });

export const selectedSessionDisplayStateSchema = z.enum([
  "needs_approval",
  "needs_input",
  "failed",
  "interrupted",
  "stale",
  "running",
  "quiet",
  "unknown"
]);

export const selectedMobileSessionRowSchema = z
  .object({
    session: managedSessionProjectionSchema,
    project_cue: z.string().min(1).max(mobileLimits.projectCueLength),
    display_state: selectedSessionDisplayStateSchema,
    attention_rank: z.number().int().min(0).max(100),
    controls_disabled: z.boolean()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.attention_rank !== mobileAttentionPriority(value.session.attention)) {
      context.addIssue({ code: "custom", message: "Mobile session attention rank must use the selected Mission Control ordering." });
    }
    if (
      ["archived", "stale", "incompatible", "unknown"].includes(value.session.session_state) &&
      !value.controls_disabled
    ) {
      context.addIssue({ code: "custom", message: "Non-writable session states must disable row controls." });
    }
    if (value.session.freshness !== "current" && !value.controls_disabled) {
      context.addIssue({ code: "custom", message: "Non-current projections must disable row controls." });
    }
    if (!displayStateMatchesSession(value.display_state, value.session)) {
      context.addIssue({ code: "custom", message: "Mobile display state contradicts the selected session projection." });
    }
  });

export const selectedMissionControlViewModelSchema = z
  .object({
    screen: z.literal("mission_control"),
    state: selectedMobileScreenStateSchema.exclude(["not_found", "stale"]),
    host_access: selectedHostAccessSchema,
    sessions: z.array(selectedMobileSessionRowSchema),
    error_message: z.string().min(1).max(mobileLimits.reasonLength).nullable()
  })
  .strict()
  .superRefine((value, context) => {
    const sessionIds = new Set(value.sessions.map((row) => row.session.id));
    if (sessionIds.size !== value.sessions.length) {
      context.addIssue({ code: "custom", message: "Mission Control cannot contain duplicate managed sessions." });
    }
    if (value.state === "empty" && value.sessions.length !== 0) {
      context.addIssue({ code: "custom", message: "Empty Mission Control state cannot contain session rows." });
    }
    if (value.state === "ready" && value.sessions.length === 0) {
      context.addIssue({ code: "custom", message: "Mission Control with no sessions must use the empty state." });
    }
    if (["loading", "remote_unreachable", "remote_unavailable", "permission_denied", "fatal"].includes(value.state) && value.sessions.length !== 0) {
      context.addIssue({ code: "custom", message: "Mission Control must not expose session data before access is available." });
    }
    if (["ready", "empty", "loading"].includes(value.state) && value.error_message !== null) {
      context.addIssue({ code: "custom", message: "Normal Mission Control states must not carry an error message." });
    }
    if (!["ready", "empty", "loading"].includes(value.state) && value.error_message === null) {
      context.addIssue({ code: "custom", message: "Exceptional Mission Control states must explain the visible failure." });
    }
    if (value.state === "loading" && value.host_access.client_connection !== "loading") {
      context.addIssue({ code: "custom", message: "Loading Mission Control requires unresolved client connection state." });
    }
    if (value.state === "remote_unreachable" && value.host_access.client_connection !== "unreachable") {
      context.addIssue({ code: "custom", message: "Remote-unreachable Mission Control requires an unreachable client connection." });
    }
    if (value.state === "remote_unreachable" && value.host_access.remote_ingress !== null) {
      context.addIssue({ code: "custom", message: "Unreachable phone origin cannot invent current laptop remote state." });
    }
    if (
      value.state === "remote_unavailable" &&
      (value.host_access.client_connection === "online" || value.host_access.remote_ingress?.availability === "ready")
    ) {
      context.addIssue({ code: "custom", message: "Remote-unavailable Mission Control requires non-ready laptop ingress truth." });
    }
    if (value.state === "permission_denied" && value.host_access.runtime !== null) {
      context.addIssue({ code: "custom", message: "Permission-denied Mission Control cannot expose runtime compatibility." });
    }
    if (["ready", "empty"].includes(value.state) && !value.host_access.reads_enabled) {
      context.addIssue({ code: "custom", message: "Readable Mission Control states require current application read authority." });
    }
    for (let index = 1; index < value.sessions.length; index += 1) {
      const previous = value.sessions[index - 1];
      const current = value.sessions[index];
      if (previous === undefined || current === undefined) continue;

      if (previous.attention_rank < current.attention_rank) {
        context.addIssue({
          code: "custom",
          message: "Mission Control sessions must be ordered by descending selected attention priority.",
          path: ["sessions", index]
        });
      }
      if (
        previous.attention_rank === current.attention_rank &&
        previous.session.last_activity_at !== null &&
        current.session.last_activity_at !== null &&
        previous.session.last_activity_at < current.session.last_activity_at
      ) {
        context.addIssue({
          code: "custom",
          message: "Mission Control sessions with equal attention must be ordered by newest activity.",
          path: ["sessions", index]
        });
      }
    }
  });

export const selectedPromptControlSchema = z
  .object({
    enabled: z.boolean(),
    phase: z.enum(["idle", "submitting", "accepted", "failure", "conflict"]),
    disabled_reason: z.string().min(1).max(mobileLimits.reasonLength).nullable(),
    error: apiErrorEnvelopeSchema.nullable()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.enabled && value.disabled_reason !== null) {
      context.addIssue({ code: "custom", message: "Enabled prompt controls must not carry a disabled reason." });
    }
    if (!value.enabled && value.disabled_reason === null) {
      context.addIssue({ code: "custom", message: "Disabled prompt controls must explain why submission is blocked." });
    }
    if (value.phase === "failure" && value.error === null) {
      context.addIssue({ code: "custom", message: "Failed prompt controls must preserve a bounded error." });
    }
    if (value.phase !== "failure" && value.error !== null) {
      context.addIssue({ code: "custom", message: "Only failed prompt controls may carry an error." });
    }
  });

export const selectedRiskyControlSchema = z
  .object({
    action: z.enum(["interrupt", "archive"]),
    enabled: z.boolean(),
    requires_confirmation: z.literal(true),
    disabled_reason: z.string().min(1).max(mobileLimits.reasonLength).nullable()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.enabled && value.disabled_reason !== null) {
      context.addIssue({ code: "custom", message: "Enabled risky controls must not carry a disabled reason." });
    }
    if (!value.enabled && value.disabled_reason === null) {
      context.addIssue({ code: "custom", message: "Disabled risky controls must explain why they are blocked." });
    }
  });

export const selectedEventDiagnosticsSchema = z
  .object({
    read_only: z.literal(true),
    projection_complete: z.boolean(),
    boundary_visible: z.boolean(),
    redaction_visible: z.boolean(),
    incomplete_reason: z.string().min(1).max(mobileLimits.reasonLength).nullable()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.projection_complete && value.incomplete_reason !== null) {
      context.addIssue({ code: "custom", message: "Complete projections must not carry an incomplete reason." });
    }
    if (!value.projection_complete && value.incomplete_reason === null) {
      context.addIssue({ code: "custom", message: "Incomplete projections must explain the visible limitation." });
    }
  });

export const selectedLaptopResumeSchema = z
  .object({
    available: z.boolean(),
    command: z.string().min(1).max(mobileLimits.resumeCommandLength).nullable(),
    unavailable_reason: z.string().min(1).max(mobileLimits.reasonLength).nullable()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.available && (value.command === null || value.unavailable_reason !== null)) {
      context.addIssue({ code: "custom", message: "Available laptop resume must provide one command without a failure reason." });
    }
    if (!value.available && (value.command !== null || value.unavailable_reason === null)) {
      context.addIssue({ code: "custom", message: "Unavailable laptop resume must provide one reason and no command." });
    }
  });

export const selectedSessionDetailViewModelSchema = z
  .object({
    screen: z.literal("session_detail"),
    state: selectedMobileScreenStateSchema.exclude(["empty"]),
    host_access: selectedHostAccessSchema,
    session: managedSessionProjectionSchema.nullable(),
    stream_state: selectedMobileStreamStateSchema,
    events: selectedSessionEventStreamSchema.nullable(),
    approvals: z.array(pendingApprovalSchema).max(64),
    prompt: selectedPromptControlSchema,
    primary_controls: z.array(selectedControlStateSchema).length(3),
    utility_controls: z.array(selectedControlStateSchema).length(3),
    risky_controls: z.array(selectedRiskyControlSchema).length(2),
    diagnostics: selectedEventDiagnosticsSchema,
    laptop_resume: selectedLaptopResumeSchema,
    error_message: z.string().min(1).max(mobileLimits.reasonLength).nullable()
  })
  .strict()
  .superRefine((value, context) => {
    const stateRequiresData = ["ready", "offline", "incompatible", "stale", "degraded"].includes(value.state);
    if (stateRequiresData && (value.session === null || value.events === null)) {
      context.addIssue({ code: "custom", message: "Loaded Session Detail states require a session and bounded event projection." });
    }
    if (!stateRequiresData && (value.session !== null || value.events !== null || value.approvals.length > 0)) {
      context.addIssue({ code: "custom", message: "Inaccessible Session Detail states must not expose session data." });
    }
    if (value.state === "remote_unreachable" && value.host_access.remote_ingress !== null) {
      context.addIssue({ code: "custom", message: "Unreachable phone origin cannot invent current laptop remote state." });
    }
    if (
      value.state === "remote_unavailable" &&
      (value.host_access.client_connection === "online" || value.host_access.remote_ingress?.availability === "ready")
    ) {
      context.addIssue({ code: "custom", message: "Remote-unavailable Session Detail requires non-ready laptop ingress truth." });
    }
    if (value.state === "permission_denied" && value.host_access.runtime !== null) {
      context.addIssue({ code: "custom", message: "Permission-denied Session Detail cannot expose runtime compatibility." });
    }
    if (
      !stateRequiresData &&
      (value.prompt.enabled ||
        value.primary_controls.some((control) => control.availability === "available") ||
        value.utility_controls.some((control) => control.availability === "available") ||
        value.risky_controls.some((control) => control.enabled))
    ) {
      context.addIssue({ code: "custom", message: "Inaccessible Session Detail states must disable every write and control surface." });
    }
    if (value.session !== null && value.events !== null && value.events.session_id !== value.session.id) {
      context.addIssue({ code: "custom", message: "Session Detail events must target the selected session." });
    }
    const sessionWritable =
      value.session !== null &&
      value.session.session_state === "active" &&
      value.session.freshness === "current" &&
      value.host_access.writes_enabled;
    if (
      !sessionWritable &&
      (value.prompt.enabled ||
        value.primary_controls.some((control) => control.availability === "available") ||
        value.utility_controls.some((control) => control.control === "compact" && control.availability === "available") ||
        value.risky_controls.some((control) => control.enabled))
    ) {
      context.addIssue({ code: "custom", message: "Unavailable, stale, or non-writable sessions must disable every mutation control." });
    }
    for (const [index, approval] of value.approvals.entries()) {
      if (
        value.session === null ||
        approval.target.session_id !== value.session.id ||
        approval.target.codex_thread_id !== value.session.codex_thread_id
      ) {
        context.addIssue({
          code: "custom",
          message: "Session Detail approvals must target the selected session and thread.",
          path: ["approvals", index, "target"]
        });
      }
    }
    assertExactControls(value.primary_controls, ["model", "goal", "plan"], "primary_controls", context);
    assertExactControls(value.utility_controls, ["usage", "compact", "skills"], "utility_controls", context);
    for (const [index, control] of [...value.primary_controls, ...value.utility_controls].entries()) {
      const negotiated = value.host_access.runtime?.capabilities.find((capability) => capability.name === control.capability);
      if ((negotiated?.state ?? "unknown") !== control.capability_state) {
        context.addIssue({
          code: "custom",
          message: "Session Detail control state must match the negotiated runtime capability state.",
          path: [index < value.primary_controls.length ? "primary_controls" : "utility_controls", index % 3]
        });
      }
    }
    const riskyActions = new Set(value.risky_controls.map((control) => control.action));
    if (riskyActions.size !== 2 || !riskyActions.has("interrupt") || !riskyActions.has("archive")) {
      context.addIssue({ code: "custom", message: "Session Detail must expose distinct interrupt and archive controls." });
    }
    if (["ready", "loading"].includes(value.state) && value.error_message !== null) {
      context.addIssue({ code: "custom", message: "Normal Session Detail states must not carry an error message." });
    }
    if (!["ready", "loading"].includes(value.state) && value.error_message === null) {
      context.addIssue({ code: "custom", message: "Exceptional Session Detail states must explain the visible failure." });
    }
    if (value.laptop_resume.available && !["ready", "degraded"].includes(value.host_access.runtime?.state ?? "disconnected")) {
      context.addIssue({ code: "custom", message: "Laptop resume cannot be advertised while the selected runtime is unavailable." });
    }
  });

export type SelectedMobileScreenState = z.infer<typeof selectedMobileScreenStateSchema>;
export type SelectedHostAccess = z.infer<typeof selectedHostAccessSchema>;
export type SelectedMobileSessionRow = z.infer<typeof selectedMobileSessionRowSchema>;
export type SelectedMissionControlViewModel = z.infer<typeof selectedMissionControlViewModelSchema>;
export type SelectedSessionDetailViewModel = z.infer<typeof selectedSessionDetailViewModelSchema>;

function assertExactControls(
  controls: readonly z.infer<typeof selectedControlStateSchema>[],
  expected: readonly StructuredControlKind[],
  path: "primary_controls" | "utility_controls",
  context: z.RefinementCtx
): void {
  const actual = new Set(controls.map((control) => control.control));
  if (actual.size !== expected.length || expected.some((control) => !actual.has(control))) {
    context.addIssue({
      code: "custom",
      message: `${path} must contain exactly ${expected.join(", ")}.`,
      path: [path]
    });
  }
}

function displayStateMatchesSession(
  displayState: z.infer<typeof selectedSessionDisplayStateSchema>,
  session: z.infer<typeof managedSessionProjectionSchema>
): boolean {
  switch (displayState) {
    case "needs_approval":
      return session.attention === "needs_approval";
    case "needs_input":
      return session.attention === "needs_input";
    case "failed":
      return session.attention === "failed";
    case "interrupted":
      return session.turn_state === "interrupted";
    case "stale":
      return session.session_state === "stale" || ["stale", "disconnected"].includes(session.freshness);
    case "running":
      return session.turn_state === "in_progress" && session.attention === "watch";
    case "quiet":
      return ["idle", "completed"].includes(session.turn_state) && session.attention === "none";
    case "unknown":
      return session.attention === "unknown" || session.turn_state === "unknown";
  }
}
