import type {
  ApiSession,
  HostStatusResponse,
  NetworkStateResponse,
  SessionOutputResponse,
  TrustState,
  UiDisabledWriteReason,
  UiHostSafetyViewModel,
  UiMissionControlViewModel,
  UiOutputBoundary,
  UiScreenState,
  UiSessionCard,
  UiSessionDetailViewModel,
  UiStreamState,
  UiTrustStateViewModel,
  UiWriteControlState
} from "@hostdeck/contracts";
import {
  sessionOutputResponseSchema,
  uiHostSafetyViewModelSchema,
  uiMissionControlViewModelSchema,
  uiOutputBoundarySchema,
  uiSessionCardSchema,
  uiSessionDetailViewModelSchema,
  uiTrustStateViewModelSchema,
  uiWriteControlStateSchema
} from "@hostdeck/contracts";
import type { AllowedSlashCommand, WriteAction, WriteDenialCode } from "@hostdeck/core";
import { allowedSlashCommands, attentionPriority, checkWriteEligibility } from "@hostdeck/core";

export type UntrustedTrustState = Extract<UiTrustStateViewModel["state"], "unpaired" | "expired" | "revoked" | "permission_denied">;

export interface TrustViewModelOptions {
  readonly untrustedState?: UntrustedTrustState;
  readonly message?: string | null;
}

export interface WriteControlOptions {
  readonly auditAvailable?: boolean;
  readonly slashCommand?: AllowedSlashCommand | string;
  readonly rawInputConfirmed?: boolean;
  readonly advancedRawVisible?: boolean;
  readonly streamState?: UiStreamState;
}

export interface SessionCardOptions {
  readonly projectLabel?: string;
  readonly auditAvailable?: boolean;
}

export interface MissionControlOptions {
  readonly state?: UiScreenState;
  readonly errorMessage?: string | null;
  readonly trust?: TrustViewModelOptions;
}

export interface SessionDetailOptions extends WriteControlOptions {
  readonly output?: SessionOutputResponse;
  readonly errorMessage?: string | null;
}

export function createHostSafetyViewModel(input: {
  readonly host: HostStatusResponse;
  readonly security: TrustState;
  readonly network: NetworkStateResponse;
}): UiHostSafetyViewModel {
  return uiHostSafetyViewModelSchema.parse({
    host: input.host,
    security: input.security,
    network: input.network,
    remote_unlock_available: false,
    dashboard_lan_mutation_available: false
  });
}

export function createTrustStateViewModel(security: TrustState, options: TrustViewModelOptions = {}): UiTrustStateViewModel {
  const state = trustStateFromSecurity(security, options.untrustedState);

  return uiTrustStateViewModelSchema.parse({
    state,
    trusted: security.trusted,
    read_only: security.read_only,
    locked: security.locked,
    lan_enabled: security.lan_enabled,
    client_id: security.client_id,
    write_controls_enabled: security.trusted && !security.read_only && !security.locked,
    message: options.message ?? defaultTrustMessage(state)
  });
}

export function createWriteControlState(input: {
  readonly action: WriteAction;
  readonly session: ApiSession;
  readonly security: TrustState;
  readonly options?: WriteControlOptions;
}): UiWriteControlState {
  const options = input.options ?? {};
  const requiresConfirmation = input.action === "stop" || input.action === "raw_input";
  const advancedRequired = input.action === "raw_input";
  const disabledReason = immediateDisabledReason(input.action, input.session, options);

  if (disabledReason !== null) {
    return disabledWriteControl(input.action, disabledReason, requiresConfirmation, advancedRequired);
  }

  const eligibility = checkWriteEligibility({
    action: input.action,
    sessionId: input.session.id,
    targetSessionIds: [input.session.id],
    lifecycleState: input.session.lifecycle_state,
    trusted: input.security.trusted,
    readOnly: input.security.read_only,
    hostLocked: input.security.locked,
    auditAvailable: options.auditAvailable ?? true,
    ...(options.slashCommand !== undefined ? { slashCommand: options.slashCommand } : {}),
    ...(input.action === "raw_input" ? { rawInputConfirmed: options.advancedRawVisible === true && options.rawInputConfirmed === true } : {})
  });

  if (!eligibility.allowed) {
    return disabledWriteControl(input.action, disabledReasonForDenial(eligibility.code), requiresConfirmation, advancedRequired);
  }

  return uiWriteControlStateSchema.parse({
    action: input.action,
    enabled: true,
    disabled_reason: null,
    requires_confirmation: requiresConfirmation,
    advanced_required: advancedRequired
  });
}

export function createSessionCardViewModel(session: ApiSession, security: TrustState, options: SessionCardOptions = {}): UiSessionCard {
  return uiSessionCardSchema.parse({
    id: session.id,
    name: session.name,
    cwd: session.cwd,
    project_label: options.projectLabel ?? projectLabelFromCwd(session.cwd),
    branch: session.branch,
    lifecycle_state: session.lifecycle_state,
    status: session.status,
    attention: session.attention,
    last_activity_at: session.last_activity_at,
    recent_output: {
      text: session.recent_output.text.slice(0, 280),
      cursor: session.recent_output.cursor,
      truncated: session.recent_output.truncated
    },
    write_control: createWriteControlState({
      action: "prompt",
      session,
      security,
      options: writeControlOptions({ auditAvailable: options.auditAvailable })
    })
  });
}

export function createMissionControlViewModel(input: {
  readonly host: HostStatusResponse;
  readonly security: TrustState;
  readonly network: NetworkStateResponse;
  readonly sessions: readonly ApiSession[];
  readonly options?: MissionControlOptions;
}): UiMissionControlViewModel {
  const sessions = input.sessions.map((session) => createSessionCardViewModel(session, input.security)).sort(compareSessionCards);
  const state = input.options?.state ?? (sessions.length === 0 ? "empty" : "ready");

  return uiMissionControlViewModelSchema.parse({
    screen: "mission_control",
    state,
    host_safety: createHostSafetyViewModel(input),
    trust: createTrustStateViewModel(input.security, input.options?.trust),
    sessions,
    attention_sorted: true,
    error_message: input.options?.errorMessage ?? null
  });
}

export function createSessionOutputResponse(session: ApiSession): SessionOutputResponse {
  if (session.recent_output.cursor === null) {
    return sessionOutputResponseSchema.parse({
      session_id: session.id,
      events: [],
      next_cursor: 0,
      truncated: session.recent_output.truncated
    });
  }

  return sessionOutputResponseSchema.parse({
    session_id: session.id,
    events: [
      {
        type: "output",
        session_id: session.id,
        cursor: session.recent_output.cursor,
        captured_at: session.last_activity_at,
        text: session.recent_output.text
      }
    ],
    next_cursor: session.recent_output.cursor + 1,
    truncated: session.recent_output.truncated
  });
}

export function createOutputBoundary(output: SessionOutputResponse): UiOutputBoundary {
  const replayBoundary = output.events.find((event) => event.type === "replay_boundary");

  if (replayBoundary !== undefined) {
    return uiOutputBoundarySchema.parse({
      type: "replay_boundary",
      session_id: output.session_id,
      after: replayBoundary.after,
      next_cursor: replayBoundary.next_cursor,
      visible: true,
      message: "Older output is outside the retained replay window."
    });
  }

  if (output.truncated) {
    return uiOutputBoundarySchema.parse({
      type: "truncated",
      session_id: output.session_id,
      after: null,
      next_cursor: output.next_cursor,
      visible: true,
      message: "Recent output was truncated to keep the dashboard bounded."
    });
  }

  return uiOutputBoundarySchema.parse({
    type: "none",
    session_id: output.session_id,
    after: null,
    next_cursor: null,
    visible: false,
    message: null
  });
}

export function createSessionDetailViewModel(input: {
  readonly session: ApiSession;
  readonly security: TrustState;
  readonly options?: SessionDetailOptions;
}): UiSessionDetailViewModel {
  const streamState = input.options?.streamState ?? "connected";
  const output = input.options?.output ?? createSessionOutputResponse(input.session);
  const advancedRawVisible = input.options?.advancedRawVisible ?? false;
  const controlOptions = writeControlOptions({
    auditAvailable: input.options?.auditAvailable,
    streamState,
    advancedRawVisible,
    rawInputConfirmed: input.options?.rawInputConfirmed
  });

  return uiSessionDetailViewModelSchema.parse({
    screen: "session_detail",
    session: input.session,
    output,
    boundary: createOutputBoundary(output),
    stream_state: streamState,
    prompt_control: createWriteControlState({
      action: "prompt",
      session: input.session,
      security: input.security,
      options: controlOptions
    }),
    slash_controls: allowedSlashCommands.map((command) => ({
      command,
      control: createWriteControlState({
        action: "slash",
        session: input.session,
        security: input.security,
        options: { ...controlOptions, slashCommand: command }
      })
    })),
    stop_control: createWriteControlState({
      action: "stop",
      session: input.session,
      security: input.security,
      options: writeControlOptions({ auditAvailable: input.options?.auditAvailable })
    }),
    raw_input_control: createWriteControlState({
      action: "raw_input",
      session: input.session,
      security: input.security,
      options: controlOptions
    }),
    advanced_raw_visible: advancedRawVisible,
    error_message: input.options?.errorMessage ?? null
  });
}

function writeControlOptions(input: {
  readonly auditAvailable?: boolean | undefined;
  readonly streamState?: UiStreamState | undefined;
  readonly advancedRawVisible?: boolean | undefined;
  readonly rawInputConfirmed?: boolean | undefined;
}): WriteControlOptions {
  return {
    ...(input.auditAvailable !== undefined ? { auditAvailable: input.auditAvailable } : {}),
    ...(input.streamState !== undefined ? { streamState: input.streamState } : {}),
    ...(input.advancedRawVisible !== undefined ? { advancedRawVisible: input.advancedRawVisible } : {}),
    ...(input.rawInputConfirmed !== undefined ? { rawInputConfirmed: input.rawInputConfirmed } : {})
  };
}

function trustStateFromSecurity(security: TrustState, untrustedState: UntrustedTrustState | undefined): UiTrustStateViewModel["state"] {
  if (security.locked) {
    return "locked";
  }

  if (security.trusted) {
    return security.read_only ? "trusted_read_only" : "trusted_write";
  }

  return untrustedState ?? "unpaired";
}

function defaultTrustMessage(state: UiTrustStateViewModel["state"]): string | null {
  switch (state) {
    case "trusted_write":
      return null;
    case "trusted_read_only":
      return "Read-only access. Write controls are disabled.";
    case "locked":
      return "HostDeck is locked. Remote writes are disabled.";
    case "expired":
      return "Pairing expired. Create a new local pairing code.";
    case "revoked":
      return "This browser was revoked. Pair again from the host.";
    case "permission_denied":
      return "This browser can read allowed state but cannot write.";
    case "unpaired":
      return "Pair this browser from the host before writing.";
  }
}

function immediateDisabledReason(action: WriteAction, session: ApiSession, options: WriteControlOptions): UiDisabledWriteReason | null {
  if ((action === "prompt" || action === "slash" || action === "raw_input") && options.streamState !== undefined && options.streamState !== "connected") {
    return "stream_disconnected";
  }

  if (session.lifecycle_state === "running" && session.status === "unknown") {
    return "unknown";
  }

  return null;
}

function disabledReasonForDenial(code: WriteDenialCode): UiDisabledWriteReason {
  switch (code) {
    case "unsupported_slash":
      return "unsupported_slash";
    case "untrusted":
      return "untrusted";
    case "read_only":
      return "read_only";
    case "locked":
      return "locked";
    case "stale":
      return "stale";
    case "stopped":
      return "stopped";
    case "crashed":
      return "crashed";
    case "unknown":
      return "unknown";
    case "not_running":
      return "not_running";
    case "raw_input_confirmation_required":
      return "raw_input_confirmation_required";
    case "audit_unavailable":
      return "audit_unavailable";
    case "multi_session_write":
    case "invalid_action":
      throw new TypeError(`Unexpected write denial for dashboard control: ${code}`);
  }
}

function disabledWriteControl(
  action: WriteAction,
  disabledReason: UiDisabledWriteReason,
  requiresConfirmation: boolean,
  advancedRequired: boolean
): UiWriteControlState {
  return uiWriteControlStateSchema.parse({
    action,
    enabled: false,
    disabled_reason: disabledReason,
    requires_confirmation: requiresConfirmation,
    advanced_required: advancedRequired
  });
}

function compareSessionCards(left: UiSessionCard, right: UiSessionCard): number {
  const attentionDifference = attentionPriority(right.attention) - attentionPriority(left.attention);

  if (attentionDifference !== 0) {
    return attentionDifference;
  }

  return left.name.localeCompare(right.name);
}

function projectLabelFromCwd(cwd: string): string {
  const label = cwd.split("/").filter(Boolean).at(-1);

  return label === undefined ? cwd : label;
}
